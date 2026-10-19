/**
 * Supabase PostgREST client built on fetch (no dependencies).
 * Filter spec: { col: value | { eq, neq, gt, gte, lt, lte, in: [...], isnull: true|false, like } }
 */
const enc = encodeURIComponent;

function lit(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function inList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')})`;
}

export function buildFilters(where = {}) {
  const params = [];
  for (const [col, spec] of Object.entries(where)) {
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, val] of Object.entries(spec)) {
        if (op === 'in') params.push(`${enc(col)}=in.${enc(inList(val))}`);
        else if (op === 'isnull') params.push(`${enc(col)}=${val ? 'is.null' : 'not.is.null'}`);
        else if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like'].includes(op)) params.push(`${enc(col)}=${op}.${enc(lit(val))}`);
        else throw new Error(`unsupported filter operator: ${op}`);
      }
    } else if (spec === null) params.push(`${enc(col)}=is.null`);
    else params.push(`${enc(col)}=eq.${enc(lit(spec))}`);
  }
  return params;
}

export function createPostgrest({ url, key, fetchImpl = fetch, timeoutMs = 20000 }) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });

  async function call(path, { method = 'GET', body, prefer, extra } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: headers({ ...(prefer ? { Prefer: prefer } : {}), ...(extra || {}) }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`postgrest ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.code = (() => { try { return JSON.parse(text).code; } catch { return undefined; } })();
      throw err;
    }
    return { res, data: text ? JSON.parse(text) : null };
  }

  return {
    kind: 'postgrest',
    async select(table, { where = {}, columns = '*', order, limit, offset } = {}) {
      const p = [`select=${enc(columns)}`, ...buildFilters(where)];
      if (order) p.push(`order=${enc(order)}`);
      if (limit) p.push(`limit=${limit}`);
      if (offset) p.push(`offset=${offset}`);
      return (await call(`/${table}?${p.join('&')}`)).data || [];
    },
    async one(table, opts) {
      const rows = await this.select(table, { ...opts, limit: 1 });
      return rows[0] || null;
    },
    async count(table, where = {}) {
      const p = ['select=*', ...buildFilters(where)];
      const { res } = await call(`/${table}?${p.join('&')}`, { prefer: 'count=exact', extra: { Range: '0-0', 'Range-Unit': 'items' } });
      const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
      return m ? Number(m[1]) : 0;
    },
    async insert(table, rows, { ignoreDuplicates = false, onConflict } = {}) {
      const arr = Array.isArray(rows) ? rows : [rows];
      if (!arr.length) return [];
      const q = onConflict ? `?on_conflict=${enc(onConflict)}` : '';
      const prefer = ignoreDuplicates ? 'return=representation,resolution=ignore-duplicates' : 'return=representation';
      return (await call(`/${table}${q}`, { method: 'POST', body: arr, prefer })).data || [];
    },
    async upsert(table, rows, { onConflict }) {
      const arr = Array.isArray(rows) ? rows : [rows];
      if (!arr.length) return [];
      return (await call(`/${table}?on_conflict=${enc(onConflict)}`, { method: 'POST', body: arr, prefer: 'return=representation,resolution=merge-duplicates' })).data || [];
    },
    async update(table, where, patch) {
      const p = buildFilters(where);
      if (!p.length) throw new Error('refusing update without a filter');
      return (await call(`/${table}?${p.join('&')}`, { method: 'PATCH', body: patch, prefer: 'return=representation' })).data || [];
    },
    async delete(table, where) {
      const p = buildFilters(where);
      if (!p.length) throw new Error('refusing delete without a filter');
      return (await call(`/${table}?${p.join('&')}`, { method: 'DELETE', prefer: 'return=representation' })).data || [];
    },
    async rpc(fn, args = {}) {
      return (await call(`/rpc/${fn}`, { method: 'POST', body: args })).data;
    },
  };
}
