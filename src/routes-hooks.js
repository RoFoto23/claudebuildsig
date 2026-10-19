import { createHmac } from 'node:crypto';
import { json, readRaw } from './http.js';
import { verifyWebhook, subscriptionToAccount } from './stripe.js';
import { safeEqual } from './crypto.js';
import { runIngest, runDigest, runReminders, runHousekeeping, log } from './jobs.js';
import { esc } from './html.js';
import { acceptInbound, processMessage, sweep } from './inbox.js';
import { createLlm } from './llm.js';
import { alertAdmins } from './jobs.js';

/** Svix signature check used by Resend webhooks. */
export function verifySvix(rawBody, headers, secret, nowMs = Date.now()) {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sig = headers.get('svix-signature');
  if (!secret || !id || !ts || !sig) throw new Error('missing signature headers');
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) throw new Error('timestamp outside tolerance');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const ok = sig.split(' ').some((p) => p.startsWith('v1,') && safeEqual(p.slice(3), expected));
  if (!ok) throw new Error('signature mismatch');
  return JSON.parse(rawBody);
}

export async function processStripeEvent(ctx, event) {
  const { store, config } = ctx;
  const obj = event.data?.object || {};
  const plans = await store.select('plans');
  const planByPrice = Object.fromEntries(plans.filter((p) => p.stripe_price_id).map((p) => [p.stripe_price_id, p.id]));
  const findAccount = async (customerId, accountId) => {
    if (accountId) { const a = await store.one('accounts', { where: { id: accountId } }); if (a) return a; }
    return customerId ? store.one('accounts', { where: { stripe_customer_id: customerId } }) : null;
  };
  const applySub = async (sub, accountId) => {
    const patch = subscriptionToAccount(sub, planByPrice);
    const acct = await findAccount(patch.stripe_customer_id, accountId || sub.metadata?.account_id);
    if (!acct) { log({ job: 'stripe', state_to: 'no_account', event: event.type }); return; }
    if (!patch.plan_id) delete patch.plan_id;
    await store.update('accounts', { id: acct.id }, patch);
    if (acct.billing_status !== patch.billing_status) await store.insert('events', { name: `billing_${patch.billing_status}`, account_id: acct.id, props: {} });
  };
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return;
      const acct = await findAccount(obj.customer, obj.client_reference_id);
      if (acct && obj.customer) await store.update('accounts', { id: acct.id }, { stripe_customer_id: obj.customer });
      if (obj.subscription && ctx.stripe) await applySub(await ctx.stripe.api(`/subscriptions/${obj.subscription}`, {}, 'GET'), obj.client_reference_id);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySub(obj);
    case 'invoice.payment_failed': {
      const acct = await findAccount(obj.customer, null);
      if (!acct) return;
      await store.update('accounts', { id: acct.id }, { billing_status: 'past_due' });
      await ctx.mailer.send({
        accountId: acct.id, to: acct.email, subject: `Payment failed for your ${config.brand} subscription`,
        html: `<div style="font:16px/1.5 Arial,sans-serif;max-width:520px"><p>We could not charge your card. Stripe will retry automatically, but digests may pause if it keeps failing.</p><p><a href="${esc(config.baseUrl)}/app/settings" style="display:inline-block;padding:13px 18px;background:#f5a30a;color:#1f2124;border-radius:10px;font-weight:700;text-decoration:none">Update your card</a></p></div>`,
        text: `We could not charge your card. Update it here: ${config.baseUrl}/app/settings`, kind: 'dunning', key: `dunning:${obj.id}`,
      });
      return;
    }
    default:
  }
}

/** Dependencies the inbox needs, built from a request/cron context. The model client exists only when a key and model are configured. */
export function inboxDeps(base) {
  const { config, store, mailer, fetchImpl } = base;
  const nowFn = typeof base.now === 'function' ? base.now : () => base.now;
  return {
    store, config, fetchImpl, now: nowFn(),
    llm: config.has.llm ? createLlm({ config, store, fetchImpl, now: nowFn }) : null,
    alert: (subject, body, key) => alertAdmins({ config, mailer }, subject, body, key),
  };
}

const withBudget = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('budget_exhausted'), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve('error'); });
});

