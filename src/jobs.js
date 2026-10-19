import { ADAPTERS } from './adapters/index.js';
import { assessHealth, upsertOpportunities } from './ingest.js';
import { evaluate, selectForDigest, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from './scoring.js';
import { renderDigest, reminderEmail, changeAlertEmail } from './digest.js';
import { azDate, azDow, azMonth, selectAll } from './time.js';
import { esc } from './html.js';

/**
 * Scheduled jobs. Every job is idempotent (claimed by a unique run key), logs one structured JSON line per
 * state change, and returns a stats object. See docs/LOGIC_AND_OBSERVABILITY.md for the state machines.
 */
export function log(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

async function loadSettings(store) {
  const rows = await store.select('settings');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { weights: { ...DEFAULT_WEIGHTS, ...(m.scoring_weights || {}) }, thresholds: { ...DEFAULT_THRESHOLDS, ...(m.thresholds || {}) }, emailCostCents: Number(m.email_unit_cost_cents) || 0.1 };
}

export async function audit(store, actor, action, target, detail = {}) {
  await store.insert('audit_log', { actor, action, target: target || null, detail });
}

export async function alertAdmins(deps, subject, body, key) {
  for (const to of deps.config.adminEmails) {
    await deps.mailer.send({ to, subject: `[${deps.config.brand}] ${subject}`, html: `<pre style="font:14px/1.5 monospace;white-space:pre-wrap">${esc(body)}</pre>`, text: body, kind: 'admin_alert', key: `${key}:${to}` });
  }
}

/* ---------------- ingest ---------------- */
export async function runIngest(deps) {
  const { config, store, fetchImpl, now = new Date() } = deps;
  const results = [];
  const sources = await store.select('source_config');
  for (const cfg of sources) {
    const adapter = ADAPTERS[cfg.source];
    const base = { job: 'ingest', source: cfg.source };
    if (!adapter) { results.push({ source: cfg.source, skipped: 'no adapter' }); continue; }
    if (!cfg.enabled) { results.push({ source: cfg.source, skipped: cfg.auto_disabled ? 'auto-disabled' : 'disabled' }); continue; }
    if (!cfg.terms_reviewed_at) { results.push({ source: cfg.source, skipped: 'terms not reviewed' }); continue; }
    if (adapter.needsKey && !config.samKey) { results.push({ source: cfg.source, skipped: 'no api key' }); continue; }
    const runKey = `${azDate(now)}`;
    const claimed = await store.rpc('claim_job', { p_job: `ingest:${cfg.source}`, p_key: runKey });
    if (!claimed) { results.push({ source: cfg.source, skipped: 'already ran today' }); continue; }
    log({ ...base, state_from: 'claimed', state_to: 'fetching', run_key: runKey });
    let count = 0;
    let error = null;
    let rateLimited = false;
    let stats = {};
    try {
      const rawRows = await adapter.fetchRaw(fetchImpl, now, { key: config.samKey });
      const items = rawRows.map((r) => adapter.normalize(r)).filter(Boolean);
      count = rawRows.length;
      stats = await upsertOpportunities(store, items, now);
      stats.normalized = items.length;
    } catch (e) {
      error = String(e.message || e);
      rateLimited = Boolean(e.rateLimited);
    }
    const health = assessHealth(cfg, { count, error, rateLimited }, now);
    await store.update('source_config', { source: cfg.source }, health.patch);
    await store.update('job_runs', { job: `ingest:${cfg.source}`, run_key: runKey }, { status: error ? 'failed' : 'ok', finished_at: new Date().toISOString(), stats: { raw: count, ...stats }, error });
    log({ ...base, state_from: 'fetching', state_to: health.problem ? 'unhealthy' : 'ok', raw_count: count, ...stats, error_code: health.problem });
    if (health.alert) {
      await alertAdmins(deps, `Source ${cfg.source}: ${health.problem}${health.autoDisabled ? ' (auto-disabled)' : ''}`, `Source: ${cfg.label}\nProblem: ${health.problem}\nConsecutive failures: ${health.patch.consecutive_failures}\n${health.autoDisabled ? 'The source was auto-disabled. Re-enable it in Admin > Sources after you check it.' : ''}`, `srcalert:${cfg.source}:${runKey}`);
    }
    if (health.autoDisabled) await audit(store, 'system', 'source.auto_disabled', cfg.source, { problem: health.problem });
    results.push({ source: cfg.source, raw: count, ...stats, problem: health.problem });
  }
  return results;
}

/* ---------------- matching + digests ---------------- */
/** Runs fn over items with bounded concurrency; stops starting new items once shouldStop() is true. Returns how many were started. */
export async function pool(items, concurrency, fn, shouldStop = () => false) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await fn(item);
    }
  }));
  return next;
}

