import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, ENV } from './helpers.js';
import { createMailer } from '../src/email.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';
import { runIngest, runDigest, runReminders, runHousekeeping } from '../src/jobs.js';
import { upsertOpportunities } from '../src/ingest.js';
import { SAMPLE_OPPS } from '../src/sample.js';
import { sam } from '../src/adapters/sam.js';
import { fakeFetch } from './helpers.js';

const MON = new Date('2026-10-12T13:00:00Z'); // Monday 6:00 a.m. Arizona
const day = (n) => new Date(MON.getTime() + n * 86400000);

async function world({ env = {}, script = {} } = {}) {
  const config = loadConfig({ ...ENV, ...env });
  const store = createMemoryStore();
  await seedMemory(store);
  const fetchImpl = fakeFetch(script);
  const mailer = createMailer({ config, store, fetchImpl, sleep: async () => {} });
  const deps = (now) => ({ config, store, mailer, fetchImpl, now });
  return { config, store, fetchImpl, mailer, deps };
}

async function customer(store, email = 'c@example.com', { billing = 'trialing', plan = 'pro', profile = {} } = {}) {
  const [a] = await store.insert('accounts', { email, plan_id: plan, billing_status: billing, trial_end: new Date(MON.getTime() + 5 * 86400000).toISOString() });
  await store.insert('profiles', { account_id: a.id, business_name: 'Sun Valley Framing', contact_name: 'Dana Ruiz', phone: '480-555-0111', license_number: '314159', trades: ['framing'], jurisdictions: ['mesa'], onboarded_at: MON.toISOString(), ...profile });
  return a;
}

const freshOpps = (n = 3) => Array.from({ length: n }, (_, i) => ({
  ...SAMPLE_OPPS[1], id: undefined, source: 'mesa_permits', source_id: `PMT-${i}`, parent_key: `fam-${i}`, is_sample: false, issued_date: '2026-10-05', title: `New apartment building ${i}`, address: `${i} Main St`, units: 30 + i,
  fingerprint: `fp-${i}`, tags: [], version: 1,
}));

async function seedOpps(store, items = freshOpps()) {
  for (const it of items) await store.insert('opportunities', { ...it, last_seen: MON.toISOString() });
}

