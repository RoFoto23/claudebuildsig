import { h, each, when, raw } from './html.js';
import { html, redirect, json, respond, asArray } from './http.js';
import { evaluate, money } from './scoring.js';
import { TRADE_IDS, COVERED_JURISDICTIONS, CERTIFICATIONS, cleanMulti, parseZips, groupsForTrades, TRADES } from './taxonomy.js';
import { introEmail, callScript, capabilityStatement, proposalDraft, formsChecklist, buildIcs } from './kit.js';
import { opportunityCard, profileFields, checklistList, dollars, deadlineLine } from './views.js';
import { kitSections, capabilityPage } from './kitview.js';
import { applyDisposition, setAction, featuresFor, hasAccess, ACTION_LABELS } from './actions.js';
import { selectAll, fmtDay, fmtAz } from './time.js';
import { audit } from './jobs.js';
import { deleteAccountInbox, inboxSettings } from './inbox.js';
import { createHash } from 'node:crypto';

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function parseProfile(f, plan) {
  const errors = [];
  const trades = cleanMulti(asArray(f.trades), TRADE_IDS);
  const jurisdictions = cleanMulti(asArray(f.jurisdictions), COVERED_JURISDICTIONS);
  const min_value = num(f.min_value);
  const max_value = num(f.max_value);
  const bonding_limit = num(f.bonding_limit);
  const insurance_limit = num(f.insurance_limit);
  for (const [k, v] of Object.entries({ 'Smallest job': min_value, 'Largest job': max_value, 'Bonding capacity': bonding_limit, 'Insurance limit': insurance_limit })) if (Number.isNaN(v)) errors.push(`${k} must be a number.`);
  if (min_value !== null && max_value !== null && min_value > max_value) errors.push('Smallest job is larger than largest job.');
  const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const license_number = clean(f.license_number, 20).replace(/\s+/g, '');
  if (license_number && !/^[A-Za-z0-9-]{3,20}$/.test(license_number)) errors.push('License number should be letters, digits and dashes only.');
  const license_classes = [...new Set(String(f.license_classes || '').toUpperCase().split(/[\s,;]+/).filter((t) => /^[A-Z]{1,3}-?\d{1,3}[A-Z]{0,2}$/.test(t)))].slice(0, 10);
  const rate_card = [];
  for (const line of String(f.rate_card || '').split(/\r?\n/).slice(0, 40)) {
    const [label, unit, rate] = line.split('|').map((s) => s.trim());
    if (!label) continue;
    const n = num(rate);
    if (n === null || Number.isNaN(n) || n <= 0) { errors.push(`Rate card line "${label.slice(0, 40)}" needs a rate like 8.50.`); continue; }
    rate_card.push({ label: label.slice(0, 80), unit: (unit || 'unit').slice(0, 20), rate: n });
  }
  if (!clean(f.business_name, 120)) errors.push('Business name is required.');
  if (!clean(f.contact_name, 80)) errors.push('Your name is required.');
  if (!trades.length) errors.push('Pick at least one trade.');
  if (!jurisdictions.length) errors.push('Pick at least one area.');
  if (plan && groupsForTrades(trades).length > plan.trade_group_limit) errors.push(`${plan.name} covers up to ${plan.trade_group_limit} trade group${plan.trade_group_limit === 1 ? '' : 's'}. Remove some trades or switch plans.`);
  if (plan && jurisdictions.length > plan.area_limit) errors.push(`${plan.name} covers up to ${plan.area_limit} service area${plan.area_limit === 1 ? '' : 's'}.`);
  const profile = {
    business_name: clean(f.business_name, 120), contact_name: clean(f.contact_name, 80), phone: clean(f.phone, 30) || null,
    trades, jurisdictions, zips: parseZips(f.zips), min_value, max_value, license_number: license_number || null, license_classes,
    certifications: cleanMulti(asArray(f.certifications), Object.keys(CERTIFICATIONS)), bonding_limit, insurance_limit,
    digest_frequency: f.digest_frequency === 'weekly' ? 'weekly' : 'daily', capability_blurb: clean(f.capability_blurb, 600) || null, rate_card,
  };
  return { profile, errors };
}

