// Local preview: node scripts/dev.js  (in-memory data, simulated email, dev sign-in links shown on screen)
import http from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { seedMemory } from '../src/seed.js';

const env = { APP_URL: 'http://localhost:3000', SESSION_SECRET: 'dev'.repeat(16), TOKEN_SECRET: 'tok'.repeat(16), ENC_KEY: 'enc'.repeat(16), ALLOW_DEV_LOGIN_LINKS: '1', ADMIN_EMAILS: 'owner@example.com', MAILING_ADDRESS: 'Dev address', ...process.env };
const config = loadConfig(env);
const store = createMemoryStore();
await seedMemory(store);
const app = createApp({ config, store });
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await app.fetch(new Request(`http://localhost:3000${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  res.statusCode = r.status;
  r.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
  res.setHeader('Set-Cookie', r.headers.getSetCookie().map((c) => c.replace('; Secure', '')));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(3000, () => console.log('http://localhost:3000'));
