import { signToken } from './crypto.js';
import { esc, safeHref, forwardedLine, linkLabel } from './html.js';
import { money, daysSince } from './scoring.js';
import { TRADES } from './taxonomy.js';

const TAP_TTL = 60 * 86400 * 6;

export const tapLink = (config, accountId, matchId, act) => `${config.baseUrl}/t/${signToken({ typ: 'tap', a: accountId, m: matchId, act }, config.tokenSecret, TAP_TTL)}`;
export const openPixel = (config, digestId) => `${config.baseUrl}/o/${signToken({ typ: 'open', d: digestId }, config.tokenSecret, TAP_TTL)}.gif`;
export const itemLink = (config, accountId, matchId) => `${config.baseUrl}/t/${signToken({ typ: 'view', a: accountId, m: matchId }, config.tokenSecret, TAP_TTL)}`;

const DOT = { green: '#1f8a4c', yellow: '#b7791f', red: '#c0392b' };

function itemHtml(config, accountId, it, i) {
  const { opp, eval: ev, matchId } = it;
  const bits = [opp.agency, opp.kind === 'public_bid' ? (opp.deadline ? `Due ${new Date(opp.deadline).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric' })}` : 'No deadline found') : opp.stage === 'issued' ? `Issued ${opp.issued_date || ''}` : 'In plan review', opp.value ? `Value ${money(opp.value)}` : null].filter(Boolean).join(' · ');
  const btn = (act, label, bg, fg) => `<a href="${esc(tapLink(config, accountId, matchId, act))}" style="display:inline-block;padding:13px 16px;margin:4px 4px 0 0;border-radius:8px;background:${bg};color:${fg};font:700 15px Arial,sans-serif;text-decoration:none">${label}</a>`;
  const checks = ev.checklist.slice(0, 5).map((c) => `<tr><td style="vertical-align:top;padding:3px 8px 3px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${DOT[c.status]}"></span></td><td style="font:13px/1.4 Arial,sans-serif;color:#333;padding:3px 0"><b>${esc(c.label)}.</b> ${esc(c.reason)}</td></tr>`).join('');
  return `<div style="border:1px solid #e3e3e0;border-radius:12px;padding:16px;margin:0 0 16px;background:#fff">
<div style="font:700 12px Arial,sans-serif;color:#8a6d00;letter-spacing:.04em">#${i + 1} · FIT SCORE ${ev.score}/100</div>
<div style="font:700 18px/1.3 Arial,sans-serif;color:#1f2124;margin:4px 0">${esc(opp.title)}</div>
<div style="font:13px Arial,sans-serif;color:#555;margin-bottom:8px">${esc(bits)}</div>${opp.owner_account_id ? `<div style="font:12px/1.4 Arial,sans-serif;color:#666;margin-bottom:8px">${esc(forwardedLine(opp))}</div>` : ''}
<div style="font:14px/1.45 Arial,sans-serif;color:#222;margin-bottom:8px"><b>Why it fits you.</b> ${esc(ev.why)}</div>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom:8px">${checks}</table>
<a href="${esc(safeHref(opp.url))}" style="font:13px Arial,sans-serif;color:#0b5cad">${esc(linkLabel(opp))}</a> &nbsp;·&nbsp; <a href="${esc(itemLink(config, accountId, matchId))}" style="font:13px Arial,sans-serif;color:#0b5cad">Details and response kit</a>
<div style="margin-top:10px">${btn('interested', 'Interested', '#f5a30a', '#1f2124')}${btn('not_for_me', 'Not for me', '#eceae4', '#1f2124')}${btn('already_knew', 'Already knew', '#eceae4', '#1f2124')}</div>
</div>`;
}

