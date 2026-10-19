import { evaluate, selectForDigest, deriveTags } from './scoring.js';
import { introEmail, callScript, capabilityStatement, proposalDraft, formsChecklist } from './kit.js';

/**
 * Public demo data. These are 10 real permit records from a dated research snapshot (September 17, 2026),
 * each with its official record link. They are a frozen sample, not a live feed, and the UI says so.
 */
export const SNAPSHOT_DATE = '2026-09-17';
export const SNAPSHOT_NOW = new Date('2026-09-17T19:00:00Z');

const S = (id, o) => ({
  id: `sample-${id}`, source: 'sample', kind: 'permit_lead', stage: 'issued', permit_type: 'COM', version: 1, status: 'active', is_sample: true,
  zip: null, tags: [], raw: {}, applicant: null, ...o, source_id: o.source_id,
});

export const SAMPLE_OPPS = [
  S(1, { source_id: '324318', title: 'Artesia multifamily, 419 units', agency: 'City of Scottsdale', jurisdiction: 'scottsdale', address: '7117 N Scottsdale Rd', issued_date: '2026-08-13', value: 116768829.14, units: 419, sqft: null, gc_name: 'MT Builders LLC', work_type: 'Multifamily dwelling', scope: 'New multifamily dwelling, 419 units. Permit type: multifamily dwelling.', url: 'https://eservices.scottsdaleaz.gov/bldgresources/BuildingPermit/Details/324318', parent_key: 'sample:artesia' }),
  S(2, { source_id: 'PMT21-15339', title: '305-unit multifamily development', agency: 'City of Mesa', jurisdiction: 'mesa', address: '5135 S Power Rd', issued_date: '2026-09-01', value: 53810201.3, units: 305, sqft: 328390, gc_name: 'MMF 1 Arizona Contractor LLC', work_type: 'New building', scope: 'New 305-unit multifamily development with one four-story building, two three-story buildings, and a garage and maintenance building.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT21-15339', parent_key: 'sample:power-rd' }),
  S(3, { source_id: 'PMT26-05579', title: 'Manufacturing tenant improvement, 51,938 sq ft', agency: 'City of Mesa', jurisdiction: 'mesa', address: '3204 S Signal Butte Rd #1049', issued_date: '2026-09-08', value: 2500000, sqft: 51938, gc_name: 'Mortenson Construction', work_type: 'Tenant improvement', scope: 'Tenant improvement in a 51,938 sq ft warehouse for water-based battery electrolyte and related processes, including demising wall and restroom work.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT26-05579', parent_key: 'sample:signal-butte' }),
  S(4, { source_id: '324328', title: 'Commercial new building, 16,713 sq ft', agency: 'City of Scottsdale', jurisdiction: 'scottsdale', address: '7400 E Mayo Blvd', issued_date: '2026-09-15', value: 2354694.57, sqft: 16713, gc_name: null, work_type: 'Commercial new', scope: 'Commercial new construction, 16,713 air-conditioned sq ft. The public report view does not name the project or the builder.', url: 'https://eservices.scottsdaleaz.gov/bldgresources/BuildingPermit/Details/324328', parent_key: 'sample:mayo' }),
  S(5, { source_id: 'PMT25-11457', title: 'New 36-unit apartment building', agency: 'City of Mesa', jurisdiction: 'mesa', address: '539 S Williams', issued_date: '2026-08-26', value: null, units: 36, sqft: 41595, gc_name: 'Ridgeway Construction LLC', work_type: 'New building', scope: 'New three-story, 36-unit apartment building, 41,595 sq ft.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT25-11457', parent_key: 'sample:williams' }),
  S(6, { source_id: '324273', title: 'Commercial new building, Scottsdale Airport', agency: 'City of Scottsdale', jurisdiction: 'scottsdale', address: '15111 N Airport Dr', issued_date: '2026-07-28', value: 13962705.49, gc_name: 'Willmeng Construction', work_type: 'Commercial new', scope: 'Commercial new construction. Listed owner: City of Scottsdale.', url: 'https://eservices.scottsdaleaz.gov/bldgresources/BuildingPermit/Details/324273', parent_key: 'sample:airport' }),
  S(7, { source_id: 'PMT25-21434', title: 'Health and fitness club tenant improvement', agency: 'City of Mesa', jurisdiction: 'mesa', address: '6744 E Broadway Rd', issued_date: '2026-09-01', value: 3265500, sqft: 43540, gc_name: 'Ancor Inc.', work_type: 'Tenant improvement', scope: 'Tenant improvement of an existing 43,540 sq ft building plus a 2,978 sq ft outdoor area for a health and fitness club.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT25-21434', parent_key: 'sample:broadway' }),
  S(8, { source_id: '324336', title: 'Twelve-unit multifamily building', agency: 'City of Scottsdale', jurisdiction: 'scottsdale', address: '4251 N Marshall Way', issued_date: '2026-08-20', value: 2730552.05, units: 12, gc_name: 'H&E Construction LLC', work_type: 'Multifamily dwelling', scope: 'New multifamily dwelling, 12 units.', url: 'https://eservices.scottsdaleaz.gov/bldgresources/BuildingPermit/Details/324336', parent_key: 'sample:marshall' }),
  S(9, { source_id: 'PMT26-10388', title: 'Retail shell with drive-through', agency: 'City of Mesa', jurisdiction: 'mesa', address: '8338 E Elliot Rd', issued_date: '2026-09-01', value: null, sqft: 5191, gc_name: 'EOS Builders LLC', work_type: 'New building', scope: 'New 5,191 sq ft retail shell with a 5,956 sq ft drive-through area.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT26-10388', parent_key: 'sample:elliot' }),
  S(10, { source_id: 'PMT26-09422', title: 'Warehouse and office expansion', agency: 'City of Mesa', jurisdiction: 'mesa', address: '7307 S 89th Pl', issued_date: '2026-09-10', value: null, sqft: 5564, gc_name: 'LGE Design Build', work_type: 'Addition', scope: 'New two-story, 5,564 sq ft expansion to an existing 11,810 sq ft warehouse and office building, including civil and landscape work.', url: 'https://data.mesaaz.gov/resource/m2kk-w2hz.json?permit_number=PMT26-09422', parent_key: 'sample:89th' }),
].map((o) => ({ ...o, tags: deriveTags(o) }));

