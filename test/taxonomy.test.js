import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADES, TRADE_IDS, TRADE_GROUPS, JURISDICTIONS, COVERED_JURISDICTIONS, cleanMulti, parseZips, groupsForTrades, tradesInGroup, groupOfTrade } from '../src/taxonomy.js';

test('every trade has a label, a valid group, signals and at least one NAICS code', () => {
  assert.ok(TRADE_IDS.length >= 15);
  for (const id of TRADE_IDS) {
    const t = TRADES[id];
    assert.equal(t.id, id);
    assert.ok(t.label, id);
    assert.ok(TRADE_GROUPS[t.group], `${id} group`);
    assert.ok(t.signals.length > 0, `${id} signals`);
    assert.ok(t.naics.length > 0, `${id} naics`);
    for (const [re, w, label] of t.signals) { assert.ok(re instanceof RegExp); assert.ok(w > 0); assert.ok(label); }
  }
});

test('groups partition the trades with none orphaned', () => {
  const all = Object.keys(TRADE_GROUPS).flatMap(tradesInGroup);
  assert.deepEqual([...all].sort(), [...TRADE_IDS].sort());
  assert.equal(groupOfTrade('roofing'), TRADES.roofing.group);
});

test('multi-value filters: cleanMulti keeps only allowed, unique values and accepts scalars and arrays', () => {
  assert.deepEqual(cleanMulti(['roofing', 'bogus', 'roofing', ' paving '], TRADE_IDS), ['roofing', 'paving']);
  assert.deepEqual(cleanMulti('roofing', TRADE_IDS), ['roofing']);
  assert.deepEqual(cleanMulti(undefined, TRADE_IDS), []);
  assert.deepEqual(cleanMulti('', TRADE_IDS), []);
});

test('multi-value ZIP codes all parse (regression: rules with several ZIPs never matched)', () => {
  assert.deepEqual(parseZips('85201, 85202 85203\n85204;85205'), ['85201', '85202', '85203', '85204', '85205']);
  assert.deepEqual(parseZips(['85201', '8520', 'abcde', '85201-1234']), ['85201']);
  assert.deepEqual(parseZips(''), []);
});

test('groupsForTrades counts distinct groups for plan limits', () => {
  assert.equal(groupsForTrades(['roofing', 'painting']).length, 1);
  assert.ok(groupsForTrades(['roofing', 'electrical', 'janitorial']).length >= 3);
  assert.deepEqual(groupsForTrades([]), []);
});

test('covered jurisdictions exist in the vocabulary', () => {
  for (const j of COVERED_JURISDICTIONS) assert.ok(JURISDICTIONS[j]);
});
