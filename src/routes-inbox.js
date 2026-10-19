import { h, each, when } from './html.js';
import { redirect } from './http.js';
import { activeAddress, issueAddress, inboxSettings } from './inbox.js';
import { fmtAz } from './time.js';
import { audit } from './jobs.js';

const STATUS_WORDS = {
  received: 'Received, being read', fetched: 'Received, being read', parsed: 'Added to your digest list', held: 'Needs a look: we could not read it',
  dropped: 'Ignored (not a bid alert)', failed: 'Could not be read', expired: 'Content deleted after 30 days',
};

/** Customer-facing page for the forwarded-alert inbox. Honest by construction: it says nothing the code does not do. */
export function registerInbox(r, { fail }) {
  async function available(ctx) {
    const s = await inboxSettings(ctx.store);
    return ctx.config.has.inbox && s.enabled;
  }

  r.get('/app/inbox', async (ctx) => {
    const s = await ctx.requireUser();
    if (!(await available(ctx))) {
      return ctx.render('Forwarded alerts', h`<div class="wrap narrow" style="padding-top:20px"><p class="small"><a href="/app">&larr; Dashboard</a></p><h1>Forwarded alerts</h1><div class="card"><p>Forwarding your own bid-alert emails to ${ctx.config.brand} is not available yet. Nothing is being collected.</p></div></div>`, { noindex: true, current: 'app' });
    }
    const account = s.account;
    let addr = await activeAddress(ctx.store, ctx.config, account.id);
    if (!addr) addr = await issueAddress(ctx.store, ctx.config, account.id, ctx.now());
    const msgs = await ctx.store.select('inbound_messages', { where: { account_id: account.id }, order: 'received_at.desc', limit: 20 });
    const code = msgs.find((m) => m.kind === 'forward_confirmation' && m.confirmation_code && m.status !== 'expired');
    const cfg = await inboxSettings(ctx.store);
    const llm = await ctx.store.select('settings', { where: { key: 'llm.enabled' } });
    const aiOn = ctx.config.has.llm && llm[0]?.value === true;
    const body = h`<div class="wrap narrow" style="padding-top:20px"><p class="small"><a href="/app">&larr; Dashboard</a></p><h1>Forwarded alerts</h1>
<p>Already get bid alerts from other sites? Forward them here. ${ctx.config.brand} reads them, drops duplicates, checks them against your profile and puts the good ones in your digest next to everything else. Your forwarded emails are never shown to other customers.</p>
<div class="card"><h3>Your private address</h3>
<p><code style="word-break:break-all;user-select:all">${addr.address}</code></p>
<p class="small muted">Anyone who knows this address can send mail to your inbox here, so keep it private. At most ${cfg.dailyLimit} emails a day are accepted. If it leaks, get a new one below and the old one stops working.</p>
<p><a class="btn alt" href="mailto:${addr.address}?subject=Test%20forward&amp;body=Forward%20an%20alert%20email%20to%20this%20address.">Send a test message</a></p></div>
<div class="card" style="margin-top:12px"><h3>How to use it</h3>
<ol><li>Open a bid-alert email in your mail app.</li><li>Choose Forward and send it to the address above.</li><li>It shows up below within a minute or two and, if it fits, in your next digest.</li></ol>
<p class="small muted">Forwarding one email at a time works today. Step-by-step guides for automatic forwarding in Gmail and Outlook are not included yet; they will be added once checked in the real apps.</p></div>
${when(code, h`<div class="card" style="margin-top:12px"><h3>Gmail confirmation code</h3><p>Gmail asked you to confirm this address. Your code is <b style="font-size:1.3em;user-select:all">${code?.confirmation_code}</b>. Enter it in Gmail's forwarding settings. It disappears after 30 days.</p></div>`)}
<div class="card" style="margin-top:12px"><h3>What we do with each email</h3><ul class="plain small">
<li>We read the subject and text, and keep them for 30 days, then delete the content.</li>
<li>We never open links in your emails and never download attachments.</li>
<li>${aiOn ? 'If our rules cannot read an email, its text may be sent to an AI service to pull out the title, dates and link. Your data is not used to train models.' : 'Emails are read by fixed rules only. No AI service sees them.'}</li>
<li>Emails we cannot read are reviewed by ${ctx.config.brand} staff so we can add them for you. Dates and links are shown exactly as the email wrote them. Please confirm them on the listing.</li></ul></div>
<h2>Recent emails</h2>
${msgs.length ? each(msgs, (m) => h`<div class="card" style="margin-bottom:8px"><div class="small muted">${fmtAz(m.received_at, { dateStyle: 'medium', timeStyle: 'short' })} · from ${m.from_domain || 'unknown sender'} · ${m.kind === 'forward_confirmation' ? 'Gmail confirmation' : STATUS_WORDS[m.status] || m.status}${m.status === 'parsed' && m.opportunity_ids?.length ? ` (${m.opportunity_ids.length} item${m.opportunity_ids.length === 1 ? '' : 's'})` : ''}</div><div>${m.subject || '(no subject)'}</div></div>`) : h`<div class="card"><p>Nothing received yet.</p></div>`}
<form method="post" action="/app/inbox/new-address" class="stack card" style="margin-top:16px"><h3>Get a new address</h3><p class="small muted">The old address stops working right away. Update any forwarding rules you set up.</p><p><button class="btn alt" type="submit">Replace my address</button></p></form>
</div>`;
    return ctx.render('Forwarded alerts', body, { noindex: true, current: 'app' });
  });

  r.post('/app/inbox/new-address', async (ctx) => {
    const s = await ctx.requireUser();
    if (!(await available(ctx))) throw fail(404, 'Not available.');
    await issueAddress(ctx.store, ctx.config, s.account.id, ctx.now());
    await audit(ctx.store, 'customer', 'inbox.address_replaced', s.account.id, {});
    return redirect('/app/inbox');
  });
}