test('digest: sends once per day, max 5 items, with tap links, unsubscribe headers and the mailing address', async () => {
  const w = await world();
  const a = await customer(w.store);
  await seedOpps(w.store, freshOpps(8));
  const s = await runDigest(w.deps(MON));
  assert.equal(s.sent, 1);
  const digests = await w.store.select('digests');
  assert.equal(digests.length, 1);
  assert.equal(digests[0].item_count, 5);
  assert.ok(digests[0].sent_at);
  const out = (await w.store.select('outbox', { where: { kind: 'digest' } }))[0];
  assert.match(out.html, /\/t\/[A-Za-z0-9_.-]+/);
  assert.match(out.html, /Interested/);
  assert.match(out.html, /1 Test St, Mesa, AZ 85201/);
  assert.match(out.html, /unsubscribe\?t=/);
  const sentBody = JSON.parse(w.fetchImpl.calls.find((c) => c.url.includes('resend')).body);
  assert.match(sentBody.headers['List-Unsubscribe'], /unsubscribe\?t=/);
  assert.equal(sentBody.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal((await w.store.select('matches', { where: { account_id: a.id } })).length, 5);

  const again = await runDigest(w.deps(new Date(MON.getTime() + 3600000)));
  assert.equal(again.sent, 0);
  assert.equal((await w.store.select('digests')).length, 1);
  assert.equal(w.fetchImpl.calls.filter((c) => c.url.includes('resend')).length, 1);
});

test('digest: items are not repeated; an honest "no strong matches" note replaces padding and is throttled', async () => {
  const w = await world();
  await customer(w.store);
  await seedOpps(w.store, freshOpps(2));
  assert.equal((await runDigest(w.deps(day(0)))).sent, 1);
  const d1 = await runDigest(w.deps(day(1)));
  assert.equal(d1.sent, 0);
  assert.equal(d1.empty, 1);
  const note = (await w.store.select('outbox', { where: { kind: 'digest' } })).find((o) => /no strong matches/i.test(o.subject));
  assert.ok(note);
  assert.doesNotMatch(note.html, /\/t\/[A-Za-z0-9]/);
  const d2 = await runDigest(w.deps(day(2)));
  assert.equal(d2.empty + d2.sent, 0);
});

test('digest: weekly customers get mail on Mondays only', async () => {
  const w = await world();
  await customer(w.store, 'w@example.com', { profile: { digest_frequency: 'weekly' } });
  await seedOpps(w.store);
  assert.equal((await runDigest(w.deps(day(1)))).sent, 0); // Tuesday
  assert.equal((await runDigest(w.deps(day(0)))).sent, 1); // Monday
});

test('digest: skips unsubscribed, paused, not-onboarded, and customers with no active billing', async () => {
  const w = await world();
  const a = await customer(w.store, 'u@example.com');
  await w.store.update('accounts', { id: a.id }, { unsubscribed_at: MON.toISOString() });
  const b = await customer(w.store, 'p@example.com');
  await w.store.update('accounts', { id: b.id }, { digest_paused: true });
  await customer(w.store, 'n@example.com', { profile: { onboarded_at: null } });
  await customer(w.store, 'x@example.com', { billing: 'none' });
  await customer(w.store, 'c@example.com', { billing: 'canceled' });
  await seedOpps(w.store);
  const s = await runDigest(w.deps(MON));
  assert.equal(s.sent + s.empty, 0);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('email: no Resend key means "simulated" (never "sent"); no mailing address blocks marketing mail', async () => {
  const sim = await world({ env: { RESEND_API_KEY: '', EMAIL_FROM: '' } });
  await customer(sim.store);
  await seedOpps(sim.store);
  await runDigest(sim.deps(MON));
  const row = (await sim.store.select('outbox'))[0];
  assert.equal(row.status, 'simulated');
  assert.equal(sim.fetchImpl.calls.length, 0);

  const noAddr = await world({ env: { MAILING_ADDRESS: '' } });
  const r = await noAddr.mailer.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', kind: 'digest', key: 'k1' });
  assert.equal(r.status, 'blocked_no_address');
  assert.equal(noAddr.fetchImpl.calls.length, 0);
});

test('email: idempotent per key, honors suppressions, retries 5xx then reports failure', async () => {
  const w = await world();
  const m = { to: 'a@b.co', subject: 's', html: 'h', text: 't', kind: 'login', key: 'same' };
  assert.equal((await w.mailer.send(m)).status, 'sent');
  assert.equal((await w.mailer.send(m)).duplicate, true);
  assert.equal(w.fetchImpl.calls.length, 1);
  await w.store.insert('suppressions', { email: 'bounced@b.co', reason: 'bounce' });
  assert.equal((await w.mailer.send({ ...m, to: 'BOUNCED@b.co', key: 'k2' })).status, 'suppressed');
  let n = 0;
  const flaky = await world({ script: { 'api.resend.com': () => { n++; return new Response('{"message":"down"}', { status: 503 }); } } });
  const r = await flaky.mailer.send({ ...m, key: 'k3' });
  assert.equal(r.status, 'failed');
  assert.equal(n, 3);
});

test('reminders fire once each at 7, 3 and 1 days for Interested bids on Pro, and stop after the deadline', async () => {
  const w = await world();
  const a = await customer(w.store);
  const deadline = new Date(MON.getTime() + 7 * 86400000 - 3600000).toISOString();
  const [opp] = await w.store.insert('opportunities', { ...freshOpps(1)[0], kind: 'public_bid', jurisdiction: 'statewide', stage: 'open_bid', deadline, source: 'sam_gov', source_id: 'N9', title: 'Concrete apron repair', last_seen: MON.toISOString() });
  await w.store.insert('matches', { account_id: a.id, opportunity_id: opp.id, score: 80, disposition: 'interested', delivered_at: MON.toISOString(), change_alerted_version: 1 });
  let total = 0;
  for (let d = 0; d <= 9; d++) { total += (await runReminders(w.deps(day(d)))).reminders; }
  assert.equal(total, 3);
  const subjects = (await w.store.select('outbox', { where: { kind: 'reminder' } })).map((o) => o.subject);
  assert.equal(subjects.length, 3);
  assert.ok(subjects.every((s) => /Deadline in/.test(s)));
});

test('reminders are a Pro feature after the trial: Starter on an active plan gets none', async () => {
  const w = await world();
  const a = await customer(w.store, 's@example.com', { billing: 'active', plan: 'starter' });
  const [opp] = await w.store.insert('opportunities', { ...freshOpps(1)[0], kind: 'public_bid', stage: 'open_bid', deadline: new Date(MON.getTime() + 86400000).toISOString(), source: 'sam_gov', source_id: 'N8', last_seen: MON.toISOString() });
  await w.store.insert('matches', { account_id: a.id, opportunity_id: opp.id, score: 80, disposition: 'interested', delivered_at: MON.toISOString() });
  assert.equal((await runReminders(w.deps(MON))).reminders, 0);
});

test('an amended solicitation triggers exactly one change alert for customers who marked it Interested', async () => {
  const w = await world();
  const a = await customer(w.store);
  const base = sam.normalize({ noticeId: 'n1', title: 'Roof repair', naicsCode: '238160', active: 'Yes', responseDeadLine: '2026-10-30T17:00:00-07:00', solicitationNumber: 'S1' });
  await upsertOpportunities(w.store, [base], MON);
  const opp = (await w.store.select('opportunities'))[0];
  await w.store.insert('matches', { account_id: a.id, opportunity_id: opp.id, score: 80, disposition: 'interested', delivered_at: MON.toISOString(), change_alerted_version: 1 });
  assert.equal((await runReminders(w.deps(MON))).change_alerts, 0);
  await upsertOpportunities(w.store, [sam.normalize({ noticeId: 'n1', title: 'Roof repair', naicsCode: '238160', active: 'Yes', responseDeadLine: '2026-11-06T17:00:00-07:00', solicitationNumber: 'S1' })], day(1));
  assert.equal((await runReminders(w.deps(day(1)))).change_alerts, 1);
  assert.equal((await runReminders(w.deps(day(2)))).change_alerts, 0);
  const alert = (await w.store.select('outbox', { where: { kind: 'change_alert' } }))[0];
  assert.match(alert.subject, /Updated/);
  assert.match(alert.html, /version 2/);
});

test('inactivity: a customer who never opens 14 digests in a row is paused automatically', async () => {
  const w = await world();
  const a = await customer(w.store);
  for (let i = 1; i <= 14; i++) await w.store.insert('digests', { account_id: a.id, kind: 'daily', item_count: 1, digest_key: `${a.id}:old${i}`, sent_at: new Date(MON.getTime() - i * 86400000).toISOString() });
  await seedOpps(w.store);
  const s = await runDigest(w.deps(MON));
  assert.equal(s.paused, 1);
  assert.equal((await w.store.one('accounts', { where: { id: a.id } })).digest_paused, true);
  assert.equal((await w.store.select('audit_log')).some((x) => x.action === 'digest.auto_paused_inactive'), true);
});

test('ingest: runs only enabled sources with reviewed terms, once per day, and stores normalized items', async () => {
  const mesaRows = [{ permit_number: 'PMT26-9', permit_type: 'COM', status: 'Issued', issued_date: '2026-10-08T00:00:00.000', type_of_work: 'New building', property_address: '9 Main St', description_of_work: 'New three-story apartments', job_value: '9000000', contractor_name: 'Acme' }];
  const w = await world({ script: { 'data.mesaaz.gov': mesaRows } });
  let r = await runIngest(w.deps(MON));
  assert.ok(r.every((x) => x.skipped)); // nothing enabled or reviewed yet
  await w.store.update('source_config', { source: 'mesa_permits' }, { enabled: true });
  r = await runIngest(w.deps(MON));
  assert.equal(r.find((x) => x.source === 'mesa_permits').skipped, 'terms not reviewed');
  await w.store.update('source_config', { source: 'mesa_permits' }, { terms_reviewed_at: MON.toISOString() });
  r = await runIngest(w.deps(MON));
  const mesaRes = r.find((x) => x.source === 'mesa_permits');
  assert.equal(mesaRes.inserted, 1);
  assert.equal((await w.store.select('opportunities')).length, 1);
  r = await runIngest(w.deps(new Date(MON.getTime() + 3600000)));
  assert.equal(r.find((x) => x.source === 'mesa_permits').skipped, 'already ran today');
  r = await runIngest(w.deps(day(1)));
  assert.equal(r.find((x) => x.source === 'mesa_permits').unchanged, 1);
  assert.equal((await w.store.one('source_config', { where: { source: 'mesa_permits' } })).baseline_count > 0, true);
});

test('ingest: a source that keeps failing is auto-disabled after 3 runs and the owner is alerted', async () => {
  const w = await world({ script: { 'data.mesaaz.gov': () => new Response('boom', { status: 500 }) } });
  await w.store.update('source_config', { source: 'mesa_permits' }, { enabled: true, terms_reviewed_at: MON.toISOString() });
  for (let d = 0; d < 3; d++) await runIngest(w.deps(day(d)));
  const cfg = await w.store.one('source_config', { where: { source: 'mesa_permits' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.auto_disabled, true);
  assert.equal(cfg.consecutive_failures, 3);
  const alerts = await w.store.select('outbox', { where: { kind: 'admin_alert' } });
  assert.ok(alerts.length >= 2);
  assert.ok(alerts.some((a) => /auto-disabled/.test(a.subject)));
  assert.ok(alerts.every((a) => a.to_email === 'owner@example.com'));
  const r = await runIngest(w.deps(day(3)));
  assert.equal(r.find((x) => x.source === 'mesa_permits').skipped, 'auto-disabled');
});

test('ingest: the SAM source is skipped without a key and never called', async () => {
  const w = await world();
  await w.store.update('source_config', { source: 'sam_gov' }, { enabled: true, terms_reviewed_at: MON.toISOString() });
  const r = await runIngest(w.deps(MON));
  assert.equal(r.find((x) => x.source === 'sam_gov').skipped, 'no api key');
  assert.equal(w.fetchImpl.calls.filter((c) => c.url.includes('sam.gov')).length, 0);
});

test('housekeeping: trial-ending email once, stale items closed, owner gets a daily summary', async () => {
  const w = await world();
  const a = await customer(w.store, 't@example.com');
  await w.store.update('accounts', { id: a.id }, { trial_end: new Date(MON.getTime() + 2 * 86400000).toISOString() });
  await w.store.insert('opportunities', { ...freshOpps(1)[0], last_seen: new Date(MON.getTime() - 20 * 86400000).toISOString() });
  const h1 = await runHousekeeping(w.deps(MON));
  assert.equal(h1.trial_ending, 1);
  assert.equal(h1.closed_stale, 1);
  const h2 = await runHousekeeping(w.deps(new Date(MON.getTime() + 3600000)));
  assert.equal(h2.trial_ending, 0);
  const summaries = await w.store.select('outbox', { where: { kind: 'admin_alert' } });
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].text_body, /MRR/);
  assert.match(summaries[0].text_body, /LLM cost: \$0\.00/);
});
