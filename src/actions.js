import { deriveTags, updateFeedbackWeights } from './scoring.js';

export const DISPOSITIONS = ['interested', 'not_for_me', 'already_knew'];
export const ACTIONS = ['none', 'contacted', 'bid_submitted', 'won', 'lost'];
export const ACTION_LABELS = { none: 'Not started', contacted: 'Contacted', bid_submitted: 'Bid submitted', won: 'Won', lost: 'Lost' };

/**
 * Records a one-tap answer on a delivered match. Idempotent: repeating the same answer changes nothing.
 * The ranking weights learn from the tags of the project (never from the jurisdiction, which is a hard filter).
 */
export async function applyDisposition(store, { accountId, matchId, disposition, reason = null, now = new Date() }) {
  if (!DISPOSITIONS.includes(disposition)) return null;
  const match = await store.one('matches', { where: { id: matchId, account_id: accountId } });
  if (!match) return null;
  const opp = await store.one('opportunities', { where: { id: match.opportunity_id } });
  if (!opp) return null;
  if (match.disposition === disposition) return { match, opp, changed: false };
  const patch = { disposition, disposition_at: now.toISOString(), ...(reason ? { reason: String(reason).slice(0, 200) } : {}) };
  if (disposition === 'interested') patch.change_alerted_version = opp.version;
  const [updated] = await store.update('matches', { id: match.id }, patch);
  const profile = await store.one('profiles', { where: { account_id: accountId } });
  if (profile) {
    const tags = opp.tags?.length ? opp.tags : deriveTags(opp);
    await store.update('profiles', { account_id: accountId }, { feedback_weights: updateFeedbackWeights(profile.feedback_weights, tags, disposition) });
  }
  await store.insert('events', { name: `tap_${disposition}`, account_id: accountId, props: { source: opp.source, kind: opp.kind } });
  return { match: updated, opp, changed: true };
}

export async function setAction(store, { accountId, matchId, action, note = null, now = new Date() }) {
  if (!ACTIONS.includes(action)) return null;
  const match = await store.one('matches', { where: { id: matchId, account_id: accountId } });
  if (!match) return null;
  const patch = { action, action_at: now.toISOString(), ...(note !== null ? { note: String(note).slice(0, 500) } : {}) };
  // moving something along the pipeline implies interest
  if (action !== 'none' && match.disposition !== 'interested') patch.disposition = 'interested';
  const [updated] = await store.update('matches', { id: match.id }, patch);
  await store.insert('events', { name: `action_${action}`, account_id: accountId, props: {} });
  return updated;
}

/** Features available to an account. A trial includes everything so people can judge the full product. */
export function featuresFor(account, plans) {
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
  if (account.billing_status === 'trialing') return { ...(byId.pro?.features || {}), trialAll: true };
  return byId[account.plan_id]?.features || byId.starter?.features || {};
}

export const hasAccess = (account) => ['trialing', 'active', 'past_due'].includes(account.billing_status);
