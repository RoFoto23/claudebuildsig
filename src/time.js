/** Arizona is UTC-7 all year (no daylight saving), so "Arizona time" is simple and stable. */
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' });
const dowFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short' });

export const azDate = (now = new Date()) => fmt.format(now); // YYYY-MM-DD
export const azDow = (now = new Date()) => dowFmt.format(now); // Mon, Tue, ...
export const azMonth = (now = new Date()) => azDate(now).slice(0, 7);

export function fmtAz(iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix', ...opts });
}

export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** Page through a table past PostgREST's default 1000-row cap. */
export async function selectAll(store, table, opts = {}, pageSize = 1000, maxRows = 20000) {
  const out = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const rows = await store.select(table, { ...opts, limit: pageSize, offset });
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
