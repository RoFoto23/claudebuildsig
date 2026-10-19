# OWNER-TODO: everything only you can do

Order matters. Items 1-6 turn the site from "waitlist mode" into "customers can start a trial". The site tells visitors which mode it is in, and it will not open signups until every dependency below is configured.

Never paste a secret into chat. Put each one only in the Vercel dashboard (Project > Settings > Environment Variables), then redeploy.

## 0. Do this first: rotate the leaked Gemini key
A Gemini API key in your local `apiinfo.txt` was printed in a tool output during this build. Treat it as exposed.
1. Open Google AI Studio > API keys.
2. Delete that key. A new key is needed only if you later turn on the optional AI fallback for forwarded emails (section 10); create it fresh then, and enter it only in Vercel.
3. Delete or empty `apiinfo.txt` and make sure it is never committed (`.gitignore` already excludes it).

## 1. Hosting: Vercel Pro (required for a paid product)
Vercel's Hobby plan is for non-commercial use only. A subscription site must be on Pro (about $20/month; check current pricing).
1. vercel.com > your account > Billing > upgrade to Pro.
2. The project `buildsignal` is created for you. Open it > Settings > Domains and add your domain (item 5).

## 2. Database: Supabase
The project `buildsignal-prod` already exists with the schema applied (see `db/schema.sql`).
1. Supabase dashboard > Project Settings > API. Copy the **Project URL**, the **publishable (anon) key** and the **secret key**.
2. In Vercel set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`. (The URL and anon key are public by design; the secret key is not. Mark the secret key "Sensitive".)
3. Upgrade Supabase to Pro (about $25/month) before real customers: the free tier pauses after a week of inactivity and has no backups. After upgrading, do one restore test (Database > Backups) and write the date in `docs/RUNBOOK.md`.

## 3. Email: Resend
1. resend.com > create account > Domains > add your sending domain and add the DNS records it shows (SPF, DKIM). Wait for "Verified".
2. API Keys > create a key with "Sending access" only. Set `RESEND_API_KEY` in Vercel.
3. Set `EMAIL_FROM` (for example `BuildSignal <digest@yourdomain.com>`) and `REPLY_TO` (an inbox you read).
4. Webhooks > add endpoint `https://YOURDOMAIN/webhooks/resend`, events: `email.bounced`, `email.complained` (and `email.received` once you set up forwarding, section 10). Copy the signing secret into `RESEND_WEBHOOK_SECRET`.
5. Resend's free tier caps sending at 100 emails/day; a daily digest product needs the paid tier once you pass about 3 daily customers.

## 4. Payments: Stripe
1. stripe.com > create account and finish business verification (needs your legal entity details, item 8).
2. Developers > API keys. Use **test mode** keys first. Create a **restricted key** if you prefer (needs write access to Customers, Checkout Sessions, Billing Portal, Subscriptions, Products, Prices). Set `STRIPE_SECRET_KEY`.
3. Developers > Webhooks > add endpoint `https://YOURDOMAIN/webhooks/stripe`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Settings > Billing > Customer portal: enable cancel subscription and pause, and show your Terms and Privacy links.
5. Test the full path in test mode with card `4242 4242 4242 4242` (see Verification below). Only then swap in live keys and re-create the webhook in live mode.
6. Stripe Tax / sales tax: see item 8.

## 5. Domain
Buy a domain (Vercel > Domains, or any registrar), add it to the Vercel project, then set `APP_URL=https://yourdomain.com`. Before you buy: check the name is free and check trademark search at uspto.gov. "BuildSignal" is a working name; I did not verify trademark availability.

## 6. Required settings and admin access
| Variable | What to put |
| --- | --- |
| `ADMIN_EMAILS` | Your email (comma-separate more). Only these addresses can ever become admin. |
| `MAILING_ADDRESS` | A real physical mailing address (a PO box or registered-agent address works). CAN-SPAM requires it; the site refuses to send marketing mail without it. |
| `BRAND_NAME` | Optional. Defaults to `BuildSignal`. |
| `SAM_API_KEY` | Optional. Free key from sam.gov (account > API Key). Enables federal opportunities. |

