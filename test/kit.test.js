import test from 'node:test';
import assert from 'node:assert/strict';
import { introEmail, callScript, capabilityStatement, proposalDraft, formsChecklist, buildIcs, missingInputs, addBusinessDays, licenseLine } from '../src/kit.js';

const full = { business_name: 'Sun Valley Concrete', contact_name: 'Dana Ruiz', phone: '480-555-0111', license_number: '314159', license_classes: ['C-9'], trades: ['concrete'], jurisdictions: ['mesa'], certifications: ['small_business'], capability_blurb: 'We pour flatwork.', rate_card: [{ label: 'Flatwork', unit: 'sq ft', rate: 8.5 }], insurance_limit: 1000000, bonding_limit: null };
const bare = { trades: [], jurisdictions: [], certifications: [], rate_card: [] };
const permit = { id: 'o1', kind: 'permit_lead', title: 'New building: 1 Main', address: '1 Main St', source_id: 'PMT1', agency: 'City of Mesa', gc_name: 'Acme Builders', url: 'https://x/y' };
const bid = { id: 'o2', kind: 'public_bid', title: 'Concrete repair', agency: 'GSA', source_id: 'N1', deadline: '2026-10-20T20:00:00Z', url: 'https://sam.gov/opp/1' };

test('every draft shows the ROC license number (A.R.S. 32-1124) and marks it self-reported', () => {
  assert.match(licenseLine(full), /314159/);
  assert.match(introEmail(full, permit).body, /314159/);
  assert.match(callScript(full, permit).steps.join(' '), /314159/);
  assert.match(proposalDraft(full, bid).text, /314159/);
  assert.match(capabilityStatement(full).sections.map((s) => s.p).join(' '), /314159/);
});

test('missing information is listed and left in [brackets], never invented', () => {
  const m = missingInputs(bare, { forProposal: true });
  for (const k of ['Business name', 'Your name', 'Phone number', 'ROC license number', 'Trades', 'Rate card (your unit prices)', 'Insurance limits']) assert.ok(m.includes(k), k);
  const e = introEmail(bare, permit);
  assert.match(e.body, /\[add your license number/);
  assert.match(e.body, /\[your business name\]/);
  assert.ok(e.missing.length >= 4);
});

test('drafts never claim credentials the customer has not entered', () => {
  const cap = capabilityStatement({ ...bare, business_name: 'X', contact_name: 'Y', phone: '1' });
  const text = cap.sections.map((s) => `${s.h}:${s.p}`).join(' ');
  assert.doesNotMatch(text, /certified|bonded|insured|licensed/i);
  assert.equal(cap.sections.find((s) => s.h === 'Certifications').p, null);
  assert.equal(cap.sections.find((s) => s.h === 'Insurance and bonding').p, null);
  const withIns = capabilityStatement(full).sections.find((s) => s.h === 'Insurance and bonding').p;
  assert.match(withIns, /Insurance limit/);
  assert.doesNotMatch(withIns, /Bonding/);
});

test('proposal uses rate-card rates only, leaves quantities and totals blank, and says it is not a bid', () => {
  const p = proposalDraft(full, bid);
  assert.match(p.text, /DRAFT PROPOSAL\. This is not a bid/);
  assert.match(p.text, /Flatwork: \$8\.50 per sq ft/);
  assert.match(p.text, /quantity \[____\]/);
  assert.doesNotMatch(p.text, /Total: \$\d/);
  assert.equal(proposalDraft(bare, bid).lines.length, 0);
});

test('permit-lead drafts frame it as a bid-list request, not an invitation to bid', () => {
  assert.match(introEmail(full, permit).body, /bid list/);
  assert.doesNotMatch(introEmail(full, permit).body, /invitation to bid/i);
});

test('forms checklist is honest about what is on file', () => {
  const f = formsChecklist({ ...bare, insurance_limit: null }, bid);
  assert.ok(f.some((x) => /Addenda/.test(x.item)));
  assert.equal(f.find((x) => /insurance/i.test(x.item)).status, 'missing');
  assert.equal(formsChecklist(full, permit).find((x) => /license/i.test(x.item)).status, 'number on file');
  assert.ok(!formsChecklist(full, permit).some((x) => /Addenda/.test(x.item)));
});

test('calendar file: valid RFC 5545 shape, CRLF, escaped, folded, deadline event for bids', () => {
  const ics = buildIcs(bid, full, new Date('2026-10-11T00:00:00Z'));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /DTSTART:20261020T200000Z/);
  assert.match(ics, /SUMMARY:Bid deadline: Concrete repair/);
  assert.match(ics, /TRIGGER:-P1D/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  const lead = buildIcs(permit, full, new Date('2026-10-09T12:00:00Z')).replace(/\r\n /g, ''); // Friday, unfolded
  assert.match(lead, /SUMMARY:Follow up/);
  assert.match(lead, /Not a bid deadline|not a bid deadline/);
  assert.match(lead, /DTSTART:20261013T160000Z/); // Tuesday 9:00 AZ, two business days later
});

test('addBusinessDays skips weekends', () => {
  assert.equal(addBusinessDays(new Date('2026-10-09T12:00:00Z'), 2).toISOString().slice(0, 10), '2026-10-13');
});
