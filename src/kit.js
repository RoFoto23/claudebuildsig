import { TRADES, JURISDICTIONS, CERTIFICATIONS } from './taxonomy.js';
import { money } from './scoring.js';

/**
 * Response kit generators. Deterministic templates only: every sentence is built from the customer's saved
 * profile and the cited public record. Missing inputs are listed, never invented, and nothing is ever submitted.
 */

const tradeLabels = (p) => (p.trades || []).map((t) => TRADES[t]?.label).filter(Boolean);
const areaLabels = (p) => (p.jurisdictions || []).map((j) => JURISDICTIONS[j]?.label).filter(Boolean);
const certLabels = (p) => (p.certifications || []).map((c) => CERTIFICATIONS[c]).filter(Boolean);
const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

export function licenseLine(profile) {
  return profile.license_number ? `ROC license #${profile.license_number} (self-reported; verify on the ROC lookup)` : 'ROC license #[add your license number in Settings]';
}

export function missingInputs(profile, { forProposal = false } = {}) {
  const m = [];
  if (!profile.business_name) m.push('Business name');
  if (!profile.contact_name) m.push('Your name');
  if (!profile.phone) m.push('Phone number');
  if (!profile.license_number) m.push('ROC license number');
  if (!(profile.trades || []).length) m.push('Trades');
  if (!profile.capability_blurb) m.push('One or two sentences about your work (capability blurb)');
  if (forProposal && !(profile.rate_card || []).length) m.push('Rate card (your unit prices)');
  if (forProposal && profile.insurance_limit == null) m.push('Insurance limits');
  return m;
}

function projectRef(opp) {
  const where = opp.address ? ` at ${opp.address}` : '';
  const id = opp.source_id ? ` (${opp.agency || 'public record'} ${opp.kind === 'public_bid' ? 'solicitation' : 'permit'} ${opp.source_id})` : '';
  return `${opp.title}${where}${id}`;
}

export function introEmail(profile, opp) {
  const trades = list(tradeLabels(profile).map((t) => t.toLowerCase()));
  const areas = list(areaLabels(profile));
  const biz = profile.business_name || '[your business name]';
  const me = profile.contact_name || '[your name]';
  const missing = missingInputs(profile);
  const isBid = opp.kind === 'public_bid';
  const subject = isBid ? `Question on ${opp.source_id || opp.title}: ${biz}` : `${tradeLabels(profile)[0] || 'Trade'} bids for ${opp.address || opp.title}: ${biz}`;
  const lines = [];
  lines.push(opp.gc_name && !isBid ? `Hello ${opp.gc_name} team,` : 'Hello,');
  lines.push('');
  if (isBid) {
    lines.push(`I'm ${me} with ${biz}${trades ? `, a ${trades} contractor` : ''}${areas ? ` serving ${areas}` : ''}. I'm reviewing ${projectRef(opp)} and have a question about the scope and the submission process.`);
  } else {
    lines.push(`I'm ${me} with ${biz}${trades ? `, a ${trades} contractor` : ''}${areas ? ` serving ${areas}` : ''}. I saw ${projectRef(opp)} in the public record and wanted to ask who handles ${(tradeLabels(profile)[0] || 'trade').toLowerCase()} bids for it.`);
  }
  if (profile.capability_blurb) lines.push('', profile.capability_blurb.trim());
  lines.push('', isBid ? 'Could you confirm the best contact for questions, and whether there are any addenda I should have?' : 'Could you add us to your bid list or point me to the right contact? I can send a capability statement, W-9 and certificate of insurance.');
  lines.push('', `${licenseLine(profile)}`, '', 'Thank you,', me, biz, profile.phone || '[your phone number]');
  return { subject, body: lines.join('\n'), missing };
}

export function callScript(profile, opp) {
  const biz = profile.business_name || '[your business name]';
  const me = profile.contact_name || '[your name]';
  const trade = (tradeLabels(profile)[0] || 'trade').toLowerCase();
  const who = opp.gc_name || (opp.kind === 'public_bid' ? opp.agency : 'the project team') || 'the project team';
  const steps = [
    `Opening: "Hi, this is ${me} with ${biz}. I'm calling about ${projectRef(opp)}. Who handles ${trade} bids or vendors for it?"`,
    'If they are the right person: "Is the ' + trade + ' scope already awarded? If it is, can I be your backup or get on your bid list for the next phase?"',
    'Ask: "What do you need from us to be considered: license, insurance certificate, W-9, references, a capability statement?"',
    opp.kind === 'public_bid' ? 'Ask: "Is there a mandatory pre-bid meeting, and are all addenda posted on the official page?"' : 'Ask: "Which phase is the project in, and when do you expect to buy out the trades?"',
    `Close: "Can I email you my capability statement today? My ${profile.license_number ? 'ROC license number is ' + profile.license_number : 'license number is [add in Settings]'}."`,
  ];
  const voicemail = `Voicemail: "Hi ${who === 'the project team' ? '' : who + ' team, '}this is ${me} with ${biz}. I'm calling about ${opp.address || opp.title}. We do ${trade} work and would like to get on your bid list. My number is ${profile.phone || '[your phone number]'}. I'll also send an email. Thank you."`;
  return { steps, voicemail, missing: missingInputs(profile) };
}

