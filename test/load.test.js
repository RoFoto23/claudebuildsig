import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, fakeFetch } from './helpers.js';
import { createMailer } from '../src/email.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';
import { runDigest } from '../src/jobs.js';
import { TRADE_IDS } from '../src/taxonomy.js';
import { finalize } from '../src/adapters/util.js';

const NOW = new Date('2026-10-12T13:00:00Z');

async function world(n, opps) {
  const config = loadConfig({ ...ENV, RESEND_API_KEY: '', EMAIL_FROM: '' }); // simulated email: measures our compute, not Resend
  const store = createMemoryStore();
  await seedMemory(store);
  const mailer = createMailer({ config, store, fetchImpl: fakeFetch(), sleep: async () => {} });
  const accts = Array.from({ length: n }, (_, i) => ({ email: `c${i}@example.com`, plan_id: 'pro', billing_status: i % 5 === 0 ? 'active' : 'trialing' }));
  const created = await store.insert('accounts', accts);
  await store.insert('profiles', created.map((a, i) => ({ account_id: a.id, business_name: `Biz ${i}`, contact_name: 'Pat', license_number: String(100000 + i), trades: [TRADE_IDS[i % TRADE_IDS.length], TRADE_IDS[(i + 3) % TRADE_IDS.length]], jurisdictions: [i % 2 ? 'mesa' : 'phoenix'], zips: [], onboarded_at: NOW.toISOString() })));
  const rows = Array.from({ length: opps }, (_, i) => ({
    source: i % 3 ? 'mesa_permits' : 'phoenix_permits', source_id: `P${i}`, kind: 'permit_lead', title: `${['New building', 'Tenant improvement', 'Demolition', 'Addition'][i % 4]}: ${i} Main St`, jurisdiction: i % 3 ? 'mesa' : 'phoenix',
    stage: 'issued', value: i % 4 ? 250000 + i * 1000 : null, issued_date: '2026-10-02', scope: ['New apartment building with paving, concrete, framing and landscaping', 'Tenant improvement: drywall, painting, electrical, plumbing, HVAC', 'Demolition of existing warehouse', 'Addition of roof and fencing'][i % 4],
    permit_type: 'COM', gc_name: i % 2 ? 'Acme Builders' : null, url: `https://x/${i}`, fingerprint: `f${i}`, parent_key: `k${i}`, last_seen: NOW.toISOString(), tags: [],
  }));
  await store.insert('opportunities', rows);
  return { config, store, mailer };
}

test('load: 500 customers x 1,500 opportunities produce 500 digests, once each, well inside the function time limit', async () => {
  const w = await world(500, 1500);
  const t0 = performance.now();
  const s = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW });
  const ms = performance.now() - t0;
  console.log(`# load: 500 customers x 1500 opportunities -> ${s.sent} digests, ${s.empty} empty notes, ${Math.round(ms)} ms (in-memory store, simulated email)`);
  assert.equal(s.failed, 0);
  assert.equal(s.sent + s.empty, 500);
  assert.equal(s.remaining, 0);
  assert.ok(ms < 20000, `took ${ms} ms`);
  assert.equal((await w.store.select('digests')).length, 500);
  const outbox = await w.store.select('outbox', { where: { kind: 'digest' } });
  assert.equal(outbox.length, 500);
  assert.equal(new Set(outbox.map((o) => o.to_email)).size, 500);
  assert.ok((await w.store.select('digests')).every((d) => d.item_count <= 5));
  const again = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW });
  assert.equal(again.sent + again.empty, 0);
  assert.equal((await w.store.select('outbox', { where: { kind: 'digest' } })).length, 500);
});

test('time budget: when the budget runs out the job reports what remains, and a second pass finishes without duplicates', async () => {
  const w = await world(60, 200);
  const first = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW, budgetMs: -1, concurrency: 4 });
  assert.equal(first.sent + first.empty, 0);
  assert.equal(first.remaining, 60);
  const second = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW });
  assert.equal(second.sent + second.empty, 60);
  assert.equal((await w.store.select('outbox', { where: { kind: 'digest' } })).length, 60);
});

test('crash safety: a digest row created but never sent is redone on the next pass, once', async () => {
  const w = await world(3, 20);
  const [a] = await w.store.select('accounts', { limit: 1 });
  await w.store.insert('digests', { account_id: a.id, kind: 'daily', item_count: 2, digest_key: `${a.id}:2026-10-12` }); // sent_at null
  const s = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW });
  assert.equal(s.sent + s.empty, 3);
  const mine = await w.store.select('digests', { where: { account_id: a.id } });
  assert.equal(mine.length, 1);
  assert.ok(mine[0].sent_at);
});

test('load: 500 customers each with 3 forwarded items (1,500 private items) + 1,500 public ones -> digests, with no cross-account leakage', async () => {
  const w = await world(500, 1500);
  const accts = await w.store.select('accounts');
  const rows = [];
  accts.forEach((a, i) => {
    for (let k = 0; k < 3; k++) {
      const o = finalize({
        source: 'forwarded', source_id: `fw:${a.id}:${k}`, kind: 'public_bid', title: `PRIVATE-${i}-${k} roof replacement bid`, agency: 'City of Mesa', jurisdiction: 'mesa', stage: 'open_bid',
        deadline: new Date(NOW.getTime() + (5 + k) * 86400000).toISOString(), url: `https://example.gov/${i}/${k}`, scope: 'roofing re-roof', owner_account_id: a.id,
        provenance: { title: { quote: 'x', source: 'email' } }, also_seen_via: [], raw: { forwarded: true },
      });
      o.fingerprint = `fw-${i}-${k}`;
      o.last_seen = NOW.toISOString();
      rows.push(o);
    }
  });
  await w.store.insert('opportunities', rows);
  const t0 = performance.now();
  const s = await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: NOW });
  const ms = performance.now() - t0;
  console.log(`# load: 500 customers x (1500 public + 1500 private) -> ${s.sent} digests, ${s.empty} empty, ${Math.round(ms)} ms (in-memory store, simulated email)`);
  assert.equal(s.failed, 0);
  assert.equal(s.sent + s.empty, 500);
  assert.ok(ms < 30000, `took ${ms} ms`);
  const byId = new Map(accts.map((a, i) => [a.email, i]));
  const outbox = await w.store.select('outbox', { where: { kind: 'digest' } });
  assert.equal(outbox.length, 500);
  let withPrivate = 0;
  for (const o of outbox) {
    const mine = byId.get(o.to_email);
    const seen = [...String(o.html || '').matchAll(/PRIVATE-(\d+)-\d+/g)].map((m) => Number(m[1]));
    assert.ok(seen.every((n) => n === mine), `${o.to_email} saw someone else's private item`);
    if (seen.length) withPrivate++;
  }
  const privOpps = new Set((await w.store.select('opportunities', { where: { source: 'forwarded' } })).map((o) => o.id));
  const privMatches = (await w.store.select('matches')).filter((m) => privOpps.has(m.opportunity_id));
  console.log(`# load: ${privMatches.length} matches on private items; ${withPrivate} of 500 digests show one`);
  assert.ok(privMatches.every((m) => (accts.find((a) => a.id === m.account_id) && true)));
  assert.ok(withPrivate > 0, 'forwarded items appear in digests');
});
