/**
 * Ingestion: normalize -> dedupe -> version -> upsert, plus source health assessment.
 * Idempotent: running the same batch twice changes nothing the second time.
 */
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const SNAP_FIELDS = ['title', 'stage', 'status', 'value', 'sqft', 'units', 'deadline', 'scope', 'gc_name', 'applicant', 'issued_date', 'url'];

export async function upsertOpportunities(store, items, now = new Date()) {
  const stats = { seen: items.length, inserted: 0, changed: 0, unchanged: 0 };
  if (!items.length) return stats;
  const nowIso = now.toISOString();
  const bySource = new Map();
  for (const it of items) (bySource.get(it.source) || bySource.set(it.source, []).get(it.source)).push(it);

  for (const [source, list] of bySource) {
    const existing = new Map();
    for (const ids of chunk(list.map((i) => i.source_id), 80)) {
      const rows = await store.select('opportunities', { where: { source, source_id: { in: ids } }, columns: 'id,source_id,fingerprint,version,status' });
      for (const r of rows) existing.set(r.source_id, r);
    }
    const toInsert = [];
    const unchangedIds = [];
    for (const it of list) {
      const prev = existing.get(it.source_id);
      if (!prev) {
        toInsert.push({ ...it, version: 1, first_seen: nowIso, last_seen: nowIso });
      } else if (prev.fingerprint !== it.fingerprint) {
        const version = prev.version + 1;
        const { fingerprint, ...rest } = it;
        await store.update('opportunities', { id: prev.id }, { ...rest, fingerprint, version, last_seen: nowIso, changed_at: nowIso });
        await store.insert('opportunity_versions', { opportunity_id: prev.id, version, fingerprint, snapshot: Object.fromEntries(SNAP_FIELDS.map((f) => [f, it[f] ?? null])) }, { ignoreDuplicates: true });
        stats.changed++;
      } else {
        unchangedIds.push(prev.id);
        stats.unchanged++;
      }
    }
    for (const part of chunk(toInsert, 100)) {
      const created = await store.insert('opportunities', part, { ignoreDuplicates: true });
      stats.inserted += created.length;
      if (created.length) await store.insert('opportunity_versions', created.map((c) => ({ opportunity_id: c.id, version: 1, fingerprint: c.fingerprint, snapshot: Object.fromEntries(SNAP_FIELDS.map((f) => [f, c[f] ?? null])) })), { ignoreDuplicates: true });
    }
    for (const ids of chunk(unchangedIds, 40)) await store.update('opportunities', { id: { in: ids } }, { last_seen: nowIso });
  }
  return stats;
}

/**
 * Pure health rule. Returns the next source_config fields and whether to alert the owner.
 * Failure = error, zero items, or a count far below the learned baseline. Three failures in a row auto-disable.
 */
export function assessHealth(cfg, { count, error, rateLimited = false }, now = new Date()) {
  const base = Number(cfg.baseline_count) || 0;
  let problem = null;
  if (error) problem = rateLimited ? 'rate limited' : `error: ${String(error).slice(0, 160)}`;
  else if (count === 0) problem = 'zero items returned';
  else if (base >= 20 && count < base * 0.2) problem = `count anomaly (${count} vs usual ${Math.round(base)})`;

  const patch = { last_run_at: now.toISOString(), last_count: count ?? null, updated_at: now.toISOString() };
  if (!problem) {
    return { patch: { ...patch, last_ok_at: now.toISOString(), last_error: null, consecutive_failures: 0, baseline_count: Math.round((base ? base * 0.7 + count * 0.3 : count) * 10) / 10 }, alert: false, problem: null };
  }
  const failures = rateLimited ? cfg.consecutive_failures || 0 : (cfg.consecutive_failures || 0) + 1;
  const autoDisable = failures >= 3;
  return {
    patch: { ...patch, last_error: problem, consecutive_failures: failures, ...(autoDisable ? { enabled: false, auto_disabled: true } : {}) },
    alert: autoDisable || (!rateLimited && failures === 1),
    problem,
    autoDisabled: autoDisable,
  };
}
