# ARCHITECTURE, RISKS and UNIT ECONOMICS

## Architecture (one page)
```
Browser / email client
   |  HTML only (no JavaScript, CSP script-src 'none')
Vercel function api/index.js  -->  src/app.js router
   routes-public  (landing, demo, pricing, legal, waitlist, signup, login, /t tap links, /o pixel, unsubscribe)
   routes-app     (dashboard, onboarding/settings, match + response kit, pipeline, billing, export, delete)
   routes-admin   (8 screens, TOTP)
   routes-hooks   (Stripe + Resend webhooks, cron entry points)
   |
   src/store (PostgREST over fetch)  -->  Supabase Postgres (RLS on, no policies; secret key server-side only)
   src/adapters (mesa, phoenix, sam)  -->  public data APIs
   src/email.js   -->  Resend      src/stripe.js  -->  Stripe Checkout / Portal / Billing
Vercel Cron: 11:00 UTC ingest (+housekeeping), 13:00 UTC digest (+reminders)
```
Key modules: `taxonomy.js` (one trade vocabulary shared by UI, rules, adapters, tests), `scoring.js` (deterministic eligibility + weighted fit, per-item green/yellow/red checklist), `kit.js` (intro email, call script, capability statement, proposal draft from the customer's rate card, forms checklist; missing inputs are listed, never invented; ROC number shown on every draft), `jobs.js` (idempotent jobs), `auth.js`, `crypto.js`, `totp.js`.
Adding a source: write `src/adapters/<name>.js` exporting `{id, label, jurisdiction, fetchRaw, normalize}`, register in `adapters/index.js`, insert a `source_config` row.
Data model: see `db/schema.sql`.

## Top risks and mitigations
| # | Risk | Mitigation | Residual |
| --- | --- | --- | --- |
| 1 | Source terms forbid commercial reuse | Sources ship disabled; owner marks terms reviewed; links to official records only; no document hosting | Owner must actually read the terms |
| 2 | Public permits are not bids; customers may over-read them | Every digest says records show what was filed, not who will be hired; permit values are not contract prices | Wording needs attorney review |
| 3 | Thin supply: Mesa commercial permits + Phoenix + SAM are not a full bid feed | Honest "no strong matches" email; no padding; marketing says "public permit records and federal notices" | **Product-market fit is unproven.** Local public bids (cities, school districts, state portal) are not integrated yet |
| 4 | Customer submits a bad bid and blames us | Product never submits; ROC number on drafts; Terms disclaim; "customer is responsible" | Attorney review |
| 5 | Email deliverability | SPF/DKIM via Resend, one-click unsubscribe, suppression on bounce/complaint, auto-pause for non-openers | New domain warm-up |
| 6 | Secrets leaked | Env vars only; `.env.example` placeholders; tests scan for secrets; gitleaks in CI + pre-commit | The Gemini key already leaked locally must be rotated |
| 7 | Vercel Hobby / Supabase free tier limits | Documented in OWNER-TODO: Pro tiers before launch | Cost +$45/month |
| 8 | Cron continuation chain unproven on live Vercel | Idempotent; owner can run "Run digest" manually | Verify on first real day |
| 9 | Scale of digest at 500 customers | Shared loads, concurrency 8, 40 s budget, tested at 500 accounts offline (4.1 s with in-memory store) | Not load-tested against live Postgres/Resend |
| 10 | Legal: auto-renewal law, sales tax | Drafts flagged; owner tasks listed | Needs professionals |

## Unit economics
Assumptions (mine, not measured): blended price $39/month (half Starter at $29, half Pro at $49); no LLM cost; Stripe card fee 2.9% + $0.30 per charge (published US standard rate; Billing and Tax may add fees, verify in your Stripe account); Resend Pro ~$0.0004 per email (50,000 emails for $20); about 35 emails per customer per month (30 digests + reminders). Fixed: Vercel Pro $20 + Supabase Pro $25 + Resend Pro $20 + domain ~$1 = $66/month (brief target: <= $80). Vendor prices change; verify before relying on them. Excludes churn, refunds, taxes, your time.

| Paying customers | Revenue | Stripe fees | Email | Fixed | Net before tax | Variable cost / customer |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | $1,950 | $72 | $1 | $66 | **$1,812** | ~$1.45 |
| 200 | $7,800 | $286 | $3 | $66 | **$7,445** | ~$1.45 |
| 500 | $19,500 | $716 | $7 | $66 | **$18,711** | $1.45 |

The brief's variable-cost ceiling is $4 per customer; at these assumptions we are under it. These numbers say nothing about whether you can *acquire* 50 customers. Treat them as cost structure only.
