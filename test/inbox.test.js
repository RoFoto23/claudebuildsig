import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxWorld, customer, webhook, received, message, T0 } from './helpers-inbox.js';
import { newLocalPart, issueAddress, resolveAccount, toPlainText, htmlToText, classify, sweep, processMessage, expireMessages, deleteAccountInbox, MAX_ATTEMPTS } from '../src/inbox.js';
import { runDigest } from '../src/jobs.js';

const emailsFor = (w, accountId) => w.store.select('inbound_messages', { where: { account_id: accountId } });

test('addresses: 130-bit random local part, unique, and issuing a new one revokes the old', async () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) { const l = newLocalPart(); assert.match(l, /^alerts-[a-z2-7]{26}$/); seen.add(l); }
  assert.equal(seen.size, 300);
  const w = await inboxWorld();
  const c = await customer(w);
  assert.ok((await resolveAccount(w.store, w.config, [c.address]))?.accountId === c.account.id);
  assert.ok(await resolveAccount(w.store, w.config, [`Dana <${c.address.toUpperCase()}>`]), 'display names and case are tolerated');
  assert.equal(await resolveAccount(w.store, w.config, [c.address.replace('@in.t.example', '@evil.example')]), null, 'wrong domain');
  assert.equal(await resolveAccount(w.store, w.config, ['alerts-aaaaaaaaaaaaaaaaaaaaaaaaaa@in.t.example']), null, 'guess');
  const next = await issueAddress(w.store, w.config, c.account.id, w.now());
  assert.notEqual(next.address, c.address);
  assert.equal(await resolveAccount(w.store, w.config, [c.address]), null, 'old address stops working');
  assert.ok(await resolveAccount(w.store, w.config, [next.address]));
});

test('webhook: bad signature is rejected; disabled inbox and unknown address answer 200 and store nothing', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  assert.equal((await webhook(w, received('em_1', c.address), { badSig: true })).status, 400);
  const unknown = await webhook(w, received('em_2', 'alerts-zzzzzzzzzzzzzzzzzzzzzzzzzz@in.t.example'));
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).result, 'unknown_address');
  assert.equal((await w.store.select('inbound_messages')).length, 0);
  await w.store.update('settings', { key: 'inbox.enabled' }, { value: false });
  const off = await webhook(w, received('em_3', c.address));
  assert.equal((await off.json()).result, 'disabled');
  assert.equal((await w.store.select('inbound_messages')).length, 0);
  assert.equal(w.fetchImpl.calls.filter((x) => x.url.includes('/receiving/')).length, 0, 'nothing fetched when rejected');
});

test('webhook: a real alert is fetched with the bearer key, parsed, and becomes a private opportunity', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.em_1 = message();
  const res = await webhook(w, received('em_1', c.address));
  assert.equal(res.status, 200);
  const call = w.fetchImpl.calls.find((x) => x.url.includes('/receiving/em_1'));
  assert.match(call.url, /html_format=cid/);
  assert.equal(call.headers.authorization, 'Bearer test-resend');
  const [m] = await emailsFor(w, c.account.id);
  assert.equal(m.status, 'parsed');
  assert.equal(m.parse_method, 'rules');
  assert.equal(m.from_domain, 'gmail.com');
  assert.deepEqual(m.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  assert.equal(m.opportunity_ids.length, 1);
  const opp = await w.store.one('opportunities', { where: { id: m.opportunity_ids[0] } });
  assert.equal(opp.owner_account_id, c.account.id);
  assert.equal(opp.source, 'forwarded');
  assert.equal(opp.kind, 'public_bid');
  assert.equal(opp.title, 'Roof Replacement - City of Mesa Fire Station 205');
  assert.equal(opp.jurisdiction, 'mesa');
  assert.equal(opp.deadline, '2026-10-27T14:00:00-07:00');
  assert.equal(opp.url, 'https://www.bidnetdirect.com/arizona/mesa/solicitations/123');
  assert.equal(opp.provenance.deadline.quote, 'October 27, 2026 at 2:00 PM MST');
});

test('webhook: the same delivery twice creates one message and fetches once', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.em_1 = message();
  await webhook(w, received('em_1', c.address));
  const again = await webhook(w, received('em_1', c.address));
  assert.equal((await again.json()).result, 'duplicate');
  assert.equal((await emailsFor(w, c.account.id)).length, 1);
  assert.equal(w.fetchImpl.calls.filter((x) => x.url.includes('/receiving/')).length, 1);
});

test('webhook: per-account daily limit and inactive accounts are refused without storing anything', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  await w.store.update('settings', { key: 'inbox.daily_limit' }, { value: 2 });
  for (const id of ['a1', 'a2']) { w.received[id] = message(); assert.equal((await (await webhook(w, received(id, c.address))).json()).result, 'accepted'); }
  w.received.a3 = message();
  assert.equal((await (await webhook(w, received('a3', c.address))).json()).result, 'daily_limit');
  assert.equal((await emailsFor(w, c.account.id)).length, 2);
  const lapsed = await customer(w, { email: 'old@example.com', billing: 'canceled' });
  assert.equal((await (await webhook(w, received('b1', lapsed.address))).json()).result, 'inactive_account');
});