export function registerApp(r, { fail }) {
  const planFor = (plans, account) => plans.find((p) => p.id === account.plan_id) || plans[0];

  async function loadProfile(ctx, account) {
    return (await ctx.store.one('profiles', { where: { account_id: account.id } })) || (await ctx.store.insert('profiles', { account_id: account.id }))[0];
  }

  function billingBox(ctx, account, plan) {
    const { config } = ctx;
    const trialLeft = account.trial_end ? Math.max(0, Math.ceil((Date.parse(account.trial_end) - ctx.now().getTime()) / 86400000)) : null;
    const portal = h`<form method="post" action="/app/billing/portal" style="display:inline"><button class="btn alt sm" type="submit">Manage or cancel billing</button></form>`;
    switch (account.billing_status) {
      case 'none':
        return config.has.billing
          ? h`<div class="notice warn"><b>Your digest starts after you add a card.</b> ${plan.trial_days}-day free trial, then ${dollars(plan.price_cents)}/month (${plan.name}). Cancel or pause in one click.<form method="post" action="/app/billing/checkout" style="margin-top:8px"><button class="btn" type="submit">Start free trial</button></form></div>`
          : h`<div class="notice warn">Billing is not connected on this site yet, so the trial cannot start.</div>`;
      case 'trialing': return h`<div class="notice">Free trial: ${trialLeft} day${trialLeft === 1 ? '' : 's'} left (ends ${fmtDay(account.trial_end)}). Then ${dollars(plan.price_cents)}/month unless you cancel. ${portal}</div>`;
      case 'active': return h`<div class="notice">${plan.name} plan, active${account.cancel_at_period_end ? `. Ends ${fmtDay(account.current_period_end)} (canceled)` : `. Renews ${fmtDay(account.current_period_end)}`}. ${portal}</div>`;
      case 'past_due': return h`<div class="notice bad"><b>Payment failed.</b> Update your card to keep getting digests. ${portal}</div>`;
      case 'paused': return h`<div class="notice warn">Paused: no digests and no billing. <form method="post" action="/app/billing/resume" style="display:inline"><button class="btn sm" type="submit">Resume</button></form></div>`;
      default: return h`<div class="notice warn">Your subscription ended. <form method="post" action="/app/billing/checkout" style="display:inline"><button class="btn sm" type="submit">Restart</button></form></div>`;
    }
  }

  /* ---------------- dashboard ---------------- */
  r.get('/app', async (ctx) => {
    const s = await ctx.requireUser();
    if (s.isAdminCandidate && !s.account.plan_id) return redirect('/admin');
    const plans = await ctx.getPlans();
    const account = s.account;
    const profile = await loadProfile(ctx, account);
    if (!profile.onboarded_at) return redirect('/app/onboarding');
    const plan = planFor(plans, account);
    const matches = await ctx.store.select('matches', { where: { account_id: account.id, delivered_at: { isnull: false } }, order: 'delivered_at.desc', limit: 15 });
    const opps = matches.length ? await ctx.store.select('opportunities', { where: { id: { in: matches.map((m) => m.opportunity_id) } } }) : [];
    const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
    const feat = featuresFor(account, plans);
    const inboxOn = ctx.config.has.inbox && (await inboxSettings(ctx.store)).enabled;
    const body = h`<div class="wrap" style="padding-top:20px"><h1>Dashboard</h1>
${ctx.url.searchParams.get('checkout') === 'success' ? h`<div class="notice">Thanks. Your trial is being set up; this page updates within a minute.</div>` : ''}
${billingBox(ctx, account, plan)}
${account.unsubscribed_at ? h`<div class="notice warn" style="margin-top:10px">You unsubscribed from emails. <form method="post" action="/app/resubscribe" style="display:inline"><button class="btn sm" type="submit">Turn emails back on</button></form></div>` : ''}
${account.digest_paused ? h`<div class="notice warn" style="margin-top:10px">Digests are paused. Resume in <a href="/app/settings">Settings</a>.</div>` : ''}
<div class="actions"><a class="btn dark" href="/app/settings">Profile and settings</a>${when(feat.pipeline, h`<a class="btn alt" href="/app/pipeline">Pipeline</a>`)}${when(inboxOn, h`<a class="btn alt" href="/app/inbox">Forwarded alerts</a>`)}</div>
<h2>Recent matches</h2>
${matches.length ? each(matches, (m) => {
    const o = byId[m.opportunity_id];
    if (!o) return '';
    return h`<div class="card" style="margin-bottom:10px"><div class="small muted">Score ${m.score}/100 · ${deadlineLine(o)} ${m.disposition ? h`· <span class="pill">${m.disposition.replace('_', ' ')}</span>` : ''}</div><h3><a href="/app/m/${m.id}">${o.title}</a></h3><p class="small muted">${o.agency || ''}${o.address ? ` · ${o.address}` : ''}</p></div>`;
  }) : h`<div class="card"><p>No matches yet. Your first digest arrives at about 6 a.m. Arizona time once your trial has started and new items fit. If nothing fits you get a short "no strong matches" note, not filler.</p></div>`}
</div>`;
    return ctx.render('Dashboard', body, { noindex: true, current: 'app' });
  });

  r.post('/app/resubscribe', async (ctx) => {
    const s = await ctx.requireUser();
    await ctx.store.update('accounts', { id: s.account.id }, { unsubscribed_at: null });
    return redirect('/app');
  });

  /* ---------------- onboarding & settings ---------------- */
  async function profilePage(ctx, { onboarding, errors = [], values = null }) {
    const s = await ctx.requireUser();
    const plans = await ctx.getPlans();
    const plan = planFor(plans, s.account);
    const p = values || (await loadProfile(ctx, s.account));
    const account = s.account;
    const body = h`<div class="wrap narrow" style="padding-top:20px"><h1>${onboarding ? 'Set up your profile' : 'Settings'}</h1>
${onboarding ? h`<p>About three minutes. This decides what you see. Plan: <b>${plan.name}</b>.</p>` : ''}
${when(errors.length > 0, h`<div class="notice bad" role="alert"><b>Please fix:</b><ul class="plain">${each(errors, (e) => h`<li>${e}</li>`)}</ul></div>`)}
<form class="stack" method="post" action="${onboarding ? '/app/onboarding' : '/app/settings'}">${profileFields(p, plan, { forOnboarding: onboarding })}
<p><button class="btn" type="submit">${onboarding ? 'Save and continue' : 'Save settings'}</button></p></form>
${onboarding ? '' : h`
<h2>Billing and digests</h2>
${billingBox(ctx, account, plan)}
<div class="actions">
${account.digest_paused || account.billing_status === 'paused' ? h`<form method="post" action="/app/billing/resume"><button class="btn" type="submit">Resume digests${account.billing_status === 'paused' ? ' and billing' : ''}</button></form>` : h`<form method="post" action="/app/billing/pause"><button class="btn alt" type="submit">Pause digests${account.stripe_customer_id && ctx.config.has.billing ? ' and billing' : ''}</button></form>`}
${account.stripe_customer_id && ctx.config.has.billing ? h`<form method="post" action="/app/billing/portal"><button class="btn alt" type="submit">Billing portal (card, invoices, cancel)</button></form>` : ''}
</div>
<h2>Your data</h2>
<div class="actions"><a class="btn alt" href="/app/export">Download my data (JSON)</a></div>
<form method="post" action="/app/delete" class="stack card" style="margin-top:14px"><h3>Delete my account</h3><p class="small muted">Removes your profile, matches and sign-in records, and cancels any subscription right away. This cannot be undone.</p>
<label for="confirm">Type DELETE to confirm</label><input id="confirm" name="confirm" type="text" autocomplete="off"><p><button class="btn danger" type="submit">Delete my account</button></p></form>`}
<form method="post" action="/logout" style="margin-top:20px"><button class="btn alt sm" type="submit">Sign out</button></form></div>`;
    return ctx.render(onboarding ? 'Set up your profile' : 'Settings', body, { noindex: true, current: 'app', status: errors.length ? 400 : 200 });
  }

  const saveProfile = (onboarding) => async (ctx) => {
    const s = await ctx.requireUser();
    const plans = await ctx.getPlans();
    const plan = planFor(plans, s.account);
    const f = await ctx.form();
    const { profile, errors } = parseProfile(f, plan);
    if (errors.length) return profilePage(ctx, { onboarding, errors, values: { ...profile, trades: profile.trades, rate_card: profile.rate_card } });
    const existing = await loadProfile(ctx, s.account);
    await ctx.store.update('profiles', { account_id: s.account.id }, { ...profile, updated_at: ctx.now().toISOString(), ...(existing.onboarded_at ? {} : { onboarded_at: ctx.now().toISOString() }) });
    if (!existing.onboarded_at) ctx.logEvent('activated_profile', {});
    return redirect(onboarding ? '/app' : '/app/settings');
  };
  r.get('/app/onboarding', (ctx) => profilePage(ctx, { onboarding: true }));
  r.post('/app/onboarding', saveProfile(true));
  r.get('/app/settings', (ctx) => profilePage(ctx, { onboarding: false }));
  r.post('/app/settings', saveProfile(false));

  /* ---------------- billing ---------------- */
  r.post('/app/billing/checkout', async (ctx) => {
    const s = await ctx.requireUser();
    if (!ctx.stripe) throw fail(503, 'Billing is not connected yet.');
    const profile = await loadProfile(ctx, s.account);
    if (!profile.onboarded_at) return redirect('/app/onboarding');
    if (['trialing', 'active', 'past_due'].includes(s.account.billing_status)) return redirect('/app');
    const plans = await ctx.getPlans();
    const plan = planFor(plans, s.account);
    let priceId = plan.stripe_price_id;
    if (!priceId) {
      priceId = await ctx.stripe.syncPlanPrice(plan);
      await ctx.store.update('plans', { id: plan.id }, { stripe_price_id: priceId });
      ctx.bust('plans');
    }
    const trialDays = s.account.trial_end || s.account.stripe_customer_id ? undefined : plan.trial_days; // one trial per account
    const session = await ctx.stripe.createCheckout({ accountId: s.account.id, email: s.account.email, customerId: s.account.stripe_customer_id, priceId, trialDays, planId: plan.id, successUrl: `${ctx.config.baseUrl}/app?checkout=success`, cancelUrl: `${ctx.config.baseUrl}/app?checkout=cancel` });
    ctx.logEvent('checkout', { plan: plan.id });
    return redirect(session.url);
  });

  r.post('/app/billing/portal', async (ctx) => {
    const s = await ctx.requireUser();
    if (!ctx.stripe || !s.account.stripe_customer_id) throw fail(400, 'There is no billing account to manage yet.');
    const session = await ctx.stripe.createPortal(s.account.stripe_customer_id, `${ctx.config.baseUrl}/app/settings`);
    return redirect(session.url);
  });

  async function subscriptionId(ctx, account) {
    if (!ctx.stripe || !account.stripe_customer_id) return null;
    const list = await ctx.stripe.api('/subscriptions', { customer: account.stripe_customer_id, status: 'all', limit: 5 }, 'GET');
    return (list.data || []).find((x) => ['trialing', 'active', 'past_due'].includes(x.status))?.id || null;
  }

  r.post('/app/billing/pause', async (ctx) => {
    const s = await ctx.requireUser();
    const patch = { digest_paused: true };
    const subId = await subscriptionId(ctx, s.account);
    if (subId) { await ctx.stripe.pause(subId); patch.billing_status = 'paused'; }
    await ctx.store.update('accounts', { id: s.account.id }, patch);
    await ctx.store.insert('events', { name: 'pause', account_id: s.account.id, props: { billing: Boolean(subId) } });
    return redirect('/app/settings');
  });

  r.post('/app/billing/resume', async (ctx) => {
    const s = await ctx.requireUser();
    const patch = { digest_paused: false };
    if (ctx.stripe && s.account.stripe_customer_id) {
      const list = await ctx.stripe.api('/subscriptions', { customer: s.account.stripe_customer_id, status: 'all', limit: 5 }, 'GET');
      const sub = (list.data || []).find((x) => x.pause_collection);
      if (sub) { await ctx.stripe.resume(sub.id); patch.billing_status = sub.trial_end && sub.trial_end * 1000 > ctx.now().getTime() ? 'trialing' : 'active'; }
    }
    await ctx.store.update('accounts', { id: s.account.id }, patch);
    return redirect('/app/settings');
  });

  /* ---------------- data export & deletion ---------------- */
  r.get('/app/export', async (ctx) => {
    const s = await ctx.requireUser();
    const a = s.account;
    const profile = await ctx.store.one('profiles', { where: { account_id: a.id } });
    const matches = await selectAll(ctx.store, 'matches', { where: { account_id: a.id } });
    const opps = matches.length ? await ctx.store.select('opportunities', { where: { id: { in: matches.map((m) => m.opportunity_id) } }, columns: 'id,title,agency,url,source_id' }) : [];
    const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
    const inboxRows = await selectAll(ctx.store, 'inbound_messages', { where: { account_id: a.id }, columns: 'received_at,from_domain,subject,status,kind,parse_method,body_text' });
    const forwarded = await selectAll(ctx.store, 'opportunities', { where: { owner_account_id: a.id }, columns: 'title,agency,deadline,url,status,provenance,also_seen_via,first_seen' });
    const out = {
      exported_at: ctx.now().toISOString(),
      account: { email: a.email, plan: a.plan_id, billing_status: a.billing_status, created_at: a.created_at, unsubscribed_at: a.unsubscribed_at },
      profile,
      forwarded_emails: inboxRows,
      forwarded_items: forwarded,
      matches: matches.map((m) => ({ score: m.score, disposition: m.disposition, action: m.action, note: m.note, delivered_at: m.delivered_at, opportunity: byId[m.opportunity_id] || null })),
    };
    return respond(JSON.stringify(out, null, 2), { type: 'application/json; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="buildsignal-data.json"' } });
  });

  r.post('/app/delete', async (ctx) => {
    const s = await ctx.requireUser();
    const f = await ctx.form();
    if (String(f.confirm || '').trim() !== 'DELETE') throw fail(400, 'Type DELETE exactly to confirm.');
    if (s.account.role === 'admin') throw fail(400, 'Admin accounts cannot be deleted here.');
    const a = s.account;
    if (ctx.stripe && a.stripe_customer_id) {
      try {
        const list = await ctx.stripe.api('/subscriptions', { customer: a.stripe_customer_id, status: 'all', limit: 10 }, 'GET');
        for (const sub of list.data || []) if (!['canceled', 'incomplete_expired'].includes(sub.status)) await ctx.stripe.api(`/subscriptions/${sub.id}`, {}, 'DELETE');
      } catch (e) { throw fail(502, 'We could not cancel your subscription with the payment provider, so nothing was deleted. Cancel in the billing portal first, then try again.'); }
    }
    await deleteAccountInbox(ctx.store, a.id);
    for (const t of ['matches', 'digests']) await ctx.store.delete(t, { account_id: a.id });
    await ctx.store.delete('outbox', { account_id: a.id });
    await ctx.store.delete('login_tokens', { account_id: a.id });
    await ctx.store.delete('profiles', { account_id: a.id });
    await ctx.store.update('events', { account_id: a.id }, { account_id: null });
    await ctx.store.delete('accounts', { id: a.id });
    await audit(ctx.store, 'customer', 'account.deleted', createHash('sha256').update(a.email).digest('hex').slice(0, 12), {});
    return redirect('/?deleted=1', { cookies: ctx.auth.clearSession() });
  });

  /* ---------------- match detail, kit, pipeline ---------------- */
  async function loadMatch(ctx, id) {
    const s = await ctx.requireUser();
    const m = await ctx.store.one('matches', { where: { id, account_id: s.account.id } });
    if (!m) throw fail(404, 'We could not find that item.');
    const opp = await ctx.store.one('opportunities', { where: { id: m.opportunity_id } });
    if (!opp) throw fail(404, 'That record is no longer available.');
    const profile = await loadProfile(ctx, s.account);
    const plans = await ctx.getPlans();
    return { s, m, opp, profile, plans, feat: featuresFor(s.account, plans) };
  }

  r.get('/app/m/:id', async (ctx) => {
    const { s, m, opp, profile, feat } = await loadMatch(ctx, ctx.params.id);
    const live = evaluate(profile, opp, { now: ctx.now() });
    const ev = { score: m.score, checklist: live.eligible ? live.checklist : m.checklist, why: live.eligible ? live.why : 'This item was delivered earlier; some details may have changed since.' };
    const kit = { email: introEmail(profile, opp), script: callScript(profile, opp), cap: capabilityStatement(profile), proposal: proposalDraft(profile, opp), forms: formsChecklist(profile, opp) };
    const dBtn = (d, label) => h`<form method="post" action="/app/m/${m.id}/disposition"><input type="hidden" name="disposition" value="${d}"><button class="btn ${m.disposition === d ? '' : 'alt'}" type="submit" ${m.disposition === d ? raw('aria-pressed="true"') : ''}>${label}</button></form>`;
    const aBtn = (a) => h`<form method="post" action="/app/m/${m.id}/action"><input type="hidden" name="action" value="${a}"><button class="btn sm ${m.action === a ? '' : 'alt'}" type="submit">${ACTION_LABELS[a]}</button></form>`;
    const interested = m.disposition === 'interested';
    const body = h`<div class="wrap narrow" style="padding-top:20px"><p class="small"><a href="/app">&larr; Dashboard</a></p>
${opportunityCard({ opp, eval: ev, actions: h`<div class="actions">${dBtn('interested', 'Interested')}${dBtn('not_for_me', 'Not for me')}${dBtn('already_knew', 'Already knew')}</div>` })}
<details><summary>How this score was built</summary><div class="scroll"><table class="t"><thead><tr><th>Factor</th><th>Points</th><th>Why</th></tr></thead><tbody>${each(m.factors || [], (f) => h`<tr><td>${f.label}${f.kind === 'inference' ? ' (judgment)' : ''}</td><td>${f.points}${f.weight ? ` / ${f.weight}` : ''}</td><td>${f.note}</td></tr>`)}</tbody></table></div><p class="small muted">Rules score every item the same way. "Your past taps" nudges the score by at most 10 points.</p></details>
${when(opp.kind === 'permit_lead', h`<div class="notice warn" style="margin-top:10px">Permit record, not a bid request. The named contractor <b>may already have its trades</b>; call to get on their bid list.</div>`)}
${interested ? h`<h2>Pipeline</h2>${feat.pipeline ? h`<div class="actions">${each(['none', 'contacted', 'bid_submitted', 'won', 'lost'], aBtn)}</div>` : h`<p class="small muted">Pipeline tracking is part of the Pro plan.</p>`}
<h2>Response kit</h2>${feat.kit ? kitSections({ kit, icsHref: `/app/m/${m.id}/calendar.ics`, capHref: `/app/m/${m.id}/capability` }) : h`<div class="notice warn">The response kit is part of the Pro plan. Open the billing portal to switch.</div>`}` : h`<p class="muted" style="margin-top:14px">Tap <b>Interested</b> to open the response kit: draft email, call script, capability statement, draft proposal, forms checklist and a calendar file.</p>`}
</div>`;
    return ctx.render(opp.title, body, { noindex: true, current: 'app' });
  });

  r.post('/app/m/:id/disposition', async (ctx) => {
    const s = await ctx.requireUser();
    const f = await ctx.form();
    const out = await applyDisposition(ctx.store, { accountId: s.account.id, matchId: ctx.params.id, disposition: f.disposition, now: ctx.now() });
    if (!out) throw fail(404, 'We could not find that item.');
    return redirect(`/app/m/${ctx.params.id}`);
  });

  r.post('/app/m/:id/action', async (ctx) => {
    const { s, feat } = await loadMatch(ctx, ctx.params.id);
    if (!feat.pipeline) throw fail(403, 'Pipeline tracking is part of the Pro plan.');
    const f = await ctx.form();
    const out = await setAction(ctx.store, { accountId: s.account.id, matchId: ctx.params.id, action: f.action, note: f.note ?? null, now: ctx.now() });
    if (!out) throw fail(400, 'Unknown action.');
    return redirect(f.back === 'pipeline' ? '/app/pipeline' : `/app/m/${ctx.params.id}`);
  });

  r.get('/app/m/:id/calendar.ics', async (ctx) => {
    const { opp, profile, feat } = await loadMatch(ctx, ctx.params.id);
    if (!feat.kit) throw fail(403, 'The response kit is part of the Pro plan.');
    return respond(buildIcs(opp, profile, ctx.now()), { type: 'text/calendar; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="buildsignal.ics"' } });
  });

  r.get('/app/m/:id/capability', async (ctx) => {
    const { profile, feat } = await loadMatch(ctx, ctx.params.id);
    if (!feat.kit) throw fail(403, 'The response kit is part of the Pro plan.');
    return ctx.render('Capability statement', capabilityPage(capabilityStatement(profile)), { noindex: true });
  });

  r.get('/app/pipeline', async (ctx) => {
    const s = await ctx.requireUser();
    const plans = await ctx.getPlans();
    const feat = featuresFor(s.account, plans);
    if (!feat.pipeline) return ctx.render('Pipeline', h`<div class="wrap narrow" style="padding:30px 16px"><h1>Pipeline</h1><div class="notice warn">The pipeline is part of the Pro plan. Open the billing portal from Settings to switch.</div></div>`, { noindex: true });
    const all = await selectAll(ctx.store, 'matches', { where: { account_id: s.account.id, delivered_at: { isnull: false } } });
    const interested = all.filter((m) => m.disposition === 'interested');
    const opps = interested.length ? await ctx.store.select('opportunities', { where: { id: { in: interested.map((m) => m.opportunity_id) } } }) : [];
    const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
    const monthStart = new Date(ctx.now().getTime() - 31 * 86400000).toISOString();
    const recent = all.filter((m) => (m.delivered_at || '') >= monthStart);
    const cols = ['none', 'contacted', 'bid_submitted', 'won', 'lost'];
    const card = (m) => {
      const o = byId[m.opportunity_id];
      if (!o) return '';
      return h`<div class="card" style="margin-bottom:8px"><b><a href="/app/m/${m.id}">${o.title}</a></b><div class="small muted">${deadlineLine(o)}</div>
<div class="actions">${each(cols.filter((c) => c !== m.action), (c) => h`<form method="post" action="/app/m/${m.id}/action"><input type="hidden" name="action" value="${c}"><input type="hidden" name="back" value="pipeline"><button class="btn sm alt" type="submit">${ACTION_LABELS[c]}</button></form>`)}</div></div>`;
    };
    const body = h`<div class="wrap" style="padding-top:20px"><h1>Pipeline</h1>
<div class="kpi"><div class="card"><b>${recent.length}</b>seen, last 30 days</div><div class="card"><b>${recent.filter((m) => m.disposition === 'interested').length}</b>marked Interested</div><div class="card"><b>${recent.filter((m) => ['bid_submitted', 'won', 'lost'].includes(m.action)).length}</b>bids submitted</div><div class="card"><b>${recent.filter((m) => m.action === 'won').length}</b>won</div></div>
<p class="small muted">Counts come from what you tap. We do not know the outcome of anything you do not tell us.</p>
<div class="cols">${each(cols, (c) => h`<div><h3>${ACTION_LABELS[c]} (${interested.filter((m) => m.action === c).length})</h3>${each(interested.filter((m) => m.action === c), card)}</div>`)}</div></div>`;
    return ctx.render('Pipeline', body, { noindex: true, current: 'app' });
  });
}
