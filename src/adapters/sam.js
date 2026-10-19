import { clip, finalize, isoDate } from './util.js';
import { TRADES } from '../taxonomy.js';

/**
 * SAM.gov Opportunities API v2 (federal). Needs SAM_API_KEY. Rate limits depend on account role and were not
 * verified, so this adapter makes exactly one request per run and treats HTTP 429 as "rate limited", not "broken".
 */
const NAICS = new Set(Object.values(TRADES).flatMap((t) => t.naics));
const mdy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;

export const sam = {
  id: 'sam_gov',
  label: 'SAM.gov Opportunities API (federal)',
  jurisdiction: 'statewide',
  needsKey: true,

  url(key, now = new Date()) {
    const from = new Date(now.getTime() - 14 * 86400000);
    const p = new URLSearchParams({ api_key: key, postedFrom: mdy(from), postedTo: mdy(now), limit: '1000', offset: '0', state: 'AZ', ptype: 'o,k,p' });
    return `https://api.sam.gov/opportunities/v2/search?${p.toString()}`;
  },

  async fetchRaw(fetchImpl, now = new Date(), { key } = {}) {
    if (!key) throw new Error('SAM_API_KEY not configured');
    const res = await fetchImpl(this.url(key, now), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429) {
      const e = new Error('sam: rate limited (429)');
      e.rateLimited = true;
      throw e;
    }
    if (!res.ok) throw new Error(`sam ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.opportunitiesData)) throw new Error('sam: unexpected response shape');
    return json.opportunitiesData;
  },

  normalize(r) {
    const naics = String(r.naicsCode || '');
    if (!r.noticeId || r.active === 'No' || !(NAICS.has(naics) || naics.startsWith('23'))) return null;
    const pop = r.placeOfPerformance || {};
    return finalize({
      source: this.id,
      source_id: String(r.noticeId),
      kind: 'public_bid',
      title: clip(r.title, 200) || 'Federal solicitation',
      agency: clip(r.fullParentPathName ? String(r.fullParentPathName).split('.').slice(-1)[0] : r.department, 160),
      jurisdiction: 'statewide',
      address: clip([pop.city?.name, pop.state?.code].filter(Boolean).join(', '), 120),
      zip: pop.zip ? String(pop.zip).slice(0, 5) : null,
      stage: 'open_bid',
      value: null,
      sqft: null,
      units: null,
      issued_date: r.postedDate ? String(r.postedDate).slice(0, 10) : null,
      deadline: r.responseDeadLine ? new Date(r.responseDeadLine).toISOString() : null,
      url: r.uiLink || `https://sam.gov/opp/${r.noticeId}/view`,
      gc_name: null,
      applicant: null,
      scope: clip(`${r.title || ''} ${r.solicitationNumber ? `(Solicitation ${r.solicitationNumber})` : ''}`, 400),
      work_type: clip(r.type, 80),
      permit_type: null,
      parent_key: `sam:${r.solicitationNumber || r.noticeId}`,
      raw: { naics, setAside: r.typeOfSetAsideDescription || null, solicitation: r.solicitationNumber || null, posted: r.postedDate || null },
    });
  },
};

export { isoDate as _isoDate };