test('retry: a failed fetch backs off, the sweeper retries when due, and the 5th failure is final with an owner alert', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.em_1 = new Response('boom', { status: 503 });
  await webhook(w, received('em_1', c.address));
  let [m] = await emailsFor(w, c.account.id);
  assert.equal(m.status, 'received');
  assert.equal(m.attempts, 1);
  assert.ok(m.next_attempt_at > T0.toISOString());
  assert.match(m.error, /fetch_503/);
  const early = await sweep(w.deps());
  assert.equal(early.picked, 0, 'not due yet');
  // provider recovers
  w.received.em_1 = message();
  w.advance(6 * 60000);
  const ok = await sweep(w.deps());
  assert.equal(ok.picked, 1);
  assert.equal(ok.parsed, 1);
  [m] = await emailsFor(w, c.account.id);
  assert.equal(m.status, 'parsed');

  // permanent failure path
  w.received.em_2 = new Response('nope', { status: 500 });
  await webhook(w, received('em_2', c.address), { id: 'msg_2' });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { w.advance(11 * 3600000); await sweep(w.deps()); }
  const failed = (await emailsFor(w, c.account.id)).find((x) => x.provider_email_id === 'em_2');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, MAX_ATTEMPTS);
  const alerts = await w.store.select('outbox', { where: { kind: 'admin_alert' } });
  assert.ok(alerts.some((a) => /failed 5 times/.test(a.subject)));
});

test('a message already being processed is leased: a concurrent sweep does not process it twice', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const [row] = await w.store.insert('inbound_messages', { account_id: c.account.id, provider_email_id: 'em_lease', received_at: new Date(T0.getTime() - 3600000).toISOString() });
  w.received.em_lease = message();
  await w.store.update('inbound_messages', { id: row.id }, { next_attempt_at: new Date(T0.getTime() + 5 * 60000).toISOString() });
  assert.equal((await sweep(w.deps())).picked, 0);
  w.advance(6 * 60000);
  assert.equal((await sweep(w.deps())).picked, 1);
});

test('Gmail forwarding confirmation is recognised, shows its code, and creates no opportunity', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.em_g = message({ from: 'Gmail Team <forwarding-noreply@google.com>', subject: 'Gmail Forwarding Confirmation - Receive Mail from owner@gmail.com', text: 'owner@gmail.com has requested to automatically forward mail to your email address.\nConfirmation code: 123456789\nTo allow the forwarding, click the link below.' });
  await webhook(w, received('em_g', c.address, { subject: 'Gmail Forwarding Confirmation - Receive Mail from owner@gmail.com' }));
  const [m] = await emailsFor(w, c.account.id);
  assert.equal(m.kind, 'forward_confirmation');
  assert.equal(m.confirmation_code, '123456789');
  assert.equal(m.status, 'parsed');
  assert.equal((await w.store.select('opportunities', { where: { owner_account_id: c.account.id } })).length, 0);
});

test('an unreadable forward is held (never invented) and an auto-reply is dropped', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.em_h = message({ subject: 'Fwd: see below', text: 'Take a look at this when you get a chance, thanks for the help with the other thing yesterday afternoon.' });
  w.received.em_o = message({ subject: 'Automatic reply: Out of office', text: 'I am out of the office until Monday and will reply when I return to work.' });
  await webhook(w, received('em_h', c.address, { subject: 'Fwd: see below' }));
  await webhook(w, received('em_o', c.address, { subject: 'Automatic reply: Out of office' }), { id: 'msg_2' });
  const rows = await emailsFor(w, c.account.id);
  assert.equal(rows.find((r) => r.provider_email_id === 'em_h').status, 'held');
  assert.equal(rows.find((r) => r.provider_email_id === 'em_o').status, 'dropped');
  assert.equal((await w.store.select('opportunities', { where: { owner_account_id: c.account.id } })).length, 0);
});

test('re-forwarding the same alert does not make a second item or a false new version; a moved deadline does make version 2', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.e1 = message();
  w.received.e2 = message({ text: 'FW: forwarded again\nAgency: City of Mesa\nBid No. IFB 26-045\nBids due October 27, 2026 at 2:00 PM MST\nhttps://click.example.test/track?u=999\nhttps://www.bidnetdirect.com/arizona/mesa/solicitations/123' });
  await webhook(w, received('e1', c.address));
  await webhook(w, received('e2', c.address), { id: 'msg_2' });
  let opps = await w.store.select('opportunities', { where: { owner_account_id: c.account.id } });
  assert.equal(opps.length, 1);
  assert.equal(opps[0].version, 1);
  w.received.e3 = message({ subject: 'Fwd: Addendum 1 - Bid: Roof Replacement - City of Mesa Fire Station 205', text: 'Agency: City of Mesa\nBid No. IFB 26-045\nBids due November 10, 2026 at 2:00 PM MST (extended)\nhttps://www.bidnetdirect.com/arizona/mesa/solicitations/123' });
  await webhook(w, received('e3', c.address, { subject: 'Fwd: Addendum 1' }), { id: 'msg_3' });
  opps = await w.store.select('opportunities', { where: { owner_account_id: c.account.id } });
  assert.equal(opps.length, 1, 'same solicitation number = same item');
  assert.equal(opps[0].version, 2);
  assert.equal(opps[0].deadline, '2026-11-10T14:00:00-07:00');
  assert.equal((await w.store.select('opportunity_versions', { where: { opportunity_id: opps[0].id } })).length, 2);
});

