import { h, each, when, raw } from './html.js';
import { html, redirect, json, respond, safeNext } from './http.js';
import { verifyToken, safeEqual } from './crypto.js';
import { opportunityCard, planCard, waitlistForm, tradeOptions, dollars, page } from './views.js';
import { kitSections, capabilityPage } from './kitview.js';
import { termsPage, privacyPage, refundPage } from './legal.js';
import { demoDigest, demoKit, SNAPSHOT_DATE } from './sample.js';
import { TRADES, parseZips } from './taxonomy.js';
import { applyDisposition } from './actions.js';
import { ADAPTERS } from './adapters/index.js';

const GIF = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

export function registerPublic(r, { fail }) {
  /* ---------------- landing ---------------- */
  r.get('/', async (ctx) => {
    const { config } = ctx;
    const [plans, sources] = await Promise.all([ctx.getPlans(), ctx.sourceStatus()]);
    ctx.logEvent('visit', {});
    const live = sources.filter((s) => s.enabled);
    const cta = config.signupOpen ? h`<a class="btn" href="#start">Start your ${plans[0]?.trial_days || 14}-day free trial</a>` : h`<a class="btn" href="#start">Join the waitlist</a>`;
    const body = h`
<section class="hero"><div class="wrap">
<h1>Commercial projects and public bids in the Phoenix area, matched to your trade.</h1>
<p class="lead">One short email with at most five items. Each one says why it fits you and gives a green, yellow or red checklist of what you would need to go after it. Mark one "Interested" and get a draft email, call script and capability statement to edit and send yourself.</p>
<p><a class="btn dark" href="/demo">See the live demo</a> &nbsp; ${cta}</p>
<p class="small muted">Built for small and family-run trade businesses that are too busy working to hunt for jobs. Every item links to the official public record.</p>
</div></section>
<section class="wrap"><div class="grid c3">
<div class="card"><h3>1. We watch the public record</h3><p class="small">New commercial permits and published solicitations, from official open-data feeds. We keep the record link and the dates, and we do not host the documents.</p></div>
<div class="card"><h3>2. We match it to you</h3><p class="small">Your trade, service area, job size and credentials decide what you see. Rules come first, so the reasons are plain English, and your one-tap answers adjust the ranking.</p></div>
<div class="card"><h3>3. You decide and respond</h3><p class="small">Review the checklist, tap Interested, edit the drafts and contact them under your own license. We never submit anything for you.</p></div>
</div></section>
<section class="wrap"><h2>What is live today, and what is not</h2>
<div class="grid c2">
<div class="card"><h3>Live feed status</h3>
${live.length ? h`<ul class="plain small">${each(live, (s) => h`<li>${s.label}${s.last_ok_at ? ' (updating daily)' : ' (turned on, first update pending)'}</li>`)}</ul>` : h`<p class="small">The live feed is being switched on. Until then the demo uses a frozen sample of ten real permit records from ${SNAPSHOT_DATE}, each with its official link.</p>`}
<p class="small muted">Planned, not live: more cities and school districts, Spanish, text-message alerts.</p></div>
<div class="card"><h3>What this is not</h3><ul class="plain small"><li>It does not submit bids or send messages for you.</li><li>A permit is not a bid request. The general contractor named on a permit may already have its trades, so we label those "may already be awarded; call to get on their bid list".</li><li>Permit values are not contract prices.</li><li>License details are what you enter, shown as unverified until you confirm them on the official ROC lookup.</li><li>No guarantees of leads or wins.</li></ul></div>
</div></section>
<section class="wrap" id="pricing"><h2>Simple monthly pricing</h2>
<div class="grid c2">${each(plans, (p, i) => planCard(p, { highlight: i === 1, cta: h`<p><a class="btn ${i === 1 ? '' : 'alt'}" href="${config.signupOpen ? `/signup?plan=${p.id}` : '#start'}">${config.signupOpen ? 'Start free trial' : 'Join the waitlist'}</a></p>` }))}</div>
<p class="small muted">Full-featured during the trial. Pause or cancel in one click. Prices are charged monthly; there is no annual contract.</p></section>
<section class="wrap" id="start"><h2>${config.signupOpen ? 'Start your free trial' : 'Get launch updates and sample leads'}</h2>
${config.signupOpen ? signupForm(plans) : waitlistForm({ source: 'landing', note: 'Paid sign-ups are not open yet. Leave your email and trade and we will tell you when they are. No spam, one-tap unsubscribe.' })}</section>
<section class="wrap"><h2>Questions</h2>
${each(faq(), ([q, a]) => h`<details><summary>${q}</summary><p>${a}</p></details>`)}
</section>`;
    return ctx.render('Commercial leads and bids for Arizona trade businesses', body, { current: 'home', canonical: '/', desc: 'A short daily email of Phoenix-area commercial projects and public bids, matched to your trade, with a plain-English can-you-bid checklist and editable drafts.' });
  });

  /* ---------------- demo ---------------- */
  r.get('/demo', async (ctx) => {
    const tradeId = TRADES[ctx.url.searchParams.get('trade')] ? ctx.url.searchParams.get('trade') : 'concrete';
    const d = demoDigest(tradeId);
    ctx.logEvent('demo_view', { trade: tradeId });
    const body = h`<div class="wrap" style="padding-top:20px">
<h1>Live demo: your digest, with sample data</h1>
<div class="notice warn"><b>Sample data.</b> These are 10 real permit records from a research snapshot on ${SNAPSHOT_DATE} (Mesa and Scottsdale), each linked to its official record. It is frozen, not a live feed. Buttons marked "simulated" do nothing here.</div>
<form method="get" action="/demo" class="stack" style="margin:14px 0"><label for="trade">Pick your trade</label>
<select id="trade" name="trade">${tradeOptions(tradeId)}</select>
<p><button class="btn dark" type="submit">Show my sample digest</button></p></form>
<h2>${d.items.length ? `${d.items.length} ${d.items.length === 1 ? 'match' : 'matches'} for ${TRADES[tradeId].label}` : 'No strong matches'}</h2>
<p class="small muted">${d.considered} sample records checked, ${d.excluded} ruled out by the rules (wrong trade signal, too old, or outside the area). We show at most five.</p>
${d.items.length ? each(d.items, (it, i) => opportunityCard({
    ...it, index: i, detailHref: `/demo/kit/${it.opp.id}?trade=${tradeId}`,
    actions: h`<div class="actions"><a class="btn" href="/demo/kit/${it.opp.id}?trade=${tradeId}">Interested</a><button class="btn alt" disabled>Not for me (simulated)</button><button class="btn alt" disabled>Already knew (simulated)</button></div><p class="small muted">Tapping Interested opens the response kit. In your real digest these three buttons also teach the ranking.</p>`,
  })) : h`<div class="card"><p>Nothing in the sample fits this trade. That is what a real "no strong matches" email says: we do not pad the list.</p></div>`}
<div class="card" style="margin-top:20px"><h3>Want this for your trade and ZIP codes?</h3><p><a class="btn" href="/#start">${ctx.config.signupOpen ? 'Start your free trial' : 'Join the waitlist'}</a></p></div>
</div>`;
    return ctx.render('Live demo', body, { current: 'demo', desc: 'Pick a trade and see a sample digest built from real Arizona permit records, with eligibility checklists and a response kit.', canonical: '/demo' });
  });

  r.get('/demo/kit/:id', async (ctx) => {
    const tradeId = TRADES[ctx.url.searchParams.get('trade')] ? ctx.url.searchParams.get('trade') : 'concrete';
    const kit = demoKit(tradeId, ctx.params.id);
    if (!kit) throw fail(404, 'That sample record does not exist.');
    const capHref = `/demo/capability?trade=${tradeId}`;
    const body = h`<div class="wrap narrow" style="padding-top:20px">
<p class="small"><a href="/demo?trade=${tradeId}">&larr; Back to the sample digest</a></p>
<h1>Response kit</h1><p class="muted">${kit.opp.title}, ${kit.opp.address}</p>
${opportunityCard({ opp: kit.opp, eval: kit.eval })}
<h2>Your drafts</h2>${kitSections({ kit, demo: true, capHref })}
<div class="card" style="margin-top:20px"><p><a class="btn" href="/#start">${ctx.config.signupOpen ? 'Start your free trial' : 'Join the waitlist'}</a></p></div></div>`;
    return ctx.render('Sample response kit', body, { noindex: true });
  });

  r.get('/demo/capability', async (ctx) => {
    const tradeId = TRADES[ctx.url.searchParams.get('trade')] ? ctx.url.searchParams.get('trade') : 'concrete';
    const kit = demoKit(tradeId, 'sample-1');
    return ctx.render('Sample capability statement', capabilityPage(kit.cap, { demo: true }), { noindex: true });
  });

  /* ---------------- pricing & legal ---------------- */
  r.get('/pricing', async (ctx) => {
    const plans = await ctx.getPlans();
    const body = h`<div class="wrap" style="padding-top:20px"><h1>Pricing</h1>
<p>Monthly plans. The trial is full-featured. Pause or cancel in one click from Settings; there is no annual contract.</p>
<div class="grid c2">${each(plans, (p, i) => planCard(p, { highlight: i === 1, cta: h`<p><a class="btn ${i === 1 ? '' : 'alt'}" href="${ctx.config.signupOpen ? `/signup?plan=${p.id}` : '/#start'}">${ctx.config.signupOpen ? 'Start free trial' : 'Join the waitlist'}</a></p>` }))}</div>
<p class="small muted">Free portal alerts exist (for example the state procurement portal and county bid sites). ${ctx.config.brand} is one feed across sources, filtered to your trade, with a can-you-bid checklist and drafts. If a free alert already does the job for you, you do not need this.</p></div>`;
    return ctx.render('Pricing', body, { current: 'pricing', canonical: '/pricing' });
  });
  r.get('/terms', (ctx) => ctx.render('Terms of Service', termsPage(ctx.config), { canonical: '/terms' }));
  r.get('/privacy', (ctx) => ctx.render('Privacy Policy', privacyPage(ctx.config), { canonical: '/privacy' }));
  r.get('/refunds', (ctx) => ctx.render('Refund Policy', refundPage(ctx.config), { canonical: '/refunds' }));

  /* ---------------- waitlist ---------------- */
  r.post('/waitlist', async (ctx) => {
    const f = await ctx.form();
    if (f.website) return redirect('/thanks'); // honeypot
    if (!(await ctx.limit(`wl:${ctx.ip}`, 6, 3600))) throw fail(429, 'Too many sign-ups from this connection. Please try again later.');
    const email = String(f.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw fail(400, 'Please enter a valid email address.');
    if (!f.consent) throw fail(400, 'Please tick the box so we know you want to hear from us.');
    const trade = TRADES[f.trade] ? f.trade : null;
    const zip = parseZips(f.zip)[0] || null;
    const s = ctx.store || ctx.publicStore;
    if (!s) throw fail(503, 'The waitlist is not connected yet. Please check back soon.');
    const res = await s.rpc('join_waitlist', { p_email: email, p_trade: trade, p_zip: zip, p_consent: true, p_source: String(f.source || 'site').slice(0, 40) });
    if (res !== 'ok') throw fail(400, 'We could not add that email. Please check it and try again.');
    ctx.logEvent('waitlist', { trade });
    return redirect('/thanks');
  });
  r.get('/thanks', (ctx) => ctx.render('Thanks', h`<div class="wrap narrow" style="padding:30px 16px"><h1>You are on the list.</h1><p>We will email you when sign-ups open. Meanwhile, try the <a href="/demo">live demo</a>.</p></div>`, { noindex: true }));

  /* ---------------- signup & login ---------------- */
  r.get('/signup', async (ctx) => {
    if (!ctx.config.signupOpen) return redirect('/#start');
    const plans = await ctx.getPlans();
    return ctx.render('Start your free trial', h`<div class="wrap narrow" style="padding-top:20px"><h1>Start your free trial</h1>${signupForm(plans, ctx.url.searchParams.get('plan'), ctx.url.searchParams.get('ref'))}</div>`, { noindex: true });
  });

  r.post('/signup', async (ctx) => {
    if (!ctx.config.signupOpen) return redirect('/#start');
    const f = await ctx.form();
    if (f.website) return redirect('/login/sent');
    if (!(await ctx.limit(`signup:${ctx.ip}`, 8, 3600))) throw fail(429, 'Too many attempts from this connection. Please try again later.');
    const email = String(f.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw fail(400, 'Please enter a valid email address.');
    if (!f.consent) throw fail(400, 'Please accept the Terms and Privacy Policy to continue.');
    const plans = await ctx.getPlans();
    const plan = plans.find((p) => p.id === f.plan) || plans[0];
    const acct = await ctx.auth.accountForLogin(email, { allowCreate: true, plan: plan.id, consent: true, referredBy: f.ref ? String(f.ref).slice(0, 20) : null });
    if (acct) {
      if (acct.billing_status === 'none' && acct.plan_id !== plan.id) await ctx.store.update('accounts', { id: acct.id }, { plan_id: plan.id });
      await sendLoginLink(ctx, acct, '/app/onboarding');
      ctx.logEvent('signup', { plan: plan.id });
    }
    return redirect('/login/sent');
  });

  r.get('/login', async (ctx) => {
    const s = await ctx.session();
    if (s) return redirect('/app');
    const next = safeNext(ctx.url.searchParams.get('next'));
    return ctx.render('Sign in', h`<div class="wrap narrow" style="padding-top:20px"><h1>Sign in</h1><p>No password. We email you a one-time link.</p>
<form class="stack card" method="post" action="/login"><input type="hidden" name="next" value="${next}">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" inputmode="email">
<p><button class="btn" type="submit">Email me a sign-in link</button></p></form></div>`, { noindex: true, current: 'login' });
  });

  r.post('/login', async (ctx) => {
    ctx.needStore();
    const f = await ctx.form();
    const email = String(f.email || '').trim().toLowerCase();
    if (!(await ctx.limit(`login:${ctx.ip}`, 10, 3600)) || !(await ctx.limit(`loginmail:${email}`, 4, 900))) throw fail(429, 'Too many sign-in requests. Please wait a few minutes.');
    const acct = EMAIL_RE.test(email) ? await ctx.auth.accountForLogin(email, { allowCreate: false }) : null;
    let devLink = null;
    if (acct) devLink = await sendLoginLink(ctx, acct, safeNext(f.next));
    return ctx.render('Check your email', h`<div class="wrap narrow" style="padding:30px 16px"><h1>Check your email</h1><p>If that address has an account, a sign-in link is on its way. It works once and expires in 20 minutes.</p>${when(devLink, h`<div class="notice warn">Development mode: <a href="${devLink}">sign-in link</a></div>`)}</div>`, { noindex: true });
  });
  r.get('/login/sent', (ctx) => ctx.render('Check your email', h`<div class="wrap narrow" style="padding:30px 16px"><h1>Check your email</h1><p>If that address has an account, a sign-in link is on its way. It works once and expires in 20 minutes.</p></div>`, { noindex: true }));

  r.get('/auth/verify', async (ctx) => {
    const t = ctx.url.searchParams.get('t') || '';
    const next = safeNext(ctx.url.searchParams.get('next'));
    return ctx.render('Confirm sign in', h`<div class="wrap narrow" style="padding:30px 16px"><h1>Confirm sign in</h1><p>Tap the button to finish signing in on this device.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${t}"><input type="hidden" name="next" value="${next}"><button class="btn" type="submit">Sign in</button></form></div>`, { noindex: true });
  });
  r.post('/auth/verify', async (ctx) => {
    ctx.needStore();
    const f = await ctx.form();
    if (!(await ctx.limit(`verify:${ctx.ip}`, 20, 900))) throw fail(429, 'Too many attempts.');
    const acct = await ctx.auth.consumeLoginToken(String(f.t || ''), ctx.now());
    if (!acct) throw fail(400, 'That sign-in link has expired or was already used. Request a new one from the sign-in page.');
    const next = acct.role === 'admin' && !String(f.next || '').startsWith('/app') ? '/admin' : safeNext(f.next);
    return redirect(next, { cookies: [ctx.auth.sessionCookie(acct)] });
  });
  r.post('/logout', async (ctx) => redirect('/', { cookies: ctx.auth ? ctx.auth.clearSession() : [] }));

  /* ---------------- one-tap links from email ---------------- */
  const doneCopy = { interested: ['Saved: Interested', 'We marked this Interested and will remind you before the deadline. Your response kit is ready.'], not_for_me: ['Saved: Not for me', 'Got it. We will show fewer projects like this.'], already_knew: ['Saved: Already knew', 'Thanks. We will keep that in mind so you see more that is new to you.'] };
  async function applyTap(ctx, payload) {
    const out = await applyDisposition(ctx.store, { accountId: payload.a, matchId: payload.m, disposition: payload.act, now: ctx.now() });
    if (!out) throw fail(404, 'We could not find that item. It may have been removed.');
    const [title, msg] = doneCopy[payload.act];
    return ctx.render(title, h`<div class="wrap narrow" style="padding:30px 16px"><h1>${title}</h1><p>${msg}</p><p class="small muted">${out.opp.title}</p>
<p><a class="btn" href="/app/m/${out.match.id}">Open details${payload.act === 'interested' ? ' and response kit' : ''}</a> <a class="btn alt" href="/app">Dashboard</a></p><p class="small muted">Opening your account asks you to sign in if you are not already.</p></div>`, { noindex: true });
  }
  r.get('/t/:token', async (ctx) => {
    ctx.needStore();
    const p = verifyToken(ctx.params.token, ctx.config.tokenSecret);
    if (!p || !['tap', 'view'].includes(p.typ)) throw fail(400, 'This link has expired. Sign in to see your items.');
    if (p.typ === 'view') return redirect(`/app/m/${p.m}`);
    if (ctx.req.headers.get('sec-fetch-user') === '?1') return applyTap(ctx, p);
    const [title] = doneCopy[p.act] || ['Confirm'];
    return ctx.render('Confirm', h`<div class="wrap narrow" style="padding:30px 16px"><h1>${title.replace('Saved: ', 'Mark as: ')}?</h1><p>One tap to confirm.</p><form method="post" action="/t/${ctx.params.token}"><button class="btn" type="submit">Confirm</button></form></div>`, { noindex: true });
  });
  r.post('/t/:token', async (ctx) => {
    ctx.needStore();
    const p = verifyToken(ctx.params.token, ctx.config.tokenSecret);
    if (!p || p.typ !== 'tap') throw fail(400, 'This link has expired. Sign in to see your items.');
    return applyTap(ctx, p);
  });

  r.get('/o/:file', async (ctx) => {
    const token = ctx.params.file.replace(/\.gif$/, '');
    const p = verifyToken(token, ctx.config.tokenSecret);
    if (p?.typ === 'open' && ctx.store) {
      try {
        const now = ctx.now().toISOString();
        const [d] = await ctx.store.update('digests', { id: p.d, opened_at: { isnull: true } }, { opened_at: now });
        if (d) await ctx.store.update('accounts', { id: d.account_id }, { last_open_at: now });
      } catch { /* tracking must never fail the image */ }
    }
    return respond(GIF, { type: 'image/gif', cache: 'private, no-store' });
  });

  /* ---------------- unsubscribe ---------------- */
  r.get('/unsubscribe', async (ctx) => {
    const t = ctx.url.searchParams.get('t') || '';
    if (!verifyToken(t, ctx.config.tokenSecret)) throw fail(400, 'This unsubscribe link has expired. Sign in and use Settings to stop emails.');
    return ctx.render('Unsubscribe', h`<div class="wrap narrow" style="padding:30px 16px"><h1>Unsubscribe</h1><p>Stop digests, reminders and other ${ctx.config.brand} emails to this address?</p><form method="post" action="/unsubscribe?t=${t}"><button class="btn" type="submit">Yes, unsubscribe me</button></form></div>`, { noindex: true });
  }, { });
  r.post('/unsubscribe', async (ctx) => {
    ctx.needStore();
    const t = ctx.url.searchParams.get('t') || '';
    const p = verifyToken(t, ctx.config.tokenSecret);
    if (!p || p.typ !== 'unsub') throw fail(400, 'This unsubscribe link has expired. Sign in and use Settings to stop emails.');
    await ctx.store.update('accounts', { id: p.a }, { unsubscribed_at: ctx.now().toISOString() });
    await ctx.store.insert('events', { name: 'unsubscribe', account_id: p.a, props: {} });
    return ctx.render('Unsubscribed', h`<div class="wrap narrow" style="padding:30px 16px"><h1>You are unsubscribed.</h1><p>You will not get digests or reminders. Your subscription, if any, is unchanged: cancel or pause it in Settings so you are not billed for emails you do not receive.</p></div>`, { noindex: true });
  }, { noCsrf: true });

  /* ---------------- diagnostics for the owner (disabled unless DIAG_TOKEN is set) ---------------- */
  r.get('/diag/sources', async (ctx) => {
    const tok = ctx.url.searchParams.get('token') || '';
    if (!ctx.config.diagToken || !safeEqual(tok, ctx.config.diagToken)) throw fail(404, 'Not found');
    const out = {};
    for (const [id, ad] of Object.entries(ADAPTERS)) {
      if (ad.needsKey && !ctx.config.samKey) { out[id] = { skipped: 'no api key' }; continue; }
      try {
        const rows = await ad.fetchRaw(ctx.fetchImpl, ctx.now(), { key: ctx.config.samKey });
        const norm = rows.map((x) => ad.normalize(x)).filter(Boolean);
        out[id] = { raw: rows.length, normalized: norm.length, sample: norm.slice(0, 2).map((n) => ({ source_id: n.source_id, title: n.title, jurisdiction: n.jurisdiction, stage: n.stage, value: n.value, issued_date: n.issued_date, url: n.url })) };
      } catch (e) { out[id] = { error: String(e.message || e).slice(0, 300) }; }
    }
    return json(out, { cache: 'no-store' });
  });
}

export function signupForm(plans, selected = null, ref = null) {
  return h`<form class="stack card" method="post" action="/signup" id="signup">
<label for="su-email">Work email</label><input id="su-email" name="email" type="email" required autocomplete="email" inputmode="email">
<label for="su-plan">Plan</label><select id="su-plan" name="plan">${each(plans, (p) => h`<option value="${p.id}" ${p.id === selected ? raw('selected') : ''}>${p.name}: ${dollars(p.price_cents)}/month after a ${p.trial_days}-day free trial</option>`)}</select>
<input type="hidden" name="ref" value="${ref || ''}">
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="checks"><label><input type="checkbox" name="consent" value="1" required> <span>I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span></label></div>
<p class="small muted">We email you a sign-in link, you fill in your profile (about 3 minutes), then add a card to start the trial. You are charged only when the trial ends, and you can cancel or pause in one click.</p>
<p><button class="btn" type="submit">Email me a sign-in link</button></p></form>`;
}

async function sendLoginLink(ctx, acct, next) {
  const link = await ctx.auth.createLoginLink(acct.id, next, ctx.now());
  await ctx.mailer.send({
    accountId: acct.id, to: acct.email, subject: `Your ${ctx.config.brand} sign-in link`,
    html: `<div style="font:16px/1.5 Arial,sans-serif;max-width:480px"><p>Tap to sign in. The link works once and expires in 20 minutes.</p><p><a href="${link}" style="display:inline-block;padding:13px 18px;background:#f5a30a;color:#1f2124;border-radius:10px;font-weight:700;text-decoration:none">Sign in to ${ctx.config.brand}</a></p><p style="font-size:13px;color:#666">If you did not ask for this, ignore this email.</p></div>`,
    text: `Sign in to ${ctx.config.brand}: ${link}\nThe link works once and expires in 20 minutes. If you did not ask for this, ignore this email.`,
    kind: 'login', key: `login:${acct.id}:${Date.now()}`,
  });
  return ctx.config.allowDevLoginLinks ? link : null;
}
export { sendLoginLink };

function faq() {
  return [
    ['Where does the data come from?', 'Official public sources: city open-data permit feeds (Mesa and Phoenix first) and SAM.gov for federal solicitations, each only after we have reviewed its terms. Every item links to the official record. We do not scrape sites that forbid it, and we do not log in to private bid platforms.'],
    ['Will this get me jobs?', 'No one can promise that, and we do not. It saves you the hunting and tells you quickly whether an item is worth a call. Many permits are already staffed by a general contractor; the point is to get on their bid list early.'],
    ['Do you submit bids for me?', 'Never. Under Arizona law, submitting a bid is acting as a contractor, so you review everything and send it yourself under your own license.'],
    ['Is my license checked?', 'Your license number and classifications are shown as unverified until you confirm them on the official Arizona Registrar of Contractors lookup. We do not scrape that site.'],
    ['How do I cancel?', 'One click in Settings opens the billing portal. You can also pause. No calls, no forms.'],
    ['What do you do with my rate card and profile?', 'They stay private, are used only to build your drafts and ranking, and you can export or delete them any time. We do not use customer data to train AI models.'],
  ];
}
