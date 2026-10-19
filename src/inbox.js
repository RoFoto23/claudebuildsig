import { randomBytes } from 'node:crypto';
import { sha256hex } from './crypto.js';
import { finalize, clip } from './adapters/util.js';
import { upsertOpportunities } from './ingest.js';
import { parseMessage } from './parse/index.js';
import { findAgency } from './parse/agencies.js';
import { pool, log } from './jobs.js';
import { selectAll } from './time.js';

/**
 * Forwarded-alert inbox. A contractor forwards alert emails to a private address; we fetch the message from
 * Resend, read it (templates -> rules -> optional model), and store the result as an opportunity that only that
 * account can ever see. See docs/inbox-detailed-design.md for the state machine and docs/LOGIC_AND_OBSERVABILITY.md
 * for the log events. Mail content is untrusted data: it is never executed, never fetched, and always escaped on output.
 */

export const MAX_ATTEMPTS = 5;
export const BACKOFF_MIN = [5, 30, 120, 600]; // minutes after failed attempt 1..4; the 5th failure is final
const LEASE_MIN = 10;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const LOCAL_RE = /^alerts-[a-z2-7]{26}$/;

/* ---------------- settings ---------------- */
const SETTING_DEFAULTS = { 'inbox.enabled': false, 'inbox.daily_limit': 40, 'inbox.max_chars': 20000, 'inbox.parse_threshold': 0.6 };
export async function inboxSettings(store) {
  const rows = await store.select('settings', { where: { key: { like: 'inbox.*' } } });
  const m = { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return {
    enabled: m['inbox.enabled'] === true,
    dailyLimit: Number(m['inbox.daily_limit']) > 0 ? Number(m['inbox.daily_limit']) : 40,
    maxChars: Number(m['inbox.max_chars']) > 1000 ? Number(m['inbox.max_chars']) : 20000,
    threshold: Number(m['inbox.parse_threshold']) > 0 ? Number(m['inbox.parse_threshold']) : 0.6,
  };
}

/* ---------------- addresses ---------------- */
/** 'alerts-' + 26 base32 characters = 130 bits of randomness. */
export function newLocalPart(rb = randomBytes) {
  const bytes = rb(17);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length && out.length < 26; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return `alerts-${out}`;
}

export const addressOf = (config, local) => `${local}@${config.inboundDomain}`;

/** Revokes any active address and issues a new one. Returns { local_part, address }. */
export async function issueAddress(store, config, accountId, now = new Date()) {
  if (!config.inboundDomain) throw new Error('INBOUND_DOMAIN is not configured');
  await store.update('inbox_addresses', { account_id: accountId, revoked_at: null }, { revoked_at: now.toISOString() });
  const [row] = await store.insert('inbox_addresses', { account_id: accountId, local_part: newLocalPart() });
  return { local_part: row.local_part, address: addressOf(config, row.local_part) };
}

export async function activeAddress(store, config, accountId) {
  const row = await store.one('inbox_addresses', { where: { account_id: accountId, revoked_at: null }, order: 'created_at.desc' });
  return row ? { local_part: row.local_part, address: addressOf(config, row.local_part) } : null;
}

const bare = (a) => {
  const m = /<([^>]+)>/.exec(String(a || ''));
  return (m ? m[1] : String(a || '')).trim().toLowerCase();
};
export const domainOf = (addr) => { const b = bare(addr); const i = b.lastIndexOf('@'); return i > 0 ? b.slice(i + 1) : ''; };

/** First recipient that is one of our active inbox addresses -> { accountId, localPart } or null. */
export async function resolveAccount(store, config, recipients) {
  for (const r of recipients || []) {
    const b = bare(r);
    const i = b.lastIndexOf('@');
    if (i < 1) continue;
    const local = b.slice(0, i);
    if (b.slice(i + 1) !== config.inboundDomain || !LOCAL_RE.test(local)) continue;
    const row = await store.one('inbox_addresses', { where: { local_part: local, revoked_at: null } });
    if (row) return { accountId: row.account_id, localPart: local };
  }
  return null;
}

/* ---------------- webhook intake ---------------- */
/**
 * Called by the Resend webhook for `email.received` (signature already verified).
 * Always answers with a 200-style result so senders learn nothing and Resend does not retry rejects.
 * @returns {Promise<{ ok: true, result: string, message?: object }>}
 */
export async function acceptInbound(ctx, event) {
  const { store, config } = ctx;
  const d = event.data || {};
  const reject = (reason, extra = {}) => { log({ event: 'inbox.rejected', reason, ...extra }); return { ok: true, result: reason }; };
  const settings = await inboxSettings(store);
  if (!settings.enabled || !config.has.inbox) return reject('disabled');
  if (!d.email_id) return reject('no_email_id');
  const target = await resolveAccount(store, config, [...(d.received_for || []), ...(d.to || [])]);
  if (!target) return reject('unknown_address', { to_hash: sha256hex((d.to || []).join(',')).slice(0, 12) });
  const acct = await store.one('accounts', { where: { id: target.accountId }, columns: 'id,status,billing_status' });
  if (!acct || acct.status !== 'active' || !['trialing', 'active'].includes(acct.billing_status)) return reject('inactive_account', { account: target.accountId });
  const within = await ctx.limit(`inbox:${target.accountId}`, settings.dailyLimit, 86400);
  if (!within) return reject('daily_limit', { account: target.accountId });
  const [row] = await store.insert('inbound_messages', {
    account_id: target.accountId,
    provider_email_id: String(d.email_id),
    from_domain: domainOf(d.from) || null,
    subject: clip(d.subject, 300),
  }, { ignoreDuplicates: true });
  if (!row) { log({ event: 'inbox.duplicate', provider_email_id: String(d.email_id) }); return { ok: true, result: 'duplicate' }; }
  log({ event: 'inbox.received', message_id: row.id, account: target.accountId, provider_email_id: row.provider_email_id, from_domain: row.from_domain });
  return { ok: true, result: 'accepted', message: row };
}

/* ---------------- fetching and cleaning ---------------- */
export async function fetchReceived(config, fetchImpl, emailId, timeoutMs = 10000) {
  const res = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`, {
    headers: { authorization: `Bearer ${config.resendKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const e = new Error(`resend receiving fetch -> ${res.status}`);
    e.code = `fetch_${res.status}`;
    throw e;
  }
  const j = await res.json();
  return {
    text: typeof j.text === 'string' ? j.text : '',
    html: typeof j.html === 'string' ? j.html : '',
    from: j.from || '',
    subject: j.subject || '',
    authentication: j.authentication || null,
    attachments: Array.isArray(j.attachments) ? j.attachments.length : 0,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
const decodeEntities = (s) => s
  .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

// Control characters and bidirectional/zero-width controls are removed: they hide text from reviewers and can reorder displayed text.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => {
    const l = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return l && l !== href ? `${l} (${href})` : href;
  });
  s = s.replace(/<\s*br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|ul|ol|section|article)\s*>/gi, '\n').replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s);
}

