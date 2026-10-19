import { clip, finalize, isoDate } from './util.js';

/**
 * City of Phoenix "Current Permits (2 Years)" ArcGIS layer. Fields verified on 2026-10-11.
 * The layer has no valuation, square footage, ZIP or house number, and PROFESS_NAME is the professional on the
 * permit (not necessarily the general contractor), so it is shown as "applicant" and ranks lower on contact quality.
 */
const LAYER = 'https://maps.phoenix.gov/pub/rest/services/Public/Planning_Permit/MapServer/1';
const WANTED = /^(SHELL|DEMOLITION|STRUC|COMMERCIAL PERMIT|SITE PERMIT|PAVING CIVIL|CONCRETE CIVIL|GRADING|CIVIL LANDSCAPE|TEMPORARY COMM FENCE|SHORING|MECHANICAL|PLUMBING|ELECTRICAL|PLMB|MECH|REPAIR GARAGE)/;
const UNWANTED = /^(RES|FP |OTC|SIGN|SOLAR|FIRE|WATER|SWIMMING)/;

export const phoenix = {
  id: 'phoenix_permits',
  label: 'City of Phoenix current permits (ArcGIS)',
  jurisdiction: 'phoenix',
  layer: LAYER,

  url(now = new Date()) {
    const since = isoDate(new Date(now.getTime() - 45 * 86400000));
    const p = new URLSearchParams({
      where: `PERMIT_STAT='OPEN' AND PER_ISSUE_DATE >= DATE '${since}'`,
      outFields: 'PER_NUM,PROJECT,PERMIT_NAME,PERMIT_STAT,PER_ISSUE_DATE,STREET_FULL_NAME,PROFESS_NAME,PER_TYPE_DESC,SCOPE_DESC',
      orderByFields: 'PER_ISSUE_DATE DESC',
      resultRecordCount: '2000',
      returnGeometry: 'false',
      f: 'json',
    });
    return `${LAYER}/query?${p.toString()}`;
  },

  async fetchRaw(fetchImpl, now = new Date()) {
    const res = await fetchImpl(this.url(now), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`phoenix ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`phoenix: ${json.error.message || 'arcgis error'}`);
    if (!Array.isArray(json.features)) throw new Error('phoenix: unexpected response shape');
    return json.features.map((f) => f.attributes);
  },

  normalize(a) {
    const type = String(a.PER_TYPE_DESC || '').toUpperCase();
    if (!a.PER_NUM || !type || UNWANTED.test(type) || !WANTED.test(type)) return null;
    const issued = a.PER_ISSUE_DATE ? new Date(a.PER_ISSUE_DATE).toISOString().slice(0, 10) : null;
    const street = clip(a.STREET_FULL_NAME, 120);
    return finalize({
      source: this.id,
      source_id: String(a.PER_NUM),
      kind: 'permit_lead',
      title: `${clip(a.PERMIT_NAME, 120) || clip(a.PER_TYPE_DESC, 80)}${street ? `: ${street} (street only)` : ''}`,
      agency: 'City of Phoenix Planning and Development',
      jurisdiction: 'phoenix',
      address: street,
      zip: null,
      stage: 'issued',
      value: null,
      sqft: null,
      units: null,
      issued_date: issued,
      deadline: null,
      url: `${LAYER}/query?where=${encodeURIComponent(`PER_NUM='${String(a.PER_NUM).replace(/'/g, '')}'`)}&outFields=*&returnGeometry=false&f=html`,
      gc_name: null,
      applicant: clip(a.PROFESS_NAME, 120),
      scope: clip(a.SCOPE_DESC, 1200),
      work_type: clip(a.PER_TYPE_DESC, 120),
      permit_type: 'COM',
      parent_key: `phx:${a.PROJECT || a.PER_NUM}`,
      raw: { project: a.PROJECT ?? null, address_note: 'Phoenix layer provides the street name only' },
    });
  },
};