export function registerHooks(r, { fail }) {
  r.post('/webhooks/stripe', async (ctx) => {
    ctx.needStore();
    const rawBody = await readRaw(ctx.req);
    let event;
    try { event = verifyWebhook(rawBody, ctx.req.headers.get('stripe-signature'), ctx.config.stripeWebhookSecret); } catch (e) { return json({ error: 'invalid signature' }, { status: 400 }); }
    const inserted = await ctx.store.insert('stripe_events', { id: event.id, type: event.type }, { ignoreDuplicates: true });
    if (!inserted.length) {
      const prior = await ctx.store.one('stripe_events', { where: { id: event.id } });
      if (prior?.processed_at) return json({ ok: true, duplicate: true });
    }
    try {
      await processStripeEvent(ctx, event);
      await ctx.store.update('stripe_events', { id: event.id }, { processed_at: ctx.now().toISOString(), error: null });
      return json({ ok: true });
    } catch (e) {
      await ctx.store.update('stripe_events', { id: event.id }, { error: String(e.message || e).slice(0, 300) });
      log({ level: 'error', job: 'stripe', event: event.type, error_code: String(e.message || e).slice(0, 200) });
      return json({ error: 'processing failed' }, { status: 500 });
    }
  }, { noCsrf: true });

  r.post('/webhooks/resend', async (ctx) => {
    ctx.needStore();
    const rawBody = await readRaw(ctx.req);
    let event;
    try { event = verifySvix(rawBody, ctx.req.headers, ctx.config.resendWebhookSecret, ctx.now().getTime()); } catch { return json({ error: 'invalid signature' }, { status: 400 }); }
    const t = event.type;
    if (t === 'email.received') {
      // Metadata only: accept fast, then read the message under a time budget. The sweeper finishes anything left over.
      const accepted = await acceptInbound(ctx, event);
      if (accepted.message) await withBudget(processMessage(inboxDeps(ctx), accepted.message), 8000);
      return json({ ok: true, result: accepted.result });
    }
    const to = (event.data?.to || [])[0];
    if (['email.bounced', 'email.complained'].includes(t) && to) {
      const email = String(to).toLowerCase();
      const reason = t === 'email.complained' ? 'complaint' : 'bounce';
      await ctx.store.insert('suppressions', { email, reason }, { ignoreDuplicates: true });
      if (event.data?.email_id) await ctx.store.update('outbox', { provider_id: event.data.email_id }, { status: reason === 'complaint' ? 'complained' : 'bounced' });
      if (reason === 'complaint') await ctx.store.update('accounts', { email }, { unsubscribed_at: ctx.now().toISOString() });
    }
    return json({ ok: true });
  }, { noCsrf: true });

  r.get('/api/cron/:job', async (ctx) => {
    ctx.needStore();
    const auth = ctx.req.headers.get('authorization') || '';
    if (!ctx.config.cronSecret || !safeEqual(auth, `Bearer ${ctx.config.cronSecret}`)) throw fail(404, 'Not found');
    const deps = { config: ctx.config, store: ctx.store, mailer: ctx.mailer, fetchImpl: ctx.fetchImpl, now: ctx.now() };
    const started = Date.now();
    let result;
    switch (ctx.params.job) {
      case 'ingest': result = { ingest: await runIngest(deps), housekeeping: await runHousekeeping(deps), inbox: await sweep(inboxDeps({ ...ctx, now: ctx.now })) }; break;
      case 'digest': {
        const inbox = await sweep(inboxDeps({ ...ctx, now: ctx.now })); // late forwards are read before today's digests are chosen
        const digest = await runDigest(deps);
        result = { inbox, digest, reminders: await runReminders(deps) };
        const depth = Number(ctx.url.searchParams.get('depth') || 0);
        if (digest.remaining > 0 && depth < 6) {
          // Time budget reached: ask a fresh invocation to continue. The job is idempotent, so overlap is harmless.
          try { await ctx.fetchImpl(`${ctx.config.baseUrl}/api/cron/digest?depth=${depth + 1}`, { headers: { authorization: `Bearer ${ctx.config.cronSecret}` }, signal: AbortSignal.timeout(4000) }); } catch { /* the continuation keeps running on its own */ }
        }
        break;
      }
      case 'housekeeping': result = await runHousekeeping(deps); break;
      default: throw fail(404, 'Unknown job');
    }
    log({ job: ctx.params.job, state_to: 'done', ms: Date.now() - started });
    return json({ ok: true, job: ctx.params.job, result }, { cache: 'no-store' });
  });
}