/** Plain text for parsing and display. Prefers the text part; falls back to the HTML part; caps the length. */
export function toPlainText(text, html, maxChars = 20000) {
  let s = String(text || '');
  if (s.replace(/\s/g, '').length < 20 && html) s = htmlToText(html);
  s = s.replace(INVISIBLE, '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, maxChars);
}

/** 'forward_confirmation' | 'ignored' | 'alert'. The confirmation-code pattern is unverified against a real Gmail message (task T13). */
export function classify(subject, fromDomain, text) {
  const s = String(subject || '');
  if (/forwarding confirmation/i.test(s) || (/(^|\.)google\.com$/.test(fromDomain || '') && /confirmation code/i.test(text || ''))) {
    const m = /confirmation code[^0-9]{0,40}(\d{6,10})/i.exec(text || '') || /\b(\d{9})\b/.exec(text || '');
    return { kind: 'forward_confirmation', code: m ? m[1] : null };
  }
  if (/^(automatic reply|auto-?reply|out of office|undeliverable|delivery status notification|mail delivery)/i.test(s) || String(text || '').replace(/\s/g, '').length < 15) return { kind: 'ignored', code: null };
  return { kind: 'alert', code: null };
}

/* ---------------- opportunities from parsed items ---------------- */
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const solKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokens = (s) => new Set(normKey(s).split(' ').filter((w) => w.length > 2));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Identity of a forwarded bid: agency + solicitation number, or agency + normalized title. A moved deadline is a new VERSION, not a new item. */
export function forwardedSourceId(accountId, item) {
  const base = `${normKey(item.agency?.value)}|${item.solicitation_no ? solKey(item.solicitation_no.value) : normKey(item.title.value)}`;
  return `fw:${accountId}:${sha256hex(base).slice(0, 20)}`;
}

export function itemToOpportunity(accountId, item, msg, body) {
  const prov = {};
  for (const k of ['title', 'agency', 'deadline', 'solicitation_no', 'prebid', 'url', 'value_stated', 'set_aside']) {
    if (item[k]) prov[k] = { quote: item[k].quote, source: item.staff ? 'staff' : 'email', ...(k === 'deadline' || k === 'prebid' ? { time_stated: item[k].time_stated } : {}) };
  }
  const opp = finalize({
    source: 'forwarded',
    source_id: forwardedSourceId(accountId, item),
    kind: 'public_bid',
    title: clip(item.title.value, 200),
    agency: item.agency?.value ?? null,
    jurisdiction: item.agency?.jurisdiction ?? null,
    stage: 'open_bid',
    value: item.value_stated?.amount ?? null,
    deadline: item.deadline?.iso ?? null,
    url: item.url?.value ?? null,
    scope: clip(body, 400),
    owner_account_id: accountId,
    provenance: prov,
    also_seen_via: [],
    raw: {
      forwarded: true,
      sender_domain: msg.from_domain || null,
      message_id: msg.id,
      solicitation_no: item.solicitation_no?.value ?? null,
      setAside: item.set_aside?.value ?? null,
      prebid: item.prebid ? { iso: item.prebid.iso, mandatory: item.prebid.mandatory, time_stated: item.prebid.time_stated } : null,
      deadline_time_stated: item.deadline ? item.deadline.time_stated : null,
    },
  });
  // Scope text and tracking links differ between re-forwards of the same alert; only real field changes should make a new version.
  opp.fingerprint = sha256hex(JSON.stringify(['fw', opp.title, opp.deadline, opp.value, opp.status]));
  return opp;
}

/** Same-account duplicate check across senders: same solicitation number, or near-identical title with deadlines within 24 hours. */
export function findDuplicate(existing, opp) {
  const sol = opp.raw?.solicitation_no ? solKey(opp.raw.solicitation_no) : null;
  const tk = tokens(opp.title);
  for (const e of existing) {
    if (e.id === opp.id) continue;
    if (sol && e.raw?.solicitation_no && solKey(e.raw.solicitation_no) === sol) return e;
    const close = !opp.deadline || !e.deadline ? false : Math.abs(Date.parse(opp.deadline) - Date.parse(e.deadline)) <= 86400000;
    if (close && jaccard(tk, tokens(e.title)) >= 0.9) return e;
  }
  return null;
}

/** Stores items as private opportunities. Returns the opportunity ids (new, merged, or re-seen). */
export async function saveForwarded(store, accountId, items, msg, body, now = new Date()) {
  const nowIso = now.toISOString();
  const existing = await store.select('opportunities', { where: { owner_account_id: accountId, status: 'active' }, columns: 'id,source_id,title,deadline,raw,also_seen_via' });
  const ids = [];
  const fresh = [];
  for (const it of items) {
    const opp = itemToOpportunity(accountId, it, msg, body);
    const same = existing.find((e) => e.source_id === opp.source_id);
    if (same) {
      // The same bid arriving again (maybe from another sender): keep the first sender as the origin and note the others.
      const origin = same.raw?.sender_domain || msg.from_domain || null;
      const via = new Set(same.also_seen_via || []);
      if (msg.from_domain && origin && msg.from_domain !== origin) via.add(msg.from_domain);
      opp.also_seen_via = [...via];
      opp.raw = { ...opp.raw, sender_domain: origin };
      if (via.size !== (same.also_seen_via || []).length) await store.update('opportunities', { id: same.id }, { also_seen_via: [...via] });
      fresh.push(opp); ids.push(same.id); continue;
    }
    const dup = findDuplicate(existing, opp);
    if (dup) {
      const via = new Set([...(dup.also_seen_via || [])]);
      if (msg.from_domain) via.add(msg.from_domain);
      await store.update('opportunities', { id: dup.id }, { also_seen_via: [...via], last_seen: nowIso });
      ids.push(dup.id);
      continue;
    }
    fresh.push(opp);
    existing.push({ id: `pending:${opp.source_id}`, source_id: opp.source_id, title: opp.title, deadline: opp.deadline, raw: opp.raw, also_seen_via: [] });
  }
  if (fresh.length) {
    await upsertOpportunities(store, fresh, now);
    const rows = await store.select('opportunities', { where: { source: 'forwarded', source_id: { in: fresh.map((f) => f.source_id) }, owner_account_id: accountId }, columns: 'id,source_id' });
    for (const r of rows) if (!ids.includes(r.id)) ids.push(r.id);
  }
  return ids;
}

/* ---------------- processing state machine ---------------- */
function nextAttemptAfter(attempts, now) {
  const mins = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1];
  return new Date(now.getTime() + mins * 60000).toISOString();
}