**You must create these four secrets yourself** (they are not set yet, and the site keeps sign-up closed until they exist). In Vercel > your project > Settings > Environment Variables, add each as a Production variable with a long random value (at least 32 characters; a password manager's "generate" button works, or run `openssl rand -hex 32` in a terminal):
- `SESSION_SECRET` signs login cookies.
- `TOKEN_SECRET` signs sign-in, one-tap and unsubscribe links.
- `ENC_KEY` encrypts your authenticator (2FA) secret. **Never change it after admin 2FA is enrolled.**
- `CRON_SECRET` protects the scheduled-job URLs. Vercel automatically sends it as `Authorization: Bearer <value>` when it triggers the two daily jobs.

Also add `SUPABASE_SECRET_KEY` (Supabase > Project Settings > API Keys > secret key). Without it the site runs in waitlist-only mode. Never paste any of these into chat or into a file in the repository. After adding variables, redeploy (Vercel > Deployments > Redeploy) so they take effect.

First admin login: go to `/login`, enter your admin email, open the emailed link, then you are sent to `/admin/2fa` to scan a QR/secret into an authenticator app. Admin screens need that 6-digit code every 8 hours. If email is not configured yet, the sign-in link is written to the `outbox` table (Supabase > Table editor > outbox, status `simulated`); open it from there.

## 7. Data sources: review terms, then switch on
All three live sources ship **off**. I could not read their terms from my environment, and your brief says unknown terms = blocked.
1. Admin > Sources. For each source open the terms link, read it, and decide.
   - City of Mesa open data: https://data.mesaaz.gov/stories/s/Terms-of-Use-page/2dcd-j2nx/ (also the Data Policy page and opendata.info@mesaaz.gov).
   - City of Phoenix ArcGIS permit layer: look for the City's open-data terms; email the city data team if unclear.
   - SAM.gov: https://open.gsa.gov/api/get-opportunities-public-api/ (the page lists rate limits "by role" but gives no numbers; test and watch for HTTP 429).
2. If acceptable: write a note, click "Mark terms reviewed", then "Enable". Click "Test fetch (stores nothing)" to see a live fetch result.
3. Watch Admin > Sources for the first three days. A source that returns zero items or errors three days in a row switches itself off and emails you.

## 8. Legal and business (not code)
- [ ] **Attorney review** of Terms, Privacy and Refund pages (`src/legal.js`). They are drafts marked ATTORNEY REVIEW REQUIRED. Ask specifically about: use of public permit records, "information not advice" wording, auto-renewal disclosures (Arizona and FTC negative-option rules), CAN-SPAM, and the "you submit under your own license" language (A.R.S. 32-1101, 32-1124, 32-1151).
- [ ] Business entity (LLC), EIN, business bank account, separate from personal.
- [ ] **Sales tax**: whether Arizona transaction privilege tax applies to your subscription is a question for an AZ tax professional or the Department of Revenue. Stripe Tax can collect once you know.
- [ ] Insurance: ask an agent about tech E&O / cyber coverage for an information service.
- [ ] ROC records request: ask the Arizona Registrar of Contractors (roc.az.gov) for an authorized roster for commercial use. Not built into the product yet; assisted verification only.
- [ ] Privacy: if you ever add analytics beyond the built-in first-party funnel counters, update the Privacy page first.
- [ ] SMS: not built. If you add it later, carrier registration (A2P 10DLC) with your SMS provider is an owner task.

## 9. Alerts you will actually see
- Source problems: email to `ADMIN_EMAILS` (zero items, error, count anomaly, auto-disable).
- Daily owner summary email: MRR, trials, churn, digests sent, errors, cost per customer.
- Stripe failed payments: customer gets a dunning email; you see `past_due` in Admin > Customers.

## 10. Forwarded-alert inbox (built, OFF; do these in order before turning it on)
The feature is fully tested against simulated Resend responses only. Nothing below has been verified against the real services.
1. **Inbound address.** In Resend, enable receiving. Either (a) use the free `<id>.resend.app` address Resend gives you, or (b) add an inbound subdomain such as `in.yourdomain.com` and add the MX record Resend shows, at a LOWER priority than any existing mail records (use a subdomain so your normal email is untouched). Set `INBOUND_DOMAIN` in Vercel to that domain (no `@`).
2. **Resend plan and key.** Check Resend's current pricing for received email: each received message counts against your quota (the builder could not verify the inbound price). The `RESEND_API_KEY` must be allowed to read received mail; if "Sending access" is not enough, create a key with full access and replace it.
3. **Webhook.** Edit the existing Resend webhook (`/webhooks/resend`) and add the event `email.received`. Same signing secret.
4. **Real samples (blocking).** Collect at least 60 real alert emails from contractors you know (BidNet, Arizona Procurement Portal, PlanHub, BuildingConnected) and forward them yourself to a test account's address. Then run the parser on them and read `docs/EVAL-RESULTS.md` guidance: the 90% extraction target can only be measured on real emails. Save the three or four most common layouts as sender templates.
5. **Live check (T13).** Send one real email to your own address and confirm: row appears in `inbound_messages`, the item appears on that account's dashboard, a Gmail forwarding-confirmation email shows its code on `/app/inbox`, and a replaced address stops working. Report anything that differs (message size limits, retry behaviour, attachment handling were not verifiable from documentation).
6. **Portal terms (attorney).** Ask the attorney whether forwarding portal alert emails to a processor (us) for the subscriber's own use is permitted by BidNet, PlanHub and BuildingConnected terms. Do not market the feature by naming a portal until answered.
7. **Optional AI fallback.** Only after steps 1-5. Create an LLM key (Google AI Studio for Gemini, or Anthropic/OpenAI), put it in Vercel as `LLM_API_KEY`, set `LLM_PROVIDER` and `LLM_MODEL`. In Admin > Sources > Inbox card enter a monthly dollar cap and the model's per-million-token input and output prices (copy from the provider's price page; the app does not guess). Verify the provider's API terms state that API inputs are not used for training before you enable it, then tick "Allow the AI fallback".
8. **Switch on.** Admin > Sources > Inbox card > tick "Accept forwarded mail". Watch the Review queue daily for the first week.
9. **Privacy and Terms.** The draft Privacy page already has a forwarded-email section; have the attorney confirm it matches what you enabled (AI provider named, retention 30 days, staff can read unreadable emails).

## Verification checklist after you set the keys
1. `https://YOURDOMAIN/health` shows `"db":"ok"`, `"email":"live"`, `"billing":"live"` and `"signup_open":true`.
2. Landing page no longer says "Early access"; the Start trial button works.
3. Stripe test-mode checkout with 4242 card: you land in onboarding, account shows `trialing`.
4. Admin > Sources: use "Test fetch" on each source once.
5. Admin > Overview > "Run a job now" > Run digest. Check your inbox: tap "Interested", confirm the response kit opens.
6. Click Unsubscribe in that email and confirm no further mail arrives.