export const DEMO_PROFILE = {
  business_name: 'Sample Contractor Co. (demo)', contact_name: 'Alex Sample', phone: '(480) 555-0100', license_number: null, license_classes: [],
  jurisdictions: ['mesa', 'scottsdale', 'phoenix'], zips: [], min_value: null, max_value: null, certifications: [], rate_card: [],
  capability_blurb: 'Family-run crew serving the East Valley. This is demo text; your real profile fills this in.', bonding_limit: null, insurance_limit: null, feedback_weights: {},
};

export function demoDigest(tradeId) {
  const profile = { ...DEMO_PROFILE, trades: [tradeId] };
  const evals = SAMPLE_OPPS.map((opp) => ({ opp, eval: evaluate(profile, opp, { now: SNAPSHOT_NOW }) }));
  const picked = selectForDigest(evals, { maxItems: 5, deliverMin: 50 });
  const considered = evals.length;
  const excluded = evals.filter((e) => !e.eval.eligible).length;
  return { profile, items: picked.map((p) => ({ opp: p.opp, eval: p.eval, matchId: p.opp.id })), considered, excluded };
}

export function demoKit(tradeId, oppId) {
  const opp = SAMPLE_OPPS.find((o) => o.id === oppId);
  if (!opp) return null;
  const profile = { ...DEMO_PROFILE, trades: [tradeId] };
  const ev = evaluate(profile, opp, { now: SNAPSHOT_NOW });
  return { opp, profile, eval: ev, email: introEmail(profile, opp), script: callScript(profile, opp), cap: capabilityStatement(profile), proposal: proposalDraft(profile, opp), forms: formsChecklist(profile, opp) };
}

/** Plans shown when the database is not reachable. Mirrors the seeded rows; the admin screen edits the real ones. */
export const DEFAULT_PLANS = [
  { id: 'starter', name: 'Starter', price_cents: 2900, trade_group_limit: 1, area_limit: 1, trial_days: 14, features: { digest: true, eligibility: true, kit: false, pipeline: false, reminders: false } },
  { id: 'pro', name: 'Pro', price_cents: 4900, trade_group_limit: 3, area_limit: 2, trial_days: 14, features: { digest: true, eligibility: true, kit: true, pipeline: true, reminders: true } },
];
