import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, encrypt, decrypt, randomToken, sha256hex, safeEqual } from '../src/crypto.js';
import { hotp, verifyTotp, newSecret, base32Decode, base32Encode, stepOf, otpauthUri } from '../src/totp.js';

test('signed tokens verify, expire, and reject tampering or a different secret', () => {
  const t = signToken({ typ: 'tap', a: '1' }, 'secret', 60, 1_000_000);
  assert.equal(verifyToken(t, 'secret', 1_000_000 + 59_000).a, '1');
  assert.equal(verifyToken(t, 'secret', 1_000_000 + 61_000), null);
  assert.equal(verifyToken(t, 'other', 1_000_000), null);
  const [p, s] = t.split('.');
  assert.equal(verifyToken(`${p}x.${s}`, 'secret', 1_000_000), null);
  assert.equal(verifyToken('', 'secret'), null);
  assert.equal(verifyToken(undefined, 'secret'), null);
  assert.equal(verifyToken('a.b.c', 'secret'), null);
});

test('AES-GCM round trip, random IVs, tamper detection', () => {
  const a = encrypt('JBSWY3DPEHPK3PXP', 'k');
  assert.equal(decrypt(a, 'k'), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(a, encrypt('JBSWY3DPEHPK3PXP', 'k'));
  assert.throws(() => decrypt(a, 'wrong'));
  const parts = a.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => decrypt(parts.join('.'), 'k'));
});

test('helpers: random tokens are unique and long, safeEqual is length-safe', () => {
  assert.notEqual(randomToken(), randomToken());
  assert.ok(randomToken(32).length >= 40);
  assert.equal(sha256hex('a').length, 64);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('TOTP matches RFC 6238 / RFC 4226 test vectors and enforces replay protection', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(hotp(secret, 0), '755224'); // RFC 4226 Appendix D
  assert.equal(hotp(secret, 1), '287082');
  assert.equal(hotp(secret, 9), '520489');
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082'); // RFC 6238 T=59 (last 6 digits of 94287082)
  const now = 1_700_000_000_000;
  const code = hotp(secret, stepOf(now));
  assert.equal(verifyTotp(secret, code, { nowMs: now }), stepOf(now));
  assert.equal(verifyTotp(secret, code, { nowMs: now, lastUsedStep: stepOf(now) }), null); // replay
  assert.equal(verifyTotp(secret, hotp(secret, stepOf(now) - 1), { nowMs: now }), stepOf(now) - 1); // clock skew window
  assert.equal(verifyTotp(secret, hotp(secret, stepOf(now) + 5), { nowMs: now }), null);
  assert.equal(verifyTotp(secret, '12345', { nowMs: now }), null);
  assert.equal(verifyTotp(secret, 'abcdef', { nowMs: now }), null);
});

test('base32 round trip and otpauth URI', () => {
  const s = newSecret();
  assert.equal(base32Encode(base32Decode(s)), s);
  assert.match(otpauthUri(s, 'a@b.co', 'BuildSignal'), /^otpauth:\/\/totp\/.*secret=/);
});
