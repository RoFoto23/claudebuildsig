import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxWorld, customer, webhook, received, message, T0 } from './helpers-inbox.js';
import { browser, signIn, BASE, plain } from './helpers.js';
import { runDigest, runHousekeeping } from '../src/jobs.js';
import { upsertOpportunities } from '../src/ingest.js';
import { SAMPLE_OPPS } from '../src/sample.js';

const DAY = 86400000;

async function twoRoofers() {
  const w = await inboxWorld();
  const a = await customer(w, { email: 'a@example.com' });
  const b = await customer(w, { email: 'b@example.com' });
  w.received.f1 = message();
  await webhook(w, received('f1', a.address));
  return { w, a, b };
}

test('isolation: a forwarded bid is evaluated for the forwarding account only', async () => {
  const { w, a, b } = await twoRoofers();
  const stats = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  assert.equal(stats.failed, 0);
  assert.equal((await w.store.select('matches', { where: { account_id: a.account.id } })).length, 1);
  assert.equal((await w.store.select('matches', { where: { account_id: b.account.id } })).length, 0, 'B never sees A\'s forwarded bid');
  const mailA = (await w.store.select('outbox', { where: { to_email: 'a@example.com', kind: 'digest' } }))[0];
  const mailB = (await w.store.select('outbox', { where: { to_email: 'b@example.com', kind: 'digest' } }))[0];
  assert.match(mailA.html, /Roof Replacement/);
  assert.doesNotMatch(mailB.html, /Roof Replacement|Fire Station/);
});

test('isolation: shared public items still reach everyone, and forwarded ones do not displace them', async () => {
  const { w, a, b } = await twoRoofers();
  await upsertOpportunities(w.store, [{ ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: 'PMT-ISO', is_sample: false, title: 'New roof for warehouse building', scope: 'roofing re-roof of warehouse', kind: 'permit_lead', stage: 'issued', issued_date: '2026-10-08', jurisdiction: 'mesa', fingerprint: 'iso-1', tags: [], version: 1, status: 'active' }], T0);
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  const titles = async (acc) => (await w.store.select('matches', { where: { account_id: acc.account.id } })).length;
  assert.ok((await titles(a)) >= 1);
  assert.ok((await titles(b)) >= 1);
  const opp = await w.store.one('opportunities', { where: { source_id: 'PMT-ISO' } });
  assert.equal(opp.owner_account_id, null);
});

test('isolation: another signed-in account cannot open someone else\'s match, kit or pipeline entry', async () => {
  const { w, a } = await twoRoofers();
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  const match = (await w.store.select('matches', { where: { account_id: a.account.id } }))[0];
  // B signs up through the real flow and gets a session
  const b = browser(w.app);
  assert.equal((await b.post('/signup', { email: 'intruder@example.com', plan: 'pro', consent: '1' })).status, 303);
  assert.equal((await signIn(b, w.store, 'intruder@example.com')).status, 303);
  for (const path of [`/app/m/${match.id}`, `/app/m/${match.id}/capability`, `/app/m/${match.id}/calendar.ics`]) {
    const r = await b.get(path);
    assert.equal(r.status, 404, `${path} -> ${r.status}`);
  }
  const dash = plain(await (await b.get('/app')).text());
  assert.doesNotMatch(dash, /Roof Replacement|Fire Station/);
  const post = await b.post(`/app/m/${match.id}/disposition`, { disposition: 'interested' });
  assert.notEqual(post.status, 200);
  assert.equal((await w.store.one('matches', { where: { id: match.id } })).disposition ?? null, null, 'B cannot change A\'s match');
});

test('isolation: the admin opportunity list and the public pages never show forwarded content', async () => {
  const { w } = await twoRoofers();
  const pub = browser(w.app);
  for (const p of ['/', '/demo', '/pricing']) assert.doesNotMatch(plain(await (await pub.get(p)).text()), /Fire Station 205/);
  const adminOpps = await w.store.select('opportunities', { where: { owner_account_id: { isnull: true } } });
  assert.ok(!adminOpps.some((o) => /Fire Station/.test(o.title)));
});

test('forwarded bid with no recognised city is kept but its territory is marked unconfirmed', async () => {
  const w = await inboxWorld();
  const a = await customer(w, { jurisdictions: ['mesa'] });
  w.received.n1 = message({ subject: 'Fwd: Bid: Roof Replacement - County Annex', text: 'Bids due October 30, 2026\nhttps://www.bidnetdirect.com/arizona/x/9' });
  await webhook(w, received('n1', a.address));
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  const [m] = await w.store.select('matches', { where: { account_id: a.account.id } });
  assert.ok(m, 'delivered');
  const terr = m.checklist.find((c) => c.key === 'territory');
  assert.equal(terr.status, 'yellow');
  assert.match(terr.reason, /does not name a city/);
  const ev = m.factors.find((f) => f.key === 'evidence');
  assert.match(ev.note, /forwarded/);
});

test('a known city outside the customer\'s service area is not delivered', async () => {
  const w = await inboxWorld();
  const a = await customer(w, { jurisdictions: ['phoenix'] });
  w.received.n2 = message();
  await webhook(w, received('n2', a.address));
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: T0 });
  assert.equal((await w.store.select('matches', { where: { account_id: a.account.id } })).length, 0);
});

test('housekeeping: forwarded bids close the day after their deadline, not after 14 idle days; public items still close on the old rule', async () => {
  const { w, a } = await twoRoofers();
  w.received.far = message({ subject: 'Fwd: Bid: Roof Recoat - City of Mesa Library', text: 'Agency: City of Mesa\nBid No. IFB 26-099\nBids due December 15, 2026\nhttps://www.bidnetdirect.com/arizona/mesa/lib' });
  await webhook(w, received('far', a.address), { id: 'msg_far' });
  const near = await w.store.one('opportunities', { where: { owner_account_id: a.account.id, source_id: { like: 'fw:*' }, title: 'Roof Replacement - City of Mesa Fire Station 205' } });
  const far = await w.store.one('opportunities', { where: { owner_account_id: a.account.id, title: 'Roof Recoat - City of Mesa Library' } });
  assert.ok(near && far);
  const deps = (d) => ({ config: w.config, store: w.store, mailer: w.mailer, now: d });
  await runHousekeeping(deps(new Date(T0.getTime() + 20 * DAY))); // Nov 2: both idle 20 days; the near deadline (Oct 27) has passed
  assert.equal((await w.store.one('opportunities', { where: { id: far.id } })).status, 'active', 'idle 20 days but its deadline is in December');
  assert.equal((await w.store.one('opportunities', { where: { id: near.id } })).status, 'closed', 'deadline passed');
  await w.store.insert('opportunities', { ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: 'OLD', is_sample: false, fingerprint: 'old', last_seen: T0.toISOString() });
  await runHousekeeping(deps(new Date(T0.getTime() + 20 * DAY)));
  assert.equal((await w.store.one('opportunities', { where: { source_id: 'OLD' } })).status, 'closed');
});
