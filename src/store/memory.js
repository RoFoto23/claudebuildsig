import { randomUUID } from 'node:crypto';

/** In-memory store with the same interface as the PostgREST client. Used by tests and the local dev server. */
const UNIQUE = {
  accounts: [['email'], ['stripe_customer_id'], ['referral_code']],
  opportunities: [['source', 'source_id']],
  matches: [['account_id', 'opportunity_id']],
  digests: [['digest_key']],
  outbox: [['idempotency_key']],
  leads: [['email']],
  job_runs: [['job', 'run_key']],
  login_tokens: [['token_hash']],
  plans: [['id']],
  settings: [['key']],
  source_config: [['source']],
  profiles: [['account_id']],
  suppressions: [['email']],
  stripe_events: [['id']],
  admin_totp: [['account_id']],
  opportunity_versions: [['opportunity_id', 'version']],
  inbox_addresses: [['local_part']],
  inbound_messages: [['provider_email_id']],
};
const UUID_TABLES = new Set(['accounts', 'opportunities', 'matches', 'digests', 'outbox', 'leads', 'job_runs', 'opportunity_versions', 'inbox_addresses', 'inbound_messages', 'llm_calls']);
const SERIAL_TABLES = new Set(['events', 'audit_log']);
const DEFAULTS = {
  accounts: () => ({ role: 'customer', status: 'active', session_epoch: 1, marketing_consent: false, digest_paused: false, billing_status: 'none', cancel_at_period_end: false }),
  profiles: () => ({ trades: [], jurisdictions: [], zips: [], license_classes: [], certifications: [], digest_frequency: 'daily', channel: 'email', rate_card: [], feedback_weights: {} }),
  opportunities: () => ({ tags: [], version: 1, status: 'active', is_sample: false, owner_account_id: null, provenance: null, also_seen_via: [] }),
  matches: () => ({ factors: [], checklist: [], action: 'none', reminders_sent: [] }),
  outbox: () => ({ status: 'queued' }),
  job_runs: () => ({ status: 'running', stats: {} }),
  source_config: () => ({ enabled: false, consecutive_failures: 0, auto_disabled: false }),
  plans: () => ({ active: true, trial_days: 14, features: {} }),
  events: () => ({ props: {} }),
  audit_log: () => ({ detail: {} }),
  leads: () => ({ consent: false }),
  inbound_messages: () => ({ status: 'received', attempts: 0, kind: 'alert', opportunity_ids: [], parse_method: null, confidence: null, next_attempt_at: null, error: null }),
};

function matches(row, where) {
  for (const [col, spec] of Object.entries(where || {})) {
    const v = row[col];
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, val] of Object.entries(spec)) {
        if (op === 'eq' && !(v === val)) return false;
        if (op === 'neq' && v === val) return false;
        if (op === 'gt' && !(v > val)) return false;
        if (op === 'gte' && !(v >= val)) return false;
        if (op === 'lt' && !(v < val)) return false;
        if (op === 'lte' && !(v <= val)) return false;
        if (op === 'in' && !val.includes(v)) return false;
        if (op === 'isnull' && (v === null || v === undefined) !== val) return false;
        if (op === 'like' && !new RegExp('^' + String(val).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(v ?? ''))) return false;
      }
    } else if (spec === null) {
      if (v !== null && v !== undefined) return false;
    } else if (v !== spec) return false;
  }
  return true;
}

