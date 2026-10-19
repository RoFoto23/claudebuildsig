/** Minimal safe HTML templating. Everything interpolated through `h` is escaped unless wrapped with raw(). */
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => MAP[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s ?? ''));

const render = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v));

/** Tagged template: h`<p>${userText}</p>` escapes userText; nested h`` results and raw() pass through. */
export function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Raw(out);
}

export const when = (cond, tpl) => (cond ? tpl : raw(''));
export const each = (arr, fn) => raw((arr || []).map((x, i) => render(fn(x, i))).join(''));
export const toStr = (v) => (v instanceof Raw ? v.s : String(v));

/** Only http(s) links are ever put in an href. Anything else (javascript:, data:, relative) becomes '#'. */
export const safeHref = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '#');
export const hostOf = (u) => { try { return new URL(String(u)).hostname; } catch { return ''; } };
/** One plain sentence telling the reader a forwarded item came from their own email, with the date exactly as the email wrote it. */
export function forwardedLine(opp) {
  if (!opp?.owner_account_id) return '';
  const also = (opp.also_seen_via || []).length ? ` Also seen via ${opp.also_seen_via.join(', ')}.` : '';
  const d = opp.provenance?.deadline;
  if (d?.source === 'staff' || opp.provenance?.title?.source === 'staff') return `From an email you forwarded. We could not read it automatically, so BuildSignal staff typed in the details. Please confirm them against your original email.${also}`;
  return `From an email you forwarded.${d?.quote ? ` Deadline as written there: \u201C${d.quote}\u201D.` : ''}${also}`;
}
export function linkLabel(opp) {
  if (opp?.owner_account_id) { const host = hostOf(opp.url); return host ? `Link from your forwarded email (${host})` : 'Link from your forwarded email'; }
  return `Official record${opp?.is_sample ? ' (sample snapshot)' : ''}`;
}
