import { TRADES, JURISDICTIONS } from './taxonomy.js';

export const DEFAULT_WEIGHTS = { fit: 30, timing: 25, scale: 15, access: 15, evidence: 15 };
export const DEFAULT_THRESHOLDS = { deliver_min: 50, urgent_min: 80, max_items: 5, freshness_days: 45 };

const DAY = 86400000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export const money = (n) =>
  n === null || n === undefined ? 'not stated' : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n).toLocaleString('en-US')}`;

const textMemo = new WeakMap();
export function opportunityText(opp) {
  let t = textMemo.get(opp);
  if (t === undefined) {
    t = [opp.title, opp.scope, opp.work_type, opp.permit_type].filter(Boolean).join(' | ').toLowerCase();
    textMemo.set(opp, t);
  }
  return t;
}

export function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY);
}

export function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (t - now.getTime()) / DAY;
}

/** Plain, stable tags used for de-duplication, display and per-customer learning. */
export function deriveTags(opp) {
  const text = opportunityText(opp);
  const tags = [];
  if (opp.jurisdiction) tags.push(`jur:${opp.jurisdiction}`);
  if (opp.stage) tags.push(`stage:${opp.stage}`);
  const cls =
    /multi.?family|apartment|dwelling units|\d+.?unit/.test(text) ? 'multifamily'
    : /warehouse|industrial|manufactur|distribution/.test(text) ? 'industrial'
    : /restaurant|tea shop|take.?out|cafe|kitchen/.test(text) ? 'restaurant'
    : /medical|clinic|hospital|health|rehab|pharmacy/.test(text) ? 'healthcare'
    : /retail|store|shop|shell\b/.test(text) ? 'retail'
    : /office/.test(text) ? 'office'
    : /school|campus|university|church/.test(text) ? 'institutional'
    : 'other';
  tags.push(`class:${cls}`);
  const type =
    /demoli|wrecking/.test(text) ? 'demolition'
    : /new (building|construction)|ground.?up|shell\b|commercial new/.test(text) ? 'new_build'
    : /addition|expansion/.test(text) ? 'addition'
    : /tenant improvement|remodel|renovat|build.?out|conversion/.test(text) ? 'remodel'
    : 'other';
  tags.push(`type:${type}`);
  const v = num(opp.value);
  const sq = num(opp.sqft);
  const size = v ? (v >= 5e6 ? 'xl' : v >= 1e6 ? 'large' : v >= 2.5e5 ? 'mid' : 'small') : sq ? (sq >= 100000 ? 'xl' : sq >= 20000 ? 'large' : sq >= 5000 ? 'mid' : 'small') : 'unknown';
  tags.push(`size:${size}`);
  return tags;
}

/** Raw fit 0..100 for one trade, with the signal labels that matched. */
export function tradeFit(tradeId, opp) {
  const trade = TRADES[tradeId];
  if (!trade) return { raw: 0, matched: [] };
  const text = opportunityText(opp);
  let raw = 0;
  const matched = [];
  for (const [re, weight, label] of trade.signals) {
    if (re.test(text)) {
      raw += weight;
      matched.push(label);
    }
  }
  for (const [re, weight] of trade.negative || []) if (re.test(text)) raw -= weight;
  const naics = opp.raw?.naics;
  if (naics && trade.naics.includes(String(naics))) {
    raw = Math.max(raw, 80);
    matched.push(`listing NAICS ${naics}`);
  }
  return { raw: clamp(raw, 0, 100), matched };
}

function timingRating(opp, trade, now) {
  if (opp.kind === 'public_bid') {
    const d = daysUntil(opp.deadline, now);
    if (d === null) return { r: 3, note: 'No deadline found in the listing.' };
    if (d >= 14) return { r: 5, note: `Due in ${Math.floor(d)} days.` };
    if (d >= 7) return { r: 4, note: `Due in ${Math.floor(d)} days.` };
    if (d >= 3) return { r: 3, note: `Due in ${Math.floor(d)} days. Tight.` };
    return { r: 2, note: `Due in ${Math.max(0, Math.floor(d))} days. Very tight.` };
  }
  const late = trade?.stageBias === 'late';
  const age = daysSince(opp.issued_date, now);
  if (opp.stage === 'issued' || opp.stage === 'active') {
    if (age === null) return { r: 3, note: 'Issue date not stated.' };
    if (late) return { r: age <= 7 ? 3 : age <= 45 ? 4 : 3, note: `Permit issued ${age} days ago. Service for this trade usually starts later in the build.` };
    return { r: age <= 7 ? 5 : age <= 21 ? 4 : age <= 45 ? 3 : 2, note: `Permit issued ${age} day${age === 1 ? '' : 's'} ago.` };
  }
  if (opp.stage === 'in_review') return { r: late ? 2 : 4, note: 'In plan review. Vendors are often chosen around permit issue.' };
  if (opp.stage === 'planning') return { r: 2, note: 'Planning stage. Early, not yet authorized to build.' };
  return { r: 2, note: 'Stage not clear in the public record.' };
}

function scaleRating(opp) {
  const v = num(opp.value);
  const sq = num(opp.sqft);
  const u = num(opp.units);
  const picks = [];
  if (v) picks.push(v < 5e4 ? 1 : v < 2.5e5 ? 2 : v < 1e6 ? 3 : v < 5e6 ? 4 : 5);
  if (sq) picks.push(sq < 5000 ? 1 : sq < 20000 ? 2 : sq < 50000 ? 3 : sq < 150000 ? 4 : 5);
  if (u) picks.push(u >= 100 ? 5 : u >= 20 ? 4 : u >= 5 ? 3 : 2);
  if (!picks.length) return { r: 2, note: 'Size and value are not stated in the record.' };
  const parts = [];
  if (v) parts.push(`value ${money(v)}`);
  if (sq) parts.push(`${Math.round(sq).toLocaleString('en-US')} sq ft`);
  if (u) parts.push(`${u} units`);
  return { r: Math.max(...picks), note: `Scale from the record: ${parts.join(', ')}.` };
}

function accessRating(opp) {
  if (opp.kind === 'public_bid') return { r: 5, note: `Contact route is the issuing agency (${opp.agency || 'agency'}).` };
  if (opp.gc_name) return { r: 5, note: `Contractor named in the public record: ${opp.gc_name}.` };
  if (opp.applicant) return { r: 3, note: 'Only an applicant is named. Confirm who runs the project.' };
  return { r: 1, note: 'No business is named yet.' };
}

function evidenceRating(opp) {
  if (opp.owner_account_id) return { r: 3, note: 'Taken from an email you forwarded. The dates and link come from that email; confirm them on the listing.' };
  if (opp.is_sample) return { r: 4, note: 'Official record link and ID from a dated research snapshot.' };
  if (opp.url && opp.source_id) return { r: 5, note: 'Official record link and ID on file.' };
  if (opp.kind === 'manual') return { r: 3, note: 'Entered by BuildSignal staff. Check the linked source.' };
  return { r: 2, note: 'No official link on file.' };
}

/** Per-customer learning. Weights map tag -> delta points, capped so feedback can never dominate. */
export function feedbackAdjustment(tags, weights) {
  const w = weights || {};
  const parts = [];
  let total = 0;
  for (const t of tags) {
    const d = num(w[t]);
    if (d) {
      total += d;
      parts.push({ tag: t, delta: d });
    }
  }
  return { points: clamp(Math.round(total * 10) / 10, -10, 10), parts };
}

export function updateFeedbackWeights(weights, tags, disposition) {
  const delta = disposition === 'interested' ? 1.5 : disposition === 'not_for_me' ? -2 : 0;
  const next = { ...(weights || {}) };
  if (!delta) return next;
  for (const t of tags) {
    if (t.startsWith('jur:')) continue; // territory is a hard filter, not a taste signal
    next[t] = clamp(Math.round(((num(next[t]) || 0) + delta) * 10) / 10, -6, 6);
  }
  return next;
}

export function buildChecklist(profile, opp, ctx) {
  const items = [];
  const now = ctx.now;
  const jl = JURISDICTIONS[opp.jurisdiction]?.label || opp.jurisdiction || 'your service area';
  // Territory
  if (opp.owner_account_id && !opp.jurisdiction) items.push({ key: 'territory', label: 'Territory', status: 'yellow', reason: 'The email you forwarded does not name a city we recognise. Check the location in the solicitation.' });
  else if (opp.jurisdiction === 'statewide') items.push({ key: 'territory', label: 'Territory', status: 'yellow', reason: 'Statewide or federal listing. Check the place of performance in the documents.' });
  else if (profile.zips?.length && !opp.zip) items.push({ key: 'territory', label: 'Territory', status: 'yellow', reason: `In ${jl}, which is in your service area. The public record has no ZIP code, so confirm the location is in your ZIPs.` });
  else items.push({ key: 'territory', label: 'Territory', status: 'green', reason: `In ${jl}${opp.zip ? ` (${opp.zip})` : ''}, which is in your service area.` });
  // Size
  const v = num(opp.value);
  if (!v) items.push({ key: 'size', label: 'Job size', status: 'yellow', reason: 'Value is not stated in the public record, so size is unconfirmed.' });
  else items.push({ key: 'size', label: 'Job size', status: 'green', reason: (num(profile.min_value) !== null || num(profile.max_value) !== null) ? `${money(v)} is inside your job-size range. Permit values are not contract prices.` : `${money(v)} stated in the record (you have no size limits set). Permit values are not contract prices.` });
  // Timing
  const t = timingRating(opp, ctx.trade, now);
  items.push({ key: 'timing', label: 'Timing', status: t.r >= 4 ? 'green' : t.r === 3 ? 'yellow' : 'red', reason: t.note });
  // License
  if (!profile.license_number) items.push({ key: 'license', label: 'Your license', status: 'red', reason: 'Add your ROC license number. Every draft shows it, and you should not quote without one.' });
  else items.push({ key: 'license', label: 'Your license', status: 'yellow', reason: `License ${profile.license_number} is on file but unverified. Confirm status and classification on the official ROC lookup before you quote.` });
  if (opp.kind === 'public_bid') {
    const sa = opp.raw?.setAside;
    if (sa) {
      const mine = (profile.certifications || []).join(' ').toLowerCase().replace(/_/g, ' ');
      const ok = /small/i.test(sa) ? /small/.test(mine) : mine.split(' ').some((w) => w.length > 3 && sa.toLowerCase().includes(w));
      items.push({ key: 'setaside', label: 'Set-aside', status: ok ? 'green' : 'red', reason: ok ? `Set aside for "${sa}". Your profile lists a matching certification (unverified).` : `Set aside for "${sa}". Your profile does not list a matching certification.` });
    } else items.push({ key: 'setaside', label: 'Set-aside', status: 'yellow', reason: 'No set-aside stated in the listing.' });
    items.push({ key: 'requirements', label: 'Bonding, insurance, prevailing wage, pre-bid meeting', status: 'yellow', reason: opp.owner_account_id ? 'Not found in the email you forwarded. Read the solicitation documents before you commit.' : 'Not found in the listing text BuildSignal holds. Read the solicitation documents before you commit.' });
  } else {
    items.push({ key: 'contact', label: 'Who to call', status: opp.gc_name ? 'green' : 'yellow', reason: opp.gc_name ? `${opp.gc_name} is named in the public record. Ask for their subcontractor or vendor contact.` : 'No contractor is named yet. Try the applicant or the city project record.' });
    items.push({ key: 'paperwork', label: 'Bonding and insurance', status: 'yellow', reason: 'Private project. The general contractor sets insurance and paperwork. Ask when you call.' });
  }
  return items;
}

/**
 * Deterministic fit and eligibility. Returns { eligible, excludedReason, score, factors, checklist, tags, tradeId, why }.
 * ctx: { now?, weights?, thresholds? }
 */
export function evaluate(profile, opp, ctx = {}) {
  const now = ctx.now || new Date();
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };
  const th = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds || {}) };
  const tags = opp.tags?.length ? opp.tags : deriveTags(opp);
  const out = (reason) => ({ eligible: false, excludedReason: reason, score: 0, factors: [], checklist: [], tags, tradeId: null, why: '' });

  if (opp.status && opp.status !== 'active') return out('inactive');
  if (opp.permit_type === 'RES' || opp.raw?.new_residential_permit === 'Y') return out('residential permits are out of scope');
  if (opp.stage === 'completed') return out('project already completed');
  if (opp.kind === 'permit_lead') {
    const age = daysSince(opp.issued_date, now);
    if (opp.stage === 'issued' && age !== null && age > th.freshness_days) return out('permit older than freshness window');
  }
  if (opp.kind === 'public_bid') {
    const d = daysUntil(opp.deadline, now);
    if (d !== null && d < 0) return out('deadline passed');
  }
  const juris = profile.jurisdictions || [];
  // An item the customer forwarded themselves with no place named is kept; the checklist says the location is unconfirmed.
  const unplacedForward = Boolean(opp.owner_account_id) && !opp.jurisdiction;
  if (juris.length && !unplacedForward && opp.jurisdiction !== 'statewide' && !juris.includes(opp.jurisdiction)) return out('outside your territory');
  const zips = profile.zips || [];
  if (zips.length && opp.zip && !zips.includes(String(opp.zip))) return out('outside your ZIP codes');
  const v = num(opp.value);
  if (v) {
    const min = num(profile.min_value);
    const max = num(profile.max_value);
    if (min !== null && v < min) return out('below your minimum job size');
    if (max !== null && v > max) return out('above your maximum job size');
  }

  let best = { tradeId: null, raw: -1, matched: [] };
  for (const tId of profile.trades || []) {
    const f = tradeFit(tId, opp);
    if (f.raw > best.raw) best = { tradeId: tId, ...f };
  }
  if (!best.tradeId || best.raw < 15) return out('no signal for your trades');
  const trade = TRADES[best.tradeId];

  const rt = { fit: { r: Math.round((best.raw / 20) * 10) / 10, note: `${trade.label}: ${best.matched.join(', ') || 'listing match'}.` }, timing: timingRating(opp, trade, now), scale: scaleRating(opp), access: accessRating(opp), evidence: evidenceRating(opp) };
  const factors = Object.keys(rt).map((k) => ({
    key: k,
    label: { fit: 'Trade fit', timing: 'Timing', scale: 'Scale', access: 'Who to call', evidence: 'Evidence' }[k],
    rating: rt[k].r,
    weight: weights[k],
    points: Math.round(((weights[k] * rt[k].r) / 5) * 10) / 10,
    note: rt[k].note,
    kind: k === 'fit' || k === 'timing' ? 'inference' : 'fact',
  }));
  let score = factors.reduce((s, f) => s + f.points, 0);
  const adj = feedbackAdjustment(tags, profile.feedback_weights);
  if (adj.points) {
    factors.push({ key: 'learned', label: 'Your past taps', rating: null, weight: null, points: adj.points, note: `Adjusted ${adj.points > 0 ? 'up' : 'down'} from what you marked before (${adj.parts.map((p) => p.tag.split(':')[1]).join(', ')}).`, kind: 'learned' });
    score += adj.points;
  }
  score = Math.round(clamp(score, 0, 100));
  const checklist = buildChecklist(profile, opp, { now, trade });
  return { eligible: true, excludedReason: null, score, factors, checklist, tags, tradeId: best.tradeId, why: whyItFits(trade, opp, best, rt, now) };
}

export function whyItFits(trade, opp, best, rt, now = new Date()) {
  const bits = [`Your trade: ${trade.label}.`];
  if (best.matched.length) bits.push(`The record points to ${best.matched.slice(0, 3).join(', ')}.`);
  bits.push(rt.timing.note);
  if (opp.gc_name) bits.push(`${opp.gc_name} is named in the record.`);
  return bits.join(' ');
}

/**
 * Pick up to max_items for a digest: open bids before permit leads (a permit lead names a GC who may already have
 * the job; an open bid is a live chance to respond), then best score first, one item per project family.
 */
const tier = (opp) => (opp.kind === 'permit_lead' ? 1 : 0);

export function selectForDigest(evals, { maxItems = 5, deliverMin = 50 } = {}) {
  const seenFamilies = new Set();
  const picked = [];
  const sorted = [...evals].filter((e) => e.eval.eligible && e.eval.score >= deliverMin).sort((a, b) => tier(a.opp) - tier(b.opp) || b.eval.score - a.eval.score);
  for (const e of sorted) {
    const fam = e.opp.parent_key || e.opp.id;
    if (seenFamilies.has(fam)) continue;
    seenFamilies.add(fam);
    picked.push(e);
    if (picked.length >= maxItems) break;
  }
  return picked;
}
