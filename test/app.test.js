import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeApp, browser, loc, plain, lastLoginLink, signIn, BASE, ENV } from './helpers.js';
import { signForTest } from '../src/stripe.js';
import { signToken } from '../src/crypto.js';
import { decrypt } from '../src/crypto.js';
import { hotp, stepOf } from '../src/totp.js';
import { SAMPLE_OPPS } from '../src/sample.js';

const STRIPE_SCRIPT = {
  'api.stripe.com/v1/products': { id: 'prod_1' },
  'api.stripe.com/v1/prices/': { id: 'price_old', active: false },
  'api.stripe.com/v1/prices': { id: 'price_new' },
  'api.stripe.com/v1/checkout/sessions': { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' },
  'api.stripe.com/v1/billing_portal/sessions': { url: 'https://billing.stripe.com/p/session/1' },
  'api.stripe.com/v1/subscriptions': { data: [{ id: 'sub_1', status: 'active' }] },
};

const profileForm = (o = {}) => ({ business_name: 'Sun Valley Framing', contact_name: 'Dana Ruiz', phone: '480-555-0111', trades: ['framing'], jurisdictions: ['mesa'], zips: '85201, 85202', min_value: '100000', max_value: '', license_number: '314159', license_classes: 'C-5, B-1', certifications: ['small_business'], digest_frequency: 'daily', capability_blurb: 'We frame multifamily.', rate_card: 'Framing labor | sq ft | 4.25', ...o });

async function signup(app, store, email, plan = 'pro') {
  const b = browser(app);
  const res = await b.post('/signup', { email, plan, consent: '1' });
  assert.equal(res.status, 303);
  const v = await signIn(b, store, email);
  assert.equal(v.status, 303);
  return b;
}

async function onboard(b, o) {
  const res = await b.post('/app/onboarding', profileForm(o));
  assert.equal(res.status, 303, await res.text());
}

test('public pages render with security headers; sample data is labeled; no forbidden claims', async () => {
  const { app } = await makeApp();
  for (const p of ['/', '/demo', '/demo?trade=roofing', '/pricing', '/terms', '/privacy', '/refunds', '/login']) {
    const r = await app.fetch(new Request(BASE + p));
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('strict-transport-security'), /max-age/);
    const t = plain(await r.text());
    assert.doesNotMatch(t, /exclusive|limited time|only \d+ spots|act now|guaranteed/i, p);
    for (const m of t.matchAll(/guarantee/gi)) assert.match(t.slice(Math.max(0, m.index - 30), m.index), /\b(not|no|never|nor)\s+(\w+\s+)?$/i, `${p}: unqualified "guarantee"`);
  }
  const demo = plain(await (await app.fetch(new Request(`${BASE}/demo?trade=framing`))).text());
  assert.match(demo, /Sample data/);
  assert.match(demo, /simulated/);
  assert.match(demo, /Official record/);
  const legal = plain(await (await app.fetch(new Request(`${BASE}/terms`))).text());
  assert.match(legal, /ATTORNEY REVIEW REQUIRED/);
  const kit = plain(await (await app.fetch(new Request(`${BASE}/demo/kit/sample-3?trade=framing`))).text());
  assert.match(kit, /never submits a bid/);
  assert.match(kit, /ROC license/);
});

test('demo digest for a trade with no fit says so instead of padding', async () => {
  const { app } = await makeApp();
  const t = plain(await (await app.fetch(new Request(`${BASE}/demo?trade=demolition`))).text());
  assert.match(t, /2 matches for Demolition/);
  const none = plain(await (await app.fetch(new Request(`${BASE}/demo?trade=tree_trimming`))).text());
  assert.match(none, /matches for Tree/);
});

