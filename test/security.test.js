import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  if (['node_modules', '.git'].includes(f)) return [];
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(ROOT).filter((f) => !/\.(png|jpg|ico)$/.test(f));

const PATTERNS = [
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [/sk_live_[0-9A-Za-z]{10,}/, 'Stripe live secret key'],
  [/rk_live_[0-9A-Za-z]{10,}/, 'Stripe live restricted key'],
  [/sb_secret_[0-9A-Za-z_-]{10,}/, 'Supabase secret key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT (service role keys look like this)'],
  [/re_[A-Za-z0-9]{20,}/, 'Resend key'],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, 'private key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
];

test('secret scan: no credential-shaped strings anywhere in the repository', () => {
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [re, name] of PATTERNS) if (re.test(text)) hits.push(`${relative(ROOT, f)}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test('.env.example holds placeholders only and real env files are git-ignored', () => {
  const ex = readFileSync(join(ROOT, '.env.example'), 'utf8');
  for (const line of ex.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (/KEY|SECRET|TOKEN/.test(m[1])) assert.match(m[2], /placeholder|your|YOUR/i, line);
  }
  const ign = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const p of ['.env', 'apiinfo.txt', 'node_modules']) assert.ok(ign.includes(p), p);
  assert.ok(!existsSync(join(ROOT, '.env')));
  assert.ok(!existsSync(join(ROOT, 'apiinfo.txt')));
});

test('no inline scripts, event handlers or third-party hosts in the shipped pages (CSP is script-src none)', () => {
  const src = files.filter((f) => f.endsWith('.js') && f.includes('/src/')).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(src, /<script[\s>]/i);
  assert.doesNotMatch(src, /\son(click|change|submit|load|error)=/i);
  assert.doesNotMatch(src, /(src|href)="https?:\/\/(?!eservices|data\.mesaaz|roc\.az)[^"]*\.(js|css)"/);
});

test('every database call goes through the store; no raw SQL strings are built from user input', () => {
  const src = files.filter((f) => f.endsWith('.js') && f.includes('/src/') && !f.includes('/store/')).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(src, /INSERT INTO .*\$\{|DELETE FROM .*\$\{|SELECT .* FROM .*\$\{/);
});

test('dependencies: zero runtime packages (nothing to be compromised through npm)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), []);
});
