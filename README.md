# BuildSignal

Verified Arizona commercial-project and public-bid opportunities for small trade businesses: a ranked digest of at most 5 items, a "can you bid?" checklist, and a response kit you review and send yourself. The product never submits a bid for anyone.

## Honest status (what is and is not real)
Built and covered by automated tests (`npm test`, 91 tests):
- Landing page, public demo with frozen sample data (clearly labelled), pricing, legal drafts (marked ATTORNEY REVIEW REQUIRED), waitlist.
- Passwordless sign-up and login, onboarding, settings, data export and account deletion.
- Stripe Checkout with 14-day trial, Customer Portal, pause, verified idempotent webhooks, dunning email. (Tested against a simulated Stripe API, not live Stripe.)
- Deterministic matching and eligibility checklist; one-tap Interested / Not for me / Already knew; response kit (intro email, call script, capability statement as print-to-PDF page, proposal draft from the customer's rate card, forms checklist, .ics calendar file); pipeline; 7/3/1-day reminders and change alerts.
- Daily/weekly digests, "no strong matches" note, unsubscribe (including one-click), bounce/complaint suppression, inactivity auto-pause.
- Admin: Overview, Customers, Opportunities, Sources, Rules, Deliverability, Pricing, Audit log, with TOTP two-factor.
- Source adapters for Mesa and Phoenix permits and SAM.gov, with health checks and auto-disable.

Not verified against the real services from the build environment: live Supabase calls from the deployed app, live data fetches, live Stripe, live Resend, Vercel cron timing. Check these with the steps in `docs/OWNER-TODO.md`.

Not built: Spanish, SMS, referral rewards, an LLM (so no evaluation set or prompt-injection suite; the brief's AI requirements do not apply yet), review queue, annual plans, ROC verification feed, past-performance builder, state portal / county BidNet / school-district adapters, native PDF generation. See `docs/DECISIONS.md`.

The market question is also open: permit records plus federal notices are a thinner feed than a full bid-alert service. Run a small pilot before spending on acquisition.

## Run locally
Requires Node 22. No install step (zero dependencies).
```
npm test
npm run dev        # in-memory preview at http://localhost:3000
```
Local preview uses an in-memory store and prints sign-in links with `ALLOW_DEV_LOGIN_LINKS=1`. Nothing is sent.

## Deploy
Vercel + Supabase. Environment variables are listed (placeholders only) in `.env.example`. Schema: `db/schema.sql`. Step-by-step: `docs/OWNER-TODO.md`.

## Docs
`docs/OWNER-TODO.md` (what you must do) | `docs/RUNBOOK.md` (weekly 30 minutes) | `docs/SOURCES.md` | `docs/DECISIONS.md` | `docs/ARCHITECTURE.md` (architecture, risks, unit economics) | `docs/LOGIC_AND_OBSERVABILITY.md` | `docs/sample-digest.html` / `.txt`

## Security notes
No secrets in the repo; `.gitleaks.toml`, a pre-commit hook and CI run gitleaks. All tables have row-level security with no policies. All private routes require a session; admin requires allowlisted email + TOTP. No JavaScript is served to browsers.