export function renderDigest(config, { account, profile, items, kind, digestId, weeklyEmptyNote = false, unreadForwards = 0 }) {
  const unreadHtml = unreadForwards > 0 ? `<p style="font:13px/1.5 Arial,sans-serif;color:#555">${unreadForwards} email${unreadForwards === 1 ? '' : 's'} you forwarded could not be read automatically. <a href="${esc(config.baseUrl)}/app/inbox">See what was received</a>.</p>` : '';
  const unreadText = unreadForwards > 0 ? `\n${unreadForwards} email${unreadForwards === 1 ? '' : 's'} you forwarded could not be read automatically: ${config.baseUrl}/app/inbox\n` : '';
  const first = profile.contact_name ? ` ${profile.contact_name.split(' ')[0]}` : '';
  const when = new Date().toLocaleDateString('en-US', { timeZone: 'America/Phoenix', weekday: 'long', month: 'long', day: 'numeric' });
  if (!items.length) {
    const subject = `${config.brand}: no strong matches ${weeklyEmptyNote ? 'this week' : 'today'}`;
    const html = `<div style="max-width:560px;margin:0 auto;padding:16px;font:15px/1.5 Arial,sans-serif;color:#222"><p>Hi${esc(first)},</p><p>No strong matches for your trades and service area ${weeklyEmptyNote ? 'this week' : 'today'}. We do not pad the list. Anything that fits will arrive as soon as it is in the public record.</p><p><a href="${esc(config.baseUrl)}/app/settings">Adjust your trades, area or job size</a></p>${unreadHtml}<img src="${esc(openPixel(config, digestId))}" width="1" height="1" alt="" style="display:block"></div>`;
    return { subject, html, text: `Hi${first},\n\nNo strong matches for your trades and service area ${weeklyEmptyNote ? 'this week' : 'today'}. We do not pad the list.\n\nAdjust your settings: ${config.baseUrl}/app/settings\n${unreadText}` };
  }
  const subject = `${items.length} ${items.length === 1 ? 'match' : 'matches'} for you: ${items[0].opp.title.slice(0, 60)}`;
  const html = `<div style="max-width:600px;margin:0 auto;padding:16px;background:#f6f5f1"><div style="font:700 20px Arial,sans-serif;color:#1f2124;margin-bottom:2px">${esc(config.brand)}</div><div style="font:13px Arial,sans-serif;color:#666;margin-bottom:14px">${esc(when)} · ${items.length} ${items.length === 1 ? 'item' : 'items'}, ranked for ${esc(profile.business_name || 'your business')}</div>${items.map((it, i) => itemHtml(config, account.id, it, i)).join('')}<div style="font:12px/1.5 Arial,sans-serif;color:#666">Public records show what has been filed, not who will be hired. Permit values are not contract prices. Check each official record before you act. This is information, not a guarantee of work.</div>${unreadHtml}<img src="${esc(openPixel(config, digestId))}" width="1" height="1" alt="" style="display:block"></div>`;
  const text = [`${config.brand} · ${when}`, `${items.length} ranked for ${profile.business_name || 'you'}`, '']
    .concat(items.flatMap((it, i) => [`#${i + 1} (${it.eval.score}/100) ${it.opp.title}`, `Why: ${it.eval.why}`, `${it.opp.owner_account_id ? 'Link from your forwarded email' : 'Official record'}: ${safeHref(it.opp.url) === '#' ? 'n/a' : it.opp.url}`, `Interested: ${tapLink(config, account.id, it.matchId, 'interested')}`, `Not for me: ${tapLink(config, account.id, it.matchId, 'not_for_me')}`, `Already knew: ${tapLink(config, account.id, it.matchId, 'already_knew')}`, '']))
    .concat(['Public records show what has been filed, not who will be hired. Permit values are not contract prices.', unreadText]).join('\n');
  return { subject, html, text };
}

export function reminderEmail(config, { account, profile, match, opp, daysLeft }) {
  const subject = `Deadline in ${daysLeft} day${daysLeft === 1 ? '' : 's'}: ${opp.title.slice(0, 70)}`;
  const link = itemLink(config, account.id, match.id);
  const html = `<div style="max-width:560px;margin:0 auto;padding:16px;font:15px/1.5 Arial,sans-serif;color:#222"><p><b>${esc(opp.title)}</b> is due ${esc(new Date(opp.deadline).toLocaleString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' }))} Arizona time (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).</p><p>You marked it Interested. Check the official page for addenda before you submit. You submit under your own license; ${esc(config.brand)} never submits anything for you.</p><p><a href="${esc(link)}" style="display:inline-block;padding:12px 16px;background:#f5a30a;color:#1f2124;border-radius:8px;font-weight:700;text-decoration:none">Open response kit</a></p></div>`;
  return { subject, html, text: `${opp.title} is due in ${daysLeft} day(s).\nOfficial record: ${opp.url}\nResponse kit: ${link}\nYou submit under your own license; we never submit for you.\n` };
}

export function changeAlertEmail(config, { account, match, opp }) {
  const subject = `Updated: ${opp.title.slice(0, 80)}`;
  const link = itemLink(config, account.id, match.id);
  const html = `<div style="max-width:560px;margin:0 auto;padding:16px;font:15px/1.5 Arial,sans-serif;color:#222"><p>A project you marked Interested changed in the public record (version ${opp.version}).</p><p><b>${esc(opp.title)}</b>${opp.deadline ? `<br>Deadline now: ${esc(new Date(opp.deadline).toLocaleString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' }))} Arizona time` : ''}</p><p><a href="${esc(opp.url || link)}">Read the official update</a> · <a href="${esc(link)}">Open in ${esc(config.brand)}</a></p><p style="font-size:13px;color:#666">We detect changes once a day. Always confirm on the official page.</p></div>`;
  return { subject, html, text: `A project you marked Interested changed (version ${opp.version}).\n${opp.title}\nOfficial: ${opp.url}\nDetails: ${link}\n` };
}

export const tradeNames = (ids) => (ids || []).map((t) => TRADES[t]?.label).filter(Boolean).join(', ');
export { daysSince };
