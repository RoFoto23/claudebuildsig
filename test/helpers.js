import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';

export const BASE = 'https://t.example';
export const ENV = {
  APP_URL: BASE, SESSION_SECRET: 's'.repeat(40), TOKEN_SECRET: 't'.repeat(40), ENC_KEY: 'e'.repeat(40), CRON_SECRET: 'cron-secret-test',
  ADMIN_EMAILS: 'owner@example.com', RESEND_API_KEY: 'test-resend', EMAIL_FROM: 'BuildSignal <hi@t.example>', MAILING_ADDRESS: '1 Test St, Mesa, AZ 85201',
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'test-secret', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('svix-secret-test-bytes').toString('base64'),
};

/** Fake network: records calls, answers Resend and scripted Stripe endpoints. */
export function fakeFetch(script = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers });
    for (const [pat, handler] of Object.entries(script)) {
      if (u.includes(pat)) {
        const out = typeof handler === 'function' ? await handler(u, init) : handler;
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: `em_${calls.length}` }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

export async function makeApp({ env = {}, script = {}, now } = {}) {
  const config = loadConfig({ ...ENV, ...env });
  const store = createMemoryStore();
  await seedMemory(store);
  const fetchImpl = fakeFetch(script);
  const app = createApp({ config, store, fetchImpl, now });
  return { app, store, config, fetchImpl };
}

/** Tiny browser: keeps cookies, always sends a same-origin Origin header on POST. */
export function browser(app) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const val = decodeURIComponent(pair.slice(i + 1));
      if (attrs.some((a) => /max-age=0/i.test(a)) || val === '') jar.delete(name);
      else jar.set(name, val);
    }
    return res;
  };
  const go = async (method, path, form, headers = {}) => {
    const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : undefined;
    const res = await app.fetch(new Request(`${BASE}${path}`, { method, headers: { cookie: cookieHeader(), ...(method === 'POST' ? { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, body, redirect: 'manual' }));
    absorb(res);
    res.text = ((orig) => { let memo; return () => (memo ??= orig()); })(res.text.bind(res));
    return res;
  };
  return { jar, get: (p, h) => go('GET', p, null, h), post: (p, f, h) => go('POST', p, f || {}, h) };
}

export const loc = (res) => res.headers.get('location');
export const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** Pull the most recent sign-in link out of the outbox. */
export async function lastLoginLink(store, email) {
  const rows = (await store.select('outbox', { where: { to_email: email, kind: 'login' } })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const m = /href="(https:\/\/t\.example\/auth\/verify[^"]+)"/.exec(rows[0]?.html || '');
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

export async function signIn(b, store, email, next) {
  const link = await lastLoginLink(store, email);
  const u = new URL(link);
  const res = await b.post('/auth/verify', { t: u.searchParams.get('t'), next: next || u.searchParams.get('next') });
  return res;
}
