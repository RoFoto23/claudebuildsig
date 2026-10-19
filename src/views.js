import { h, raw, when, each, esc, toStr, safeHref, forwardedLine, linkLabel } from './html.js';
import { money } from './scoring.js';
import { TRADES, TRADE_GROUPS, JURISDICTIONS, COVERED_JURISDICTIONS, CERTIFICATIONS } from './taxonomy.js';

const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', ...opts }) : '');

/** Shared page shell. `ctx` = { config, session, mode } */
export function page(ctx, { title, desc = '', body, noindex = false, current = '', canonical = '' }) {
  const { config, session } = ctx;
  const full = title.includes(config.brand) ? title : `${title} | ${config.brand}`;
  const user = session?.account;
  const nav = [
    ['/demo', 'Live demo', 'demo'],
    ['/pricing', 'Pricing', 'pricing'],
    ...(user ? [['/app', 'Dashboard', 'app'], ...(session.isAdminCandidate ? [['/admin', 'Admin', 'admin']] : [])] : [['/login', 'Sign in', 'login']]),
  ];
  return h`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${full}</title>
<meta name="description" content="${desc || 'Verified Arizona commercial project and public-bid opportunities, matched to your trade, with plain-English eligibility checks and ready-to-edit drafts.'}">
${when(noindex, raw('<meta name="robots" content="noindex,nofollow">'))}
${when(canonical, h`<link rel="canonical" href="${config.baseUrl}${canonical}">`)}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
</head><body>
<a class="skip" href="#main">Skip to content</a>
${when(!config.signupOpen, h`<div class="banner"><div class="wrap"><b>Early access.</b> Paid sign-ups are not open yet. The demo below uses a frozen sample of real public records, and you can join the waitlist.</div></div>`)}
<header class="top"><div class="wrap">
<a class="brand" href="/">Build<b>Signal</b></a>
<nav class="main" aria-label="Main">${each(nav, ([href, label, key]) => h`<a href="${href}" ${key === current ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
</div></header>
<main id="main">${body}</main>
<footer class="foot"><div class="wrap">
<p><b>${config.brand}</b> turns public records into a short list of leads. It is an information service, not a bidding agent: it never submits anything for you, and it does not guarantee work. Permit values are not contract prices. Not affiliated with any government agency.</p>
<p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refunds">Refunds</a> · <a href="/pricing">Pricing</a> · <a href="/demo">Demo</a>${config.has.address ? '' : ''}</p>
${when(config.has.address, h`<p>${config.mailingAddress}</p>`)}
</div></footer>
</body></html>`;
}

export const dollars = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function checklistList(items) {
  return h`<ul class="check">${each(items, (c) => h`<li><span class="dot ${c.status}" role="img" aria-label="${c.status}"></span><span><b>${c.label}.</b> ${c.reason}</span></li>`)}</ul>`;
}

export function deadlineLine(opp) {
  if (opp.kind === 'public_bid') return opp.deadline ? `Due ${fmtDate(opp.deadline, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Arizona time` : 'No deadline found in the listing';
  return opp.stage === 'issued' ? `Permit issued ${fmtDate(opp.issued_date)}` : opp.stage === 'in_review' ? 'In plan review' : 'Permit record';
}

export function opportunityCard({ opp, eval: ev, actions = null, index = null, detailHref = null }) {
  const meta = [opp.agency, deadlineLine(opp), opp.value ? `Value ${money(Number(opp.value))}` : null, opp.units ? `${opp.units} units` : null, opp.sqft ? `${Number(opp.sqft).toLocaleString('en-US')} sq ft` : null].filter(Boolean).join(' · ');
  return h`<article class="card ${opp.is_sample ? 'sample' : ''}">
<div class="small muted"><b>${index !== null ? `#${index + 1} · ` : ''}FIT SCORE ${ev.score}/100</b> ${when(opp.is_sample, h` <span class="pill sample">Sample snapshot</span>`)}</div>
<h3>${opp.title}</h3>
<p class="small muted">${opp.address ? `${opp.address} · ` : ''}${meta}</p>
${when(opp.owner_account_id, h`<p class="small muted">${forwardedLine(opp)}</p>`)}
<p><b>Why it fits.</b> ${ev.why}</p>
${checklistList(ev.checklist)}
<p class="small"><a href="${safeHref(opp.url)}" rel="noopener noreferrer" target="_blank">${linkLabel(opp)}</a>${when(detailHref, h` · <a href="${detailHref}">Details and response kit</a>`)}</p>
${actions}
</article>`;
}

export function tradeOptions(selected = '') {
  const groups = Object.values(TRADE_GROUPS);
  return raw(groups.map((g) => `<optgroup label="${esc(g.label)}">${Object.values(TRADES).filter((t) => t.group === g.id).map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</optgroup>`).join(''));
}

export function waitlistForm({ trade = '', zip = '', source = 'site', heading = 'Join the waitlist', note = '' }) {
  return h`<form class="stack card" method="post" action="/waitlist">
<h3>${heading}</h3>
${when(note, h`<p class="small muted">${note}</p>`)}
<input type="hidden" name="source" value="${source}">
<label for="wl-email">Email</label><input id="wl-email" type="email" name="email" required autocomplete="email" inputmode="email">
<label for="wl-trade">Your trade <span class="hint">(optional)</span></label><select id="wl-trade" name="trade"><option value="">Choose a trade</option>${tradeOptions(trade)}</select>
<label for="wl-zip">ZIP code <span class="hint">(optional)</span></label><input id="wl-zip" type="text" name="zip" value="${zip}" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" autocomplete="postal-code">
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="checks"><label><input type="checkbox" name="consent" value="1" required> <span>Email me about ${'BuildSignal'} launch and sample leads. I can unsubscribe any time.</span></label></div>
<p><button class="btn" type="submit">Join the waitlist</button></p>
</form>`;
}

export function planCard(plan, { cta = null, highlight = false } = {}) {
  const f = plan.features || {};
  const rows = [
    `${plan.trade_group_limit} trade group${plan.trade_group_limit === 1 ? '' : 's'}, ${plan.area_limit} service area${plan.area_limit === 1 ? '' : 's'}`,
    'Daily or weekly email digest, at most 5 items',
    'Plain-English "why it fits" and a green/yellow/red can-you-bid checklist',
    'One-tap Interested / Not for me / Already knew (the ranking learns from your taps)',
    ...(f.kit ? ['Response kit: draft intro email and call script, capability statement, draft proposal from your rate card, forms checklist, calendar file'] : []),
    ...(f.pipeline ? ['Pipeline view and monthly summary'] : []),
    ...(f.reminders ? ['Deadline reminders at 7, 3 and 1 days, and change alerts'] : []),
  ];
  return h`<div class="card" ${highlight ? raw('style="border:2px solid #f5a30a"') : ''}>
<h3>${plan.name}</h3>
<div class="price">${dollars(plan.price_cents)}<small> / month</small></div>
<p class="small muted">${plan.trial_days}-day free trial. Pause or cancel in one click.</p>
<ul class="plain small">${each(rows, (r) => h`<li>${r}</li>`)}</ul>
${cta}
</div>`;
}

export function profileFields(p, plan, { forOnboarding = false } = {}) {
  const sel = (arr, v) => (arr || []).includes(v);
  const rate = (p.rate_card || []).map((r) => `${r.label} | ${r.unit} | ${r.rate}`).join('\n');
  return h`
<fieldset><legend>Your business</legend>
<label for="business_name">Business name</label><input id="business_name" name="business_name" type="text" value="${p.business_name || ''}" required maxlength="120" autocomplete="organization">
<label for="contact_name">Your name</label><input id="contact_name" name="contact_name" type="text" value="${p.contact_name || ''}" required maxlength="80" autocomplete="name">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="${p.phone || ''}" maxlength="30" autocomplete="tel">
</fieldset>
<fieldset><legend>Your trades <span class="hint small">(up to ${plan.trade_group_limit} group${plan.trade_group_limit === 1 ? '' : 's'} on ${plan.name})</span></legend>
${each(Object.values(TRADE_GROUPS), (g) => h`<p class="small muted" style="margin:10px 0 0"><b>${g.label}</b></p><div class="checks">${each(Object.values(TRADES).filter((t) => t.group === g.id), (t) => h`<label><input type="checkbox" name="trades" value="${t.id}" ${sel(p.trades, t.id) ? raw('checked') : ''}> <span>${t.label}</span></label>`)}</div>`)}
</fieldset>
<fieldset><legend>Where you work <span class="hint small">(up to ${plan.area_limit} on ${plan.name})</span></legend>
<div class="checks">${each(Object.values(JURISDICTIONS).filter((j) => j.id !== 'statewide'), (j) => {
    const live = COVERED_JURISDICTIONS.includes(j.id);
    return h`<label><input type="checkbox" name="jurisdictions" value="${j.id}" ${sel(p.jurisdictions, j.id) ? raw('checked') : ''} ${live ? '' : raw('disabled')}> <span>${j.label}${live ? '' : ' (coming soon, no data yet)'}</span></label>`;
  })}</div>
<p class="small muted">Federal (SAM.gov) listings are included for everyone when that source is on.</p>
<label for="zips">Service ZIP codes <span class="hint">(optional; leave blank for the whole city. Some records have no ZIP, and those show as "confirm location".)</span></label>
<textarea id="zips" name="zips" rows="2" inputmode="numeric">${(p.zips || []).join(', ')}</textarea>
</fieldset>
<fieldset><legend>Job size</legend>
<label for="min_value">Smallest job you want <span class="hint">(dollars, optional)</span></label><input id="min_value" name="min_value" type="number" min="0" step="1000" inputmode="numeric" value="${p.min_value ?? ''}">
<label for="max_value">Largest job you want <span class="hint">(dollars, optional)</span></label><input id="max_value" name="max_value" type="number" min="0" step="1000" inputmode="numeric" value="${p.max_value ?? ''}">
<p class="small muted">Many records do not state a value. Those are shown with "size unconfirmed" instead of being hidden.</p>
</fieldset>
<fieldset><legend>License and credentials <span class="hint small">(self-reported, shown as unverified)</span></legend>
<label for="license_number">Arizona ROC license number</label><input id="license_number" name="license_number" type="text" value="${p.license_number || ''}" maxlength="20" inputmode="numeric">
<p class="small"><a href="https://roc.az.gov" target="_blank" rel="noopener noreferrer">Use the license lookup on the official ROC site (roc.az.gov)</a> to confirm status and classification. Arizona requires your license number on written bids and estimates (A.R.S. § 32-1124), so every draft shows it.</p>
<label for="license_classes">License classifications <span class="hint">(for example C-21, comma separated)</span></label><input id="license_classes" name="license_classes" type="text" value="${(p.license_classes || []).join(', ')}" maxlength="80">
<p class="small muted" style="margin-bottom:0">Certifications</p><div class="checks">${each(Object.entries(CERTIFICATIONS), ([id, label]) => h`<label><input type="checkbox" name="certifications" value="${id}" ${sel(p.certifications, id) ? raw('checked') : ''}> <span>${label}</span></label>`)}</div>
<label for="bonding_limit">Bonding capacity <span class="hint">(dollars, optional)</span></label><input id="bonding_limit" name="bonding_limit" type="number" min="0" inputmode="numeric" value="${p.bonding_limit ?? ''}">
<label for="insurance_limit">General liability limit <span class="hint">(dollars, optional)</span></label><input id="insurance_limit" name="insurance_limit" type="number" min="0" inputmode="numeric" value="${p.insurance_limit ?? ''}">
</fieldset>
<fieldset><legend>Digest</legend>
<label for="digest_frequency">How often</label><select id="digest_frequency" name="digest_frequency"><option value="daily" ${p.digest_frequency !== 'weekly' ? raw('selected') : ''}>Every day (about 6 a.m. Arizona time)</option><option value="weekly" ${p.digest_frequency === 'weekly' ? raw('selected') : ''}>Mondays only</option></select>
<p class="small muted">Email only for now. If nothing fits, you get a short "no strong matches" note instead of filler.</p>
</fieldset>
<details ${forOnboarding ? '' : raw('open')}><summary>Optional: drafts (you can add these later)</summary>
<label for="capability_blurb">Two sentences about your work <span class="hint">(used in your drafts and capability statement)</span></label><textarea id="capability_blurb" name="capability_blurb" maxlength="600">${p.capability_blurb || ''}</textarea>
<label for="rate_card">Rate card <span class="hint">(one per line: item | unit | rate, e.g. Concrete flatwork | sq ft | 8.50)</span></label><textarea id="rate_card" name="rate_card" rows="4" maxlength="2000">${rate}</textarea>
<p class="small muted">Drafts only use what you type here. Missing items are listed, never invented.</p></details>`;
}

export const toText = toStr;