test('the same bid from two senders merges and records where else it was seen', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.s1 = message({ subject: 'Fwd: Bid: Parking Lot Repaving, City of Mesa', text: 'Parking Lot Repaving, City of Mesa\nAgency: City of Mesa\nBid due Nov 12, 2026\nhttps://www.bidnetdirect.com/arizona/mesa/p1' });
  w.received.s2 = message({ from: 'alerts@planhub.com', subject: 'Fwd: Bid: Parking Lot Repaving - City of Mesa', text: 'Parking Lot Repaving - City of Mesa\nDue: November 12, 2026\nhttps://app.planhub.com/p/77' });
  await webhook(w, received('s1', c.address));
  await webhook(w, received('s2', c.address, { from: 'alerts@planhub.com' }), { id: 'msg_2' });
  const opps = await w.store.select('opportunities', { where: { owner_account_id: c.account.id } });
  assert.equal(opps.length, 1);
  assert.deepEqual(opps[0].also_seen_via, ['planhub.com']);
});

test('html-only mail is converted to text with links kept; invisible and bidi characters are removed', () => {
  const t = toPlainText('', '<html><head><style>.x{}</style></head><body><p>Fence Repair &amp; Gate</p><p>Bids due <b>Nov 3, 2026</b></p><a href="https://app.az.gov/bid/9">View bid</a><script>alert(1)</script><!-- hidden --></body></html>');
  assert.match(t, /Fence Repair & Gate/);
  assert.match(t, /View bid \(https:\/\/app\.az\.gov\/bid\/9\)/);
  assert.doesNotMatch(t, /alert|hidden|\.x/);
  assert.equal(toPlainText('Pay‮evil​now  text here that is long enough to count'), 'Payevilnow text here that is long enough to count');
  assert.equal(toPlainText('x'.repeat(50), '', 10).length, 10);
  assert.doesNotMatch(htmlToText('<a href="javascript:alert(1)">click</a>'), /javascript/);
});

test('classify: confirmation, auto-reply, empty and normal mail', () => {
  assert.equal(classify('Gmail Forwarding Confirmation - Receive Mail', 'google.com', 'Confirmation code: 123456789').kind, 'forward_confirmation');
  assert.equal(classify('Out of office', 'x.com', 'I am away until Monday, back soon, thanks for writing to me').kind, 'ignored');
  assert.equal(classify('Bid', 'x.com', 'hi').kind, 'ignored');
  assert.equal(classify('Bid: Roof', 'x.com', 'Bids due Nov 3, 2026 and more words here to pass').kind, 'alert');
});

test('retention: content is blanked 30 days after receipt; the row stays as a count', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.e1 = message();
  await webhook(w, received('e1', c.address));
  assert.equal(await expireMessages(w.store, new Date(T0.getTime() + 29 * 86400000)), 0);
  assert.equal(await expireMessages(w.store, new Date(T0.getTime() + 31 * 86400000)), 1);
  const [m] = await emailsFor(w, c.account.id);
  assert.equal(m.status, 'expired');
  assert.equal(m.body_text, null);
  assert.equal(m.subject, null);
});

test('deleting an account removes its addresses, messages, items and matches but keeps anonymous spend history', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.e1 = message();
  await webhook(w, received('e1', c.address));
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  assert.ok((await w.store.select('matches', { where: { account_id: c.account.id } })).length >= 1);
  await w.store.insert('llm_calls', { account_id: c.account.id, provider: 'gemini', model: 'm', cost_usd: 0.002, outcome: 'ok' });
  const r = await deleteAccountInbox(w.store, c.account.id);
  assert.equal(r.opportunities, 1);
  assert.equal((await w.store.select('opportunities', { where: { owner_account_id: c.account.id } })).length, 0);
  assert.equal((await emailsFor(w, c.account.id)).length, 0);
  assert.equal((await w.store.select('inbox_addresses', { where: { account_id: c.account.id } })).length, 0);
  assert.equal((await w.store.select('matches', { where: { account_id: c.account.id } })).length, 0);
  const calls = await w.store.select('llm_calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].account_id, null);
});

test('processMessage never throws and leaves terminal rows alone', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  const [row] = await w.store.insert('inbound_messages', { account_id: c.account.id, provider_email_id: 'em_t', status: 'parsed' });
  assert.equal(await processMessage(w.deps(), row), 'parsed');
});