export async function runDigest(deps) {
  const { config, store, mailer, now = new Date() } = deps;
  const t0 = Date.now();
  const budgetMs = deps.budgetMs ?? 40000;
  const settings = await loadSettings(store);
  const today = azDate(now);
  const stats = { considered: 0, sent: 0, empty: 0, skipped: 0, paused: 0, failed: 0, remaining: 0 };

  const accounts = await selectAll(store, 'accounts', { where: { status: 'active', billing_status: { in: ['trialing', 'active'] }, digest_paused: false, unsubscribed_at: { isnull: true } } });
  if (!accounts.length) return stats;

  // Shared inputs are loaded once and reused for every customer ("extract once, match many").
  const since60 = new Date(now.getTime() - 60 * 86400000).toISOString();
  const since30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const [opps, ownedOpps, profiles, recentDigests, heldRows] = await Promise.all([
    // Shared items (public sources) are loaded once for everyone. Items a customer forwarded to their own inbox
    // (owner_account_id set) are loaded separately and only ever evaluated for that customer.
    selectAll(store, 'opportunities', { where: { status: 'active', last_seen: { gte: since60 }, owner_account_id: { isnull: true } }, order: 'issued_date.desc' }),
    selectAll(store, 'opportunities', { where: { status: 'active', owner_account_id: { isnull: false } } }),
    selectAll(store, 'profiles', { where: { onboarded_at: { isnull: false } } }),
    selectAll(store, 'digests', { where: { created_at: { gte: since30 } }, columns: 'account_id,kind,opened_at,sent_at,created_at,digest_key' }),
    // Forwarded emails that could not be read in the last 7 days: the digest mentions the count, never the content.
    selectAll(store, 'inbound_messages', { where: { status: 'held', received_at: { gte: new Date(now.getTime() - 7 * 86400000).toISOString() } }, columns: 'account_id' }),
  ]);
  const heldBy = new Map();
  for (const m of heldRows) heldBy.set(m.account_id, (heldBy.get(m.account_id) || 0) + 1);
  const ownedBy = new Map();
  for (const o of ownedOpps) (ownedBy.get(o.owner_account_id) || ownedBy.set(o.owner_account_id, []).get(o.owner_account_id)).push(o);
  const profileBy = new Map(profiles.map((p) => [p.account_id, p]));
  const digestsBy = new Map();
  for (const d of recentDigests) (digestsBy.get(d.account_id) || digestsBy.set(d.account_id, []).get(d.account_id)).push(d);

  const one = async (account) => {
    stats.considered++;
    try {
      const profile = profileBy.get(account.id);
      if (!profile) { stats.skipped++; return; }
      if (profile.digest_frequency === 'weekly' && azDow(now) !== 'Mon') { stats.skipped++; return; }
      const kindBase = profile.digest_frequency === 'weekly' ? 'weekly' : 'daily';
      const digestKey = `${account.id}:${today}`;
      const mine = digestsBy.get(account.id) || [];
      const existing = mine.find((d) => d.digest_key === digestKey);
      if (existing?.sent_at) { stats.skipped++; return; }
      if (existing) {
        // A previous pass created the digest but never confirmed sending (crash or timeout). Undo it and redo it.
        const old = await store.one('digests', { where: { digest_key: digestKey } });
        if (old) { await store.delete('matches', { digest_id: old.id }); await store.delete('digests', { id: old.id }); }
      }

      // Inactivity check: 14 sent in 30 days and none opened -> stop sending and tell the owner via the audit log.
      const sent = mine.filter((d) => d.sent_at);
      if (sent.length >= 14 && sent.every((d) => !d.opened_at)) {
        await store.update('accounts', { id: account.id }, { digest_paused: true });
        await audit(store, 'system', 'digest.auto_paused_inactive', account.id, { sent: sent.length });
        stats.paused++;
        return;
      }

      const delivered = await store.select('matches', { where: { account_id: account.id, delivered_at: { gte: since60 } }, columns: 'opportunity_id' });
      const seen = new Set(delivered.map((m) => m.opportunity_id));
      const evals = [];
      for (const opp of [...opps, ...(ownedBy.get(account.id) || [])]) {
        if (seen.has(opp.id)) continue;
        evals.push({ opp, eval: evaluate(profile, opp, { now, weights: settings.weights, thresholds: settings.thresholds }) });
      }
      const picked = selectForDigest(evals, { maxItems: settings.thresholds.max_items, deliverMin: settings.thresholds.deliver_min });

      let kind = kindBase;
      if (!picked.length) {
        if (kindBase === 'daily' && mine.some((d) => d.kind === 'empty' && d.created_at >= new Date(now.getTime() - 7 * 86400000).toISOString())) { stats.skipped++; return; }
        kind = 'empty';
      }
      const [digest] = await store.insert('digests', { account_id: account.id, kind, item_count: picked.length, digest_key: digestKey }, { ignoreDuplicates: true });
      if (!digest) { stats.skipped++; return; }
      const rows = picked.map((p) => ({ account_id: account.id, opportunity_id: p.opp.id, score: p.eval.score, factors: p.eval.factors, checklist: p.eval.checklist, digest_id: digest.id, delivered_at: now.toISOString() }));
      const saved = rows.length ? await store.upsert('matches', rows, { onConflict: 'account_id,opportunity_id' }) : [];
      const idByOpp = new Map(saved.map((m) => [m.opportunity_id, m.id]));
      const items = picked.map((p) => ({ opp: p.opp, eval: p.eval, matchId: idByOpp.get(p.opp.id) }));
      const mail = renderDigest(config, { account, profile, items, kind, digestId: digest.id, weeklyEmptyNote: kindBase === 'weekly', unreadForwards: heldBy.get(account.id) || 0 });
      const res = await mailer.send({ accountId: account.id, to: account.email, subject: mail.subject, html: mail.html, text: mail.text, kind: 'digest', key: `digest:${digestKey}` });
      if (['sent', 'simulated'].includes(res.status)) {
        await store.update('digests', { id: digest.id }, { sent_at: now.toISOString() });
        await store.update('accounts', { id: account.id }, { last_digest_at: now.toISOString() });
        if (kind === 'empty') stats.empty++; else stats.sent++;
        log({ job: 'digest', account: account.id, state_from: 'matched', state_to: res.status, items: items.length, kind });
      } else {
        stats.failed++;
        log({ job: 'digest', account: account.id, state_from: 'matched', state_to: 'not_sent', error_code: res.status });
      }
    } catch (e) {
      stats.failed++;
      log({ job: 'digest', account: account.id, state_to: 'error', error_code: String(e.message || e).slice(0, 200) });
    }
  };

  const started = await pool(accounts, deps.concurrency ?? 8, one, () => Date.now() - t0 > budgetMs);
  stats.remaining = accounts.length - started;
  if (stats.remaining > 0) log({ job: 'digest', state_to: 'budget_exhausted', remaining: stats.remaining });
  return stats;
}

