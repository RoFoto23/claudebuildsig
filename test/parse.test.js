import test from 'node:test';
import assert from 'node:assert/strict';
import { findDates, findAmounts } from '../src/parse/dates.js';
import { findAgency } from '../src/parse/agencies.js';
import { extractByRules, cleanSubject, confidenceOf } from '../src/parse/rules.js';
import { verifyItem, quoteExists } from '../src/parse/verify.js';
import { parseMessage } from '../src/parse/index.js';
import { RULES_FIXTURES, RECEIVED } from './fixtures/inbox/rules.js';

test('dates: formats, times, Arizona offset, and rejects impossible dates', () => {
  const d = findDates('Due October 27th, 2026 at 2:00 PM MST; also 11/3/26 and 2026-12-01 and Feb 30 2026 and 13/45/2026');
  assert.deepEqual(d.map((x) => x.iso), ['2026-10-27T14:00:00-07:00', '2026-11-03T23:59:00-07:00', '2026-12-01T23:59:00-07:00']);
  assert.equal(d[0].time_stated, true);
  assert.equal(d[1].time_stated, false);
  assert.equal(findDates('12 AM and 12 PM: Nov 1 2026 12:00 AM')[0].iso, '2026-11-01T00:00:00-07:00');
  assert.equal(findDates('Nov 1 2026 12:30 PM')[0].iso, '2026-11-01T12:30:00-07:00');
});

test('amounts: million/K suffixes and cents; ignores zero', () => {
  assert.deepEqual(findAmounts('$1.2 million, $250K, $45,000.50, $0').map((a) => a.amount), [1200000, 250000, 45001]);
});

test('agencies: known names, labelled lines and school districts', () => {
  assert.equal(findAgency('Posted by City of Chandler Public Works').jurisdiction, 'chandler');
  assert.equal(findAgency('Issued by: Dysart Unified School District No. 89').value, 'Dysart Unified School District No. 89');
  assert.equal(findAgency('Agency: Maricopa County Facilities').jurisdiction, 'maricopa_county');
  assert.equal(findAgency('nothing here'), null);
});

test('subject cleanup removes forwarding and alert prefixes', () => {
  assert.equal(cleanSubject('Re: Fwd: [External] New Bid: Roof Repair'), 'Roof Repair');
  assert.equal(cleanSubject('Bid Alert - Fence Install'), 'Fence Install');
});

for (const fx of RULES_FIXTURES) {
  test(`rules fixture (synthetic): ${fx.id}`, async () => {
    const r = await parseMessage({ subject: fx.subject, text: fx.text, fromDomain: fx.from_domain, receivedAt: RECEIVED });
    const e = fx.expected;
    if (e.items === 0) { assert.equal(r.items.length, 0); assert.equal(r.method, 'none'); return; }
    if (e.count) {
      assert.equal(r.items.length, e.count);
      assert.deepEqual(r.items.map((i) => i.title.value), e.titles);
      assert.deepEqual(r.items.map((i) => i.deadline?.iso ?? null), e.deadlines);
      return;
    }
    const it = r.items[0];
    assert.ok(it, 'one item');
    if ('title' in e) assert.equal(it.title.value, e.title);
    if ('agency' in e) assert.equal(it.agency?.value, e.agency);
    if ('deadline' in e) assert.equal(it.deadline?.iso ?? null, e.deadline);
    if ('solicitation_no' in e) assert.equal(it.solicitation_no?.value, e.solicitation_no);
    if ('prebid' in e) assert.equal(it.prebid?.iso, e.prebid);
    if ('prebid_mandatory' in e) assert.equal(it.prebid?.mandatory, e.prebid_mandatory);
    if ('url' in e) assert.equal(it.url?.value, e.url);
    if ('value' in e) assert.equal(it.value_stated?.amount, e.value);
    if ('set_aside' in e) assert.equal(it.set_aside?.value.toLowerCase(), e.set_aside);
    // every stored field must trace to text that is really in the message
    const corpus = `${fx.subject}\n${fx.text}`;
    for (const k of ['title', 'agency', 'deadline', 'solicitation_no', 'prebid', 'url', 'value_stated', 'set_aside']) if (it[k]) assert.ok(quoteExists(corpus, it[k].quote), `${k} quote exists`);
  });
}

test('injection text in a body changes nothing: no extra items, no link to the attacker', async () => {
  const fx = RULES_FIXTURES.find((f) => f.id === 'injection-in-body');
  const r = await parseMessage({ subject: fx.subject, text: fx.text, fromDomain: fx.from_domain, receivedAt: RECEIVED });
  assert.equal(r.items.length, 1);
  assert.ok(!JSON.stringify(r.items).includes('evil.example'));
});

test('confidence uses only verified fields and the published weights', () => {
  assert.equal(confidenceOf({ title: {}, deadline: {}, url: {}, agency: {}, solicitation_no: {} }), 1);
  assert.equal(confidenceOf({ title: {}, deadline: {} }), 0.55);
  assert.equal(confidenceOf({}), 0);
});

test('verifier: fabricated quotes, javascript: links, non-date quotes and foreign links are dropped', () => {
  const corpus = 'Subject line\nRoof Repair for the City. Bids due November 4, 2026. See https://city.example.gov/bid/1';
  const { item, dropped } = verifyItem({
    title: { value: 'Roof Repair', quote: 'Roof Repair for the City' },
    agency: { value: 'City of Nowhere', quote: 'City of Nowhere' },
    deadline: { quote: 'November 4, 2026' },
    solicitation_no: { value: 'ZZ-99', quote: 'Solicitation ZZ-99' },
    prebid: { quote: 'sometime soon' },
    url: { value: 'javascript:alert(1)', quote: 'javascript:alert(1)' },
    value_stated: { quote: 'a lot' },
    set_aside: null,
  }, corpus);
  assert.equal(item.title.value, 'Roof Repair');
  assert.equal(item.agency, null);
  assert.equal(item.deadline.iso, '2026-11-04T23:59:00-07:00');
  assert.equal(item.solicitation_no, null);
  assert.equal(item.prebid, null);
  assert.equal(item.url, null);
  assert.equal(item.value_stated, null);
  assert.ok(dropped.length >= 5);
  const foreign = verifyItem({ title: { value: 'Roof Repair', quote: 'Roof Repair' }, url: { value: 'https://evil.example/x', quote: 'https://evil.example/x' } }, corpus);
  assert.equal(foreign.item.url, null, 'a link that is not in the message is rejected');
  assert.equal(verifyItem({ title: { value: 'Made up', quote: 'Made up title' } }, corpus).item, null, 'unquoted title drops the item');
});

test('verifier re-derives the date from the quote, ignoring a model-supplied value', () => {
  const { item } = verifyItem({ title: { value: 'Paint', quote: 'Paint Job' }, deadline: { value: '2030-01-01', iso: '2030-01-01T00:00:00-07:00', quote: 'November 4, 2026' } }, 'Paint Job due November 4, 2026');
  assert.equal(item.deadline.iso, '2026-11-04T23:59:00-07:00');
});

test('splitting needs at least two blocks that each carry their own deadline', () => {
  const one = extractByRules({ subject: 'Bid: Fence', text: 'Fence repair bid\nBids due Nov 3, 2026\n\nAnother paragraph about the project and the bid with no date.', receivedAt: RECEIVED });
  assert.equal(one.items.length, 1);
});
