import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertOpportunities, assessHealth } from '../src/ingest.js';
import { createMemoryStore } from '../src/store/memory.js';
import { mesa } from '../src/adapters/mesa.js';
import { phoenix } from '../src/adapters/phoenix.js';
import { sam } from '../src/adapters/sam.js';
import { postgrestFilters } from './helpers-pg.js';

const mesaRow = { permit_number: 'PMT26-1', permit_type: 'COM', status: 'Issued', issued_date: '2026-09-08T00:00:00.000', type_of_work: 'Tenant improvement', property_address: '3204 S Signal Butte Rd 1049', description_of_work: 'TI in 51,938 sq ft warehouse for battery process', job_value: '2500000', total_square_feet: '51938', contractor_name: 'Mortenson Construction', applicant: 'X' };

test('Mesa adapter: normalizes a permit with a record link, value from job_value, and no ZIP claimed', () => {
  const o = mesa.normalize(mesaRow);
  assert.equal(o.source, 'mesa_permits');
  assert.equal(o.kind, 'permit_lead');
  assert.equal(o.stage, 'issued');
  assert.equal(o.value, 2500000);
  assert.equal(o.zip, null);
  assert.equal(o.gc_name, 'Mortenson Construction');
  assert.match(o.url, /m2kk-w2hz\.json\?permit_number=PMT26-1/);
  assert.ok(o.fingerprint && o.tags.length > 0);
  assert.equal(mesa.normalize({ permit_number: 'X' }), null);
  assert.equal(mesa.normalize({ ...mesaRow, job_value: '0' }).value, null); // zero value = unknown, not $0
});

test('Mesa adapter builds URLs with URLSearchParams and de-duplicates rows', async () => {
  const urls = mesa.urls(new Date('2026-10-11T00:00:00Z'));
  assert.equal(urls.length, 2);
  for (const u of urls) { const p = new URL(u).searchParams; assert.ok(p.get('$where').includes("permit_type='COM'")); }
  let n = 0;
  const rows = await mesa.fetchRaw(async () => { n++; return new Response(JSON.stringify([mesaRow, mesaRow])); });
  assert.equal(rows.length, 1);
  assert.equal(n, 2);
  await assert.rejects(() => mesa.fetchRaw(async () => new Response('{}', { status: 500 })), /mesa 500/);
  await assert.rejects(() => mesa.fetchRaw(async () => new Response('{"error":1}')), /unexpected/);
});

test('Phoenix adapter: keeps commercial permit types, drops residential, solar, sign; street only; applicant not GC', () => {
  const good = phoenix.normalize({ PER_NUM: '26-1', PER_TYPE_DESC: 'SHELL BUILDING', PERMIT_NAME: 'New shell', STREET_FULL_NAME: 'N 7TH ST', PER_ISSUE_DATE: Date.UTC(2026, 8, 20), PROFESS_NAME: 'ABC Architects', PROJECT: 'P9' });
  assert.equal(good.jurisdiction, 'phoenix');
  assert.equal(good.gc_name, null);
  assert.equal(good.applicant, 'ABC Architects');
  assert.equal(good.issued_date, '2026-09-20');
  assert.match(good.title, /street only/);
  for (const t of ['RESIDENTIAL NEW', 'SOLAR PV', 'SIGN PERMIT', 'OTC SOMETHING', 'FIRE ALARM']) assert.equal(phoenix.normalize({ PER_NUM: '1', PER_TYPE_DESC: t }), null, t);
  assert.ok(phoenix.url(new Date('2026-10-11T00:00:00Z')).includes('Planning_Permit/MapServer/1/query?'));
});

test('SAM adapter: needs a key, one request, 429 is "rate limited" not "broken", filters to construction NAICS', async () => {
  await assert.rejects(() => sam.fetchRaw(async () => new Response('{}'), new Date(), {}), /not configured/);
  let calls = 0;
  await assert.rejects(() => sam.fetchRaw(async () => { calls++; return new Response('{}', { status: 429 }); }, new Date(), { key: 'k' }), (e) => e.rateLimited === true);
  assert.equal(calls, 1);
  const o = sam.normalize({ noticeId: 'abc', title: 'Repair concrete apron', naicsCode: '238110', active: 'Yes', responseDeadLine: '2026-10-20T17:00:00-07:00', typeOfSetAsideDescription: 'Total Small Business Set-Aside', solicitationNumber: 'S-1', placeOfPerformance: { city: { name: 'Phoenix' }, state: { code: 'AZ' }, zip: '85001' } });
  assert.equal(o.kind, 'public_bid');
  assert.equal(o.jurisdiction, 'statewide');
  assert.equal(o.deadline, '2026-10-21T00:00:00.000Z');
  assert.equal(o.raw.setAside, 'Total Small Business Set-Aside');
  assert.equal(sam.normalize({ noticeId: 'x', naicsCode: '541511', active: 'Yes' }), null);
  assert.equal(sam.normalize({ noticeId: 'x', naicsCode: '238110', active: 'No' }), null);
  assert.ok(!sam.url('SECRETKEY', new Date()).includes('undefined'));
});