/* ---------------- reminders + change alerts (Pro feature) ---------------- */
export async function runReminders(deps) {
  const { config, store, mailer, now = new Date() } = deps;
  const stats = { reminders: 0, change_alerts: 0 };
  const plans = Object.fromEntries((await store.select('plans')).map((p) => [p.id, p]));
  const interested = await selectAll(store, 'matches', { where: { disposition: 'interested', action: { in: ['none', 'contacted'] } } });
  for (const m of interested) {
    const account = await store.one('accounts', { where: { id: m.account_id } });
    if (!account || account.status !== 'active' || account.unsubscribed_at || !['trialing', 'active'].includes(account.billing_status)) continue;
    if (!plans[account.plan_id]?.features?.reminders && account.billing_status !== 'trialing') continue;
    const opp = await store.one('opportunities', { where: { id: m.opportunity_id } });
    if (!opp) continue;
    const profile = await store.one('profiles', { where: { account_id: account.id } });
    if (opp.kind === 'public_bid' && opp.deadline) {
      const daysLeft = Math.ceil((Date.parse(opp.deadline) - now.getTime()) / 86400000);
      if (daysLeft >= 0) {
        for (const t of [1, 3, 7]) {
          if (daysLeft <= t && !(m.reminders_sent || []).includes(t)) {
            const mail = reminderEmail(config, { account, profile, match: m, opp, daysLeft });
            const res = await mailer.send({ accountId: account.id, to: account.email, subject: mail.subject, html: mail.html, text: mail.text, kind: 'reminder', key: `reminder:${m.id}:${t}` });
            if (['sent', 'simulated'].includes(res.status)) {
              const sent = [...new Set([...(m.reminders_sent || []), ...[1, 3, 7].filter((x) => x >= t)])];
              await store.update('matches', { id: m.id }, { reminders_sent: sent });
              stats.reminders++;
            }
            break;
          }
        }
      }
    }
    if (m.change_alerted_version != null && opp.version > m.change_alerted_version) {
      const mail = changeAlertEmail(config, { account, match: m, opp });
      const res = await mailer.send({ accountId: account.id, to: account.email, subject: mail.subject, html: mail.html, text: mail.text, kind: 'change_alert', key: `change:${m.id}:${opp.version}` });
      if (['sent', 'simulated'].includes(res.status)) {
        await store.update('matches', { id: m.id }, { change_alerted_version: opp.version });
        stats.change_alerts++;
      }
    }
  }
  return stats;
}

