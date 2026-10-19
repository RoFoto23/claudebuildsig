import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, selectForDigest, updateFeedbackWeights, feedbackAdjustment, deriveTags, DEFAULT_WEIGHTS } from '../src/scoring.js';
import { TRADE_IDS, TRADES } from '../src/taxonomy.js';

const NOW = new Date('2026-09-17T19:00:00Z');
const profile = (o = {}) => ({ trades: ['framing'], jurisdictions: ['mesa'], zips: [], min_value: null, max_value: null, license_number: '123456', certifications: [], feedback_weights: {}, ...o });
const opp = (o = {}) => ({
  id: 'o1', kind: 'permit_lead', status: 'active', stage: 'issued', jurisdiction: 'mesa', zip: null, value: 2500000, sqft: 20000, units: null, issued_date: '2026-09-08',
  title: 'New building: 1 Main St', scope: 'New three-story apartment building, 36 units, wood framing', work_type: 'New building', permit_type: 'COM', gc_name: 'Acme Builders', url: 'https://x/y', source_id: 'P1', tags: [], raw: {}, ...o,
});
const ev = (p, o, ctx = {}) => evaluate(p, o, { now: NOW, ...ctx });

test('a matching trade, area and size is eligible and explained', () => {
  const r = ev(profile(), opp());
  assert.equal(r.eligible, true);
  assert.ok(r.score >= 50 && r.score <= 100);
  assert.ok(r.why.includes('Your trade'));
  assert.ok(r.factors.length >= 5);
  assert.ok(r.checklist.every((c) => ['green', 'yellow', 'red'].includes(c.status) && c.reason));
});

test('regression: permits with several ZIP codes in the profile match any of them', () => {
  const p = profile({ zips: ['85201', '85202', '85203'] });
  for (const z of ['85201', '85202', '85203']) assert.equal(ev(p, opp({ zip: z })).eligible, true, z);
  assert.equal(ev(p, opp({ zip: '85999' })).eligible, false);
});

test('regression: a permit with no ZIP is not silently skipped; it is shown with a yellow "confirm location"', () => {
  const r = ev(profile({ zips: ['85201'] }), opp({ zip: null }));
  assert.equal(r.eligible, true);
  const t = r.checklist.find((c) => c.key === 'territory');
  assert.equal(t.status, 'yellow');
  assert.match(t.reason, /confirm/i);
});

test('regression: zero or missing value does not trigger the minimum-value filter; it is flagged as unconfirmed', () => {
  for (const value of [0, null]) {
    const r = ev(profile({ min_value: 500000 }), opp({ value }));
    assert.equal(r.eligible, true, `value=${value}`);
    assert.equal(r.checklist.find((c) => c.key === 'size').status, 'yellow');
  }
  assert.equal(ev(profile({ min_value: 5000000 }), opp({ value: 2500000 })).eligible, false);
  assert.equal(ev(profile({ max_value: 1000000 }), opp({ value: 2500000 })).eligible, false);
});

test('regression: every trade offered in the UI can match something', () => {
  const probes = [
    'demolition of existing building, new building ground-up shell, addition, tenant improvement, parking lot paving, concrete foundation slab, roof replacement, drywall, painting, landscape irrigation, electrical service panel, plumbing, HVAC mechanical rooftop unit, fencing, grading excavation, tree removal, janitorial, maintenance, framing wood stud apartment',
    'new multifamily apartment 200 units ground-up with site grading, paving, concrete flatwork, landscaping, fencing, electrical, plumbing, mechanical and framing',
  ];
  for (const id of TRADE_IDS) {
    const hit = probes.some((scope) => ev(profile({ trades: [id] }), opp({ scope, title: scope, work_type: scope })).eligible);
    assert.ok(hit, `trade ${id} can never match`);
  }
});

test('hard exclusions: wrong city, residential, completed, expired deadline, stale permit, inactive', () => {
  assert.equal(ev(profile(), opp({ jurisdiction: 'phoenix' })).eligible, false);
  assert.equal(ev(profile(), opp({ permit_type: 'RES' })).eligible, false);
  assert.equal(ev(profile(), opp({ stage: 'completed' })).eligible, false);
  assert.equal(ev(profile(), opp({ issued_date: '2026-06-01' })).eligible, false);
  assert.equal(ev(profile(), opp({ status: 'hidden' })).eligible, false);
  const bid = opp({ kind: 'public_bid', jurisdiction: 'statewide', stage: 'open_bid', deadline: '2026-09-10T20:00:00Z' });
  assert.equal(ev(profile(), bid).eligible, false);
  assert.equal(ev(profile(), { ...bid, deadline: '2026-10-10T20:00:00Z' }).eligible, true);
});