test('upsert is idempotent and versions amendments (deadline change creates version 2 with a snapshot)', async () => {
  const store = createMemoryStore();
  const base = sam.normalize({ noticeId: 'n1', title: 'Roof repair', naicsCode: '238160', active: 'Yes', responseDeadLine: '2026-10-20T17:00:00-07:00', solicitationNumber: 'S1' });
  let s = await upsertOpportunities(store, [base], new Date('2026-10-11'));
  assert.deepEqual([s.inserted, s.changed, s.unchanged], [1, 0, 0]);
  s = await upsertOpportunities(store, [base], new Date('2026-10-12'));
  assert.deepEqual([s.inserted, s.changed, s.unchanged], [0, 0, 1]);
  const amended = sam.normalize({ noticeId: 'n1', title: 'Roof repair', naicsCode: '238160', active: 'Yes', responseDeadLine: '2026-10-27T17:00:00-07:00', solicitationNumber: 'S1' });
  s = await upsertOpportunities(store, [amended], new Date('2026-10-13'));
  assert.deepEqual([s.inserted, s.changed], [0, 1]);
  const [row] = await store.select('opportunities');
  assert.equal(row.version, 2);
  assert.ok(row.changed_at);
  const versions = await store.select('opportunity_versions');
  assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2]);
  assert.equal(versions.find((v) => v.version === 2).snapshot.deadline, '2026-10-28T00:00:00.000Z');
  assert.equal((await store.select('opportunities')).length, 1);
});

test('same solicitation from two sources shares a project family key for digest de-duplication', () => {
  const a = mesa.normalize({ ...mesaRow, permit_number: 'A', property_address: '100 MAIN ST 101' });
  const b = mesa.normalize({ ...mesaRow, permit_number: 'B', property_address: '100 MAIN ST 202' });
  assert.equal(a.parent_key, b.parent_key);
});

test('source health: zero items, anomaly, errors fail; 3 failures in a row auto-disable and alert; rate limit does not count', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  let cfg = { baseline_count: 0, consecutive_failures: 0 };
  let h = assessHealth(cfg, { count: 100 }, now);
  assert.equal(h.problem, null);
  assert.equal(h.patch.baseline_count, 100);
  cfg = { baseline_count: 100, consecutive_failures: 0 };
  h = assessHealth(cfg, { count: 0 }, now);
  assert.equal(h.problem, 'zero items returned');
  assert.equal(h.alert, true);
  assert.equal(h.autoDisabled, false);
  cfg = { baseline_count: 100, consecutive_failures: 1 };
  h = assessHealth(cfg, { count: 10 }, now);
  assert.match(h.problem, /count anomaly/);
  assert.equal(h.alert, false);
  cfg = { baseline_count: 100, consecutive_failures: 2 };
  h = assessHealth(cfg, { error: 'mesa 500' }, now);
  assert.equal(h.autoDisabled, true);
  assert.equal(h.patch.enabled, false);
  assert.equal(h.patch.auto_disabled, true);
  assert.equal(h.alert, true);
  h = assessHealth({ baseline_count: 5, consecutive_failures: 2 }, { error: 'x', rateLimited: true }, now);
  assert.equal(h.patch.consecutive_failures, 2);
  assert.equal(h.autoDisabled, false);
  assert.equal(assessHealth({ baseline_count: 5, consecutive_failures: 0 }, { count: 4 }, now).problem, null); // small baselines don't trip anomaly
});

test('PostgREST filters encode operators and refuse unknown ones', () => {
  assert.deepEqual(postgrestFilters({ a: 1, b: { in: ['x', 'y"z'] }, c: { isnull: true }, d: null, e: { gte: '2026-01-01' } }), ['a=eq.1', 'b=in.(%22x%22%2C%22y%5C%22z%22)', 'c=is.null', 'd=is.null', 'e=gte.2026-01-01']);
  assert.throws(() => postgrestFilters({ a: { bogus: 1 } }), /unsupported/);
});
