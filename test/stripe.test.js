import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook, signForTest, encodeForm, subscriptionToAccount, createStripe } from '../src/stripe.js';

const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } });

test('webhook signature: valid passes; wrong secret, tampered body, stale timestamp and malformed header fail', () => {
  const now = Math.floor(Date.now() / 1000);
  const sig = signForTest(body, 'whsec_a', now);
  assert.equal(verifyWebhook(body, sig, 'whsec_a').id, 'evt_1');
  assert.throws(() => verifyWebhook(body, sig, 'whsec_b'), /mismatch/);
  assert.throws(() => verifyWebhook(body + ' ', sig, 'whsec_a'), /mismatch/);
  assert.throws(() => verifyWebhook(body, signForTest(body, 'whsec_a', now - 1000), 'whsec_a'), /tolerance/);
  assert.throws(() => verifyWebhook(body, 'garbage', 'whsec_a'), /malformed/);
  assert.throws(() => verifyWebhook(body, sig, ''), /not configured/);
});

test('form encoding handles nesting and arrays the way Stripe expects', () => {
  const s = decodeURIComponent(encodeForm({ mode: 'subscription', line_items: [{ price: 'p_1', quantity: 1 }], subscription_data: { trial_period_days: 14, metadata: { account_id: 'a' } }, skip: undefined }));
  assert.match(s, /line_items\[0\]\[price\]=p_1/);
  assert.match(s, /subscription_data\[metadata\]\[account_id\]=a/);
  assert.match(s, /subscription_data\[trial_period_days\]=14/);
  assert.doesNotMatch(s, /skip/);
});

test('subscription mapping: trial, active, paused, past_due, canceled', () => {
  const base = { customer: 'cus_1', metadata: { plan_id: 'pro' }, items: { data: [{ price: { id: 'price_1' }, current_period_end: 1800000000 }] }, trial_end: 1790000000 };
  assert.equal(subscriptionToAccount({ ...base, status: 'trialing' }).billing_status, 'trialing');
  assert.equal(subscriptionToAccount({ ...base, status: 'active' }).billing_status, 'active');
  assert.equal(subscriptionToAccount({ ...base, status: 'active', pause_collection: { behavior: 'void' } }).billing_status, 'paused');
  assert.equal(subscriptionToAccount({ ...base, status: 'past_due' }).billing_status, 'past_due');
  assert.equal(subscriptionToAccount({ ...base, status: 'canceled' }).billing_status, 'canceled');
  const m = subscriptionToAccount({ ...base, status: 'active', metadata: {} }, { price_1: 'starter' });
  assert.equal(m.plan_id, 'starter');
  assert.equal(m.stripe_customer_id, 'cus_1');
  assert.ok(m.current_period_end.startsWith('2027'));
});

test('checkout request: subscription mode, trial days, card required by default, account id carried', async () => {
  let seen;
  const stripe = createStripe({ config: { stripeKey: 'sk_test_x', brand: 'B' }, fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' })); } });
  const out = await stripe.createCheckout({ accountId: 'acc1', email: 'a@b.co', priceId: 'price_1', trialDays: 14, planId: 'pro', successUrl: 'https://s', cancelUrl: 'https://c' });
  assert.equal(out.url, 'https://checkout.stripe.com/x');
  const body = decodeURIComponent(seen.init.body);
  assert.match(body, /mode=subscription/);
  assert.match(body, /payment_method_collection=always/);
  assert.match(body, /client_reference_id=acc1/);
  assert.match(body, /trial_period_days\]=14/);
  assert.match(seen.init.headers.Authorization, /^Bearer sk_test_x$/);
});

test('Stripe errors surface as exceptions', async () => {
  const stripe = createStripe({ config: { stripeKey: 'k', brand: 'B' }, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400 }) });
  await assert.rejects(() => stripe.createPortal('cus_x', 'https://r'), /No such price/);
});