test('statewide/federal items pass the city filter and show a yellow territory note', () => {
  const r = ev(profile(), opp({ kind: 'public_bid', jurisdiction: 'statewide', stage: 'open_bid', deadline: '2026-10-10T20:00:00Z', raw: { setAside: 'Total Small Business Set-Aside' } }));
  assert.equal(r.eligible, true);
  assert.equal(r.checklist.find((c) => c.key === 'territory').status, 'yellow');
  assert.equal(r.checklist.find((c) => c.key === 'setaside').status, 'red');
  const r2 = ev(profile({ certifications: ['small_business'] }), opp({ kind: 'public_bid', jurisdiction: 'statewide', stage: 'open_bid', deadline: '2026-10-10T20:00:00Z', raw: { setAside: 'Total Small Business Set-Aside' } }));
  assert.equal(r2.checklist.find((c) => c.key === 'setaside').status, 'green');
});

test('requirements not in the record are never invented: bonding/insurance/prevailing wage are yellow "not found"', () => {
  const r = ev(profile(), opp({ kind: 'public_bid', jurisdiction: 'statewide', stage: 'open_bid', deadline: '2026-10-10T20:00:00Z' }));
  const req = r.checklist.find((c) => c.key === 'requirements');
  assert.equal(req.status, 'yellow');
  assert.match(req.reason, /Not found/);
});

test('missing license is red; present license is yellow (unverified), never green', () => {
  assert.equal(ev(profile({ license_number: null }), opp()).checklist.find((c) => c.key === 'license').status, 'red');
  const l = ev(profile(), opp()).checklist.find((c) => c.key === 'license');
  assert.equal(l.status, 'yellow');
  assert.match(l.reason, /unverified/);
});

test('feedback is transparent and capped at +/-10 points; jurisdiction tags never learn', () => {
  let w = {};
  const tags = deriveTags(opp());
  for (let i = 0; i < 50; i++) w = updateFeedbackWeights(w, tags, 'interested');
  assert.ok(Object.values(w).every((v) => v <= 6 && v >= -6));
  assert.ok(!Object.keys(w).some((k) => k.startsWith('jur:')));
  assert.ok(feedbackAdjustment(tags, w).points <= 10);
  const base = ev(profile(), opp()).score;
  const up = ev(profile({ feedback_weights: w }), opp());
  assert.ok(up.score >= base);
  assert.ok(up.factors.some((f) => f.key === 'learned'));
  let neg = {};
  for (let i = 0; i < 10; i++) neg = updateFeedbackWeights(neg, tags, 'not_for_me');
  assert.ok(ev(profile({ feedback_weights: neg }), opp()).score < base);
  assert.deepEqual(updateFeedbackWeights({ a: 1 }, tags, 'already_knew'), { a: 1 });
});

test('weights are configurable and still produce 0..100 scores', () => {
  const r = ev(profile(), opp(), { weights: { ...DEFAULT_WEIGHTS, fit: 60, timing: 10, scale: 10, access: 10, evidence: 10 } });
  assert.ok(r.score >= 0 && r.score <= 100);
});

test('digest selection: max 5, best first, one per project family, below-threshold dropped', () => {
  const mk = (i, score, fam) => ({ opp: { id: `o${i}`, parent_key: fam }, eval: { eligible: true, score } });
  const evals = [mk(1, 90, 'a'), mk(2, 89, 'a'), mk(3, 80, 'b'), mk(4, 70, 'c'), mk(5, 60, 'd'), mk(6, 55, 'e'), mk(7, 54, 'f'), mk(8, 49, 'g')];
  const picked = selectForDigest(evals, { maxItems: 5, deliverMin: 50 });
  assert.deepEqual(picked.map((p) => p.opp.id), ['o1', 'o3', 'o4', 'o5', 'o6']);
  assert.equal(selectForDigest([mk(1, 40, 'a')], { deliverMin: 50 }).length, 0);
  assert.equal(selectForDigest([{ opp: { id: 'x' }, eval: { eligible: false, score: 99 } }]).length, 0);
});

test('residential and unrelated work gives "no signal" rather than a forced match', () => {
  const r = ev(profile({ trades: ['roofing'] }), opp({ scope: 'Install new sign on tenant frontage', title: 'Sign: 5 Main', work_type: 'Sign' }));
  assert.equal(r.eligible, false);
});

test('all trades have distinct ids and tradeFit labels are plain English', () => {
  for (const t of Object.values(TRADES)) for (const [, , label] of t.signals) assert.match(label, /^[a-z0-9 ,()/'.&-]+$/i);
});

test('selectForDigest: open bids rank ahead of permit leads even when the permit lead scores higher; ties by score; one per family', async () => {
  const { selectForDigest } = await import('../src/scoring.js');
  const mk = (id, kind, score, fam) => ({ opp: { id, kind, parent_key: fam || id }, eval: { eligible: true, score } });
  const picked = selectForDigest([mk('lead1', 'permit_lead', 90), mk('bidLow', 'public_bid', 55), mk('bidHigh', 'public_bid', 70), mk('lead2', 'permit_lead', 85), mk('bidDup', 'public_bid', 60, 'bidHigh')], { maxItems: 5, deliverMin: 50 });
  assert.deepEqual(picked.map((e) => e.opp.id), ['bidHigh', 'bidLow', 'lead1', 'lead2']);
  assert.deepEqual(selectForDigest([mk('x', 'public_bid', 40)], { deliverMin: 50 }), []);
});
