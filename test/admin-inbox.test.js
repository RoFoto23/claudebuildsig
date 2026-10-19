import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, loc, plain, signIn, ENV } from './helpers.js';
import { inboxWorld, customer, webhook, received, message, T0 } from './helpers-inbox.js';
import { decrypt } from '../src/crypto.js';
import { hotp, stepOf } from '../src/totp.js';
import { releaseHeld, rejectHeld, retryMessage } from '../src/inbox.js';

async function adminOf(w) {
  const b = browser(w.app);
  await b.post('/login', { email: 'owner@example.com', next: '/app' });
  await signIn(b, w.store, 'owner@example.com');
  await b.get('/admin/2fa');
  const secret = decrypt((await w.store.one('admin_totp', {})).secret_enc, ENV.ENC_KEY);
  const res = await b.post('/admin/2fa', { code: hotp(secret, stepOf(w.now().getTime())) });
  assert.equal(res.status, 303);
  return b;
}

async function holdOne(w, c, id = 'em_h') {
  w.received[id] = message({ subject: 'Fwd: see below', text: 'Take a look at this when you get a chance, thanks for the help with the other thing yesterday afternoon.' });
  await webhook(w, received(id, c.address, { subject: 'Fwd: see below' }), { id: `m_${id}` });
  const row = await w.store.one('inbound_messages', { where: { provider_email_id: id } });
  assert.equal(row.status, 'held');
  return row;
}

test('review queue: staff release adds a private item marked as staff-entered, with only the fields typed in', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const row = await holdOne(w, c);
  const admin = await adminOf(w);
  const page = plain(await (await admin.get('/admin/review')).text());
  assert.match(page, /Needs review \(1\)/);
  assert.match(page, /see below/);
  const bad = await admin.post(`/admin/review/${row.id}/release`, { title: 'ab' });
  assert.equal(bad.status, 400);
  const ok = await admin.post(`/admin/review/${row.id}/release`, { title: 'Roof repair at Fire Station 7', agency: 'City of Mesa', deadline: '2026-11-03T14:00', url: 'https://example.gov/bid/7', value: '$25,000' });
  assert.equal(ok.status, 303);
  const after = await w.store.one('inbound_messages', { where: { id: row.id } });
  assert.equal(after.status, 'parsed');
  assert.equal(after.opportunity_ids.length, 1);
  const opp = await w.store.one('opportunities', { where: { id: after.opportunity_ids[0] } });
  assert.equal(opp.owner_account_id, c.account.id);
  assert.equal(new Date(opp.deadline).toISOString(), '2026-11-03T21:00:00.000Z'); // 2 PM Arizona = 21:00 UTC
  assert.equal(opp.value, 25000);
  assert.equal(opp.provenance.deadline.source, 'staff');
  assert.equal(opp.provenance.title.source, 'staff');
  assert.equal(opp.jurisdiction, 'mesa');
  assert.ok((await w.store.select('audit_log')).some((a) => a.action === 'inbox.release' && a.target === row.id));
  // a second release of the same message is refused
  assert.equal((await admin.post(`/admin/review/${row.id}/release`, { title: 'Roof repair again' })).status, 400);
});

test('review queue: release validates every field and never invents one', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const row = await holdOne(w, c);
  const deps = { store: w.store, now: w.now() };
  assert.equal((await releaseHeld(deps, row.id, { title: 'Valid title here', deadline: 'next friday' })).ok, false);
  assert.equal((await releaseHeld(deps, row.id, { title: 'Valid title here', deadline: '2026-02-30T10:00' })).ok, false);
  assert.equal((await releaseHeld(deps, row.id, { title: 'Valid title here', url: 'javascript:alert(1)' })).ok, false);
  assert.equal((await releaseHeld(deps, row.id, { title: 'Valid title here', value: 'lots' })).ok, false);
  assert.equal((await w.store.select('opportunities', { where: { owner_account_id: c.account.id } })).length, 0);
  const r = await releaseHeld(deps, row.id, { title: 'Valid title here' });
  assert.equal(r.ok, true);
  const opp = await w.store.one('opportunities', { where: { id: r.ids[0] } });
  assert.equal(opp.deadline, null);
  assert.equal(opp.value, null);
  assert.equal(opp.url, null);
});

test('review queue: reject drops, retry requeues a failed message, only admins can see the queue', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const row = await holdOne(w, c);
  assert.equal(await rejectHeld(w.store, row.id), true);
  assert.equal((await w.store.one('inbound_messages', { where: { id: row.id } })).status, 'dropped');
  assert.equal(await rejectHeld(w.store, row.id), false);
  const [f] = await w.store.insert('inbound_messages', { account_id: c.account.id, provider_email_id: 'em_f', status: 'failed', attempts: 5, error: 'boom' });
  assert.equal(await retryMessage(w.store, f.id), true);
  const again = await w.store.one('inbound_messages', { where: { id: f.id } });
  assert.equal(again.status, 'received');
  assert.equal(again.attempts, 0);
  assert.equal(await retryMessage(w.store, row.id), false); // dropped messages are not retried
  const anon = browser(w.app);
  assert.equal((await anon.get('/admin/review')).status, 404);
  assert.equal((await anon.post(`/admin/review/${row.id}/release`, { title: 'Sneaky title' })).status, 404);
  const cust = browser(w.app);
  await cust.post('/login', { email: c.account.email, next: '/app' });
  await signIn(cust, w.store, c.account.email);
  assert.equal((await cust.get('/admin/review')).status, 404);
  assert.equal((await cust.post('/admin/inbox/settings', {})).status, 404);
});

