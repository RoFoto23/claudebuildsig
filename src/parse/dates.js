/**
 * Date and amount finders for the rules parser. Pure functions, no I/O.
 * Arizona does not observe daylight saving time, so every local time is UTC-07:00 all year.
 */
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const TIME_RE = '(?:\\s*(?:,|\\bat\\b|@|-)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?(?:\\s*(?:MST|AZ time|Arizona time|local time))?)?';
// "October 27, 2026", "Oct. 27 2026 at 2:00 PM"
const WORD_DATE = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b${TIME_RE}`, 'gi');
// "10/27/2026", "10-27-26", optional time
const NUM_DATE = new RegExp(`\\b(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4}|\\d{2})\\b${TIME_RE}`, 'gi');
// "2026-10-27"
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b(?:[ T](\d{2}):(\d{2}))?/g;

const pad = (n) => String(n).padStart(2, '0');

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function valid(y, m, d) {
  return y >= 2024 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function build(y, m, d, hh, mm, hasTime, index, quote) {
  if (!valid(y, m, d)) return null;
  const H = hasTime ? hh : 23;
  const M = hasTime ? mm : 59;
  if (H > 23 || M > 59) return null;
  return {
    date: `${y}-${pad(m)}-${pad(d)}`,
    iso: `${y}-${pad(m)}-${pad(d)}T${pad(H)}:${pad(M)}:00-07:00`,
    time_stated: hasTime,
    index,
    end: index + quote.length,
    quote,
  };
}

function to24(h, ap) {
  let H = Number(h);
  if (H < 1 || H > 12) return null;
  if (/p/i.test(ap) && H !== 12) H += 12;
  if (/a/i.test(ap) && H === 12) H = 0;
  return H;
}

/** Every plausible date in the text, in order of appearance. `quote` is the exact substring that was parsed. */
export function findDates(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(WORD_DATE)) {
    const mon = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
    const hasTime = m[4] !== undefined;
    const H = hasTime ? to24(m[4], m[6]) : null;
    if (hasTime && H === null) continue;
    const r = build(Number(m[3]), mon, Number(m[2]), H, hasTime ? Number(m[5] || 0) : 0, hasTime, m.index, m[0]);
    if (r) out.push(r);
  }
  for (const m of s.matchAll(NUM_DATE)) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    const hasTime = m[4] !== undefined;
    const H = hasTime ? to24(m[4], m[6]) : null;
    if (hasTime && H === null) continue;
    // US order month/day/year only; a first number above 12 is not a valid month and is skipped.
    const r = build(y, Number(m[1]), Number(m[2]), H, hasTime ? Number(m[5] || 0) : 0, hasTime, m.index, m[0]);
    if (r) out.push(r);
  }
  for (const m of s.matchAll(ISO_DATE)) {
    const hasTime = m[4] !== undefined;
    const r = build(Number(m[1]), Number(m[2]), Number(m[3]), hasTime ? Number(m[4]) : 0, hasTime ? Number(m[5]) : 0, hasTime, m.index, m[0]);
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.index - b.index);
}

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(million|mm|m|thousand|k)\b)?/gi;

/** Dollar amounts with the exact quoted text. "$1.2 million" and "$250K" are understood; nothing is guessed. */
export function findAmounts(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(AMOUNT)) {
    let n = Number(m[1].replace(/,/g, '') + (m[2] ? `.${m[2]}` : ''));
    const unit = (m[3] || '').toLowerCase();
    if (unit === 'million' || unit === 'mm' || unit === 'm') n *= 1e6;
    else if (unit === 'thousand' || unit === 'k') n *= 1e3;
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push({ amount: Math.round(n), index: m.index, end: m.index + m[0].length, quote: m[0] });
  }
  return out;
}