test('landing page tells the truth about launch state: waitlist until every dependency is live', async () => {
  const closed = await makeApp({ env: { STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' } });
  assert.equal(closed.config.signupOpen, false);
  const t = plain(await (await closed.app.fetch(new Request(BASE + '/'))).text());
  assert.match(t, /Paid sign-ups are not open yet/);
  assert.match(t, /Join the waitlist/);
  assert.equal((await closed.app.fetch(new Request(BASE + '/signup', { redirect: 'manual' }))).status, 303);
  const post = await closed.app.fetch(new Request(BASE + '/signup', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co&consent=1' }));
  assert.equal(post.status, 303);
  assert.equal((await closed.store.select('accounts', { where: { role: 'customer' } })).length, 0);

  const open = await makeApp();
  assert.equal(open.config.signupOpen, true);
  const t2 = plain(await (await open.app.fetch(new Request(BASE + '/'))).text());
  assert.match(t2, /Start your 14-day free trial/);
  assert.doesNotMatch(t2, /Paid sign-ups are not open yet/);
});

test('waitlist: consent required, honeypot ignored, stored once, cross-site posts blocked, rate limited', async () => {
  const { app, store } = await makeApp();
  const b = browser(app);
  const noConsent = await b.post('/waitlist', { email: 'a@b.co' });
  assert.equal(noConsent.status, 400);
  assert.equal((await b.post('/waitlist', { email: 'not-an-email', consent: '1' })).status, 400);
  assert.equal(loc(await b.post('/waitlist', { email: 'Roof@Example.com', trade: 'roofing', zip: '85201', consent: '1', source: 'landing' })), '/thanks');
  assert.equal(loc(await b.post('/waitlist', { email: 'roof@example.com', consent: '1' })), '/thanks');
  const leads = await store.select('leads');
  assert.equal(leads.length, 1);
  assert.deepEqual([leads[0].email, leads[0].trade, leads[0].zip, leads[0].consent], ['roof@example.com', 'roofing', '85201', true]);
  await b.post('/waitlist', { email: 'bot@example.com', consent: '1', website: 'http://spam' });
  assert.equal((await store.select('leads')).length, 1);
  const evil = await app.fetch(new Request(BASE + '/waitlist', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=x%40y.co&consent=1' }));
  assert.equal(evil.status, 403);
  let last;
  for (let i = 0; i < 8; i++) last = await b.post('/waitlist', { email: `n${i}@example.com`, consent: '1' });
  assert.equal(last.status, 429);
});

test('private routes require sign-in; admin routes do not even reveal themselves', async () => {
  const { app, store } = await makeApp();
  const b = browser(app);
  for (const p of ['/app', '/app/settings', '/app/pipeline', '/app/export', '/app/m/abc']) {
    const r = await b.get(p);
    assert.equal(r.status, 303, p);
    assert.match(loc(r), /^\/login\?next=/);
  }
  for (const p of ['/admin', '/admin/customers', '/admin/pricing', '/admin/audit', '/admin/2fa']) assert.equal((await b.get(p)).status, 404, p);
  for (const p of ['/app/billing/checkout', '/app/delete', '/admin/run/ingest', '/admin/pricing/pro']) { const r = await b.post(p, {}); assert.ok([303, 404].includes(r.status), `${p} ${r.status}`); }
  assert.equal((await b.get('/api/cron/digest')).status, 404);
  const cust = await signup(app, store, 'cust@example.com');
  assert.equal((await cust.get('/admin')).status, 404);
  assert.equal((await cust.post('/admin/pricing/pro', { price: '1' })).status, 404);
});

test('magic links: scanners cannot burn them (GET shows a button), single use, expire, and do not enumerate accounts', async () => {
  const { app, store } = await makeApp();
  const b = browser(app);
  await b.post('/signup', { email: 'dana@example.com', plan: 'starter', consent: '1' });
  const link = await lastLoginLink(store, 'dana@example.com');
  assert.ok(link);
  const u = new URL(link);
  const t = u.searchParams.get('t');
  const peek = await b.get(`/auth/verify?t=${t}&next=/app`);
  assert.equal(peek.status, 200);
  assert.match(await peek.text(), /Confirm sign in/);
  assert.equal((await store.select('login_tokens'))[0].used_at ?? null, null);
  assert.equal(loc(await b.post('/auth/verify', { t, next: '/app' })), '/app/onboarding'.startsWith('/app') ? '/app' : '/app');
  assert.ok(b.jar.get('bs_sess'));
  const replay = browser(app);
  assert.equal((await replay.post('/auth/verify', { t, next: '/app' })).status, 400);
  assert.equal((await replay.post('/auth/verify', { t: 'x'.repeat(43), next: '/app' })).status, 400);
  // expired
  const exp = await app.fetch(new Request(BASE + '/x')); void exp;
  const row = (await store.select('login_tokens'))[0];
  await store.update('login_tokens', { token_hash: row.token_hash }, { used_at: null, expires_at: '2020-01-01T00:00:00.000Z' });
  assert.equal((await replay.post('/auth/verify', { t, next: '/app' })).status, 400);
  // unknown email gets the same page and creates nothing
  const unknown = await b.post('/login', { email: 'nobody@example.com', next: '/app' });
  assert.equal(unknown.status, 200);
  assert.match(plain(await unknown.text()), /If that address has an account/);
  assert.equal((await store.select('accounts', { where: { email: 'nobody@example.com' } })).length, 0);
  assert.equal(safeNextCheck('//evil.com'), '/app');
});
import { safeNext } from '../src/http.js';
const safeNextCheck = (v) => safeNext(v);

test('open redirects are refused in the next parameter', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '']) assert.equal(safeNext(bad), '/app', bad);
  assert.equal(safeNext('/app/m/123?x=1'), '/app/m/123?x=1');
});

test('onboarding validates input and enforces plan limits server-side', async () => {
  const { app, store } = await makeApp();
  const b = await signup(app, store, 'starter@example.com', 'starter');
  const dash = await b.get('/app');
  assert.equal(loc(dash), '/app/onboarding');
  const noTrade = await b.post('/app/onboarding', profileForm({ trades: [] }));
  assert.equal(noTrade.status, 400);
  assert.match(plain(await noTrade.text()), /Pick at least one trade/);
  const tooMany = await b.post('/app/onboarding', profileForm({ trades: ['framing', 'electrical', 'janitorial'] }));
  assert.equal(tooMany.status, 400);
  assert.match(plain(await tooMany.text()), /Starter covers up to 1 trade group/);
  const badRate = await b.post('/app/onboarding', profileForm({ rate_card: 'Labor | hr | abc' }));
  assert.equal(badRate.status, 400);
  const sizes = await b.post('/app/onboarding', profileForm({ min_value: '900', max_value: '100' }));
  assert.equal(sizes.status, 400);
  const twoAreas = await b.post('/app/onboarding', profileForm({ jurisdictions: ['mesa', 'phoenix'] }));
  assert.equal(twoAreas.status, 400);
  assert.match(plain(await twoAreas.text()), /up to 1 service area/);
  await onboard(b, {});
  const a = await store.one('accounts', { where: { email: 'starter@example.com' } });
  const p = await store.one('profiles', { where: { account_id: a.id } });
  assert.deepEqual(p.zips, ['85201', '85202']);
  assert.deepEqual(p.license_classes, ['C-5', 'B-1']);
  assert.deepEqual(p.rate_card, [{ label: 'Framing labor', unit: 'sq ft', rate: 4.25 }]);
  assert.equal(p.license_number, '314159');
  assert.ok(p.onboarded_at);
  assert.equal(p.min_value, 100000);
  assert.equal(p.max_value, null);
});

test('profile fields escape HTML (stored XSS)', async () => {
  const { app, store } = await makeApp();
  const b = await signup(app, store, 'xss@example.com');
  await onboard(b, { business_name: '<script>alert(1)</script>"><img src=x onerror=alert(2)>' });
  const html = await (await b.get('/app/settings')).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('billing: checkout creates the Stripe price once, starts a trial with the account id; webhooks are verified and idempotent', async () => {
  const { app, store, fetchImpl } = await makeApp({ script: STRIPE_SCRIPT });
  const b = await signup(app, store, 'pay@example.com');
  await onboard(b, {});
  const acct = await store.one('accounts', { where: { email: 'pay@example.com' } });
  const co = await b.post('/app/billing/checkout');
  assert.equal(loc(co), 'https://checkout.stripe.com/c/pay/cs_1');
  const req = fetchImpl.calls.find((c) => c.url.endsWith('/checkout/sessions'));
  const body = decodeURIComponent(req.body);
  assert.match(body, new RegExp(`client_reference_id=${acct.id}`));
  assert.match(body, /trial_period_days\]=14/);
  assert.match(body, /price_new/);
  assert.equal((await store.one('plans', { where: { id: 'pro' } })).stripe_price_id, 'price_new');
  await b.post('/app/billing/checkout');
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/v1/products')).length, 1);

  const event = (id, type, object) => JSON.stringify({ id, type, data: { object } });
  const post = (raw, sig) => app.fetch(new Request(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body: raw }));
  const sub = { id: 'sub_1', customer: 'cus_1', status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 14 * 86400, metadata: { account_id: acct.id, plan_id: 'pro' }, items: { data: [{ price: { id: 'price_new' }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
  const raw1 = event('evt_1', 'customer.subscription.created', sub);
  assert.equal((await post(raw1, 'garbage')).status, 400);
  assert.equal((await post(raw1, signForTest(raw1, 'wrong-secret'))).status, 400);
  assert.equal((await post(raw1, signForTest(raw1, ENV.STRIPE_WEBHOOK_SECRET))).status, 200);
  let a2 = await store.one('accounts', { where: { id: acct.id } });
  assert.equal(a2.billing_status, 'trialing');
  assert.equal(a2.stripe_customer_id, 'cus_1');
  assert.equal(a2.plan_id, 'pro');
  const dup = await post(raw1, signForTest(raw1, ENV.STRIPE_WEBHOOK_SECRET));
  assert.equal((await dup.json()).duplicate, true);
  assert.equal((await store.select('stripe_events')).length, 1);

  const raw2 = event('evt_2', 'invoice.payment_failed', { id: 'in_1', customer: 'cus_1' });
  assert.equal((await post(raw2, signForTest(raw2, ENV.STRIPE_WEBHOOK_SECRET))).status, 200);
  a2 = await store.one('accounts', { where: { id: acct.id } });
  assert.equal(a2.billing_status, 'past_due');
  const dun = (await store.select('outbox', { where: { kind: 'dunning' } }))[0];
  assert.match(dun.subject, /Payment failed/);

  const raw3 = event('evt_3', 'customer.subscription.deleted', { ...sub, status: 'canceled' });
  await post(raw3, signForTest(raw3, ENV.STRIPE_WEBHOOK_SECRET));
  assert.equal((await store.one('accounts', { where: { id: acct.id } })).billing_status, 'canceled');

  const portal = await b.post('/app/billing/portal');
  assert.equal(loc(portal), 'https://billing.stripe.com/p/session/1');
});

test('one-tap links: prefetch-safe confirm page, then Interested creates the kit with the license number; weights learn; replays are harmless', async () => {
  const { app, store } = await makeApp();
  const b = await signup(app, store, 'tap@example.com');
  await onboard(b, {});
  const acct = await store.one('accounts', { where: { email: 'tap@example.com' } });
  await store.update('accounts', { id: acct.id }, { billing_status: 'trialing', plan_id: 'pro' });
  const [opp] = await store.insert('opportunities', { ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: 'PMT-T1', is_sample: false, fingerprint: 'f1', url: 'https://data.mesaaz.gov/x' });
  const [m] = await store.insert('matches', { account_id: acct.id, opportunity_id: opp.id, score: 77, delivered_at: new Date().toISOString(), factors: [{ label: 'Trade fit', points: 20, weight: 30, note: 'ok', kind: 'inference' }], checklist: [{ key: 'license', label: 'Your license', status: 'yellow', reason: 'unverified' }] });
  const tok = (act, extra = {}) => signToken({ typ: 'tap', a: acct.id, m: m.id, act, ...extra }, ENV.TOKEN_SECRET, 600);

  const prefetch = await app.fetch(new Request(`${BASE}/t/${tok('interested')}`));
  assert.equal(prefetch.status, 200);
  assert.match(plain(await prefetch.text()), /One tap to confirm/);
  assert.equal((await store.one('matches', { where: { id: m.id } })).disposition ?? null, null);

  const human = await app.fetch(new Request(`${BASE}/t/${tok('interested')}`, { headers: { 'sec-fetch-user': '?1' } }));
  assert.match(plain(await human.text()), /Saved: Interested/);
  let row = await store.one('matches', { where: { id: m.id } });
  assert.equal(row.disposition, 'interested');
  assert.equal(row.change_alerted_version, 1);
  const w1 = (await store.one('profiles', { where: { account_id: acct.id } })).feedback_weights;
  assert.ok(Object.keys(w1).length > 0);
  await app.fetch(new Request(`${BASE}/t/${tok('interested')}`, { headers: { 'sec-fetch-user': '?1' } }));
  assert.deepEqual((await store.one('profiles', { where: { account_id: acct.id } })).feedback_weights, w1); // idempotent

  const post = await app.fetch(new Request(`${BASE}/t/${tok('not_for_me')}`, { method: 'POST' }));
  assert.equal(post.status, 200);
  assert.equal((await store.one('matches', { where: { id: m.id } })).disposition, 'not_for_me');
  await app.fetch(new Request(`${BASE}/t/${tok('interested')}`, { method: 'POST' }));

  assert.equal((await app.fetch(new Request(`${BASE}/t/${signToken({ typ: 'tap', a: acct.id, m: m.id, act: 'interested' }, ENV.TOKEN_SECRET, -10)}`))).status, 400);
  assert.equal((await app.fetch(new Request(`${BASE}/t/${signToken({ typ: 'tap', a: acct.id, m: m.id, act: 'interested' }, 'other-secret', 600)}`))).status, 400);
  const other = await store.insert('accounts', { email: 'other@example.com' });
  const foreign = await app.fetch(new Request(`${BASE}/t/${signToken({ typ: 'tap', a: other[0].id, m: m.id, act: 'interested' }, ENV.TOKEN_SECRET, 600)}`, { method: 'POST' }));
  assert.equal(foreign.status, 404); // a token for another account cannot touch this match

  // the kit
  const page = await b.get(`/app/m/${m.id}`);
  const html = plain(await page.text());
  assert.match(html, /Response kit/);
  assert.match(html, /ROC license #314159/);
  assert.match(html, /never submits a bid/);
  assert.match(html, /How this score was built/);
  assert.match(html, /may already have its trades/);
  const ics = await b.get(`/app/m/${m.id}/calendar.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(await ics.text(), /BEGIN:VCALENDAR/);
  const cap = plain(await (await b.get(`/app/m/${m.id}/capability`)).text());
  assert.match(cap, /314159/);
  assert.match(cap, /Sun Valley Framing/);

  // pipeline
  assert.equal(loc(await b.post(`/app/m/${m.id}/action`, { action: 'bid_submitted' })), `/app/m/${m.id}`);
  assert.equal((await store.one('matches', { where: { id: m.id } })).action, 'bid_submitted');
  assert.equal((await b.post(`/app/m/${m.id}/action`, { action: 'hacked' })).status, 400);
  const pipe = plain(await (await b.get('/app/pipeline')).text());
  assert.match(pipe, /Bid submitted \(1\)/);
  assert.match(pipe, /We do not know the outcome of anything you do not tell us/);

  // another customer cannot read this match
  const eve = await signup(app, store, 'eve@example.com');
  await onboard(eve, {});
  assert.equal((await eve.get(`/app/m/${m.id}`)).status, 404);
});

test('plan gating: Starter after the trial gets eligibility and taps but not the kit or pipeline; the trial includes everything', async () => {
  const { app, store } = await makeApp();
  const b = await signup(app, store, 'st@example.com', 'starter');
  await onboard(b, {});
  const acct = await store.one('accounts', { where: { email: 'st@example.com' } });
  const [opp] = await store.insert('opportunities', { ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: 'PMT-G1', is_sample: false, fingerprint: 'g1' });
  const [m] = await store.insert('matches', { account_id: acct.id, opportunity_id: opp.id, score: 70, delivered_at: new Date().toISOString(), disposition: 'interested' });
  await store.update('accounts', { id: acct.id }, { billing_status: 'active', plan_id: 'starter' });
  let t = plain(await (await b.get(`/app/m/${m.id}`)).text());
  assert.match(t, /response kit is part of the Pro plan/i);
  assert.doesNotMatch(t, /Draft intro email/);
  assert.equal((await b.get(`/app/m/${m.id}/calendar.ics`)).status, 403);
  assert.equal((await b.post(`/app/m/${m.id}/action`, { action: 'won' })).status, 403);
  assert.match(plain(await (await b.get('/app/pipeline')).text()), /part of the Pro plan/);
  await store.update('accounts', { id: acct.id }, { billing_status: 'trialing' });
  t = plain(await (await b.get(`/app/m/${m.id}`)).text());
  assert.match(t, /Draft intro email/);
});

test('unsubscribe: confirm page on GET, applied on POST (also RFC 8058 one-click), instant, reversible, mail is then blocked', async () => {
  const { app, store, config } = await makeApp();
  const b = await signup(app, store, 'unsub@example.com');
  await onboard(b, {});
  const acct = await store.one('accounts', { where: { email: 'unsub@example.com' } });
  const t = signToken({ typ: 'unsub', a: acct.id }, ENV.TOKEN_SECRET, 600);
  const g = await app.fetch(new Request(`${BASE}/unsubscribe?t=${t}`));
  assert.match(plain(await g.text()), /Stop digests/);
  assert.equal((await store.one('accounts', { where: { id: acct.id } })).unsubscribed_at ?? null, null);
  const oneClick = await app.fetch(new Request(`${BASE}/unsubscribe?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
  assert.equal(oneClick.status, 200);
  assert.ok((await store.one('accounts', { where: { id: acct.id } })).unsubscribed_at);
  const { deps } = app;
  const r = await deps.mailer.send({ accountId: acct.id, to: 'unsub@example.com', subject: 'x', html: 'x', text: 'x', kind: 'digest', key: 'after-unsub' });
  assert.equal(r.status, 'unsubscribed');
  assert.equal((await app.fetch(new Request(`${BASE}/unsubscribe?t=bad`))).status, 400);
  await b.post('/app/resubscribe');
  assert.equal((await store.one('accounts', { where: { id: acct.id } })).unsubscribed_at, null);
  void config;
});

test('open pixel records the first open and always returns a GIF', async () => {
  const { app, store } = await makeApp();
  const [a] = await store.insert('accounts', { email: 'o@example.com' });
  const [d] = await store.insert('digests', { account_id: a.id, kind: 'daily', digest_key: 'k' });
  const r = await app.fetch(new Request(`${BASE}/o/${signToken({ typ: 'open', d: d.id }, ENV.TOKEN_SECRET, 600)}.gif`));
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.ok((await store.one('digests', { where: { id: d.id } })).opened_at);
  assert.ok((await store.one('accounts', { where: { id: a.id } })).last_open_at);
  const bad = await app.fetch(new Request(`${BASE}/o/garbage.gif`));
  assert.equal(bad.status, 200);
});

test('Resend bounce/complaint webhooks are verified and suppress the address', async () => {
  const { app, store } = await makeApp();
  const [a] = await store.insert('accounts', { email: 'bounce@example.com' });
  const secret = ENV.RESEND_WEBHOOK_SECRET;
  const send = (payload, { badSig = false } = {}) => {
    const raw = JSON.stringify(payload);
    const id = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
    return app.fetch(new Request(`${BASE}/webhooks/resend`, { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${badSig ? 'AAAA' : sig}` }, body: raw }));
  };
  assert.equal((await send({ type: 'email.bounced', data: { to: ['bounce@example.com'] } }, { badSig: true })).status, 400);
  assert.equal((await store.select('suppressions')).length, 0);
  assert.equal((await send({ type: 'email.bounced', data: { to: ['Bounce@example.com'], email_id: 'e1' } })).status, 200);
  assert.equal((await store.select('suppressions'))[0].reason, 'bounce');
  await send({ type: 'email.complained', data: { to: ['bounce@example.com'] } });
  assert.ok((await store.one('accounts', { where: { id: a.id } })).unsubscribed_at);
});

test('data export contains the customer data; deletion cancels billing and removes everything', async () => {
  const { app, store, fetchImpl } = await makeApp({ script: { 'api.stripe.com/v1/subscriptions/sub_1': { id: 'sub_1', status: 'canceled' }, 'api.stripe.com/v1/subscriptions': { data: [{ id: 'sub_1', status: 'active' }] } } });
  const b = await signup(app, store, 'del@example.com');
  await onboard(b, {});
  const acct = await store.one('accounts', { where: { email: 'del@example.com' } });
  await store.update('accounts', { id: acct.id }, { stripe_customer_id: 'cus_del', billing_status: 'active' });
  const [opp] = await store.insert('opportunities', { ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: 'PMT-D1', is_sample: false, fingerprint: 'd1' });
  await store.insert('matches', { account_id: acct.id, opportunity_id: opp.id, score: 70, delivered_at: new Date().toISOString() });
  const exp = await b.get('/app/export');
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  const data = JSON.parse(await exp.text());
  assert.equal(data.account.email, 'del@example.com');
  assert.equal(data.profile.license_number, '314159');
  assert.equal(data.matches.length, 1);
  assert.equal((await b.post('/app/delete', { confirm: 'nope' })).status, 400);
  const del = await b.post('/app/delete', { confirm: 'DELETE' });
  assert.equal(del.status, 303);
  assert.ok(fetchImpl.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/subscriptions/sub_1')));
  assert.equal(await store.one('accounts', { where: { id: acct.id } }), null);
  assert.equal((await store.select('profiles', { where: { account_id: acct.id } })).length, 0);
  assert.equal((await store.select('matches', { where: { account_id: acct.id } })).length, 0);
  assert.equal((await store.select('outbox', { where: { account_id: acct.id } })).length, 0);
  assert.equal(b.jar.get('bs_sess') ?? null, null);
  assert.equal(loc(await b.get('/app')).startsWith('/login'), true);
});

test('admin: sign-in needs the allowlisted email, a magic link AND a TOTP code (with replay protection)', async () => {
  const { app, store } = await makeApp();
  const b = browser(app);
  await b.post('/login', { email: 'owner@example.com', next: '/app' });
  const v = await signIn(b, store, 'owner@example.com');
  assert.equal(v.status, 303);
  assert.equal(loc(await b.get('/admin')), '/admin/2fa');
  const enrol = plain(await (await b.get('/admin/2fa')).text());
  assert.match(enrol, /Set up two-factor/);
  const row = await store.one('admin_totp', {});
  const secret = decrypt(row.secret_enc, ENV.ENC_KEY);
  assert.ok(enrol.includes(secret));
  assert.equal((await b.post('/admin/2fa', { code: '000000' })).status, 400);
  const code = hotp(secret, stepOf(Date.now()));
  assert.equal(loc(await b.post('/admin/2fa', { code })), '/admin');
  assert.equal((await b.get('/admin')).status, 200);
  assert.ok((await store.one('admin_totp', {})).confirmed_at);
  // replay in a fresh session
  const b2 = browser(app);
  await b2.post('/login', { email: 'owner@example.com', next: '/app' });
  await signIn(b2, store, 'owner@example.com');
  assert.equal((await b2.post('/admin/2fa', { code })).status, 400);
  // non-allowlisted account with admin role in the DB is still refused
  const [x] = await store.insert('accounts', { email: 'rogue@example.com', role: 'admin' });
  const rogue = browser(app);
  rogue.jar.set('bs_sess', signToken({ typ: 'sess', a: x.id, e: x.session_epoch }, ENV.SESSION_SECRET, 600));
  assert.equal((await rogue.get('/admin')).status, 404);
  // a forged admin cookie without TOTP does not work
  const forged = browser(app);
  await forged.post('/login', { email: 'owner@example.com', next: '/app' });
  await signIn(forged, store, 'owner@example.com');
  const owner = await store.one('accounts', { where: { email: 'owner@example.com' } });
  forged.jar.set('bs_adm', signToken({ typ: 'adm', a: owner.id, e: owner.session_epoch }, 'wrong-secret', 600));
  assert.equal(loc(await forged.get('/admin')), '/admin/2fa');
});

async function adminBrowser(app, store) {
  const b = browser(app);
  await b.post('/login', { email: 'owner@example.com', next: '/app' });
  await signIn(b, store, 'owner@example.com');
  await b.get('/admin/2fa');
  const secret = decrypt((await store.one('admin_totp', {})).secret_enc, ENV.ENC_KEY);
  // use the next window so earlier replay tests in other apps never collide
  const step = stepOf(Date.now());
  const res = await b.post('/admin/2fa', { code: hotp(secret, step) });
  assert.equal(res.status, 303);
  return b;
}

test('admin: all eight screens render and every change is written to the audit log', async () => {
  const { app, store } = await makeApp();
  const b = await adminBrowser(app, store);
  await signup(app, store, 'shown@example.com');
  for (const p of ['/admin', '/admin/customers', '/admin/opportunities', '/admin/sources', '/admin/rules', '/admin/deliverability', '/admin/pricing', '/admin/audit']) {
    const r = await b.get(p);
    assert.equal(r.status, 200, p);
  }
  const ov = plain(await (await b.get('/admin')).text());
  assert.match(ov, /MRR/);
  assert.match(ov, /Customer sign-up is OPEN/);
  const cust = await store.one('accounts', { where: { email: 'shown@example.com' } });
  assert.equal(loc(await b.post(`/admin/customers/${cust.id}/pause`)).startsWith(`/admin/customers/${cust.id}`), true);
  assert.equal((await store.one('accounts', { where: { id: cust.id } })).digest_paused, true);
  await b.post(`/admin/customers/${cust.id}/resume`);
  assert.equal((await store.one('accounts', { where: { id: cust.id } })).digest_paused, false);
  const actions = (await store.select('audit_log')).map((x) => x.action);
  assert.ok(actions.includes('customer.pause') && actions.includes('customer.resume') && actions.includes('admin.2fa_enrolled'));
  assert.ok((await store.select('audit_log')).every((x) => x.actor));
});

test('admin: prices are capped at $50, editable, create a fresh Stripe price; rules must sum to 100; sources need reviewed terms', async () => {
  const { app, store, fetchImpl } = await makeApp({ script: STRIPE_SCRIPT });
  const b = await adminBrowser(app, store);
  await store.update('plans', { id: 'pro' }, { stripe_price_id: 'price_old' });
  const over = await b.post('/admin/pricing/pro', { price: '50.01', trial_days: '14', trade_group_limit: '3', area_limit: '2', active: '1' });
  assert.equal(over.status, 400);
  assert.equal((await store.one('plans', { where: { id: 'pro' } })).price_cents, 4900);
  assert.equal((await b.post('/admin/pricing/pro', { price: '0', trial_days: '14', trade_group_limit: '3', area_limit: '2' })).status, 400);
  assert.equal(loc(await b.post('/admin/pricing/pro', { price: '39', trial_days: '7', trade_group_limit: '3', area_limit: '2', active: '1' })), '/admin/pricing?ok=Saved.');
  const pro = await store.one('plans', { where: { id: 'pro' } });
  assert.deepEqual([pro.price_cents, pro.trial_days, pro.stripe_price_id], [3900, 7, null]);
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/prices/price_old')));

  const bad = await b.post('/admin/rules', { w_fit: '50', w_timing: '25', w_scale: '15', w_access: '15', w_evidence: '15', deliver_min: '50', max_items: '5', freshness_days: '45' });
  assert.equal(bad.status, 400);
  assert.equal((await b.post('/admin/rules', { w_fit: '40', w_timing: '20', w_scale: '15', w_access: '15', w_evidence: '10', deliver_min: '55', max_items: '9', freshness_days: '45' })).status, 400);
  assert.equal(loc(await b.post('/admin/rules', { w_fit: '40', w_timing: '20', w_scale: '15', w_access: '15', w_evidence: '10', deliver_min: '55', max_items: '4', freshness_days: '30' })), '/admin/rules?ok=Saved.');
  assert.equal((await store.one('settings', { where: { key: 'thresholds' } })).value.max_items, 4);

  assert.equal((await b.post('/admin/sources/mesa_permits/enable')).status, 400);
  await b.post('/admin/sources/mesa_permits/review', { notes: 'Read Socrata terms; commercial use allowed.' });
  assert.equal(loc(await b.post('/admin/sources/mesa_permits/enable')).startsWith('/admin/sources'), true);
  const cfg = await store.one('source_config', { where: { source: 'mesa_permits' } });
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.terms_reviewed_at);
  await b.post('/admin/sources/mesa_permits/disable');
  assert.equal((await store.one('source_config', { where: { source: 'mesa_permits' } })).enabled, false);
});

test('admin: add an opportunity manually (needs an official link), hide it, and it flows into matching', async () => {
  const { app, store } = await makeApp();
  const b = await adminBrowser(app, store);
  assert.equal((await b.post('/admin/opportunities/add', { title: 'Concrete repair', kind: 'public_bid', jurisdiction: 'mesa', url: 'not a url' })).status, 400);
  assert.equal(loc(await b.post('/admin/opportunities/add', { title: 'Sidewalk concrete repair', kind: 'public_bid', agency: 'City of Mesa', jurisdiction: 'mesa', deadline: '2026-11-20T14:00', value: '85000', url: 'https://www.mesaaz.gov/bids/123', scope: 'Remove and replace concrete sidewalk and curb ramps' })), '/admin/opportunities?ok=Added.');
  const o = await store.one('opportunities', { where: { source: 'manual' } });
  assert.equal(o.kind, 'public_bid');
  assert.equal(o.deadline, '2026-11-20T21:00:00.000Z'); // 14:00 Arizona time = 21:00 UTC
  assert.ok(o.fingerprint);
  await b.post(`/admin/opportunities/${o.id}/hide`);
  assert.equal((await store.one('opportunities', { where: { id: o.id } })).status, 'hidden');
});

test('cron endpoints need the secret, run the jobs, and are idempotent', async () => {
  const { app, store } = await makeApp();
  const call = (job, auth) => app.fetch(new Request(`${BASE}/api/cron/${job}`, { headers: auth ? { authorization: auth } : {} }));
  assert.equal((await call('ingest')).status, 404);
  assert.equal((await call('ingest', 'Bearer wrong')).status, 404);
  for (const j of ['ingest', 'digest', 'housekeeping']) {
    const r = await call(j, `Bearer ${ENV.CRON_SECRET}`);
    assert.equal(r.status, 200, j);
    assert.equal((await r.json()).ok, true);
  }
  assert.equal((await call('bogus', `Bearer ${ENV.CRON_SECRET}`)).status, 404);
  assert.ok((await store.select('outbox', { where: { kind: 'admin_alert' } })).length >= 1); // daily owner summary
});

test('health endpoint reports mode without leaking secrets; diag is off unless a token is configured', async () => {
  const { app } = await makeApp();
  const h = await (await app.fetch(new Request(BASE + '/health'))).text();
  assert.match(h, /"signup_open":true/);
  for (const v of Object.values(ENV)) if (v.length > 8) assert.ok(!h.includes(v));
  assert.equal((await app.fetch(new Request(BASE + '/diag/sources?token=x'))).status, 404);
  const d = await makeApp({ env: { DIAG_TOKEN: 'diag-token-xyz' }, script: { 'data.mesaaz.gov': [{ permit_number: 'P1', type_of_work: 'New', description_of_work: 'x', property_address: '1 A St' }], 'maps.phoenix.gov': { features: [] } } });
  assert.equal((await d.app.fetch(new Request(BASE + '/diag/sources?token=nope'))).status, 404);
  const ok = await d.app.fetch(new Request(BASE + '/diag/sources?token=diag-token-xyz'));
  const j = await ok.json();
  assert.equal(j.mesa_permits.raw, 1);
  assert.equal(j.phoenix_permits.raw, 0);
  assert.equal(j.sam_gov.skipped, 'no api key');
});

test('robots and sitemap keep private areas out of search', async () => {
  const { app } = await makeApp();
  const robots = await (await app.fetch(new Request(BASE + '/robots.txt'))).text();
  for (const p of ['/app', '/admin', '/t/', '/o/', '/auth/']) assert.match(robots, new RegExp(`Disallow: ${p}`));
  const map = await (await app.fetch(new Request(BASE + '/sitemap.xml'))).text();
  assert.match(map, /\/demo/);
  assert.doesNotMatch(map, /\/admin|\/app/);
});
