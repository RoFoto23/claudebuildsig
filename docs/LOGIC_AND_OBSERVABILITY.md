# Execution Logic & Observability Log

Every job and webhook writes one JSON line to stdout per state change (Vercel > Logs). Search by `job`.

## Log schema
```json
{ "ts": "2026-10-11T13:00:04.112Z", "level": "info|error", "job": "ingest|digest|reminders|housekeeping|stripe|resend",
  "source": "mesa_permits", "run_key": "2026-10-11", "state_from": "claimed", "state_to": "fetching",
  "error_code": "mesa 503", "event": "invoice.payment_failed", "ms": 1840 }
```
Fields are present only when relevant. `run_key` is the Arizona calendar date. Durable state also lives in Postgres: `job_runs` (one row per job per key), `outbox` (every email), `stripe_events` (every webhook), `audit_log` (every admin action), `source_config` (health per source), `events` (funnel).

## 1. Ingest (cron `0 11 * * *` = 04:00 Arizona)
States per source: `skipped` -> `claimed` -> `fetching` -> `normalized` -> `upserted` -> `ok` | `failed`.
| Gate | Condition | Result |
| --- | --- | --- |
| Adapter exists | `ADAPTERS[source]` | else `skipped: no adapter` |
| Enabled | `source_config.enabled` and not `auto_disabled` | else skipped |
| Terms | `terms_reviewed_at` not null | else skipped (unknown terms = blocked) |
| Key | adapter `needsKey` and key present | else skipped |
| Idempotency | RPC `claim_job('ingest:<source>', <AZ date>)` returns true | false = already ran today, no work |
| Health | `assessHealth`: error, zero items, or count < 20% of baseline (baseline >= 20) | problem recorded; failure counter +1; alert on first failure; **auto-disable at 3 consecutive failures**; HTTP 429 counts as "rate limited" and does not increment |
Dedupe: `(source, source_id)` unique plus content `fingerprint`; a changed fingerprint writes a new row to `opportunity_versions`, bumps `version`, sets `changed_at` (this drives change alerts).
Then housekeeping runs: expired login tokens purged, past-deadline items closed, trial-ending / win-back / monthly-summary emails, owner daily summary.

## 2. Digest (cron `0 13 * * *` = 06:00 Arizona)
Per account: eligible if active, billing `trialing|active`, not paused, not unsubscribed, not suppressed, onboarded; weekly customers only on Mondays.
1. Evaluate every active opportunity against the profile (`scoring.evaluate`): hard gates (trade, jurisdiction, value range, deadline not passed) then weighted score; unknown values -> yellow, not excluded.
2. Select top N (1-5, `max_items`) with score >= `deliver_min`; drop items already delivered or marked Not for me.
3. Create `digests` row with unique `digest_key` (`<account>:<date>`). Existing key = resume, never duplicate.
4. Send via outbox with idempotency key; on success set `sent_at`, `delivered_at` on matches.
5. No items: send the short "no strong matches" note, at most once per 7 days for daily customers.
6. Inactivity: 14 unopened digests in 30 days sets `digest_paused`.
Time budget 40 s; if accounts remain the response includes `remaining` and the cron route calls itself with `?depth=N+1` (max 6). Re-entry is safe because of step 3.
Reminders then run: 7/3/1 days before deadline for `interested` matches (`reminders_sent` array prevents repeats) and an immediate alert when `opportunity.version > match.change_alerted_version`.

## 3. Email send (every message)
`queued` -> (`simulated` if no key) | `sent` | `failed` | later `bounced` / `complained` via webhook.
Gates in order: idempotency key already `sent|simulated` -> return duplicate; recipient in `suppressions` -> not sent; marketing kind and no `MAILING_ADDRESS` -> blocked; pacing 120 ms; retry 429/5xx with backoff. Marketing mail carries List-Unsubscribe and one-click headers.

## 4. Stripe webhook `/webhooks/stripe`
`received` -> signature verified (else 400) -> `stripe_events` insert (duplicate and processed = 200 no-op) -> `processStripeEvent` -> `processed_at` set | `error` stored and 500 returned so Stripe retries. Unknown account logs `state_to: no_account`.

## 5. Login / admin
Token state: `issued` -> `used` (conditional update: only one request can win) | `expired`. Admin: session + email allowlist + role admin + TOTP step greater than `last_used_step`.

## Triage table
| Symptom | Inspect | Likely cause |
| --- | --- | --- |
| Digest count 0 | `job_runs` where job=`digest`; log `state_to` | Sources disabled -> no opportunities; or all customers paused |
| Same digest twice reported | `digests.digest_key` | Impossible by constraint; check `outbox.idempotency_key` |
| Source `rate limited` | `source_config.last_error` | SAM.gov role limit; wait a day |
| `count anomaly` | `last_count` vs `baseline_count` | Upstream filter/format changed; compare official site |
| Webhook 500s | `stripe_events.error` | Price not mapped to a plan: open Admin > Pricing and save once |
| Emails `simulated` | `/health` email field | `RESEND_API_KEY` or `EMAIL_FROM` missing |
| Timeouts on cron | log `ms` | Depth continuation should fire; check `remaining` in the response |

