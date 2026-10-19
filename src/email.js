import { signToken } from './crypto.js';
import { esc } from './html.js';

export const MARKETING_KINDS = new Set(['digest', 'reminder', 'change_alert', 'winback', 'trial_ending', 'monthly_summary', 'welcome']);

export function unsubscribeUrl(config, accountId) {
  const t = signToken({ typ: 'unsub', a: accountId }, config.tokenSecret, 60 * 86400 * 6);
  return `${config.baseUrl}/unsubscribe?t=${t}`;
}

function footer(config, accountId) {
  const url = unsubscribeUrl(config, accountId);
  const html = `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #ddd;font:12px/1.5 Arial,sans-serif;color:#666">${esc(config.brand)} sends this because you have an account. <a href="${esc(url)}" style="color:#666">Unsubscribe</a> (instant, one tap).<br>${esc(config.mailingAddress)}</div>`;
  const text = `\n\n--\n${config.brand} sends this because you have an account.\nUnsubscribe (instant): ${url}\n${config.mailingAddress}\n`;
  return { html, text, url };
}

/**
 * Sends (or records) one email. Idempotent per `key`. Honors suppressions and unsubscribes.
 * Without a Resend key the message is stored as 'simulated' so nothing is ever claimed as sent.
 */
export function createMailer({ config, store, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = 120 }) {
  // Resend's documented default is 10 requests/second per team; pace sends to stay comfortably under it.
  let nextSlot = 0;
  async function pace() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + paceMs;
    if (wait > 0) await sleep(wait);
  }
  async function deliver(row, headers) {
    if (!config.has.email) {
      await store.update('outbox', { id: row.id }, { status: 'simulated', error: 'RESEND_API_KEY not configured' });
      return { status: 'simulated' };
    }
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pace();
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.idempotency_key },
          body: JSON.stringify({ from: config.emailFrom, to: [row.to_email], subject: row.subject, html: row.html, text: row.text_body, ...(config.replyTo ? { reply_to: config.replyTo } : {}), headers }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          await store.update('outbox', { id: row.id }, { status: 'sent', provider_id: body.id || null, sent_at: new Date().toISOString(), error: null });
          return { status: 'sent', id: body.id };
        }
        lastErr = `${res.status} ${body.message || body.name || ''}`.trim();
        if (res.status < 500 && res.status !== 429) break;
        const ra = Number(res.headers?.get?.('retry-after'));
        if (res.status === 429 && ra > 0 && ra < 10) await sleep(ra * 1000);
      } catch (e) {
        lastErr = String(e.message || e);
      }
      await sleep(400 * 2 ** attempt);
    }
    await store.update('outbox', { id: row.id }, { status: 'failed', error: lastErr.slice(0, 300) });
    return { status: 'failed', error: lastErr };
  }

  async function send({ accountId = null, to, subject, html, text, kind, key }) {
    const email = String(to).toLowerCase();
    if (await store.one('suppressions', { where: { email } })) return { status: 'suppressed' };
    const marketing = MARKETING_KINDS.has(kind);
    let acct = null;
    if (accountId) acct = await store.one('accounts', { where: { id: accountId } });
    if (marketing && acct?.unsubscribed_at) return { status: 'unsubscribed' };
    let bodyHtml = html;
    let bodyText = text;
    const headers = {};
    if (marketing) {
      if (!config.has.address) {
        await store.insert('outbox', { account_id: accountId, to_email: email, subject, html, text_body: text, kind, status: 'failed', error: 'MAILING_ADDRESS not set (CAN-SPAM)', idempotency_key: key }, { ignoreDuplicates: true });
        return { status: 'blocked_no_address' };
      }
      const f = footer(config, accountId);
      bodyHtml = html + f.html;
      bodyText = text + f.text;
      headers['List-Unsubscribe'] = `<${f.url}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const inserted = await store.insert('outbox', { account_id: accountId, to_email: email, subject, html: bodyHtml, text_body: bodyText, kind, idempotency_key: key }, { ignoreDuplicates: true });
    let row = inserted[0];
    if (!row) {
      row = await store.one('outbox', { where: { idempotency_key: key } });
      if (row && ['sent', 'simulated'].includes(row.status)) return { status: row.status, duplicate: true };
    }
    return deliver(row, headers);
  }

  return { send };
}
