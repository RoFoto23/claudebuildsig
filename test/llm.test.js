import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, parseJsonText, costUsd, createLlm, LlmError } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';
import { ENV } from './helpers.js';

// Prices below are TEST VALUES for the arithmetic only. No real model price is hardcoded anywhere in src/.
const PRICES = { 'llm.enabled': true, 'llm.monthly_cap_usd': 1, 'llm.price_in_per_m': 0.1, 'llm.price_out_per_m': 0.4 };
const T = new Date('2026-10-13T12:00:00Z');

async function world({ settings = PRICES, env = {}, reply } = {}) {
  const config = loadConfig({ ...ENV, LLM_PROVIDER: 'gemini', LLM_MODEL: 'test-model', LLM_API_KEY: 'k-test', ...env });
  const store = createMemoryStore({ now: () => T });
  await seedMemory(store);
  for (const [key, value] of Object.entries(settings)) await store.insert('settings', { key, value }, { ignoreDuplicates: false }).catch(() => store.update('settings', { key }, { value }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = typeof reply === 'function' ? await reply(String(url), init) : reply;
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } }), { status: 200 });
  };
  const llm = createLlm({ config, store, fetchImpl, now: () => T });
  return { config, store, calls, llm };
}

test('request shapes: key never in the URL, system and user text in the provider fields', () => {
  const g = buildRequest('gemini', { model: 'm1', key: 'KEY', system: 'SYS', user: 'USR' });
  assert.match(g.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/m1:generateContent$/);
  assert.equal(g.headers['x-goog-api-key'], 'KEY');
  assert.ok(!g.url.includes('KEY'));
  assert.equal(g.body.systemInstruction.parts[0].text, 'SYS');
  assert.equal(g.body.contents[0].parts[0].text, 'USR');
  assert.equal(g.body.generationConfig.temperature, 0);
  const a = buildRequest('anthropic', { model: 'm2', key: 'KEY', system: 'SYS', user: 'USR' });
  assert.equal(a.headers['x-api-key'], 'KEY');
  assert.equal(a.body.system, 'SYS');
  assert.equal(a.body.messages[0].content, 'USR');
  const o = buildRequest('openai', { model: 'm3', key: 'KEY', system: 'SYS', user: 'USR' });
  assert.equal(o.headers.authorization, 'Bearer KEY');
  assert.deepEqual(o.body.messages.map((m) => m.role), ['system', 'user']);
  assert.throws(() => buildRequest('nope', {}), LlmError);
});

test('response parsing per provider; fenced JSON is accepted; garbage is invalid_json', () => {
  assert.deepEqual(parseResponse('gemini', { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { text: '{"a":1}', tokensIn: 10, tokensOut: 5 });
  assert.deepEqual(parseResponse('anthropic', { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 3, output_tokens: 2 } }), { text: '{}', tokensIn: 3, tokensOut: 2 });
  assert.deepEqual(parseResponse('openai', { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } }), { text: '{}', tokensIn: 7, tokensOut: 1 });
  assert.deepEqual(parseJsonText('```json\n{"x":1}\n```'), { x: 1 });
  assert.throws(() => parseJsonText('Sure! Here you go'), (e) => e.code === 'invalid_json');
});

test('cost arithmetic from logged tokens and owner-entered prices', () => {
  assert.equal(costUsd(1000, 500, 0.1, 0.4), 0.0003);
  assert.equal(costUsd(null, null, 1, 1), 0);
});

test('available(): every missing prerequisite keeps the model OFF, with the reason', async () => {
  assert.equal((await (await world({ env: { LLM_API_KEY: '' } })).llm.available()).reason, 'not_configured');
  assert.equal((await (await world({ settings: {} })).llm.available()).reason, 'disabled');
  assert.equal((await (await world({ settings: { 'llm.enabled': true } })).llm.available()).reason, 'no_cap');
  assert.equal((await (await world({ settings: { 'llm.enabled': true, 'llm.monthly_cap_usd': 1 } })).llm.available()).reason, 'no_price');
  assert.equal((await (await world()).llm.available()).ok, true);
});

test('extract(): logs model, tokens, cost and latency; the monthly cap switches the model off', async () => {
  const w = await world({ settings: { ...PRICES, 'llm.monthly_cap_usd': 0.0005 } });
  const r = await w.llm.extract({ system: 's', user: 'u', messageId: null, accountId: null });
  assert.deepEqual(r.json, { items: [] });
  const [row] = await w.store.select('llm_calls');
  assert.equal(row.model, 'test-model');
  assert.equal(row.tokens_in, 1000);
  assert.equal(row.tokens_out, 500);
  assert.equal(Number(row.cost_usd), 0.0003);
  assert.equal(row.outcome, 'ok');
  assert.ok(row.latency_ms >= 0);
  assert.equal((await w.llm.available()).ok, true, '0.0003 is under the 0.0005 cap');
  await w.llm.extract({ system: 's', user: 'u' });
  const after = await w.llm.available();
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'capped');
  // a new Arizona month starts again from zero
  const nextMonth = createLlm({ config: w.config, store: w.store, fetchImpl: async () => new Response('{}'), now: () => new Date('2026-11-01T08:00:00Z') });
  assert.equal((await nextMonth.available()).ok, true);
});

test('extract(): HTTP errors, timeouts and non-JSON output are recorded and surfaced as coded errors', async () => {
  const bad = await world({ reply: new Response('rate limited', { status: 429 }) });
  await assert.rejects(bad.llm.extract({ system: 's', user: 'u' }), (e) => e.code === 'http_error');
  assert.equal((await bad.store.select('llm_calls'))[0].outcome, 'http_error');
  const slow = await world({ reply: () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
  await assert.rejects(slow.llm.extract({ system: 's', user: 'u' }), (e) => e.code === 'timeout');
  const junk = await world({ reply: { candidates: [{ content: { parts: [{ text: 'Sure! Here is your answer' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } } });
  await assert.rejects(junk.llm.extract({ system: 's', user: 'u' }), (e) => e.code === 'invalid_json');
  assert.equal((await junk.store.select('llm_calls'))[0].outcome, 'invalid_json');
});