## 6. Forwarded-alert inbox (`src/inbox.js`, `src/routes-hooks.js`)
Log lines use `event` (not `job`). Search Vercel logs for `"event":"inbox.`.

### Message state machine (`inbound_messages.status`)
`received` -> `fetched` -> `parsed` | `held` | `dropped`; `failed` after 5 attempts; `expired` after 30 days (subject, body, code blanked).
| Transition | Gate / condition | Notes |
| --- | --- | --- |
| webhook -> `received` | Svix signature valid and timestamp within 300 s; `inbox.enabled`; recipient local part matches an unrevoked address; per-account daily limit (`inbox.daily_limit`) not exceeded; `provider_email_id` not seen before | otherwise `inbox.rejected` with `reason`, HTTP 200 (so Resend does not retry) |
| `received` -> `fetched` | `GET /emails/receiving/{id}` succeeds; text cleaned (HTML -> text, quoted-reply trimming, max `inbox.max_chars`) | failure sets `attempts+1`, `next_attempt_at` = backoff 5 / 30 / 120 / 600 min; a lease (`next_attempt_at` = now + 10 min) stops two workers taking the same row |
| `fetched` -> `parsed` | at least one item with recomputed confidence >= `inbox.parse_threshold` (default 0.6) | weaker items from the same email are dropped |
| `fetched` -> `held` | no item reached the threshold, or nothing found | appears in Admin > Review queue |
| `fetched` -> `dropped` | auto-reply / out-of-office / not a bid alert; Gmail forwarding confirmation (code stored for the customer) | |
| any -> `failed` | `attempts` >= 5 | Admin > Review queue > Failed > Try again |
| `held` -> `parsed` / `dropped` | staff release / reject | audited: `inbox.release`, `inbox.reject`, `inbox.retry` |

### Events (JSON lines)
| `event` | Fields | Meaning |
| --- | --- | --- |
| `inbox.received` | message_id, account, provider_email_id, from_domain | accepted from the webhook |
| `inbox.rejected` | reason (`disabled`, `no_email_id`, `unknown_address` [also covers revoked addresses], `inactive_account`, `daily_limit`), plus `to_hash` or `account` | not stored; HTTP 200 so Resend does not retry |
| `inbox.duplicate` | provider_email_id | webhook retry or double delivery; no second row |
| `inbox.fetched` | message_id, ms, chars, attachments | body read from Resend (attachments counted, never downloaded) |
| `inbox.state` | message_id, account, state_from, state_to, attempts, extra fields per step (ms, chars, items, error_code); `by:"staff"` for admin actions | every transition |
| `parse.result` | message_id, method (`template|rules|ai|none`), items, confidence, dropped, ai (AI outcome if used) | what the parser decided |
| `inbox.sweep` | picked, parsed, held, failed, dropped, retry, expired, ms (exact keys as emitted by `sweep`) | one line per sweep (cron `ingest` and `digest`) |
| `inbox.failed` | message_id, account, error_code | reached 5 attempts; admins are emailed once per message (`alertAdmins`, key `inboxfail:<id>`) |
| `llm.cap_reached` | not emitted | NOT implemented: when the cap is hit `llm.available()` returns reason `capped`, `parse.result.ai` shows `unavailable:capped` and the message is held. There is no owner email for this yet. |
Every model call is also a row in `llm_calls` (provider, model, tokens_in/out, cost_usd, latency_ms, outcome `ok`, `timeout`, `network`, `http_error`, `invalid_json`, or (set after parsing) `schema_fail`, `quote_fail`; a call blocked by the cap is not made and so has no row).

### Triage: inbox
| Symptom | Inspect | Likely cause |
| --- | --- | --- |
| Customer forwards, nothing appears | `inbound_messages` for that account; log `inbox.rejected` | `inbox.enabled` false; address replaced (old one revoked); daily limit; Resend not delivering to the MX/`resend.app` address |
| Rows stuck in `received` | `attempts`, `error`, `next_attempt_at` | Resend API key lacks receiving access, or Resend 4xx/5xx; sweeper retries on cron |
| Many `held` | `parse.result` `dropped` reasons; Review queue | portal layout the rules do not know; AI off or capped; first real samples needed |
| `parse_method` = `ai` but item empty | `llm_calls.outcome` | `quote_fail`: the model quoted text not in the email; item correctly discarded |
| AI never used | Admin > Sources > Inbox card | any of enabled / key / model / cap / prices missing (card shows the reason) |
| Webhook 400 | Resend dashboard delivery log | wrong `RESEND_WEBHOOK_SECRET`, or clock skew > 5 min |
| Customer sees someone else's item | impossible by design; if reported, check `opportunities.owner_account_id` and run `test/isolation.test.js` | |
