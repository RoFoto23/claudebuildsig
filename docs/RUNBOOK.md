# RUNBOOK: your 30-minute weekly checklist

Sign in at `/login` with your admin email, then enter the 6-digit code from your authenticator app (`/admin/2fa`).

## Weekly (about 30 minutes)
1. **Overview (3 min).** Check trials, paying customers, MRR, churn, digests sent, errors, cost per customer. Cost per customer should stay under $4/month.
2. **Source health (5 min).** Every enabled source should show a recent "last OK" and a count near its usual baseline. If a source shows *auto-disabled*, open its error, check the official site, then click Test fetch. Re-enable only if the test succeeds.
3. **Opportunities (5 min).** Skim today's ingested items. Hide anything wrong (hidden items never reach a digest). Add a manual opportunity if you hear of a good bid (deadline is entered in Arizona time).
4. **Deliverability (3 min).** Bounces and complaints are suppressed automatically. If complaints are rising, look at what was sent that day.
5. **Customers (5 min).** Look at `past_due` accounts (Stripe retries automatically and emails them). Use Pause, Resume, Refund or Send sign-in link when a customer writes in. "Refund latest charge" refunds the most recent paid charge through Stripe and is logged; it does not cancel the subscription (use "Cancel subscription now" for that).
6. **Rules (3 min).** Only touch weights/thresholds if digests feel too long or too thin. Weights must add up to 100; digest size is 1-5.
7. **Pricing (1 min).** Prices cannot exceed $50 per charge. A price change applies to new checkouts.
8. **Audit log (2 min).** Confirm every admin action in the last week was yours.
9. **Review queue (3 min, only once the forwarding feature is on).** Admin > Review queue. Release or drop each held email (type only what the email says; leave unknown fields blank), and press Try again on anything under Failed. Check Admin > Sources > Inbox card: AI spend should stay under its cap.
10. **Inbox (3 min).** Answer replies to your `REPLY_TO` address.

## Monthly
- Re-read each data source's terms (see SOURCES.md) and update "reviewed".
- Stripe > Reports: reconcile payouts. Pay estimated taxes.
- Supabase: confirm last backup exists. Do a restore test once per quarter and record the date here: ______.
- Run `npm test` before accepting any code change from anyone.

## When something breaks
| Symptom | Look at | Fix |
| --- | --- | --- |
| No digests went out | Vercel > Logs, search `"job":"digest"`; Admin > Overview error count | Run digest from Overview > "Run a job now". It is idempotent: no customer gets two. |
| Source shows zero items | Admin > Sources, last error | Check the official site is up, Test fetch, re-enable. |
| Customer says link expired | Admin > Customers > Send sign-in link | Links last 20 minutes and work once. |
| Customer paid but has no access | Stripe > Developers > Webhooks > recent deliveries; Supabase table `stripe_events` (rows with `error`) | Resend the failed event from Stripe. Handling is idempotent. |
| Emails not arriving | `/health` (email must be `live`); Resend dashboard; Supabase `outbox` rows with status `failed` | Fix key/domain; failed rows keep the error text. |
| Customer asks to delete their data | They can self-serve at Settings > "Delete my account". | Deletion cancels their Stripe subscription first, then removes profile, matches, digests. |

Detailed state machines and log fields: `docs/LOGIC_AND_OBSERVABILITY.md`.
