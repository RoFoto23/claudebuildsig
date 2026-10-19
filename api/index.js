import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore, createPublicStore } from '../src/store/index.js';

let app;
function getApp() {
  if (!app) {
    const config = loadConfig();
    app = createApp({ config, store: createStore(config), publicStore: createPublicStore(config) });
  }
  return app;
}

/** Vercel Node entry: converts the Node request into a Web Request, runs the app, writes the Response back. */
export default async function handler(req, res) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const method = req.method || 'GET';
    let body;
    if (!['GET', 'HEAD'].includes(method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const response = await getApp().fetch(new Request(`${proto}://${host}${req.url}`, { method, headers, body }));
    res.statusCode = response.status;
    const cookies = response.headers.getSetCookie();
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.log(JSON.stringify({ level: 'error', route: 'entry', error_code: String(e?.message || e).slice(0, 300) }));
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Server error');
  }
}