export function createMemoryStore({ now = () => new Date() } = {}) {
  const t = {};
  let serial = 1;
  const tab = (name) => (t[name] ||= []);
  const clone = (x) => (x === undefined ? x : structuredClone(x));

  function fill(table, row) {
    const r = { ...(DEFAULTS[table]?.() || {}), ...clone(row) };
    if (UUID_TABLES.has(table) && !r.id) r.id = randomUUID();
    if (SERIAL_TABLES.has(table) && !r.id) r.id = serial++;
    for (const c of ['created_at', 'ts', 'first_seen', 'last_seen', 'updated_at']) {
      const has = {
        created_at: ['accounts', 'login_tokens', 'digests', 'matches', 'outbox', 'suppressions', 'leads', 'opportunity_versions', 'inbox_addresses', 'llm_calls'],
        ts: ['events', 'audit_log'], first_seen: ['opportunities'], last_seen: ['opportunities'], updated_at: ['profiles', 'plans', 'source_config', 'settings'],
      }[c];
      if (has.includes(table) && !r[c]) r[c] = now().toISOString();
    }
    if (table === 'inbound_messages') {
      r.received_at ||= now().toISOString();
      r.expires_at ||= new Date(now().getTime() + 30 * 86400000).toISOString();
    }
    return r;
  }

  function conflictFor(table, row) {
    for (const cols of UNIQUE[table] || []) {
      if (cols.every((c) => row[c] !== undefined && row[c] !== null)) {
        const hit = tab(table).find((x) => cols.every((c) => x[c] === row[c]));
        if (hit) return { hit, cols };
      }
    }
    return null;
  }

  const api = {
    kind: 'memory',
    _tables: t,
    async select(table, { where = {}, columns = '*', order, limit, offset = 0 } = {}) {
      let rows = tab(table).filter((r) => matches(r, where));
      if (order) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      rows = rows.slice(offset, limit ? offset + limit : undefined).map(clone);
      if (columns !== '*') {
        const keep = columns.split(',').map((c) => c.trim());
        rows = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k]])));
      }
      return rows;
    },
    async one(table, opts) {
      return (await api.select(table, { ...opts, limit: 1 }))[0] || null;
    },
    async count(table, where = {}) {
      return tab(table).filter((r) => matches(r, where)).length;
    },
    async insert(table, rows, { ignoreDuplicates = false } = {}) {
      const out = [];
      for (const raw of Array.isArray(rows) ? rows : [rows]) {
        const r = fill(table, raw);
        const c = conflictFor(table, r);
        if (c) {
          if (ignoreDuplicates) continue;
          const e = new Error(`duplicate key on ${table} (${c.cols.join(',')})`);
          e.status = 409;
          e.code = '23505';
          throw e;
        }
        tab(table).push(r);
        out.push(clone(r));
      }
      return out;
    },
    async upsert(table, rows, { onConflict }) {
      const cols = onConflict.split(',').map((s) => s.trim());
      const out = [];
      for (const raw of Array.isArray(rows) ? rows : [rows]) {
        const hit = tab(table).find((x) => cols.every((c) => x[c] === raw[c]));
        if (hit) {
          Object.assign(hit, clone(raw));
          out.push(clone(hit));
        } else {
          const r = fill(table, raw);
          tab(table).push(r);
          out.push(clone(r));
        }
      }
      return out;
    },
    async update(table, where, patch) {
      if (!Object.keys(where).length) throw new Error('refusing update without a filter');
      const rows = tab(table).filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, clone(patch));
      return rows.map(clone);
    },
    async delete(table, where) {
      if (!Object.keys(where).length) throw new Error('refusing delete without a filter');
      const gone = tab(table).filter((r) => matches(r, where));
      t[table] = tab(table).filter((r) => !gone.includes(r));
      // emulate ON DELETE CASCADE for the account graph
      if (table === 'accounts') {
        for (const a of gone) {
          for (const child of ['profiles', 'login_tokens', 'digests', 'matches', 'admin_totp', 'inbox_addresses', 'inbound_messages']) t[child] = tab(child).filter((r) => (r.account_id ?? r.id) !== a.id);
          t.opportunities = tab('opportunities').filter((o) => o.owner_account_id !== a.id);
          for (const c of tab('llm_calls')) if (c.account_id === a.id) c.account_id = null; // history is kept, like ON DELETE SET NULL
        }
      }
      return gone.map(clone);
    },
    async rpc(fn, args = {}) {
      if (fn === 'rl_hit') {
        const row = tab('rate_limits').find((r) => r.key === args.p_key && r.window_start === args.p_window);
        if (row) return ++row.count;
        tab('rate_limits').push({ key: args.p_key, window_start: args.p_window, count: 1 });
        return 1;
      }
      if (fn === 'claim_job') {
        if (tab('job_runs').some((r) => r.job === args.p_job && r.run_key === args.p_key)) return false;
        tab('job_runs').push(fill('job_runs', { job: args.p_job, run_key: args.p_key, started_at: now().toISOString() }));
        return true;
      }
      if (fn === 'join_waitlist') {
        const e = String(args.p_email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'invalid';
        if (!args.p_consent) return 'consent_required';
        if (!tab('leads').some((l) => l.email === e)) tab('leads').push(fill('leads', { email: e, trade: args.p_trade, zip: args.p_zip, consent: true, source: args.p_source }));
        return 'ok';
      }
      if (fn === 'log_event') {
        tab('events').push(fill('events', { name: args.p_name, anon_id: args.p_anon, props: args.p_props }));
        return null;
      }
      throw new Error(`unknown rpc ${fn}`);
    },
  };
  return api;
}
