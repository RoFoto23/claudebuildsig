import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(String(str), 'base64url'),
};

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hmac(secret, msg) {
  return createHmac('sha256', secret).update(msg).digest('base64url');
}

/** Signed, expiring token: base64url(json).signature. exp is unix seconds. */
export function signToken(payload, secret, ttlSeconds, nowMs = Date.now()) {
  if (!secret) throw new Error('signing secret missing');
  const body = { ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const enc = b64u.enc(JSON.stringify(body));
  return `${enc}.${hmac(secret, enc)}`;
}

export function verifyToken(token, secret, nowMs = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [enc, sig] = parts;
  if (!safeEqual(sig, hmac(secret, enc))) return null;
  let body;
  try {
    body = JSON.parse(b64u.dec(enc).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body.exp !== 'number' || body.exp * 1000 < nowMs) return null;
  return body;
}

function key32(secret) {
  return createHash('sha256').update(String(secret)).digest();
}

/** AES-256-GCM. Output: v1.iv.tag.ciphertext (base64url). */
export function encrypt(plain, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key32(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', b64u.enc(iv), b64u.enc(c.getAuthTag()), b64u.enc(ct)].join('.');
}

export function decrypt(packed, secret) {
  const [v, iv, tag, ct] = String(packed).split('.');
  if (v !== 'v1') throw new Error('bad ciphertext version');
  const d = createDecipheriv('aes-256-gcm', key32(secret), b64u.dec(iv));
  d.setAuthTag(b64u.dec(tag));
  return Buffer.concat([d.update(b64u.dec(ct)), d.final()]).toString('utf8');
}
