import { addressFamily, clip, finalize, isoDate, posNum, toNum } from './util.js';

/**
 * City of Mesa building permits (Socrata dataset m2kk-w2hz on data.mesaaz.gov), commercial permits only.
 * Fields verified against the dataset metadata on 2026-10-11. The dataset has no ZIP column, so location
 * is matched by jurisdiction and the checklist shows ZIP as unconfirmed.
 */
export const mesa = {
  id: 'mesa_permits',
  label: 'City of Mesa building permits (open data)',
  jurisdiction: 'mesa',
  base: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json',

  urls(now = new Date()) {
    const since = isoDate(new Date(now.getTime() - 60 * 86400000));
    const q = (where, order) => `${this.base}?${new URLSearchParams({ $where: where, $order: order, $limit: '2000' }).toString()}`;
    return [
      q(`permit_type='COM' AND issued_date >= '${since}T00:00:00'`, 'issued_date DESC'),
      q(`permit_type='COM' AND status in('In Review','Submitted') AND permit_year='${now.getUTCFullYear()}'`, 'permit_number DESC'),
    ];
  },

  async fetchRaw(fetchImpl, now = new Date()) {
    const rows = [];
    for (const url of this.urls(now)) {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`mesa ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error('mesa: unexpected response shape');
      rows.push(...json);
    }
    const seen = new Set();
    return rows.filter((r) => r.permit_number && !seen.has(r.permit_number) && seen.add(r.permit_number));
  },

  normalize(r) {
    if (!r.permit_number || !(r.description_of_work || r.type_of_work)) return null;
    const status = String(r.status || '').toLowerCase();
    const stage = status === 'issued' ? 'issued' : status === 'in review' || status === 'submitted' ? 'in_review' : /final|close|expire|void|cancel|withdraw/.test(status) ? 'completed' : 'other';
    const address = clip(r.property_address, 200);
    return finalize({
      source: this.id,
      source_id: String(r.permit_number),
      kind: 'permit_lead',
      title: `${clip(r.type_of_work, 80) || 'Commercial permit'}${address ? `: ${address}` : ''}`,
      agency: 'City of Mesa Development Services',
      jurisdiction: 'mesa',
      address,
      zip: null,
      stage,
      value: posNum(r.job_value),
      sqft: posNum(r.total_square_feet),
      units: posNum(r.number_of_dwelling_units),
      issued_date: r.issued_date ? String(r.issued_date).slice(0, 10) : null,
      deadline: null,
      url: `${this.base}?permit_number=${encodeURIComponent(r.permit_number)}`,
      gc_name: clip(r.contractor_name, 120),
      applicant: clip(r.applicant, 120),
      scope: clip(r.description_of_work, 1200),
      work_type: clip(r.type_of_work, 120),
      permit_type: clip(r.permit_type, 20),
      parent_key: `mesa:${addressFamily(address)}`,
      raw: { new_residential_permit: r.new_residential_permit ?? null, parcel: r.parcel_number ?? null, council_district: r.council_district ?? null, lat: toNum(r.latitude), lng: toNum(r.longitude), job_value_note: 'Permit job value is not a contract price' },
    });
  },
};