/* ---------------- stats shared by the admin overview and the daily owner email ---------------- */
export async function adminStats(store, now = new Date()) {
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
  const [plans, accounts, outbox, jobs, leads, events] = await Promise.all([
    store.select('plans'),
    selectAll(store, 'accounts', { where: { role: 'customer', status: 'active' } }),
    selectAll(store, 'outbox', { where: { created_at: { gte: monthAgo } }, columns: 'status,kind,created_at' }),
    store.select('job_runs', { where: { started_at: { gte: dayAgo } } }),
    store.count('leads'),
    selectAll(store, 'events', { where: { ts: { gte: monthAgo } }, columns: 'name' }),
  ]);
  const price = Object.fromEntries(plans.map((p) => [p.id, p.price_cents]));
  const active = accounts.filter((a) => a.billing_status === 'active');
  const trialing = accounts.filter((a) => a.billing_status === 'trialing');
  const canceledRecent = accounts.filter((a) => a.billing_status === 'canceled');
  const mrrCents = active.reduce((s, a) => s + (price[a.plan_id] || 0), 0);
  const settings = await loadSettings(store);
  const emails30 = outbox.filter((o) => ['sent', 'simulated'].includes(o.status)).length;
  const payers = Math.max(1, active.length + trialing.length);
  const funnel = {};
  for (const e of events) funnel[e.name] = (funnel[e.name] || 0) + 1;
  return {
    mrrCents, active: active.length, trialing: trialing.length, canceled: canceledRecent.length, accounts: accounts.length, leads,
    digestsSent24h: outbox.filter((o) => o.kind === 'digest' && ['sent', 'simulated'].includes(o.status) && o.created_at >= dayAgo).length,
    emailsFailed30d: outbox.filter((o) => o.status === 'failed').length,
    bounced30d: outbox.filter((o) => ['bounced', 'complained'].includes(o.status)).length,
    jobFailures24h: jobs.filter((j) => j.status === 'failed').length,
    costPerCustomerCents: Math.round(((emails30 * settings.emailCostCents) / payers) * 100) / 100,
    funnel,
  };
}