/**
 * Advances one message as far as it can go. Never throws: a failure becomes a retry (or `failed` on the 5th attempt).
 * deps: { store, config, fetchImpl, now: Date, llm?, alert?(subject, body, key) }
 * @returns {Promise<string>} the message status afterwards
 */
export async function processMessage(deps, rowIn) {
  const { store, config, fetchImpl, llm = null } = deps;
  const now = deps.now instanceof Date ? deps.now : new Date();
  let row = rowIn;
  const move = async (patch, to, extra = {}) => {
    const from = row.status;
    const [updated] = await store.update('inbound_messages', { id: row.id }, patch);
    row = updated || { ...row, ...patch };
    log({ event: 'inbox.state', message_id: row.id, account: row.account_id, state_from: from, state_to: to ?? row.status, attempts: row.attempts, ...extra });
  };
  if (!['received', 'fetched'].includes(row.status)) return row.status;
  try {
    await store.update('inbound_messages', { id: row.id }, { next_attempt_at: new Date(now.getTime() + LEASE_MIN * 60000).toISOString() });
    const settings = await inboxSettings(store);

    if (row.status === 'received') {
      const t0 = Date.now();
      const got = await fetchReceived(config, fetchImpl, row.provider_email_id);
      const body = toPlainText(got.text, got.html, settings.maxChars);
      const subject = clip(got.subject || row.subject, 300) || '';
      const fromDomain = domainOf(got.from) || row.from_domain;
      const cls = classify(subject, fromDomain, body);
      await move({ status: 'fetched', body_text: body, subject, from_domain: fromDomain, auth: got.authentication, kind: cls.kind, confirmation_code: cls.code }, 'fetched', { ms: Date.now() - t0, chars: body.length, attachments: got.attachments });
      log({ event: 'inbox.fetched', message_id: row.id, ms: Date.now() - t0, chars: body.length, attachments: got.attachments, auth: got.authentication });
    }

    if (row.status === 'fetched') {
      if (row.kind === 'forward_confirmation') { await move({ status: 'parsed', parse_method: 'none', next_attempt_at: null }, 'parsed'); return row.status; }
      if (row.kind === 'ignored') { await move({ status: 'dropped', parse_method: 'none', next_attempt_at: null }, 'dropped'); return row.status; }
      const parsed = await parseMessage({ subject: row.subject || '', text: row.body_text || '', fromDomain: row.from_domain || '', receivedAt: row.received_at }, { llm, messageId: row.id, accountId: row.account_id, maxChars: settings.maxChars });
      log({ event: 'parse.result', message_id: row.id, method: parsed.method, items: parsed.items.length, confidence: parsed.confidence, ai: parsed.ai, dropped: parsed.dropped.length });
      const good = parsed.items.filter((i) => i.confidence >= settings.threshold);
      if (good.length) {
        const ids = await saveForwarded(store, row.account_id, good, row, row.body_text || '', now);
        await move({ status: 'parsed', parse_method: parsed.method, confidence: parsed.confidence, opportunity_ids: ids, held_items: null, next_attempt_at: null, error: null }, 'parsed', { items: ids.length, weak_dropped: parsed.items.length - good.length });
      } else {
        await move({ status: 'held', parse_method: parsed.method, confidence: parsed.confidence || null, held_items: parsed.items, next_attempt_at: null, error: null }, 'held', { items: parsed.items.length });
      }
    }
    return row.status;
  } catch (e) {
    const attempts = (row.attempts || 0) + 1;
    const code = String(e.code || e.message || 'error').slice(0, 120);
    if (attempts >= MAX_ATTEMPTS) {
      await move({ attempts, status: 'failed', error: code, next_attempt_at: null }, 'failed', { error_code: code });
      log({ level: 'error', event: 'inbox.failed', message_id: row.id, account: row.account_id, error_code: code });
      if (deps.alert) await deps.alert('An inbox message failed 5 times', `Message ${row.id} (account ${row.account_id}) failed after ${MAX_ATTEMPTS} attempts.\nLast error: ${code}\nStatus when it failed: ${rowIn.status}`, `inboxfail:${row.id}`);
    } else {
      await move({ attempts, error: code, next_attempt_at: nextAttemptAfter(attempts, now) }, row.status, { error_code: code });
    }
    return row.status;
  }
}

