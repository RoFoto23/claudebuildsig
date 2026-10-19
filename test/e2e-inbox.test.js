import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, plain, signIn } from './helpers.js';
import { inboxWorld, customer, webhook, received, message } from './helpers-inbox.js';
import { runDigest } from '../src/jobs.js';
import { sweep } from '../src/inbox.js';
import { inboxDeps } from '../src/routes-hooks.js';

async function digestOf(w, c) {
  await runDigest({ config: w.config, store: w.store, mailer: w.mailer, now: w.now() });
  const rows = await w.store.select('outbox', { where: { kind: 'digest', account_id: c.account.id } });
  assert.equal(rows.length, 1, 'one digest email');
  return rows[0];
}

test('end to end: forward -> parse -> digest -> one tap Interested -> response kit + calendar -> export -> deletion', async () => {
  const w = await inboxWorld();
  const c = await customer(w, { email: 'roofer@example.com', trades: ['roofing'], jurisdictions: ['mesa'] });
  const other = await customer(w, { email: 'other@example.com', trades: ['roofing'], jurisdictions: ['mesa'] });

  // 1. The contractor forwards a real-looking alert to the private address (webhook = metadata only; body fetched from the provider).
  w.received.e2e1 = message();
  const hook = await webhook(w, received('e2e1', c.address));
  assert.equal(hook.status, 200);
  const msg = await w.store.one('inbound_messages', { where: { provider_email_id: 'e2e1' } });
  assert.equal(msg.status, 'parsed');
  assert.equal(msg.parse_method, 'rules');

  // 2. The item exists only for this account and was scored like any other opportunity.
  const opp = await w.store.one('opportunities', { where: { id: msg.opportunity_ids[0] } });
  assert.equal(opp.owner_account_id, c.account.id);
  assert.equal(new Date(opp.deadline).toISOString(), '2026-10-27T21:00:00.000Z');

  // 3. The digest includes it for this customer only, labelled as forwarded, with the link labelled by host.
  const mail = await digestOf(w, c);
  const html = mail.html || '';
  assert.match(plain(html), /Roof Replacement/);
  assert.match(plain(html), /forwarded/i);
  assert.match(plain(html), /bidnetdirect\.com/);
  const otherMail = (await w.store.select('outbox', { where: { kind: 'digest', account_id: other.account.id } }))[0];
  assert.ok(!/Roof Replacement - City of Mesa Fire Station 205/.test(otherMail?.html || ''), 'no leak to another account');

  // 4. One tap: a link scanner's GET never records anything; the human tap does.
  const links = [...html.matchAll(/href="(https?:\/\/[^"]*\/t\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.ok(links.length >= 3, `three one-tap buttons, saw ${links.length}`);
  const match = (await w.store.select('matches', { where: { account_id: c.account.id } })).find((m) => m.opportunity_id === opp.id);
  assert.ok(match, 'a match row exists for the forwarded item');
  let chosen = null;
  for (const l of links) {
    const res = await w.app.fetch(new Request(l));
    if (/Interested/.test(plain(await res.text()))) { chosen = l; break; }
  }
  assert.ok(chosen, 'found the Interested button');
  assert.equal((await w.store.one('matches', { where: { id: match.id } })).disposition ?? null, null, 'prefetch recorded nothing');
  const tapped = await w.app.fetch(new Request(chosen, { headers: { 'sec-fetch-user': '?1' } }));
  assert.match(plain(await tapped.text()), /Saved: Interested/);
  assert.equal((await w.store.one('matches', { where: { id: match.id } })).disposition, 'interested');

  // 5. The response kit: license number on the drafts, missing inputs listed, never submitted; calendar file has the deadline.
  const b = browser(w.app);
  await b.post('/login', { email: 'roofer@example.com', next: '/app' });
  await signIn(b, w.store, 'roofer@example.com');
  const kit = plain(await (await b.get(`/app/m/${match.id}`)).text());
  assert.match(kit, /314159/);
  assert.match(kit, /ROC/i);
  assert.match(kit, /review|submit/i);
  const ics = await b.get(`/app/m/${match.id}/calendar.ics`);
  assert.equal(ics.status, 200);
  const icsText = await ics.text();
  assert.match(icsText, /BEGIN:VCALENDAR/);
  assert.match(icsText, /20261027/);
  const pipeline = plain(await (await b.get('/app/pipeline')).text());
  assert.match(pipeline, /Roof Replacement/);

  // 6. The other customer cannot open this customer's match, kit or the forwarded item.
  const ob = browser(w.app);
  await ob.post('/login', { email: 'other@example.com', next: '/app' });
  await signIn(ob, w.store, 'other@example.com');
  assert.equal((await ob.get(`/app/m/${match.id}`)).status, 404);
  assert.doesNotMatch(plain(await (await ob.get('/app/inbox')).text()), /Fire Station 205/);

  // 7. Export contains the customer's forwarded data; deletion removes every trace but keeps the other customer's.
  const exp = await (await b.get('/app/export')).text();
  assert.match(exp, /Roof Replacement/);
  assert.match(exp, /e2e1|Fire Station 205/);
  assert.ok(!exp.includes('other@example.com'));
  const del = await b.post('/app/delete', { confirm: 'DELETE' });
  assert.equal(del.status, 303);
  for (const t of ['inbox_addresses', 'inbound_messages', 'matches', 'profiles']) assert.equal((await w.store.select(t, { where: { account_id: c.account.id } })).length, 0, t);
  assert.equal((await w.store.select('opportunities', { where: { owner_account_id: c.account.id } })).length, 0);
  assert.equal((await w.store.select('inbox_addresses', { where: { account_id: other.account.id } })).length, 1);
});

test('a forward that arrives while the provider fetch is failing is retried by the sweeper, then appears in the next digest', async () => {
  const w = await inboxWorld();
  const c = await customer(w);
  w.received.late = new Response('{"message":"try later"}', { status: 503 });
  await webhook(w, received('late', c.address));
  let row = await w.store.one('inbound_messages', { where: { provider_email_id: 'late' } });
  assert.notEqual(row.status, 'parsed');
  assert.ok(row.attempts >= 1);
  w.received.late = message();
  w.advance(11 * 60000);
  const s = await sweep(inboxDeps({ config: w.config, store: w.store, mailer: w.mailer, fetchImpl: w.fetchImpl, now: w.now }));
  assert.ok(s, 'sweep ran');
  row = await w.store.one('inbound_messages', { where: { provider_email_id: 'late' } });
  assert.equal(row.status, 'parsed');
  const mail = await digestOf(w, c);
  assert.match(plain(mail.html), /Roof Replacement/);
});
