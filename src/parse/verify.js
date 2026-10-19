import { findDates, findAmounts } from './dates.js';
import { confidenceOf } from './rules.js';

const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** True when `quote` appears in `corpus` after whitespace and case are normalized. Empty quotes never verify. */
export function quoteExists(corpus, quote) {
  const q = ws(quote);
  return q.length >= 2 && ws(corpus).includes(q);
}

const isHttpUrl = (u) => { try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; } };

/**
 * Trust nothing the model or the rules produced until it is proven against the message itself:
 * - every field needs a quote that exists in the message;
 * - dates, amounts and links are re-derived from the quote, not from the value that was supplied;
 * - a link must be http(s) and must literally appear in the message.
 * Fields that fail are dropped (set to null). A dropped title drops the whole item.
 * Confidence is recomputed here; the model's own confidence is never used.
 */
export function verifyItem(item, corpus) {
  const dropped = [];
  const out = { title: null, agency: null, deadline: null, solicitation_no: null, prebid: null, url: null, value_stated: null, set_aside: null };
  const keep = (k, v) => { out[k] = v; };
  const bad = (k, why) => { if (item?.[k]) dropped.push(`${k}: ${why}`); };

  const t = item?.title;
  if (t && typeof t.value === 'string' && quoteExists(corpus, t.quote) && t.value.trim().length >= 4) keep('title', { value: t.value.trim().slice(0, 200), quote: String(t.quote).slice(0, 300) });
  else { bad('title', 'no matching quote'); return { item: null, dropped }; }

  const a = item.agency;
  if (a && typeof a.value === 'string' && quoteExists(corpus, a.quote)) keep('agency', { value: a.value.trim().slice(0, 120), quote: String(a.quote).slice(0, 200), jurisdiction: a.jurisdiction ?? null });
  else bad('agency', 'no matching quote');

  const d = item.deadline;
  if (d && quoteExists(corpus, d.quote)) {
    const re = findDates(d.quote)[0];
    if (re) keep('deadline', { iso: re.iso, quote: String(d.quote).slice(0, 200), time_stated: re.time_stated });
    else bad('deadline', 'quote is not a date');
  } else bad('deadline', 'no matching quote');

  const s = item.solicitation_no;
  if (s && typeof s.value === 'string' && quoteExists(corpus, s.quote) && ws(s.quote).includes(ws(s.value))) keep('solicitation_no', { value: s.value.trim().slice(0, 40), quote: String(s.quote).slice(0, 200) });
  else bad('solicitation_no', 'no matching quote');

  const p = item.prebid;
  if (p && quoteExists(corpus, p.quote)) {
    const re = findDates(p.quote)[0];
    if (re) keep('prebid', { iso: re.iso, quote: String(p.quote).slice(0, 200), time_stated: re.time_stated, mandatory: Boolean(p.mandatory) });
    else bad('prebid', 'quote is not a date');
  } else bad('prebid', 'no matching quote');

  const u = item.url;
  if (u && typeof u.value === 'string' && isHttpUrl(u.value) && quoteExists(corpus, u.value)) keep('url', { value: u.value, quote: u.value });
  else bad('url', 'not an http(s) link found in the message');

  const v = item.value_stated;
  if (v && quoteExists(corpus, v.quote)) {
    const re = findAmounts(v.quote)[0];
    if (re) keep('value_stated', { amount: re.amount, quote: String(v.quote).slice(0, 100) });
    else bad('value_stated', 'quote is not an amount');
  } else bad('value_stated', 'no matching quote');

  const sa = item.set_aside;
  if (sa && typeof sa.value === 'string' && quoteExists(corpus, sa.quote)) keep('set_aside', { value: sa.value.trim().slice(0, 80), quote: String(sa.quote).slice(0, 120) });
  else bad('set_aside', 'no matching quote');

  out.confidence = confidenceOf(out);
  return { item: out, dropped };
}

export function verifyItems(items, corpus) {
  const kept = [];
  const dropped = [];
  for (const it of items || []) {
    const r = verifyItem(it, corpus);
    dropped.push(...r.dropped);
    if (r.item) kept.push(r.item);
  }
  return { items: kept, dropped };
}