/** Retries messages stuck in received/fetched whose lease or backoff has passed. Safe to run at any time. */
export async function sweep(deps) {
  const { store } = deps;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const t0 = Date.now();
  const settings = await inboxSettings(store);
  const out = { picked: 0, parsed: 0, held: 0, retry: 0, failed: 0, dropped: 0, expired: 0 };
  if (settings.enabled) {
    const rows = await selectAll(store, 'inbound_messages', { where: { status: { in: ['received', 'fetched'] } } });
    const nowIso = now.toISOString();
    const youngCutoff = new Date(now.getTime() - 60000).toISOString();
    const due = rows
      .filter((r) => (r.next_attempt_at ? r.next_attempt_at <= nowIso : r.received_at <= youngCutoff))
      .sort((a, b) => (a.received_at < b.received_at ? -1 : 1))
      .slice(0, deps.batch ?? 25);
    out.picked = due.length;
    await pool(due, 4, async (r) => {
      const st = await processMessage({ ...deps, now }, r);
      if (st === 'parsed') out.parsed++; else if (st === 'held') out.held++; else if (st === 'failed') out.failed++; else if (st === 'dropped') out.dropped++; else out.retry++;
    });
  }
  out.expired = await expireMessages(store, now);
  log({ event: 'inbox.sweep', ...out, ms: Date.now() - t0 });
  return out;
}

