import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { createMailer } from './email.js';
import { createStripe } from './stripe.js';
import { html, redirect, readRaw, parseForm, sameOrigin, clientIp, respond, text } from './http.js';
import { page } from './views.js';
import { CSS, FAVICON } from './assets.js';
import { DEFAULT_PLANS } from './sample.js';
import { log } from './jobs.js';
import { h } from './html.js';
import { registerPublic } from './routes-public.js';
import { registerApp } from './routes-app.js';
import { registerInbox } from './routes-inbox.js';
import { registerAdmin } from './routes-admin.js';
import { registerHooks } from './routes-hooks.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => new HttpError(status, message);

function compile(pattern) {
  const keys = [];
  const src = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp(`^${src}$`), keys };
}

/**
 * Builds the whole application as a function Request -> Response so it runs unchanged on Vercel and in tests.
 * Dependencies are injectable (store, fetch, clock) so every route can be tested without network access.
 */
export function createApp(deps = {}) {
  const config = deps.config || loadConfig();
  const store = deps.store === undefined ? null : deps.store;
  const publicStore = deps.publicStore || null;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowFn = deps.now || (() => new Date());
  const mailer = deps.mailer || (store ? createMailer({ config, store, fetchImpl }) : null);
  const stripe = deps.stripe || (config.has.billing ? createStripe({ config, fetchImpl }) : null);
  const auth = store ? createAuth({ config, store }) : null;
  const memLimits = new Map();
  const cache = new Map();

  const routes = [];
  const add = (method, pattern, handler, opts = {}) => routes.push({ method, ...compile(pattern), handler, opts });
  const r = { get: (p, hd, o) => add('GET', p, hd, o), post: (p, hd, o) => add('POST', p, hd, o), add };

  const salt = config.tokenSecret || 'dev';
  const hashIp = (ip) => createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24);

  async function getPlans() {
    if (!store) return DEFAULT_PLANS;
    return cached('plans', 30000, async () => {
      try {
        const rows = await store.select('plans', { where: { active: true }, order: 'price_cents.asc' });
        return rows.length ? rows : DEFAULT_PLANS;
      } catch { return DEFAULT_PLANS; }
    });
  }

  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await fn();
    cache.set(key, { v, exp: Date.now() + ttlMs });
    return v;
  }
  const bust = (key) => cache.delete(key);

  async function sourceStatus() {
    if (!store) return [];
    return cached('sources', 60000, async () => {
      try { return await store.select('source_config', { columns: 'source,label,enabled,last_ok_at,last_count' }); } catch { return []; }
    });
  }

  async function limit(key, max, windowSec) {
    const now = nowFn().getTime();
    const start = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000).toISOString();
    try {
      if (store) return (await store.rpc('rl_hit', { p_key: key, p_window: start })) <= max;
    } catch { /* fall through to memory */ }
    const k = `${key}:${start}`;
    const n = (memLimits.get(k) || 0) + 1;
    memLimits.set(k, n);
    if (memLimits.size > 5000) memLimits.clear();
    return n <= max;
  }

  async function logEvent(name, props = {}) {
    try {
      const s = store || publicStore;
      if (s) await s.rpc('log_event', { p_name: name, p_anon: null, p_props: props });
    } catch { /* analytics must never break a request */ }
  }

  function makeCtx(req, url, params) {
    let sess;
    let formMemo;
    const ctx = {
      req, url, params, config, store, publicStore, mailer, stripe, auth, fetchImpl, now: nowFn, getPlans, sourceStatus, limit, logEvent, bust, cached,
      ip: hashIp(clientIp(req)),
      async session() {
        if (sess === undefined) sess = auth ? await auth.readSession(req) : null;
        return sess;
      },
      async form() {
        if (!formMemo) {
          const ct = req.headers.get('content-type') || '';
          const body = await readRaw(req);
          formMemo = ct.includes('application/json') ? JSON.parse(body || '{}') : parseForm(body);
        }
        return formMemo;
      },
      async render(title, body, opts = {}) {
        const s = await ctx.session();
        return html(page({ config, session: s }, { title, body, ...opts }), { status: opts.status || 200, cookies: opts.cookies || [] });
      },
      needStore() {
        if (!store) throw fail(503, 'This part of the site opens at launch. The demo and waitlist are available now.');
      },
      async requireUser() {
        ctx.needStore();
        const s = await ctx.session();
        if (!s) throw redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
        return s;
      },
      async requireAdmin() {
        ctx.needStore();
        const s = await ctx.session();
        if (!s || !s.isAdminCandidate) throw fail(404, 'Not found');
        if (!s.adminOk) throw redirect('/admin/2fa');
        return s;
      },
    };
    return ctx;
  }

  async function errorPage(ctx, status, message) {
    const body = h`<div class="wrap narrow" style="padding:40px 16px"><h1>${status === 404 ? 'Page not found' : status === 429 ? 'Slow down a little' : status === 503 ? 'Not available yet' : 'Something went wrong'}</h1><p>${message}</p><p><a class="btn" href="/">Back to the home page</a></p></div>`;
    try { return await ctx.render(`${status}`, body, { status, noindex: true }); } catch { return html(page({ config, session: null }, { title: String(status), body, noindex: true }), { status }); }
  }

  registerPublic(r, { fail });
  registerApp(r, { fail });
  registerInbox(r, { fail });
  registerAdmin(r, { fail });
  registerHooks(r, { fail });

  r.get('/health', async () => {
    let db = 'not configured';
    if (store) { try { await store.select('plans', { columns: 'id', limit: 1 }); db = 'ok'; } catch { db = 'error'; } }
    return respond(JSON.stringify({ ok: db !== 'error', db, email: config.has.email ? 'live' : 'simulated', billing: config.has.billing ? 'live' : 'off', signup_open: config.signupOpen, version: '1.0.0' }), { type: 'application/json', cache: 'no-store' });
  });
  r.get('/assets/app.css', () => respond(CSS, { type: 'text/css; charset=utf-8', cache: 'public, max-age=3600' }));
  r.get('/favicon.svg', () => respond(FAVICON, { type: 'image/svg+xml', cache: 'public, max-age=86400' }));
  r.get('/robots.txt', () => text(`User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /t/\nDisallow: /o/\nDisallow: /auth/\nAllow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`, { cache: 'public, max-age=3600' }));
  r.get('/sitemap.xml', () => {
    const urls = ['/', '/demo', '/pricing', '/terms', '/privacy', '/refunds'];
    return respond(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${config.baseUrl}${u}</loc></url>`).join('')}</urlset>`, { type: 'application/xml', cache: 'public, max-age=3600' });
  });

  async function fetchHandler(req) {
    const url = new URL(req.url);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const started = Date.now();
    let matched = null;
    let params = {};
    for (const rt of routes) {
      if (rt.method !== method) continue;
      const m = rt.re.exec(url.pathname);
      if (m) { matched = rt; params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); break; }
    }
    const ctx = makeCtx(req, url, params);
    try {
      if (!matched) {
        if (routes.some((rt) => rt.re.test(url.pathname))) return respond('Method not allowed', { status: 405, type: 'text/plain' });
        return await errorPage(ctx, 404, 'We could not find that page.');
      }
      if (method === 'POST' && !matched.opts.noCsrf && !sameOrigin(req, config.baseUrl)) return await errorPage(ctx, 403, 'Cross-site form submissions are blocked. Please try again from the site.');
      const res = await matched.handler(ctx);
      if (matched.opts.logName) log({ route: matched.opts.logName, status: res.status, ms: Date.now() - started });
      return res;
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof HttpError) return await errorPage(ctx, e.status, e.message);
      if (e?.status === 413) return await errorPage(ctx, 413, 'That request was too large.');
      log({ level: 'error', route: `${method} ${url.pathname}`, error_code: String(e?.message || e).slice(0, 300) });
      return await errorPage(ctx, 500, 'Something went wrong on our side. It has been logged. Please try again in a minute.');
    }
  }

  return { fetch: fetchHandler, config, store, deps: { mailer, stripe, auth } };
}
