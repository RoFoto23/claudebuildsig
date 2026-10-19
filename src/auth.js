import { randomToken, sha256hex, signToken, verifyToken } from './crypto.js';
import { cookieHeader, parseCookies } from './http.js';

const SESSION_TTL = 30 * 86400;
const ADMIN_TTL = 8 * 3600;
const LOGIN_TTL_MS = 20 * 60 * 1000;

/** Passwordless auth: hashed single-use login tokens, HMAC-signed session cookies, epoch-based revocation. */
export function createAuth({ config, store }) {
  const secure = config.baseUrl.startsWith('https://');

  async function createLoginLink(accountId, next = '/app', now = new Date()) {
    const token = randomToken(32);
    await store.insert('login_tokens', { token_hash: sha256hex(token), account_id: accountId, expires_at: new Date(now.getTime() + LOGIN_TTL_MS).toISOString() });
    return `${config.baseUrl}/auth/verify?t=${token}&next=${encodeURIComponent(next)}`;
  }

  /** Single use: the conditional update only matches while used_at is still null, so a race can win at most once. */
  async function consumeLoginToken(token, now = new Date()) {
    if (!token || token.length < 20) return null;
    const hash = sha256hex(token);
    const claimed = await store.update('login_tokens', { token_hash: hash, used_at: { isnull: true }, expires_at: { gt: now.toISOString() } }, { used_at: now.toISOString() });
    if (!claimed.length) return null;
    const acct = await store.one('accounts', { where: { id: claimed[0].account_id } });
    if (!acct || acct.status !== 'active') return null;
    await store.update('accounts', { id: acct.id }, { last_login_at: now.toISOString() });
    return acct;
  }

  const sessionCookie = (acct) => cookieHeader('bs_sess', signToken({ typ: 'sess', a: acct.id, e: acct.session_epoch }, config.sessionSecret, SESSION_TTL), { maxAge: SESSION_TTL, secure });
  const clearSession = () => [cookieHeader('bs_sess', '', { maxAge: 0, secure }), cookieHeader('bs_adm', '', { maxAge: 0, secure })];
  const adminCookie = (acct) => cookieHeader('bs_adm', signToken({ typ: 'adm', a: acct.id, e: acct.session_epoch }, config.sessionSecret, ADMIN_TTL), { maxAge: ADMIN_TTL, secure });

  async function readSession(req) {
    const c = parseCookies(req.headers.get('cookie'));
    const p = verifyToken(c.bs_sess, config.sessionSecret);
    if (!p || p.typ !== 'sess') return null;
    const acct = await store.one('accounts', { where: { id: p.a } });
    if (!acct || acct.status !== 'active' || acct.session_epoch !== p.e) return null;
    const adm = verifyToken(c.bs_adm, config.sessionSecret);
    const isAdminEmail = config.adminEmails.includes(acct.email);
    const adminOk = Boolean(isAdminEmail && acct.role === 'admin' && adm && adm.typ === 'adm' && adm.a === acct.id && adm.e === acct.session_epoch);
    return { account: acct, isAdminCandidate: isAdminEmail && acct.role === 'admin', adminOk };
  }

  /** Finds or creates the account for an email. Customers are created only when signup is open; admins always can log in. */
  async function accountForLogin(email, { allowCreate, plan = null, consent = false, referredBy = null } = {}) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(e) || e.length > 200) return null;
    let acct = await store.one('accounts', { where: { email: e } });
    const isAdmin = config.adminEmails.includes(e);
    if (acct) {
      if (acct.status !== 'active') return null;
      if (isAdmin && acct.role !== 'admin') acct = (await store.update('accounts', { id: acct.id }, { role: 'admin' }))[0];
      return acct;
    }
    if (!allowCreate && !isAdmin) return null;
    const [created] = await store.insert('accounts', {
      email: e, role: isAdmin ? 'admin' : 'customer', plan_id: plan, consent_at: consent ? new Date().toISOString() : null,
      referral_code: randomToken(5), referred_by: referredBy,
    });
    return created;
  }

  return { createLoginLink, consumeLoginToken, sessionCookie, clearSession, adminCookie, readSession, accountForLogin };
}