/** Content is kept 30 days, then blanked (the row stays as a count). */
export async function expireMessages(store, now = new Date()) {
  const rows = await store.update('inbound_messages', { expires_at: { lte: now.toISOString() }, status: { neq: 'expired' } }, { status: 'expired', body_text: null, subject: null, confirmation_code: null, held_items: null, auth: null });
  return rows.length;
}

/** Removes everything the inbox holds for one account (also used by account deletion and the customer's "delete my data"). */
export async function deleteAccountInbox(store, accountId) {
  const owned = await selectAll(store, 'opportunities', { where: { owner_account_id: accountId }, columns: 'id' });
  const ids = owned.map((o) => o.id);
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    await store.delete('matches', { opportunity_id: { in: part } });
    await store.delete('opportunity_versions', { opportunity_id: { in: part } });
    await store.delete('opportunities', { id: { in: part } });
  }
  await store.delete('inbound_messages', { account_id: accountId });
  await store.delete('inbox_addresses', { account_id: accountId });
  await store.update('llm_calls', { account_id: accountId }, { account_id: null });
  return { opportunities: ids.length };
}

/* ---------------- staff review of held messages ---------------- */
const AZ_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * The owner reads a held message and types the fields in. Nothing is guessed: whatever is left blank stays blank,
 * and the item is marked as entered by staff so the customer is told.
 * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, error: string }>}
 */
