import { raw, toStr } from './html.js';

/** Small HTTP helpers on top of the Web Request/Response API (works on Vercel and in tests). */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, secure = true, path = '/', sameSite = 'Lax', httpOnly = true } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
].join('; ');

const SECURITY = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function respond(body, { status = 200, type = 'text/html; charset=utf-8', headers = {}, cookies = [], cache = 'private, no-store' } = {}) {
  const h = new Headers({ 'Content-Type': type, 'Cache-Control': cache, ...SECURITY, ...headers });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(body instanceof Uint8Array || typeof body === 'string' || body === null ? body : toStr(body), { status, headers: h });
}

export const html = (body, opts = {}) => respond(toStr(body), opts);
export const json = (obj, opts = {}) => respond(JSON.stringify(obj), { type: 'application/json; charset=utf-8', ...opts });
export const text = (s, opts = {}) => respond(String(s), { type: 'text/plain; charset=utf-8', ...opts });

export function redirect(location, { status = 303, cookies = [] } = {}) {
  const h = new Headers({ Location: location, 'Cache-Control': 'private, no-store', ...SECURITY });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status, headers: h });
}

/** Only same-site relative paths are accepted for "next" redirects. */
export function safeNext(v, fallback = '/app') {
  const s = String(v || '');
  return /^\/(?![/\\])[A-Za-z0-9/_\-?=&%.]*$/.test(s) ? s : fallback;
}

export const MAX_BODY = 200 * 1024;

/** Reads the raw body once (needed for webhook signature checks) with a size cap. */
export async function readRaw(req) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY) {
    const e = new Error('body too large');
    e.status = 413;
    throw e;
  }
  return new TextDecoder().decode(buf);
}

export function parseForm(rawBody) {
  const params = new URLSearchParams(rawBody);
  const out = {};
  for (const k of new Set(params.keys())) {
    const all = params.getAll(k);
    out[k] = all.length > 1 ? all : all[0];
  }
  return out;
}

export const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);

export function clientIp(req) {
  const xf = req.headers.get('x-forwarded-for');
  return (xf ? xf.split(',')[0].trim() : req.headers.get('x-real-ip')) || 'unknown';
}

/** CSRF defense for state-changing browser requests: same-origin only. */
export function sameOrigin(req, baseUrl) {
  const origin = req.headers.get('origin');
  if (origin) {
    try { return new URL(origin).host === new URL(baseUrl).host || new URL(origin).host === new URL(req.url).host; } catch { return false; }
  }
  const site = req.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

export { raw };
