import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';

/** Encode nested objects/arrays the way Stripe's form API expects: a[b][0][c]=v */
export function encodeForm(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? out.push(encodeForm(item, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') out.push(encodeForm(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

/** Verify a Stripe-Signature header against the raw request body. Returns the parsed event or throws. */
export function verifyWebhook(rawBody, sigHeader, secret, { nowMs = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret) throw new Error('webhook secret not configured');
  const parts = Object.fromEntries(
    String(sigHeader || '')
      .split(',')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2),
  );
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new Error('malformed signature header');
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) throw new Error('timestamp outside tolerance');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const candidates = String(sigHeader).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!candidates.some((c) => safeEqual(c, expected))) throw new Error('signature mismatch');
  return JSON.parse(rawBody);
}

export function signForTest(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

export function createStripe({ config, fetchImpl = fetch }) {
  async function api(path, params = {}, method = 'POST') {
    const body = method === 'GET' ? undefined : encodeForm(params);
    const qs = method === 'GET' && Object.keys(params).length ? `?${encodeForm(params)}` : '';
    const res = await fetchImpl(`https://api.stripe.com/v1${path}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${config.stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${method} ${path} -> ${res.status}: ${json.error?.message || 'error'}`);
    return json;
  }

  return {
    api,
    createCheckout({ accountId, email, customerId, priceId, trialDays, planId, successUrl, cancelUrl, requireCard = true }) {
      return api('/checkout/sessions', {
        mode: 'subscription',
        client_reference_id: accountId,
        ...(customerId ? { customer: customerId } : { customer_email: email }),
        line_items: [{ price: priceId, quantity: 1 }],
        payment_method_collection: requireCard ? 'always' : 'if_required',
        subscription_data: { trial_period_days: trialDays, metadata: { account_id: accountId, plan_id: planId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
      });
    },
    createPortal(customerId, returnUrl) {
      return api('/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    },
    pause(subId) {
      return api(`/subscriptions/${subId}`, { pause_collection: { behavior: 'void' } });
    },
    resume(subId) {
      return api(`/subscriptions/${subId}`, { pause_collection: '' });
    },
    /** Create the Stripe product + monthly price for a plan (prices are immutable, so a change makes a new price). */
    async syncPlanPrice(plan) {
      const product = await api('/products', { name: `${config.brand} ${plan.name}`, metadata: { plan_id: plan.id } });
      const price = await api('/prices', { product: product.id, unit_amount: plan.price_cents, currency: 'usd', recurring: { interval: 'month' }, metadata: { plan_id: plan.id } });
      return price.id;
    },
    archivePrice(priceId) {
      return api(`/prices/${priceId}`, { active: 'false' });
    },
  };
}

/** Map a Stripe subscription object to our account columns. */
export function subscriptionToAccount(sub, planByPrice = {}) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  let status = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'none', paused: 'paused' }[sub.status] || 'none';
  if (status === 'active' && sub.pause_collection) status = 'paused';
  return {
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    billing_status: status,
    plan_id: sub.metadata?.plan_id || planByPrice[priceId] || null,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
  };
}