export async function releaseHeld(deps, messageId, fields) {
  const { store } = deps;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const msg = await store.one('inbound_messages', { where: { id: messageId } });
  if (!msg || msg.status !== 'held') return { ok: false, error: 'That message is not waiting for review.' };
  const title = clip(fields.title, 200);
  if (!title || title.length < 4) return { ok: false, error: 'A title of at least 4 characters is required.' };
  const staff = 'Entered by staff after review';
  const item = { staff: true, title: { value: title, quote: staff }, agency: null, deadline: null, url: null, value_stated: null, solicitation_no: null, prebid: null, set_aside: null };
  const agency = clip(fields.agency, 120);
  if (agency) { const known = findAgency(agency); item.agency = { value: known?.value || agency, quote: staff, jurisdiction: known?.jurisdiction ?? null }; }
  if (fields.deadline) {
    if (!AZ_LOCAL.test(fields.deadline)) return { ok: false, error: 'Deadline must be a date and time.' };
    const d = new Date(`${fields.deadline}:00-07:00`); // Arizona is UTC-7 all year
    // V8 rolls Feb 30 into March instead of rejecting it, so check that the calendar fields survive a round trip.
    const back = new Date(d.getTime() - 7 * 3600000).toISOString().slice(0, 16);
    if (Number.isNaN(d.getTime()) || back !== fields.deadline) return { ok: false, error: 'Deadline is not a real date.' };
    item.deadline = { iso: `${fields.deadline}:00-07:00`, quote: staff, time_stated: true };
  }
  if (fields.url) {
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(String(fields.url).trim())) return { ok: false, error: 'The link must start with http:// or https://.' };
    item.url = { value: String(fields.url).trim().slice(0, 500), quote: staff };
  }
  if (fields.value !== undefined && String(fields.value).trim() !== '') {
    const n = Number(String(fields.value).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Value must be a number.' };
    if (n > 0) item.value_stated = { amount: Math.round(n), quote: staff };
  }
  const ids = await saveForwarded(store, msg.account_id, [item], msg, msg.body_text || '', now);
  await store.update('inbound_messages', { id: msg.id }, { status: 'parsed', opportunity_ids: ids, held_items: null, next_attempt_at: null, error: null });
  log({ event: 'inbox.state', message_id: msg.id, account: msg.account_id, state_from: 'held', state_to: 'parsed', by: 'staff' });
  return { ok: true, ids };
}

export async function rejectHeld(store, messageId) {
  const [row] = await store.update('inbound_messages', { id: messageId, status: 'held' }, { status: 'dropped', held_items: null });
  if (row) log({ event: 'inbox.state', message_id: row.id, account: row.account_id, state_from: 'held', state_to: 'dropped', by: 'staff' });
  return Boolean(row);
}

/** Puts a failed message back in the queue (fetched again only if the body was never stored). */
export async function retryMessage(store, messageId) {
  const row = await store.one('inbound_messages', { where: { id: messageId } });
  if (!row || !['failed', 'held'].includes(row.status)) return false;
  await store.update('inbound_messages', { id: row.id }, { status: row.body_text ? 'fetched' : 'received', attempts: 0, next_attempt_at: null, error: null, held_items: null });
  log({ event: 'inbox.state', message_id: row.id, account: row.account_id, state_from: row.status, state_to: row.body_text ? 'fetched' : 'received', by: 'staff' });
  return true;
}
