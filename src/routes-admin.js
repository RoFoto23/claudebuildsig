import { h, each, when, raw } from './html.js';
import { redirect, asArray } from './http.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { newSecret, verifyTotp, otpauthUri, stepOf } from './totp.js';
import { adminStats, audit, runIngest, runDigest, runReminders, runHousekeeping } from './jobs.js';
import { ADAPTERS } from './adapters/index.js';
import { finalize } from './adapters/util.js';
import { upsertOpportunities } from './ingest.js';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, money } from './scoring.js';
import { TRADES, JURISDICTION_IDS } from './taxonomy.js';
import { dollars } from './views.js';
import { selectAll, fmtAz, azMonth } from './time.js';
import { inboxSettings, releaseHeld, rejectHeld, retryMessage } from './inbox.js';
import { createLlm } from './llm.js';

const SCREENS = [['/admin', 'Overview'], ['/admin/customers', 'Customers'], ['/admin/opportunities', 'Opportunities'], ['/admin/sources', 'Sources'], ['/admin/review', 'Review queue'], ['/admin/rules', 'Rules'], ['/admin/deliverability', 'Deliverability'], ['/admin/pricing', 'Pricing'], ['/admin/audit', 'Audit log']];

export function registerAdmin(r, { fail }) {
  const shell = (ctx, title, body, cur) => ctx.render(`Admin: ${title}`, h`<div class="wrap" style="padding-top:14px"><nav class="main" aria-label="Admin" style="background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:14px">${each(SCREENS, ([href, label]) => h`<a style="color:var(--ink)" href="${href}" ${href === cur ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav><h1>${title}</h1>${body}</div>`, { noindex: true, current: 'admin' });
  const A = (fn) => async (ctx) => { const s = await ctx.requireAdmin(); return fn(ctx, s); };
  const done = (path) => redirect(path);
  const who = (s) => s.account.email;
  const flash = (ctx) => (ctx.url.searchParams.get('ok') ? h`<div class="notice">${ctx.url.searchParams.get('ok')}</div>` : '');

  /* ---------------- two-factor ---------------- */
  r.get('/admin/2fa', async (ctx) => {
    ctx.needStore();
    const s = await ctx.session();
    if (!s || !s.isAdminCandidate) throw fail(404, 'Not found');
    if (s.adminOk) return redirect('/admin');
    let row = await ctx.store.one('admin_totp', { where: { account_id: s.account.id } });
    if (!row) row = (await ctx.store.insert('admin_totp', { account_id: s.account.id, secret_enc: encrypt(newSecret(), ctx.config.encKey) }))[0];
    const enrolling = !row.confirmed_at;
    const secret = enrolling ? decrypt(row.secret_enc, ctx.config.encKey) : null;
    return ctx.render('Admin sign-in', h`<div class="wrap narrow" style="padding:30px 16px"><h1>${enrolling ? 'Set up two-factor' : 'Two-factor code'}</h1>
${when(enrolling, h`<p>Add this key to an authenticator app (Google Authenticator, 1Password, Authy): choose "enter a setup key" and paste it.</p><pre class="draft">${secret}</pre><p class="small muted">Or use this link on a device with the app: ${otpauthUri(secret, s.account.email, ctx.config.brand)}</p>`)}
<form class="stack card" method="post" action="/admin/2fa"><label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>
<p><button class="btn" type="submit">${enrolling ? 'Confirm and continue' : 'Verify'}</button></p></form></div>`, { noindex: true });
  });

  r.post('/admin/2fa', async (ctx) => {
    ctx.needStore();
    const s = await ctx.session();
    if (!s || !s.isAdminCandidate) throw fail(404, 'Not found');
    if (!(await ctx.limit(`totp:${s.account.id}`, 10, 900))) throw fail(429, 'Too many attempts. Wait 15 minutes.');
    const f = await ctx.form();
    const row = await ctx.store.one('admin_totp', { where: { account_id: s.account.id } });
    if (!row) throw fail(400, 'Start again from the sign-in page.');
    const step = verifyTotp(decrypt(row.secret_enc, ctx.config.encKey), String(f.code || '').trim(), { nowMs: ctx.now().getTime(), lastUsedStep: Number(row.last_used_step) || 0 });
    if (step === null) {
      await audit(ctx.store, who(s), 'admin.2fa_failed', null, {});
      throw fail(400, 'That code did not match. Check your phone clock and try the next code.');
    }
    await ctx.store.update('admin_totp', { account_id: s.account.id }, { last_used_step: step, confirmed_at: row.confirmed_at || ctx.now().toISOString() });
    await audit(ctx.store, who(s), row.confirmed_at ? 'admin.login' : 'admin.2fa_enrolled', null, {});
    return redirect('/admin', { cookies: [ctx.auth.adminCookie(s.account)] });
  });

  /* ---------------- 1. overview ---------------- */
  r.get('/admin', A(async (ctx, s) => {
    const st = await adminStats(ctx.store, ctx.now());
    const sources = await ctx.store.select('source_config');
    const failedJobs = await ctx.store.select('job_runs', { where: { status: 'failed' }, order: 'started_at.desc', limit: 5 });
    const funnelOrder = ['visit', 'demo_view', 'waitlist', 'signup', 'activated_profile', 'checkout', 'billing_trialing', 'billing_active'];
    const body = h`${flash(ctx)}
<div class="kpi"><div class="card"><b>$${(st.mrrCents / 100).toFixed(2)}</b>MRR</div><div class="card"><b>${st.active}</b>paying</div><div class="card"><b>${st.trialing}</b>in trial</div><div class="card"><b>${st.canceled}</b>canceled</div>
<div class="card"><b>${st.digestsSent24h}</b>digests, 24h</div><div class="card"><b>${st.leads}</b>waitlist</div><div class="card"><b>${st.emailsFailed30d + st.jobFailures24h}</b>errors</div><div class="card"><b>$${(st.costPerCustomerCents / 100).toFixed(2)}</b>email cost / customer, 30d (est.)</div></div>
<div class="grid c2" style="margin-top:14px">
<div class="card"><h3>Launch readiness</h3><ul class="plain small">${each([['Database', ctx.config.has.db], ['Email sender (Resend)', ctx.config.has.email], ['Stripe billing', ctx.config.has.billing], ['Mailing address (CAN-SPAM)', ctx.config.has.address], ['App secrets', ctx.config.has.secrets], ['SAM.gov key', Boolean(ctx.config.samKey)], ['Bounce webhook secret', Boolean(ctx.config.resendWebhookSecret)]], ([n, ok]) => h`<li>${ok ? 'Ready' : 'Missing'}: ${n}</li>`)}</ul><p class="small">Customer sign-up is <b>${ctx.config.signupOpen ? 'OPEN' : 'CLOSED (waitlist only)'}</b>.</p></div>
<div class="card"><h3>Sources</h3><ul class="plain small">${each(sources, (x) => h`<li>${x.label}: ${x.auto_disabled ? 'AUTO-DISABLED' : x.enabled ? 'on' : 'off'}${x.last_error ? ` (last problem: ${x.last_error})` : ''}</li>`)}</ul></div></div>
<div class="card" style="margin-top:14px"><h3>Funnel, last 30 days</h3><p class="small">${funnelOrder.map((k) => `${k.replace('_', ' ')}: ${st.funnel[k] || 0}`).join(' → ')}</p><p class="small muted">Counts are events, not unique people (no tracking cookies by design).</p></div>
${when(failedJobs.length > 0, h`<div class="notice bad" style="margin-top:14px"><b>Recent failed jobs</b><ul class="plain small">${each(failedJobs, (j) => h`<li>${j.job} ${j.run_key}: ${j.error}</li>`)}</ul></div>`)}
<div class="card" style="margin-top:14px"><h3>Run a job now</h3><div class="actions">${each(['ingest', 'digest', 'housekeeping'], (j) => h`<form method="post" action="/admin/run/${j}"><button class="btn alt sm" type="submit">Run ${j}</button></form>`)}</div><p class="small muted">Jobs are idempotent: re-running does not double-send digests or alerts.</p></div>`;
    return shell(ctx, 'Overview', body, '/admin');
  }));

  r.post('/admin/run/:job', A(async (ctx, s) => {
    const deps = { config: ctx.config, store: ctx.store, mailer: ctx.mailer, fetchImpl: ctx.fetchImpl, now: ctx.now() };
    const job = ctx.params.job;
    let out;
    if (job === 'ingest') out = await runIngest(deps);
    else if (job === 'digest') out = { digest: await runDigest(deps), reminders: await runReminders(deps) };
    else if (job === 'housekeeping') out = await runHousekeeping(deps);
    else throw fail(404, 'Unknown job');
    await audit(ctx.store, who(s), `job.run.${job}`, null, { out: JSON.stringify(out).slice(0, 500) });
    return done(`/admin?ok=${encodeURIComponent(`Ran ${job}: ${JSON.stringify(out).slice(0, 300)}`)}`);
  }));

  /* ---------------- 2. customers ---------------- */
  r.get('/admin/customers', A(async (ctx) => {
    const q = (ctx.url.searchParams.get('q') || '').trim().toLowerCase();
    let accts = await selectAll(ctx.store, 'accounts', { where: { role: 'customer' }, order: 'created_at.desc' });
    if (q) accts = accts.filter((a) => a.email.includes(q));
    const body = h`${flash(ctx)}<form method="get" class="stack"><label for="q">Search email</label><input id="q" name="q" type="search" value="${q}"><p><button class="btn sm dark" type="submit">Search</button></p></form>
<div class="scroll"><table class="t"><thead><tr><th>Email</th><th>Plan</th><th>Status</th><th>Created</th><th>Last digest</th><th></th></tr></thead><tbody>${each(accts.slice(0, 200), (a) => h`<tr><td>${a.email}</td><td>${a.plan_id || ''}</td><td>${a.billing_status}${a.digest_paused ? ' (digests paused)' : ''}${a.unsubscribed_at ? ' (unsubscribed)' : ''}</td><td>${fmtAz(a.created_at, { dateStyle: 'short' })}</td><td>${a.last_digest_at ? fmtAz(a.last_digest_at, { dateStyle: 'short' }) : ''}</td><td><a href="/admin/customers/${a.id}">Open</a></td></tr>`)}</tbody></table></div><p class="small muted">${accts.length} customer account${accts.length === 1 ? '' : 's'}.</p>`;
    return shell(ctx, 'Customers', body, '/admin/customers');
  }));

  r.get('/admin/customers/:id', A(async (ctx) => {
    const a = await ctx.store.one('accounts', { where: { id: ctx.params.id } });
    if (!a) throw fail(404, 'Not found');
    const p = await ctx.store.one('profiles', { where: { account_id: a.id } });
    const digests = await ctx.store.select('digests', { where: { account_id: a.id }, order: 'created_at.desc', limit: 10 });
    const post = (act, label, cls = 'alt', extra = '') => h`<form method="post" action="/admin/customers/${a.id}/${act}" style="display:inline" ${extra ? raw(extra) : ''}><button class="btn sm ${cls}" type="submit">${label}</button></form>`;
    const body = h`${flash(ctx)}<p class="small"><a href="/admin/customers">&larr; All customers</a></p>
<div class="card"><h3>${a.email}</h3><p class="small">Plan ${a.plan_id || 'none'} · ${a.billing_status}${a.trial_end ? ` · trial ends ${fmtAz(a.trial_end, { dateStyle: 'medium' })}` : ''} · Stripe customer ${a.stripe_customer_id || 'none'}</p>
<p class="small">Joined ${fmtAz(a.created_at, { dateStyle: 'medium' })} · last sign-in ${a.last_login_at ? fmtAz(a.last_login_at) : 'never'} · last open ${a.last_open_at ? fmtAz(a.last_open_at) : 'never'}</p>
<div class="actions">${a.digest_paused ? post('resume', 'Resume digests', '') : post('pause', 'Pause digests')}${post('signin-link', 'Email a sign-in link')}${post('cancel', 'Cancel subscription now', 'danger')}${post('refund', 'Refund latest charge', 'danger')}</div></div>
<div class="card" style="margin-top:12px"><h3>Profile (customer-entered)</h3>${p ? h`<p class="small">${p.business_name || '(no name)'} · ${p.contact_name || ''} · ${p.phone || ''}<br>Trades: ${(p.trades || []).join(', ') || 'none'}<br>Areas: ${(p.jurisdictions || []).join(', ') || 'none'} · ZIPs: ${(p.zips || []).join(', ') || 'any'}<br>Size: ${p.min_value ?? 'any'} to ${p.max_value ?? 'any'}<br>License: ${p.license_number || 'none'} (unverified) ${(p.license_classes || []).join(', ')}<br>Digest: ${p.digest_frequency} · learned weights: ${JSON.stringify(p.feedback_weights || {})}</p>` : h`<p class="small">No profile.</p>`}</div>
<div class="card" style="margin-top:12px"><h3>Recent digests</h3><ul class="plain small">${each(digests, (d) => h`<li>${fmtAz(d.created_at, { dateStyle: 'short' })}: ${d.kind}, ${d.item_count} items, ${d.opened_at ? 'opened' : 'not opened'}</li>`)}</ul></div>`;
    return shell(ctx, 'Customer', body, '/admin/customers');
  }));

  const custAction = (act, fn) => r.post(`/admin/customers/:id/${act}`, A(async (ctx, s) => {
    const a = await ctx.store.one('accounts', { where: { id: ctx.params.id } });
    if (!a) throw fail(404, 'Not found');
    const msg = await fn(ctx, a);
    await audit(ctx.store, who(s), `customer.${act}`, a.id, { email: a.email });
    return done(`/admin/customers/${a.id}?ok=${encodeURIComponent(msg)}`);
  }));
  custAction('pause', async (ctx, a) => { await ctx.store.update('accounts', { id: a.id }, { digest_paused: true }); return 'Digests paused.'; });
  custAction('resume', async (ctx, a) => { await ctx.store.update('accounts', { id: a.id }, { digest_paused: false }); return 'Digests resumed.'; });
  custAction('signin-link', async (ctx, a) => {
    const link = await ctx.auth.createLoginLink(a.id, '/app', ctx.now());
    await ctx.mailer.send({ accountId: a.id, to: a.email, subject: `Your ${ctx.config.brand} sign-in link`, html: `<p><a href="${link}">Sign in</a> (works once, 20 minutes)</p>`, text: `Sign in: ${link}`, kind: 'login', key: `adminlink:${a.id}:${Date.now()}` });
    return 'Sign-in link emailed.';
  });
  custAction('cancel', async (ctx, a) => {
    if (!ctx.stripe || !a.stripe_customer_id) throw fail(400, 'No Stripe subscription for this customer.');
    const list = await ctx.stripe.api('/subscriptions', { customer: a.stripe_customer_id, status: 'all', limit: 10 }, 'GET');
    let n = 0;
    for (const sub of list.data || []) if (!['canceled', 'incomplete_expired'].includes(sub.status)) { await ctx.stripe.api(`/subscriptions/${sub.id}`, {}, 'DELETE'); n++; }
    await ctx.store.update('accounts', { id: a.id }, { billing_status: 'canceled' });
    return `Canceled ${n} subscription(s).`;
  });
  custAction('refund', async (ctx, a) => {
    if (!ctx.stripe || !a.stripe_customer_id) throw fail(400, 'No Stripe customer for this account.');
    const charges = await ctx.stripe.api('/charges', { customer: a.stripe_customer_id, limit: 5 }, 'GET');
    const c = (charges.data || []).find((x) => x.paid && !x.refunded);
    if (!c) throw fail(400, 'No refundable charge found.');
    await ctx.stripe.api('/refunds', { charge: c.id }, 'POST');
    return `Refunded ${dollars(c.amount)}.`;
  });

  /* ---------------- 3. opportunities ---------------- */
  r.get('/admin/opportunities', A(async (ctx) => {
    const since = new Date(ctx.now().getTime() - 3 * 86400000).toISOString();
    const recent = await selectAll(ctx.store, 'opportunities', { where: { first_seen: { gte: since }, owner_account_id: { isnull: true } }, order: 'first_seen.desc' }, 500, 1500);
    const counts = {};
    for (const o of recent) counts[o.source] = (counts[o.source] || 0) + 1;
    const fam = {};
    for (const o of recent) if (o.parent_key) fam[o.parent_key] = (fam[o.parent_key] || 0) + 1;
    const dupFamilies = Object.values(fam).filter((n) => n > 1).length;
    const body = h`${flash(ctx)}<p class="small">Last 3 days: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing ingested'} · ${dupFamilies} project families with more than one record (shown once per digest).</p>
<div class="scroll"><table class="t"><thead><tr><th>Source</th><th>Title</th><th>Where</th><th>Value</th><th>v</th><th>Status</th><th></th></tr></thead><tbody>${each(recent.slice(0, 150), (o) => h`<tr><td>${o.source}</td><td><a href="${o.url || '#'}" rel="noopener noreferrer" target="_blank">${o.title}</a></td><td>${o.jurisdiction || ''} ${o.address || ''}</td><td>${o.value ? money(Number(o.value)) : ''}</td><td>${o.version}</td><td>${o.status}</td><td><form method="post" action="/admin/opportunities/${o.id}/${o.status === 'hidden' ? 'show' : 'hide'}"><button class="btn sm alt" type="submit">${o.status === 'hidden' ? 'Unhide' : 'Hide'}</button></form></td></tr>`)}</tbody></table></div>
<h2>Add one manually</h2><p class="small muted">Use for a bid you found on an official page. Always include the official link. It enters the normal matching and the digest like any other item.</p>
<form class="stack card" method="post" action="/admin/opportunities/add">
<label for="m-title">Title</label><input id="m-title" name="title" required maxlength="200">
<label for="m-kind">Type</label><select id="m-kind" name="kind"><option value="public_bid">Public bid or solicitation</option><option value="permit_lead">Permit or private project</option></select>
<label for="m-agency">Agency or owner</label><input id="m-agency" name="agency" maxlength="120">
<label for="m-jur">Jurisdiction</label><select id="m-jur" name="jurisdiction">${each(JURISDICTION_IDS, (j) => h`<option>${j}</option>`)}</select>
<label for="m-deadline">Deadline (Arizona time, for bids)</label><input id="m-deadline" name="deadline" type="datetime-local">
<label for="m-value">Estimated value (only if the listing states it)</label><input id="m-value" name="value" type="number" min="0">
<label for="m-url">Official link</label><input id="m-url" name="url" type="text" required placeholder="https://" maxlength="400">
<label for="m-scope">Scope (copy the listing's own words)</label><textarea id="m-scope" name="scope" maxlength="2000"></textarea>
<p><button class="btn" type="submit">Add</button></p></form>`;
    return shell(ctx, 'Opportunities', body, '/admin/opportunities');
  }));

  r.post('/admin/opportunities/add', A(async (ctx, s) => {
    const f = await ctx.form();
    const url = String(f.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw fail(400, 'A valid official link (https://...) is required.');
    const deadline = f.deadline ? new Date(`${f.deadline}:00-07:00`).toISOString() : null; // Arizona is UTC-7 all year
    const item = finalize({
      source: 'manual', source_id: `m-${randomToken(6)}`, kind: f.kind === 'permit_lead' ? 'permit_lead' : 'public_bid', title: String(f.title || '').trim().slice(0, 200),
      agency: String(f.agency || '').trim().slice(0, 120) || null, jurisdiction: JURISDICTION_IDS.includes(f.jurisdiction) ? f.jurisdiction : 'statewide',
      stage: f.kind === 'permit_lead' ? 'issued' : 'open_bid', value: f.value ? Number(f.value) : null, deadline, url, scope: String(f.scope || '').slice(0, 2000) || null,
      issued_date: ctx.now().toISOString().slice(0, 10), version: 1,
    });
    if (!item.title) throw fail(400, 'Title is required.');
    await upsertOpportunities(ctx.store, [item], ctx.now());
    await audit(ctx.store, who(s), 'opportunity.add', item.source_id, { title: item.title });
    return done('/admin/opportunities?ok=Added.');
  }));
  for (const [act, status] of [['hide', 'hidden'], ['show', 'active']]) {
    r.post(`/admin/opportunities/:id/${act}`, A(async (ctx, s) => {
      await ctx.store.update('opportunities', { id: ctx.params.id }, { status });
      await audit(ctx.store, who(s), `opportunity.${act}`, ctx.params.id, {});
      return done(`/admin/opportunities?ok=${act === 'hide' ? 'Hidden.' : 'Visible again.'}`);
    }));
  }

  /* ---------------- 4. sources ---------------- */
  r.get('/admin/sources', A(async (ctx) => {
    const rows = await ctx.store.select('source_config', { order: 'source.asc' });
    const inbox = await inboxCard(ctx);
    const body = h`${flash(ctx)}${inbox}<p class="small muted">A source runs only when it is <b>enabled</b> and its terms are marked <b>reviewed</b>. Three failed runs in a row (error, zero items, or a count far below normal) auto-disable it and email you.</p>
${each(rows, (x) => h`<div class="card" style="margin-bottom:12px"><h3>${x.label} <span class="pill ${x.auto_disabled ? 'red' : x.enabled ? 'green' : ''}">${x.auto_disabled ? 'auto-disabled' : x.enabled ? 'on' : 'off'}</span></h3>
<p class="small">Terms: <a href="${x.terms_url || '#'}" rel="noopener noreferrer" target="_blank">${x.terms_url ? 'open terms page' : 'none on file'}</a> · ${x.terms_reviewed_at ? `reviewed ${fmtAz(x.terms_reviewed_at, { dateStyle: 'medium' })}` : 'NOT reviewed'}${x.terms_notes ? ` · notes: ${x.terms_notes}` : ''}<br>
Last run ${x.last_run_at ? fmtAz(x.last_run_at) : 'never'} · last count ${x.last_count ?? '-'} · usual ${x.baseline_count ?? '-'} · failures in a row ${x.consecutive_failures}${x.last_error ? ` · ${x.last_error}` : ''}</p>
<div class="actions"><form method="post" action="/admin/sources/${x.source}/review" class="stack" style="width:100%"><label for="n-${x.source}">I read the terms; commercial use of the data is allowed. Notes:</label><input id="n-${x.source}" name="notes" maxlength="300"><p><button class="btn sm" type="submit">Mark terms reviewed</button></p></form>
<form method="post" action="/admin/sources/${x.source}/${x.enabled ? 'disable' : 'enable'}"><button class="btn sm alt" type="submit">${x.enabled ? 'Disable' : 'Enable'}</button></form>
<form method="post" action="/admin/sources/${x.source}/test"><button class="btn sm alt" type="submit">Test fetch (stores nothing)</button></form></div></div>`)}`;
    return shell(ctx, 'Sources', body, '/admin/sources');
  }));

  r.post('/admin/sources/:id/:act', A(async (ctx, s) => {
    const cfg = await ctx.store.one('source_config', { where: { source: ctx.params.id } });
    if (!cfg) throw fail(404, 'Unknown source');
    const act = ctx.params.act;
    let msg = '';
    if (act === 'review') {
      const f = await ctx.form();
      await ctx.store.update('source_config', { source: cfg.source }, { terms_reviewed_at: ctx.now().toISOString(), terms_notes: String(f.notes || '').slice(0, 300) || null });
      msg = 'Terms marked reviewed.';
    } else if (act === 'enable') {
      if (!cfg.terms_reviewed_at) throw fail(400, 'Mark the terms reviewed before enabling this source.');
      await ctx.store.update('source_config', { source: cfg.source }, { enabled: true, auto_disabled: false, consecutive_failures: 0 });
      ctx.bust('sources');
      msg = 'Enabled.';
    } else if (act === 'disable') {
      await ctx.store.update('source_config', { source: cfg.source }, { enabled: false });
      ctx.bust('sources');
      msg = 'Disabled.';
    } else if (act === 'test') {
      const ad = ADAPTERS[cfg.source];
      if (!ad) throw fail(400, 'No adapter for this source.');
      try {
        const rows = await ad.fetchRaw(ctx.fetchImpl, ctx.now(), { key: ctx.config.samKey });
        msg = `Test fetch OK: ${rows.length} raw rows, ${rows.map((x) => ad.normalize(x)).filter(Boolean).length} usable. Nothing stored.`;
      } catch (e) { msg = `Test fetch FAILED: ${String(e.message || e).slice(0, 200)}`; }
    } else throw fail(404, 'Unknown action');
    await audit(ctx.store, who(s), `source.${act}`, cfg.source, {});
    return done(`/admin/sources?ok=${encodeURIComponent(msg)}`);
  }));

  /* ---------------- inbox: health card, settings, review queue ---------------- */
  async function inboxCard(ctx) {
    const cfg = await inboxSettings(ctx.store);
    const since = new Date(ctx.now().getTime() - 7 * 86400000).toISOString();
    const msgs = await selectAll(ctx.store, 'inbound_messages', { where: { received_at: { gte: since } }, columns: 'status' });
    const by = (st) => msgs.filter((m) => m.status === st).length;
    const sRows = await ctx.store.select('settings', { where: { key: { like: 'llm.*' } } });
    const set = Object.fromEntries(sRows.map((x) => [x.key, x.value]));
    const llm = createLlm({ config: ctx.config, store: ctx.store, fetchImpl: ctx.fetchImpl, now: ctx.now });
    const spent = await llm.monthSpend(ctx.now());
    const avail = await llm.available();
    const calls = await selectAll(ctx.store, 'llm_calls', { where: { created_at: { gte: since } }, columns: 'outcome' });
    const outcomes = {};
    for (const c of calls) outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
    const held = by('held');
    return h`<div class="card" style="margin-bottom:12px"><h3>Forwarded-alert inbox <span class="pill ${cfg.enabled && ctx.config.has.inbox ? 'green' : ''}">${cfg.enabled && ctx.config.has.inbox ? 'on' : 'off'}</span></h3>
<p class="small">Inbound domain: ${ctx.config.inboundDomain || 'NOT SET (INBOUND_DOMAIN)'} · email provider ${ctx.config.has.email ? 'configured' : 'NOT configured'}.<br>
Last 7 days: ${msgs.length} received · ${by('parsed')} added · <a href="/admin/review">${held} need review</a> · ${by('dropped')} ignored · ${by('failed')} failed · ${by('received') + by('fetched')} in progress.</p>
<p class="small">AI fallback: <b>${avail.ok ? 'on' : `off (${avail.reason})`}</b> · month-to-date spend $${spent.toFixed(4)} of cap ${set['llm.monthly_cap_usd'] ? `$${Number(set['llm.monthly_cap_usd']).toFixed(2)}` : 'not set'} · model ${ctx.config.llmModel || 'not set'} (${ctx.config.llmProvider}) · calls (7 days): ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}</p>
<form method="post" action="/admin/inbox/settings" class="stack">
<label><input type="checkbox" name="inbox_enabled" value="1" ${cfg.enabled ? raw('checked') : ''}> Accept forwarded mail (kill switch)</label>
<label for="dl">Emails accepted per customer per day</label><input id="dl" name="daily_limit" inputmode="numeric" value="${cfg.dailyLimit}">
<label for="pt">Minimum confidence to add an item (0 to 1)</label><input id="pt" name="parse_threshold" inputmode="decimal" value="${cfg.threshold}">
<label><input type="checkbox" name="llm_enabled" value="1" ${set['llm.enabled'] === true ? raw('checked') : ''}> Allow the AI fallback</label>
<label for="cap">AI monthly cap in US dollars (empty = AI stays off)</label><input id="cap" name="cap" inputmode="decimal" value="${set['llm.monthly_cap_usd'] ?? ''}">
<label for="pi">Model price per million input tokens, US dollars (from your provider's price page)</label><input id="pi" name="price_in" inputmode="decimal" value="${set['llm.price_in_per_m'] ?? ''}">
<label for="po">Model price per million output tokens, US dollars</label><input id="po" name="price_out" inputmode="decimal" value="${set['llm.price_out_per_m'] ?? ''}">
<p><button class="btn sm" type="submit">Save inbox settings</button></p></form></div>`;
  }

  r.post('/admin/inbox/settings', A(async (ctx, s) => {
    const f = await ctx.form();
    const num = (v) => (String(v ?? '').trim() === '' ? null : Number(v));
    const limit = num(f.daily_limit);
    const thr = num(f.parse_threshold);
    const cap = num(f.cap);
    const pin = num(f.price_in);
    const pout = num(f.price_out);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail(400, 'Emails per day must be a whole number from 1 to 500.');
    if (!Number.isFinite(thr) || thr <= 0 || thr > 1) throw fail(400, 'Confidence must be above 0 and at most 1.');
    for (const [name, v] of [['cap', cap], ['input price', pin], ['output price', pout]]) if (v !== null && (!Number.isFinite(v) || v < 0)) throw fail(400, `The ${name} must be a non-negative number.`);
    const t = ctx.now().toISOString();
    const rows = [
      { key: 'inbox.enabled', value: f.inbox_enabled === '1' }, { key: 'inbox.daily_limit', value: limit }, { key: 'inbox.parse_threshold', value: thr },
      { key: 'llm.enabled', value: f.llm_enabled === '1' },
    ];
    // An empty field means "not set": delete the row so the AI stays off instead of storing a fake zero.
    for (const [key, v] of [['llm.monthly_cap_usd', cap], ['llm.price_in_per_m', pin], ['llm.price_out_per_m', pout]]) {
      if (v === null) await ctx.store.delete('settings', { key }); else rows.push({ key, value: v });
    }
    await ctx.store.upsert('settings', rows.map((x) => ({ ...x, updated_at: t })), { onConflict: 'key' });
    await audit(ctx.store, who(s), 'inbox.settings', null, { inbox: f.inbox_enabled === '1', llm: f.llm_enabled === '1', limit, thr, cap, pin, pout });
    return done('/admin/sources?ok=Inbox settings saved.');
  }));

  r.get('/admin/review', A(async (ctx) => {
    const held = await ctx.store.select('inbound_messages', { where: { status: 'held' }, order: 'received_at.desc', limit: 50 });
    const failed = await ctx.store.select('inbound_messages', { where: { status: 'failed' }, order: 'received_at.desc', limit: 20 });
    const accts = Object.fromEntries((await selectAll(ctx.store, 'accounts', { where: { id: { in: [...new Set([...held, ...failed].map((m) => m.account_id))].slice(0, 80) } }, columns: 'id,email' })).map((a) => [a.id, a.email]));
    const body = h`${flash(ctx)}<p class="small muted">Forwarded emails the rules (and AI, if on) could not read confidently. Read the text, type in only what the email states, and release it. Leave anything unknown blank. Releasing marks the item "entered by staff" for the customer. Opening this page shows customer email content: only act on it to fix their alert.</p>
<h2>Needs review (${held.length})</h2>
${held.length ? each(held, (m) => {
    const guess = (m.held_items || [])[0] || {};
    return h`<div class="card" style="margin-bottom:14px"><div class="small muted">${fmtAz(m.received_at)} · ${accts[m.account_id] || m.account_id} · from ${m.from_domain || '?'} · method ${m.parse_method || 'none'} · confidence ${m.confidence ?? '-'}</div>
<h3>${m.subject || '(no subject)'}</h3><pre class="draft" style="max-height:260px;overflow:auto;white-space:pre-wrap">${(m.body_text || '').slice(0, 2500)}</pre>
<form method="post" action="/admin/review/${m.id}/release" class="stack"><label>Title</label><input name="title" value="${guess.title?.value || ''}" maxlength="200">
<label>Agency</label><input name="agency" value="${guess.agency?.value || ''}" maxlength="120">
<label>Deadline, Arizona time</label><input type="datetime-local" name="deadline" value="${(guess.deadline?.iso || '').slice(0, 16)}">
<label>Link (https://)</label><input name="url" value="${guess.url?.value || ''}" maxlength="500">
<label>Stated value, US dollars</label><input name="value" inputmode="numeric" value="${guess.value_stated?.amount || ''}">
<p><button class="btn sm" type="submit">Release to the customer</button></p></form>
<form method="post" action="/admin/review/${m.id}/reject"><button class="btn sm alt" type="submit">Not a bid alert: drop it</button></form></div>`;
  }) : h`<div class="card"><p>Nothing waiting.</p></div>`}
<h2>Failed after 5 attempts (${failed.length})</h2>
${failed.length ? each(failed, (m) => h`<div class="card" style="margin-bottom:8px"><div class="small muted">${fmtAz(m.received_at)} · ${accts[m.account_id] || m.account_id} · ${m.error || ''}</div><form method="post" action="/admin/review/${m.id}/retry"><button class="btn sm alt" type="submit">Try again</button></form></div>`) : h`<div class="card"><p>None.</p></div>`}`;
    return shell(ctx, 'Review queue', body, '/admin/review');
  }));

  r.post('/admin/review/:id/release', A(async (ctx, s) => {
    const f = await ctx.form();
    const res = await releaseHeld({ store: ctx.store, now: ctx.now() }, ctx.params.id, f);
    if (!res.ok) throw fail(400, res.error);
    await audit(ctx.store, who(s), 'inbox.release', ctx.params.id, { items: res.ids.length });
    return done('/admin/review?ok=Released.');
  }));
  r.post('/admin/review/:id/reject', A(async (ctx, s) => {
    if (!(await rejectHeld(ctx.store, ctx.params.id))) throw fail(404, 'Not waiting for review.');
    await audit(ctx.store, who(s), 'inbox.reject', ctx.params.id, {});
    return done('/admin/review?ok=Dropped.');
  }));
  r.post('/admin/review/:id/retry', A(async (ctx, s) => {
    if (!(await retryMessage(ctx.store, ctx.params.id))) throw fail(404, 'Cannot retry that message.');
    await audit(ctx.store, who(s), 'inbox.retry', ctx.params.id, {});
    return done('/admin/review?ok=Queued for another try.');
  }));

  /* ---------------- 5. rules ---------------- */
  r.get('/admin/rules', A(async (ctx) => {
    const rows = await ctx.store.select('settings');
    const m = Object.fromEntries(rows.map((x) => [x.key, x.value]));
    const w = { ...DEFAULT_WEIGHTS, ...(m.scoring_weights || {}) };
    const t = { ...DEFAULT_THRESHOLDS, ...(m.thresholds || {}) };
    const body = h`${flash(ctx)}<form class="stack card" method="post" action="/admin/rules"><h3>Scoring weights (should add up to 100)</h3>
${each(Object.keys(DEFAULT_WEIGHTS), (k) => h`<label for="w-${k}">${k}</label><input id="w-${k}" name="w_${k}" type="number" min="0" max="100" value="${w[k]}">`)}
<h3 style="margin-top:18px">Thresholds</h3>
<label for="t-dm">Minimum score to appear in a digest</label><input id="t-dm" name="deliver_min" type="number" min="0" max="100" value="${t.deliver_min}">
<label for="t-mi">Max items per digest (1 to 5)</label><input id="t-mi" name="max_items" type="number" min="1" max="5" value="${t.max_items}">
<label for="t-fd">Permit freshness window (days)</label><input id="t-fd" name="freshness_days" type="number" min="7" max="365" value="${t.freshness_days}">
<p><button class="btn" type="submit">Save rules</button></p></form>
<h2>Trade taxonomy (read-only here; edit src/taxonomy.js)</h2>
<div class="scroll"><table class="t"><thead><tr><th>Trade</th><th>Group</th><th>NAICS</th><th>CSI</th><th>Keywords</th></tr></thead><tbody>${each(Object.values(TRADES), (x) => h`<tr><td>${x.label}</td><td>${x.group}</td><td>${(x.naics || []).join(', ')}</td><td>${(x.csi || []).join(', ')}</td><td>${(x.keywords || []).join(', ')}</td></tr>`)}</tbody></table></div>`;
    return shell(ctx, 'Matching rules', body, '/admin/rules');
  }));

  r.post('/admin/rules', A(async (ctx, s) => {
    const f = await ctx.form();
    const weights = {};
    for (const k of Object.keys(DEFAULT_WEIGHTS)) {
      const n = Number(f[`w_${k}`]);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw fail(400, `Weight "${k}" must be 0 to 100.`);
      weights[k] = n;
    }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum !== 100) throw fail(400, `Weights add up to ${sum}; they must add up to 100 so scores stay on a 0 to 100 scale.`);
    const th = { deliver_min: Number(f.deliver_min), max_items: Number(f.max_items), freshness_days: Number(f.freshness_days), urgent_min: DEFAULT_THRESHOLDS.urgent_min };
    if (![th.deliver_min, th.max_items, th.freshness_days].every(Number.isFinite) || th.max_items < 1 || th.max_items > 5) throw fail(400, 'Check the thresholds: max items must be 1 to 5.');
    const now = ctx.now().toISOString();
    await ctx.store.upsert('settings', [{ key: 'scoring_weights', value: weights, updated_at: now }, { key: 'thresholds', value: th, updated_at: now }], { onConflict: 'key' });
    await audit(ctx.store, who(s), 'rules.update', null, { weights, th });
    return done('/admin/rules?ok=Saved.');
  }));

  /* ---------------- 6. deliverability ---------------- */
  r.get('/admin/deliverability', A(async (ctx) => {
    const since = new Date(ctx.now().getTime() - 30 * 86400000).toISOString();
    const out = await selectAll(ctx.store, 'outbox', { where: { created_at: { gte: since } }, columns: 'status,kind,error,to_email,created_at' });
    const by = {};
    for (const o of out) by[o.status] = (by[o.status] || 0) + 1;
    const supp = await ctx.store.select('suppressions', { order: 'created_at.desc', limit: 50 });
    const unsub = await ctx.store.count('accounts', { unsubscribed_at: { isnull: false } });
    const failures = out.filter((o) => o.status === 'failed').slice(0, 20);
    const opened = await ctx.store.count('digests', { opened_at: { isnull: false }, created_at: { gte: since } });
    const sent = await ctx.store.count('digests', { sent_at: { isnull: false }, created_at: { gte: since } });
    const body = h`<div class="kpi">${each(Object.entries(by), ([k, v]) => h`<div class="card"><b>${v}</b>${k}</div>`)}<div class="card"><b>${unsub}</b>unsubscribed</div><div class="card"><b>${sent ? Math.round((opened / sent) * 100) : 0}%</b>digest open rate (approximate)</div></div>
<p class="small muted">Open rate counts image loads, which some mail apps trigger automatically. Treat it as a ceiling. SMS is not built, so there are no SMS opt-outs to show.</p>
<h2>Recent failures</h2><ul class="plain small">${each(failures, (f) => h`<li>${f.kind} to ${f.to_email}: ${f.error}</li>`)}</ul>
<h2>Suppression list (never emailed)</h2><ul class="plain small">${each(supp, (x) => h`<li>${x.email}: ${x.reason}</li>`)}</ul>`;
    return shell(ctx, 'Deliverability', body, '/admin/deliverability');
  }));

  /* ---------------- 7. pricing ---------------- */
  r.get('/admin/pricing', A(async (ctx) => {
    const plans = await ctx.store.select('plans', { order: 'price_cents.asc' });
    const body = h`${flash(ctx)}<p class="small muted">No single charge may exceed $50.00 (enforced here and in the database). Changing a price creates a new Stripe price for new sign-ups; existing subscribers keep the price they signed up at until you change it in Stripe. Promo codes: create them in the Stripe Dashboard (Product catalog &gt; Coupons &gt; Promotion codes); the checkout page already accepts them.</p>
${each(plans, (p) => h`<form class="stack card" method="post" action="/admin/pricing/${p.id}" style="margin-bottom:12px"><h3>${p.name} <span class="pill">${p.id}</span></h3>
<label for="pr-${p.id}">Monthly price (dollars)</label><input id="pr-${p.id}" name="price" type="number" step="0.01" min="1" max="50" value="${(p.price_cents / 100).toFixed(2)}">
<label for="td-${p.id}">Trial days</label><input id="td-${p.id}" name="trial_days" type="number" min="0" max="60" value="${p.trial_days}">
<label for="tg-${p.id}">Trade groups allowed</label><input id="tg-${p.id}" name="trade_group_limit" type="number" min="1" max="10" value="${p.trade_group_limit}">
<label for="ar-${p.id}">Service areas allowed</label><input id="ar-${p.id}" name="area_limit" type="number" min="1" max="10" value="${p.area_limit}">
<div class="checks"><label><input type="checkbox" name="active" value="1" ${p.active ? raw('checked') : ''}> <span>Offered for new sign-ups</span></label></div>
<p class="small muted">Stripe price: ${p.stripe_price_id || 'not created yet (created at first checkout)'}</p>
<p><button class="btn sm" type="submit">Save ${p.name}</button></p></form>`)}`;
    return shell(ctx, 'Pricing and trials', body, '/admin/pricing');
  }));

  r.post('/admin/pricing/:id', A(async (ctx, s) => {
    const plan = await ctx.store.one('plans', { where: { id: ctx.params.id } });
    if (!plan) throw fail(404, 'Unknown plan');
    const f = await ctx.form();
    const cents = Math.round(Number(f.price) * 100);
    if (!Number.isFinite(cents) || cents < 100 || cents > 5000) throw fail(400, 'Price must be between $1.00 and $50.00.');
    const patch = {
      price_cents: cents, trial_days: Math.max(0, Math.min(60, Math.round(Number(f.trial_days)) || 0)),
      trade_group_limit: Math.max(1, Math.min(10, Math.round(Number(f.trade_group_limit)) || 1)), area_limit: Math.max(1, Math.min(10, Math.round(Number(f.area_limit)) || 1)),
      active: Boolean(f.active), updated_at: ctx.now().toISOString(),
    };
    if (cents !== plan.price_cents && plan.stripe_price_id) {
      if (ctx.stripe) { try { await ctx.stripe.archivePrice(plan.stripe_price_id); } catch { /* old price may already be archived */ } }
      patch.stripe_price_id = null;
    }
    await ctx.store.update('plans', { id: plan.id }, patch);
    ctx.bust('plans');
    await audit(ctx.store, who(s), 'plan.update', plan.id, { from: plan.price_cents, to: cents });
    return done('/admin/pricing?ok=Saved.');
  }));

  /* ---------------- 8. audit ---------------- */
  r.get('/admin/audit', A(async (ctx) => {
    const rows = await ctx.store.select('audit_log', { order: 'ts.desc', limit: 200 });
    return shell(ctx, 'Audit log', h`<div class="scroll"><table class="t"><thead><tr><th>When (AZ)</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${each(rows, (x) => h`<tr><td>${fmtAz(x.ts)}</td><td>${x.actor}</td><td>${x.action}</td><td>${x.target || ''}</td><td>${JSON.stringify(x.detail || {}).slice(0, 160)}</td></tr>`)}</tbody></table></div>`, '/admin/audit');
  }));
}
