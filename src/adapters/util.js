import { sha256hex } from '../crypto.js';
import { deriveTags } from '../scoring.js';

export const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const posNum = (v) => {
  const n = toNum(v);
  return n && n > 0 ? n : null;
};
export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
export const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null);

/** "1955 W MAIN ST 101" -> "1955 W MAIN ST" (drops a trailing unit so one building = one project family). */
export function addressFamily(addr) {
  return String(addr || '').toUpperCase().replace(/\s+(UNIT|STE|SUITE|#|APT|BLDG|BUILDING)?\s*[A-Z]?\d{1,5}[A-Z]?$/, '').replace(/\s+/g, ' ').trim();
}

/** Stable fingerprint over the fields whose change means a new version (amendment). */
export function fingerprint(o) {
  return sha256hex(JSON.stringify([o.title, o.stage, o.value ?? null, o.sqft ?? null, o.units ?? null, o.deadline ?? null, o.scope, o.gc_name, o.issued_date ?? null, o.status || 'active']));
}

/** Finish a normalized opportunity: tags + fingerprint. */
export function finalize(o) {
  const base = { status: 'active', is_sample: false, tags: [], raw: {}, ...o };
  base.tags = deriveTags(base);
  base.fingerprint = fingerprint(base);
  return base;
}