export function capabilityStatement(profile) {
  const missing = missingInputs(profile);
  const sections = [];
  sections.push({ h: 'Services', p: tradeLabels(profile).length ? list(tradeLabels(profile)) : null });
  sections.push({ h: 'Service area', p: areaLabels(profile).length ? list(areaLabels(profile)) : null });
  sections.push({ h: 'About us', p: profile.capability_blurb || null });
  sections.push({ h: 'Licensing', p: profile.license_number ? `ROC license #${profile.license_number}${(profile.license_classes || []).length ? `, classifications: ${profile.license_classes.join(', ')}` : ''} (self-reported)` : null });
  sections.push({ h: 'Certifications', p: certLabels(profile).length ? list(certLabels(profile)) + ' (self-reported)' : null });
  const cover = [];
  if (profile.insurance_limit != null) cover.push(`Insurance limit on file: ${money(Number(profile.insurance_limit))}`);
  if (profile.bonding_limit != null) cover.push(`Bonding capacity on file: ${money(Number(profile.bonding_limit))}`);
  sections.push({ h: 'Insurance and bonding', p: cover.length ? cover.join('. ') + '. (self-reported)' : null });
  return { title: profile.business_name || '[Your business name]', contact: [profile.contact_name, profile.phone].filter(Boolean).join(' | '), sections, missing };
}

export function proposalDraft(profile, opp) {
  const missing = missingInputs(profile, { forProposal: true });
  const rc = Array.isArray(profile.rate_card) ? profile.rate_card : [];
  const lines = rc.map((r) => ({ label: String(r.label || ''), unit: String(r.unit || ''), rate: Number(r.rate), qty: null }));
  const text = [
    'DRAFT PROPOSAL. This is not a bid. Review it, edit it, and submit it under your own license.',
    '',
    `To: ${opp.gc_name || opp.agency || '[recipient]'}`,
    `Project: ${projectRef(opp)}`,
    `From: ${profile.business_name || '[your business name]'}, ${licenseLine(profile)}`,
    '',
    lines.length ? 'Items from your rate card (you enter quantities after you review the plans or documents):' : 'No rate card on file. Add your unit rates in Settings to fill this section.',
    ...lines.map((l) => `- ${l.label}: ${Number.isFinite(l.rate) ? '$' + l.rate.toFixed(2) : '[rate]'} per ${l.unit || 'unit'}  x  quantity [____]  =  $[____]`),
    '',
    'Scope inclusions and exclusions: [you write this after reading the scope documents]',
    'Schedule and start window: [you confirm]',
    'Payment terms: [you set]',
    'Proposal valid for: [you set] days',
    '',
    'Permit values and public records on BuildSignal are context only. They are not contract prices, and this draft does not estimate your price.',
  ].join('\n');
  return { lines, text, missing };
}

export function formsChecklist(profile, opp) {
  const items = [
    { item: 'Completed W-9', status: 'you provide', note: 'BuildSignal does not hold tax forms.' },
    { item: 'Certificate of insurance', status: profile.insurance_limit != null ? 'limit on file' : 'missing', note: profile.insurance_limit != null ? `Limit entered: ${money(Number(profile.insurance_limit))}. Request the certificate from your agent.` : 'Add your limits in Settings and request a certificate from your agent.' },
    { item: 'Copy of your Arizona contractor license', status: profile.license_number ? 'number on file' : 'missing', note: 'Confirm status and classification on the official ROC lookup first.' },
    { item: 'Capability statement', status: 'ready to print', note: 'Generated from your profile.' },
    { item: 'References or past work', status: 'you provide', note: 'Not stored by BuildSignal.' },
  ];
  if (opp.kind === 'public_bid') {
    items.push({ item: 'Bid or performance bond, if the solicitation requires one', status: profile.bonding_limit != null ? 'capacity on file' : 'check', note: 'Requirement not found in BuildSignal data. Read the documents.' });
    items.push({ item: 'Addenda acknowledgment', status: 'you provide', note: 'Check the official page for addenda before you submit.' });
  }
  return items;
}

/* ---------- Calendar (.ics) ---------- */
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** Adds n business days (skips Sat/Sun). */
export function addBusinessDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export function buildIcs(opp, profile, now = new Date()) {
  const isBid = opp.kind === 'public_bid' && opp.deadline;
  const start = isBid ? new Date(opp.deadline) : addBusinessDays(now, 2);
  if (!isBid) start.setUTCHours(16, 0, 0, 0); // 9:00 AM Arizona time (UTC-7, no daylight saving)
  const end = new Date(start.getTime() + 30 * 60000);
  const summary = isBid ? `Bid deadline: ${opp.title}` : `Follow up: ${opp.gc_name || 'project team'} about ${opp.address || opp.title}`;
  const desc = [
    isBid ? 'Official deadline per the listing. Verify on the official page before you rely on it.' : 'Follow-up reminder set by you in BuildSignal. This is not a bid deadline.',
    opp.url ? `Official record: ${opp.url}` : '',
    profile.license_number ? `Your ROC license: ${profile.license_number}` : '',
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BuildSignal//Response Kit//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${opp.id}-${isBid ? 'deadline' : 'followup'}@buildsignal`,
    `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape(desc)}`,
    ...(opp.url ? [`URL:${opp.url}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`, `TRIGGER:-P${isBid ? '1D' : 'T0M'}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