test('a staff-released item reaches the digest with the staff note and no quoted deadline', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const row = await holdOne(w, c);
  const r = await releaseHeld({ store: w.store, now: w.now() }, row.id, { title: 'Roof replacement, Fire Station 7', agency: 'City of Mesa', deadline: '2026-11-03T14:00', url: 'https://example.gov/bid/7' });
  const opp = await w.store.one('opportunities', { where: { id: r.ids[0] } });
  const { forwardedLine } = await import('../src/html.js');
  const line = forwardedLine(opp);
  assert.match(line, /staff typed in the details/);
  assert.doesNotMatch(line, /Deadline as written/);
});

test('inbox settings: saved, validated and audited; an empty cap or price removes the row so the AI stays off', async () => {
  const w = await inboxWorld();
  const admin = await adminOf(w);
  const card = plain(await (await admin.get('/admin/sources')).text());
  assert.match(card, /Forwarded-alert inbox/);
  assert.match(card, /AI fallback: off/);
  for (const bad of [{ daily_limit: '0' }, { daily_limit: '2.5' }, { parse_threshold: '0' }, { parse_threshold: '1.5' }, { cap: '-1' }, { price_in: 'abc' }]) {
    const res = await admin.post('/admin/inbox/settings', { inbox_enabled: '1', daily_limit: '40', parse_threshold: '0.6', ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const res = await admin.post('/admin/inbox/settings', { inbox_enabled: '1', daily_limit: '25', parse_threshold: '0.7', llm_enabled: '1', cap: '5', price_in: '0.1', price_out: '0.4' });
  assert.equal(res.status, 303);
  const get = async (key) => (await w.store.one('settings', { where: { key } }))?.value;
  assert.equal(await get('inbox.daily_limit'), 25);
  assert.equal(await get('inbox.parse_threshold'), 0.7);
  assert.equal(await get('llm.monthly_cap_usd'), 5);
  assert.equal(await get('llm.price_in_per_m'), 0.1);
  assert.equal(await get('llm.enabled'), true);
  assert.ok((await w.store.select('audit_log')).some((a) => a.action === 'inbox.settings'));
  // clearing the cap and prices removes them, and turning the switch off is honoured
  await admin.post('/admin/inbox/settings', { daily_limit: '25', parse_threshold: '0.7', cap: '', price_in: '', price_out: '' });
  assert.equal(await get('llm.monthly_cap_usd'), undefined);
  assert.equal(await get('llm.price_in_per_m'), undefined);
  assert.equal(await get('inbox.enabled'), false);
  assert.equal(await get('llm.enabled'), false);
  const page = plain(await (await admin.get('/admin/sources')).text());
  assert.match(page, /AI fallback: off/);
});

test('customer inbox page: disabled message, address, replacing the address, confirmation code, no leakage between accounts', async () => {
  const off = await inboxWorld({ enabled: false });
  const c0 = await customer(off);
  const b0 = browser(off.app);
  await b0.post('/login', { email: c0.account.email, next: '/app' });
  await signIn(b0, off.store, c0.account.email);
  const p0 = plain(await (await b0.get('/app/inbox')).text());
  assert.match(p0, /not available yet/);
  assert.ok(!p0.includes(c0.address));
  assert.equal((await b0.post('/app/inbox/new-address')).status, 404);

  const w = await inboxWorld();
  const a = await customer(w, { email: 'a@example.com' });
  const other = await customer(w, { email: 'b@example.com' });
  w.received.gc = message({ subject: 'Gmail Forwarding Confirmation - Receive Mail from a@gmail.com', text: 'a@gmail.com has requested to automatically forward mail to your email address. Confirmation code: 123456\n\nTo allow a@gmail.com to automatically forward mail to your address, please click the link below to confirm the request.' });
  w.received.sec = message({ subject: 'Fwd: Secret job for B only', text: 'Agency: City of Mesa\nBid No. IFB 99-001\nBids due November 5, 2026 at 2:00 PM MST\nhttps://example.gov/b-only' });
  await webhook(w, received('gc', a.address, { subject: 'Gmail Forwarding Confirmation - Receive Mail from a@gmail.com' }), { id: 'g1' });
  await webhook(w, received('sec', other.address, { subject: 'Fwd: Secret job for B only' }), { id: 'g2' });
  const b = browser(w.app);
  await b.post('/login', { email: 'a@example.com', next: '/app' });
  await signIn(b, w.store, 'a@example.com');
  const page = plain(await (await b.get('/app/inbox')).text());
  assert.ok(page.includes(a.address));
  assert.ok(!page.includes(other.address));
  assert.ok(!page.includes('Secret job for B only'));
  assert.match(page, /Gmail confirmation code/);
  assert.match(page, /123456/);
  const dash = plain(await (await b.get('/app')).text());
  assert.match(dash, /Forward/i);
  const r = await b.post('/app/inbox/new-address');
  assert.equal(loc(r), '/app/inbox');
  const after = plain(await (await b.get('/app/inbox')).text());
  assert.ok(!after.includes(a.address));
  // the old address now bounces to nowhere
  w.received.old = message();
  const res = await (await webhook(w, received('old', a.address), { id: 'g3' })).json();
  assert.notEqual(res.result, 'accepted');
});