/* ---------------- housekeeping: cleanup, lifecycle emails, owner summary ---------------- */
export async function runHousekeeping(deps) {
  const { config, store, mailer, now = new Date() } = deps;
  const stats = { trial_ending: 0, winback: 0, monthly: 0, closed_stale: 0, closed_forwarded: 0 };
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();

  await store.delete('login_tokens', { expires_at: { lt: now.toISOString() } });
  const stale = await store.update('opportunities', { status: 'active', last_seen: { lt: iso(-14 * 86400000) }, is_sample: false, owner_account_id: { isnull: true } }, { status: 'closed' });
  stats.closed_stale = stale.length;
  // Forwarded bids are not re-seen daily like public feeds. They close one day after their deadline, or 45 days after last seen if no deadline was stated.
  const fwdPast = await store.update('opportunities', { status: 'active', owner_account_id: { isnull: false }, deadline: { lt: iso(-86400000) } }, { status: 'closed' });
  const fwdOld = await store.update('opportunities', { status: 'active', owner_account_id: { isnull: false }, deadline: { isnull: true }, last_seen: { lt: iso(-45 * 86400000) } }, { status: 'closed' });
  stats.closed_forwarded = fwdPast.length + fwdOld.length;

  const accounts = await selectAll(store, 'accounts', { where: { status: 'active', unsubscribed_at: { isnull: true } } });
  for (const a of accounts) {
    if (a.billing_status === 'trialing' && a.trial_end) {
      const left = (Date.parse(a.trial_end) - now.getTime()) / 86400000;
      if (left > 0 && left <= 3) {
        const r = await mailer.send({ accountId: a.id, to: a.email, subject: `Your ${config.brand} trial ends in ${Math.ceil(left)} day${Math.ceil(left) === 1 ? '' : 's'}`, html: `<p style="font:15px/1.5 Arial,sans-serif">Your free trial ends on ${esc(new Date(a.trial_end).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'long' }))}. After that your card is charged the monthly plan price. You can pause or cancel in one click: <a href="${esc(config.baseUrl)}/app/settings">Settings</a>.</p>`, text: `Your trial ends ${a.trial_end.slice(0, 10)}. After that your card is charged the monthly plan price. Pause or cancel in one click: ${config.baseUrl}/app/settings`, kind: 'trial_ending', key: `trial_ending:${a.id}:${a.trial_end.slice(0, 10)}` });
        if (!r.duplicate && (r.status === 'sent' || r.status === 'simulated')) stats.trial_ending++;
      }
    }
    if (a.billing_status === 'canceled') {
      const since = a.current_period_end ? (now.getTime() - Date.parse(a.current_period_end)) / 86400000 : null;
      if (since !== null && since >= 14 && since <= 30) {
        const r = await mailer.send({ accountId: a.id, to: a.email, subject: `Still hunting commercial work in Arizona?`, html: `<p style="font:15px/1.5 Arial,sans-serif">You left ${esc(config.brand)} a couple of weeks ago. If we missed the mark, reply and tell us what would have made it useful. If you want back in, you can restart any time: <a href="${esc(config.baseUrl)}/app/settings">Settings</a>. No pressure.</p>`, text: `You left ${config.brand} a couple of weeks ago. Reply and tell us what would have made it useful, or restart: ${config.baseUrl}/app/settings`, kind: 'winback', key: `winback:${a.id}` });
        if (!r.duplicate && (r.status === 'sent' || r.status === 'simulated')) stats.winback++;
      }
    }
    if (azDate(now).slice(8, 10) === '01' && ['trialing', 'active'].includes(a.billing_status)) {
      const m = await selectAll(store, 'matches', { where: { account_id: a.id } });
      const monthStart = new Date(now.getTime() - 31 * 86400000).toISOString();
      const recent = m.filter((x) => (x.delivered_at || '') >= monthStart);
      if (recent.length) {
        const c = (f) => recent.filter(f).length;
        const body = `Last month: ${recent.length} opportunities delivered, ${c((x) => x.disposition === 'interested')} marked Interested, ${c((x) => ['bid_submitted', 'won', 'lost'].includes(x.action))} bids submitted, ${c((x) => x.action === 'won')} won (as you recorded them).`;
        const r = await mailer.send({ accountId: a.id, to: a.email, subject: `${config.brand} monthly summary`, html: `<p style="font:15px/1.5 Arial,sans-serif">${esc(body)}</p><p><a href="${esc(config.baseUrl)}/app/pipeline">Open your pipeline</a></p>`, text: `${body}\n${config.baseUrl}/app/pipeline`, kind: 'monthly_summary', key: `monthly:${a.id}:${azMonth(now)}` });
        if (!r.duplicate && (r.status === 'sent' || r.status === 'simulated')) stats.monthly++;
      }
    }
  }
  const s = await adminStats(store, now);
  const body = `MRR: $${(s.mrrCents / 100).toFixed(2)}\nActive: ${s.active}  Trials: ${s.trialing}  Canceled: ${s.canceled}\nWaitlist: ${s.leads}\nDigests (24h): ${s.digestsSent24h}\nEmail failures (30d): ${s.emailsFailed30d}  Bounces/complaints: ${s.bounced30d}\nJob failures (24h): ${s.jobFailures24h}\nEmail cost per customer (30d, est.): $${(s.costPerCustomerCents / 100).toFixed(2)}\nLLM cost: $0.00 (no LLM in use)`;
  await alertAdmins(deps, `Daily summary ${azDate(now)}`, body, `summary:${azDate(now)}`);
  return stats;
}
