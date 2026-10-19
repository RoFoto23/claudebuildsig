// Generates docs/sample-digest.html and .txt from the real renderer using the frozen demo data.
import { writeFileSync } from 'node:fs';
import { demoDigest, SNAPSHOT_NOW } from '../src/sample.js';
import { renderDigest } from '../src/digest.js';
const config = { brand: 'BuildSignal', baseUrl: 'https://example.com', tokenSecret: 'sample-only-secret-not-real' };
const d = demoDigest('framing');
const mail = renderDigest(config, { account: { id: 'sample-account' }, profile: d.profile, items: d.items, kind: 'daily', digestId: 'sample-digest' });
const day = SNAPSHOT_NOW.toISOString().slice(0, 10);
writeFileSync(new URL('../docs/sample-digest.html', import.meta.url), `<!doctype html><meta charset="utf-8"><title>Sample digest</title><p style="font:13px Arial;background:#fff4d6;padding:8px">SAMPLE: frozen snapshot of ${day}; buttons point at example.com and do nothing.</p>${mail.html}`);
writeFileSync(new URL('../docs/sample-digest.txt', import.meta.url), `Subject: ${mail.subject}\n\n${mail.text}`);
console.log(mail.subject);
