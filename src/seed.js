import { DEFAULT_PLANS } from './sample.js';

/** Seeds an in-memory store the same way the database migration seeds Postgres. Used by tests and the local dev server. */
export async function seedMemory(store) {
  await store.insert('plans', DEFAULT_PLANS.map((p) => ({ ...p })));
  await store.insert('source_config', [
    { source: 'mesa_permits', label: 'City of Mesa building permits (open data)', terms_url: 'https://data.mesaaz.gov/stories/s/Terms-of-Use-page/2dcd-j2nx/' },
    { source: 'phoenix_permits', label: 'City of Phoenix current permits (ArcGIS)', terms_url: 'https://maps.phoenix.gov/pub/rest/services/Public/Planning_Permit/MapServer/1' },
    { source: 'sam_gov', label: 'SAM.gov Opportunities API (federal)', terms_url: 'https://open.gsa.gov/api/get-opportunities-public-api/' },
  ]);
  await store.insert('settings', [
    { key: 'scoring_weights', value: { fit: 30, timing: 25, scale: 15, access: 15, evidence: 15 } },
    { key: 'thresholds', value: { max_items: 5, urgent_min: 80, deliver_min: 50, freshness_days: 45 } },
    { key: 'email_unit_cost_cents', value: 0.1 },
    { key: 'inbox.enabled', value: false },
    { key: 'inbox.daily_limit', value: 40 },
    { key: 'inbox.max_chars', value: 20000 },
    { key: 'inbox.parse_threshold', value: 0.6 },
    { key: 'llm.enabled', value: false },
  ]);
}
