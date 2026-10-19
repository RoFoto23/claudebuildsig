import { azMonth, selectAll } from './time.js';

/**
 * Provider-swappable model client built on fetch. Cost is computed from logged tokens and prices the OWNER enters
 * in Admin settings (llm.price_in_per_m, llm.price_out_per_m); no price is hardcoded. The client refuses to run
 * (available() is false) unless the feature is enabled, a key and model exist, prices are set, and this month's
 * spend is under the owner's cap (llm.monthly_cap_usd). With several calls in flight the month can overshoot the cap
 * by at most the cost of the calls already running.
 *
 * Request and response shapes are written from the providers' public docs. Gemini's endpoint, systemInstruction,
 * contents, generationConfig, candidates path and usage field names were checked on 2026-10-13; the x-goog-api-key
 * header, the Anthropic and OpenAI shapes, and JSON-mode flags are NOT yet verified live (build task T13).
 */
export class LlmError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function buildRequest(provider, { model, key, system, user, maxTokens = 1500 }) {
  if (provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } },
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] },
    };
  }
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    };
  }
  throw new LlmError('bad_provider', `unknown provider ${provider}`);
}

/** Returns { text, tokensIn, tokensOut } from a provider response body. */
export function parseResponse(provider, body) {
  if (provider === 'gemini') {
    const parts = body?.candidates?.[0]?.content?.parts;
    return { text: Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '', tokensIn: body?.usageMetadata?.promptTokenCount ?? null, tokensOut: body?.usageMetadata?.candidatesTokenCount ?? null };
  }
  if (provider === 'anthropic') {
    const c = body?.content;
    return { text: Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('') : '', tokensIn: body?.usage?.input_tokens ?? null, tokensOut: body?.usage?.output_tokens ?? null };
  }
  if (provider === 'openai') {
    return { text: body?.choices?.[0]?.message?.content || '', tokensIn: body?.usage?.prompt_tokens ?? null, tokensOut: body?.usage?.completion_tokens ?? null };
  }
  throw new LlmError('bad_provider');
}

/** Pull a JSON object out of model text. Accepts a bare object or one wrapped in a code fence. */
export function parseJsonText(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { throw new LlmError('invalid_json'); }
}

export const costUsd = (tokensIn, tokensOut, priceInPerM, priceOutPerM) =>
  Math.round((((tokensIn || 0) * priceInPerM + (tokensOut || 0) * priceOutPerM) / 1e6) * 1e6) / 1e6;

export function createLlm({ config, store, fetchImpl = fetch, now = () => new Date(), timeoutMs = 15000 }) {
  async function settings() {
    const rows = await store.select('settings', { where: { key: { like: 'llm.*' } } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async function monthSpend(at) {
    const start = `${azMonth(at)}-01T07:00:00.000Z`; // Arizona midnight is 07:00 UTC
    const rows = await selectAll(store, 'llm_calls', { where: { created_at: { gte: start } }, columns: 'cost_usd' });
    return rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  }

  /** @returns {Promise<{ok: boolean, reason?: string, spent?: number, cap?: number}>} */
  async function available() {
    if (!config.llmKey || !config.llmModel) return { ok: false, reason: 'not_configured' };
    const s = await settings();
    if (s['llm.enabled'] !== true) return { ok: false, reason: 'disabled' };
    const cap = Number(s['llm.monthly_cap_usd']);
    if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: 'no_cap' };
    if (!Number.isFinite(Number(s['llm.price_in_per_m'])) || !Number.isFinite(Number(s['llm.price_out_per_m'])) || s['llm.price_in_per_m'] == null || s['llm.price_out_per_m'] == null) return { ok: false, reason: 'no_price' };
    const spent = await monthSpend(now());
    if (spent >= cap) return { ok: false, reason: 'capped', spent, cap };
    return { ok: true, spent, cap };
  }

  async function extract({ system, user, messageId = null, accountId = null }) {
    const s = await settings();
    const provider = config.llmProvider;
    const req = buildRequest(provider, { model: config.llmModel, key: config.llmKey, system, user });
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network';
      await record({ provider, outcome: code, latency: Date.now() - t0, messageId, accountId });
      throw new LlmError(code);
    }
    const latency = Date.now() - t0;
    if (!res.ok) {
      await record({ provider, outcome: 'http_error', latency, messageId, accountId });
      throw new LlmError('http_error', `provider returned ${res.status}`);
    }
    let body;
    try { body = await res.json(); } catch { await record({ provider, outcome: 'invalid_json', latency, messageId, accountId }); throw new LlmError('invalid_json'); }
    const { text, tokensIn, tokensOut } = parseResponse(provider, body);
    const cost = costUsd(tokensIn, tokensOut, Number(s['llm.price_in_per_m']) || 0, Number(s['llm.price_out_per_m']) || 0);
    const callId = await record({ provider, tokensIn, tokensOut, cost, latency, outcome: 'ok', messageId, accountId });
    let json;
    try { json = parseJsonText(text); } catch (e) { await setOutcome(callId, 'invalid_json', null); throw e; }
    return { json, callId, tokensIn, tokensOut, cost, latency };
  }

  async function record({ provider, tokensIn = null, tokensOut = null, cost = null, latency = null, outcome, messageId, accountId }) {
    const [row] = await store.insert('llm_calls', { message_id: messageId, account_id: accountId, provider, model: config.llmModel, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost, latency_ms: latency, outcome });
    return row?.id || null;
  }

  async function setOutcome(callId, outcome, confidence) {
    if (!callId) return;
    await store.update('llm_calls', { id: callId }, { outcome, confidence });
  }

  return { available, extract, setOutcome, monthSpend };
}
