import { findDates, findAmounts } from './dates.js';
import { findAgency } from './agencies.js';

/**
 * Tier 2: generic rules for alert emails. Every field returned carries the exact `quote` it was read from,
 * so the verifier (verify.js) can prove it exists in the message. Pure; no network.
 */
export const BID_NOUN = /\b(bid|bids|rfp|rfq|ifb|itb|rfi|solicitation|invitation|project|proposal|quote|quotation|procurement|contract)\b/i;
const GENERIC_SUBJECT = /^(?:new\s+)?(?:bid|bids|solicitations?|opportunit(?:y|ies)|notifications?|alerts?|daily|weekly|your|bid alerts?|bid opportunit(?:y|ies)|new bid opportunit(?:y|ies)|saved search)(?:\s+(?:alert|alerts|digest|summary|notification|notifications|opportunit(?:y|ies)|results|update|updates))*\s*$/i;
const BOILERPLATE = /^(?:you are receiving|to unsubscribe|unsubscribe|view (?:this )?(?:email )?in (?:your )?browser|click here|sent to|manage (?:your )?(?:preferences|subscription)|this (?:email|message) (?:was|is)|powered by|copyright|©|forwarded message|from:|to:|date:|subject:|sent:|cc:)/i;

const TRIGGER_STRONG = /\b(?:bids?\s+(?:are\s+)?(?:due|close[sd]?|closing|opening|deadline)|proposals?\s+(?:are\s+)?due|responses?\s+(?:are\s+)?due|submittals?\s+(?:are\s+)?due|submission\s+deadline|submittal\s+deadline|closing\s+date|due\s+date|bid\s+date|closes?|closing|deadline|due)\b/gi;
const NOT_DEADLINE_BEFORE = /(?:questions?|rfis?|inquir(?:y|ies)|addend(?:a|um)|clarifications?|registration|register|published|posted|issued|release[ds]?)[^\n]{0,30}$/i;
const PREBID = /\b(?:pre-?\s?bid|pre-?\s?proposal|pre-?\s?submittal|mandatory\s+(?:pre-?\s?bid\s+)?(?:meeting|conference)|site\s+(?:walk|visit|tour)|job\s*walk)\b/gi;
const SOL_LABEL = /\b(?:bid|solicitation|rfp|rfq|ifb|itb|project|contract|reference|event)\s*(?:no\.?|number|num\.?|#|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/.]{2,28})/gi;
const SOL_BARE = /\b((?:RFP|RFQ|IFB|ITB|CIP|BID)[-\s]?\d{2,4}[-\s]?\d{2,6}|[A-Z]{1,4}\d{2}-\d{3,6})\b/g;
const VALUE_TRIGGER = /\b(?:estimated|estimate|engineer'?s\s+estimate|budget|construction\s+(?:cost|budget|value)|project\s+value|contract\s+value|value|not\s+to\s+exceed|approx(?:imately)?)\b/i;
const SET_ASIDE = /\b(?:small\s+business|sbe|dbe|mbe|wbe|dvbe|veteran(?:-|\s)owned|sdvosb|hubzone|8\(a\)|woman(?:-|\s)owned|minority(?:-|\s)owned|local\s+(?:business|vendor)\s+preference)\b/i;
const SET_ASIDE_CTX = /set[- ]?aside|reserved|restricted|only|preference|requirement|goal/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export const OFFICIAL_HOSTS = ['app.az.gov', 'procure.az.gov', 'bidnetdirect.com', 'planhub.com', 'buildingconnected.com', 'bonfirehub.com', 'procurement.opengov.com', 'publicpurchase.com', 'sam.gov', 'periscopeholdings.com', 'euna.com', 'opengov.com', 'questcdn.com', 'procorenet.com'];
const TRACKING = /unsubscribe|optout|opt-out|preferences|list-manage|mailchimp|sendgrid|click\.|track|pixel|\/open\b|mailto:|privacy|terms|facebook\.com|linkedin\.com|twitter\.com|x\.com/i;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isOfficialHost = (h) => h.endsWith('.gov') || h.endsWith('.az.us') || OFFICIAL_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, '');

/** Plain-language cleanup of a forwarded subject line. */
export function cleanSubject(subject) {
  let s = String(subject || '').trim();
  for (let i = 0; i < 4; i++) s = s.replace(/^\s*(?:fwd?|re|fw)\s*:\s*/i, '').replace(/^\s*\[[^\]]{1,20}\]\s*/, '');
  s = s.replace(/^\s*(?:new\s+)?(?:bid|solicitation|rfp|opportunity|notice)(?:\s+(?:alert|opportunity|notice|notification))?\s*[:\-–]\s*/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

const FIELD_LINE = /^(?:agency|bid\s*(?:no|number|#)|solicitation|rfp|rfq|ifb|itb|project\s*(?:no|number|#)|closing|close|due|bids?\s+(?:due|close)|deadline|issued by|buyer|owner|department|pre-?bid|estimated|budget|posted|status)\b/i;
const GREETING = /^(?:hello|hi|hey|dear|good\s+(?:morning|afternoon)|thanks|thank you)\b/i;
const looksLikeSentence = (l) => /[.!?]$/.test(l) || /\b(?:your saved search|your search|matches your|you (?:have|are|can|may)|please|click|attached)\b/i.test(l);

function usableLine(raw) {
  const line = raw.replace(/^[\s>*\-•#\d.)]+/, '').trim();
  if (line.length < 8 || line.length > 200 || BOILERPLATE.test(line) || GREETING.test(line) || FIELD_LINE.test(line) || looksLikeSentence(line) || /^https?:/i.test(line)) return null;
  return line;
}

function pickTitle(subject, text) {
  const cleaned = cleanSubject(subject);
  if (cleaned.length >= 8 && !GENERIC_SUBJECT.test(cleaned)) return { value: cleaned.slice(0, 200), quote: cleaned.slice(0, 200), from: 'subject' };
  const lines = String(text || '').split('\n');
  // Best signal: the last usable line just above the first labelled field (agency, bid number, due date).
  const firstField = lines.findIndex((l) => FIELD_LINE.test(l.replace(/^[\s>*\-•#\d.)]+/, '').trim()));
  if (firstField > 0) {
    for (let i = firstField - 1; i >= Math.max(0, firstField - 3); i--) {
      const line = usableLine(lines[i]);
      if (line) return { value: line, quote: line, from: 'body' };
    }
  }
  for (const raw of lines) {
    const line = usableLine(raw);
    if (line && BID_NOUN.test(line)) return { value: line, quote: line, from: 'body' };
  }
  return null;
}

function firstDateAfter(text, from, span, dates) {
  return dates.find((d) => d.index >= from && d.index <= from + span);
}

function pickDeadline(text, dates, receivedAt) {
  if (!dates.length) return null;
  const recv = receivedAt ? Date.parse(receivedAt) : Date.now();
  const lo = recv - 400 * 86400000;
  const hi = recv + 400 * 86400000;
  const ok = (d) => { const t = Date.parse(d.iso); return t >= lo && t <= hi; };
  const found = [];
  for (const m of text.matchAll(TRIGGER_STRONG)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (NOT_DEADLINE_BEFORE.test(before)) continue;
    const trigEnd = m.index + m[0].length;
    let d = firstDateAfter(text, trigEnd, 90, dates);
    if (!d) {
      // "10/27/2026 - Bid Due" style: a date shortly before the trigger on the same line
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      d = dates.filter((x) => x.end <= m.index && x.index >= lineStart && m.index - x.end <= 40).pop();
    }
    if (d && ok(d)) found.push({ d, trigger: m[0], at: m.index });
  }
  if (!found.length) return null;
  const future = found.filter((f) => Date.parse(f.d.iso) >= recv - 86400000);
  const pick = (future.length ? future : found)[0];
  return { iso: pick.d.iso, quote: pick.d.quote, time_stated: pick.d.time_stated, trigger: pick.trigger };
}

function pickPrebid(text, dates, receivedAt) {
  const recv = receivedAt ? Date.parse(receivedAt) : Date.now();
  for (const m of text.matchAll(PREBID)) {
    const d = firstDateAfter(text, m.index + m[0].length, 120, dates);
    if (!d) continue;
    const t = Date.parse(d.iso);
    if (t < recv - 400 * 86400000 || t > recv + 400 * 86400000) continue;
    const ctx = text.slice(Math.max(0, m.index - 30), d.end);
    return { iso: d.iso, quote: d.quote, time_stated: d.time_stated, mandatory: /mandatory/i.test(ctx) && !/non-?\s?mandatory|optional/i.test(ctx) };
  }
  return null;
}

function pickSolicitationNo(text) {
  for (const m of text.matchAll(SOL_LABEL)) {
    const v = m[1].replace(/[.,;:]+$/, '');
    if (/\d/.test(v) && !/^\d{1,2}$/.test(v)) return { value: v, quote: m[0].trim() };
  }
  const bare = SOL_BARE.exec(text);
  SOL_BARE.lastIndex = 0;
  return bare ? { value: bare[1].trim(), quote: bare[1] } : null;
}

function pickUrl(text) {
  const urls = [...text.matchAll(URL_RE)].map((m) => trimUrl(m[0])).filter((u) => u.length <= 500);
  const official = urls.find((u) => isOfficialHost(hostOf(u)) && !/unsubscribe|optout|preferences|privacy|terms/i.test(u));
  if (official) return { value: official, quote: official };
  const plain = urls.find((u) => !TRACKING.test(u));
  return plain ? { value: plain, quote: plain } : null;
}

function pickValue(text) {
  for (const a of findAmounts(text)) {
    const around = text.slice(Math.max(0, a.index - 70), a.index + 10);
    if (VALUE_TRIGGER.test(around)) return { amount: a.amount, quote: a.quote };
  }
  return null;
}

function pickSetAside(text) {
  for (const line of text.split('\n')) {
    const m = SET_ASIDE.exec(line);
    if (m && SET_ASIDE_CTX.test(line)) return { value: m[0], quote: m[0] };
  }
  return null;
}

/** Score the fields that were found and verified. Weights are starting values, tuned against the evaluation set. */
export const CONFIDENCE_WEIGHTS = { title: 0.25, deadline: 0.30, url: 0.20, agency: 0.15, solicitation_no: 0.10 };
export function confidenceOf(item) {
  let c = 0;
  for (const [k, w] of Object.entries(CONFIDENCE_WEIGHTS)) if (item[k]) c += w;
  return Math.round(c * 100) / 100;
}

function extractOne({ subject, text: bodyText, receivedAt, titleOverride }) {
  // A single-bid message may state fields in the subject too; a block inside a digest has no subject of its own.
  const text = titleOverride ? bodyText : `${subject ? `${subject}\n` : ''}${bodyText}`;
  const dates = findDates(text);
  const title = titleOverride || pickTitle(subject, bodyText);
  if (!title) return null;
  const agency = findAgency(text);
  const deadline = pickDeadline(text, dates, receivedAt);
  const item = {
    title: { value: title.value, quote: title.quote },
    agency: agency ? { value: agency.value, quote: agency.quote, jurisdiction: agency.jurisdiction } : null,
    deadline: deadline ? { iso: deadline.iso, quote: deadline.quote, time_stated: deadline.time_stated } : null,
    solicitation_no: pickSolicitationNo(text),
    prebid: pickPrebid(text, dates, receivedAt),
    url: pickUrl(text),
    value_stated: pickValue(text),
    set_aside: pickSetAside(text),
  };
  // Nothing bid-like anywhere (no noun in the title, no deadline, no solicitation number): not an alert.
  if (!item.deadline && !item.solicitation_no && !item.url?.value.match(/bid|solicit|procure|rfp|rfq|ifb/i) && !BID_NOUN.test(title.value) && !BID_NOUN.test(subject || '')) return null;
  item.confidence = confidenceOf(item);
  return item;
}

/** Splits a multi-bid digest into blocks. Only blocks that carry their own deadline date count as a bid. */
export function splitBlocks(text, receivedAt) {
  const raw = String(text || '').split(/\n\s*(?:[-=_*]{3,}|\n)\s*/).map((b) => b.trim()).filter((b) => b.length > 20);
  const blocks = raw.filter((b) => {
    if (!BID_NOUN.test(b)) return false;
    return Boolean(pickDeadline(b, findDates(b), receivedAt));
  });
  return blocks.length >= 2 ? blocks : null;
}

/**
 * @returns {{ items: object[], notes: string[] }}
 */
export function extractByRules({ subject, text, receivedAt }) {
  const notes = [];
  const body = String(text || '');
  const blocks = splitBlocks(body, receivedAt);
  if (blocks) {
    const items = [];
    for (const b of blocks) {
      const lines = b.split('\n').map((l) => l.replace(/^[\s>*\-•#\d.)]+/, '').trim()).filter(Boolean);
      const titleLine = lines.map((l) => usableLine(l)).find(Boolean) || lines.find((l) => BID_NOUN.test(l) && l.length <= 200);
      const it = extractOne({ subject, text: b, receivedAt, titleOverride: titleLine ? { value: titleLine, quote: titleLine } : null });
      if (it) items.push(it);
    }
    notes.push(`split into ${items.length} items`);
    return { items: items.slice(0, 8), notes };
  }
  const it = extractOne({ subject, text: body, receivedAt });
  return { items: it ? [it] : [], notes };
}
