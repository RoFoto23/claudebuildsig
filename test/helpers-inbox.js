import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';
import { createMailer } from '../src/email.js';
import { ENV, BASE, fakeFetch } from './helpers.js';
import { issueAddress } from '../src/inbox.js';
import { alertAdmins } from '../src/jobs.js';

export const T0 = new Date('2026-10-13T12:00:00Z');
export const INBOUND = 'in.t.example';

/** App + store with a fixed clock, the inbox switched on, and a scripted Resend "receiving" API. */
export async function inboxWorld({ env = {}, enabled = true, inbound = {} } = {}) {
  let clock = T0;
  const now = () => clock;
  const config = loadConfig({ ...ENV, INBOUND_DOMAIN: INBOUND, ...env });
  const store = createMemoryStore({ now });
  await seedMemory(store);
  if (enabled) await store.update('settings', { key: 'inbox.enabled' }, { value: true });
  const received = { ...inbound }; // email_id -> response body (or Response)
  const fetchImpl = fakeFetch({
    'api.resend.com/emails/receiving/': (u) => {
      const id = decodeURIComponent(u.split('/receiving/')[1].split('?')[0]);
      const v = received[id];
      if (v instanceof Response) return v;
      if (!v) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      return v;
    },
  });
  const mailer = createMailer({ config, store, fetchImpl, sleep: async () => {} });
  const app = createApp({ config, store, fetchImpl, now, mailer });
  const deps = () => ({ store, config, fetchImpl, now: clock, mailer, llm: null, alert: (s, b, k) => alertAdmins({ config, mailer }, s, b, k) });
  return {
    app, store, config, fetchImpl, mailer, received, deps,
    setNow: (d) => { clock = d; },
    advance: (ms) => { clock = new Date(clock.getTime() + ms); },
    now,
  };
}

export async function customer(w, { email = 'c@example.com', billing = 'trialing', trades = ['roofing'], jurisdictions = ['mesa'], profile = {} } = {}) {
  const [a] = await w.store.insert('accounts', { email, plan_id: 'pro', billing_status: billing, trial_end: new Date(T0.getTime() + 5 * 86400000).toISOString() });
  await w.store.insert('profiles', { account_id: a.id, business_name: 'Test Roofing LLC', contact_name: 'Dana', phone: '480-555-0111', license_number: '314159', trades, jurisdictions, onboarded_at: T0.toISOString(), ...profile });
  const addr = await issueAddress(w.store, w.config, a.id, w.now());
  return { account: a, ...addr };
}

export function webhook(w, payload, { badSig = false, id = 'msg_1' } = {}) {
  const app = w.app;
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(w.now().getTime() / 1000)); // the app verifies against its own (injected) clock
  const key = Buffer.from(ENV.RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return app.fetch(new Request(`${BASE}/webhooks/resend`, { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${badSig ? 'AAAA' : sig}` }, body: raw }));
}

export const received = (emailId, to, over = {}) => ({ type: 'email.received', created_at: T0.toISOString(), data: { email_id: emailId, from: 'Dana <dana@gmail.com>', to: [to], received_for: [to], subject: 'Fwd: New Bid: Roof Replacement - City of Mesa Fire Station 205', message_id: `<${emailId}@mail>`, attachments: [], ...over } });

/** A Resend "retrieve received email" response body. */
export const message = (over = {}) => new Response(JSON.stringify({
  id: 'x', from: 'Dana <dana@gmail.com>', subject: 'Fwd: New Bid: Roof Replacement - City of Mesa Fire Station 205',
  text: 'Agency: City of Mesa\nBid No. IFB 26-045\nBids due October 27, 2026 at 2:00 PM MST\nhttps://www.bidnetdirect.com/arizona/mesa/solicitations/123\n',
  html: null, attachments: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, ...over,
}), { status: 200, headers: { 'content-type': 'application/json' } });
