import { extractByRules } from './rules.js';
import { verifyItems } from './verify.js';
import { extractByAi } from './ai.js';
import { TEMPLATES } from './templates.js';

/**
 * Three tiers, cheapest first: sender templates, generic rules, then the model (only when rules found no
 * item or no item with a deadline, and only when the spend cap allows). Every tier's output is verified
 * against the message before it is returned.
 *
 * @returns {Promise<{ items: object[], method: 'template'|'rules'|'ai'|'none', confidence: number, notes: string[], dropped: string[], ai?: string }>}
 */
export async function parseMessage({ subject = '', text = '', fromDomain = '', receivedAt = null }, { llm = null, messageId = null, accountId = null, maxChars = 20000 } = {}) {
  const corpus = `${subject}\n${text}`;
  const notes = [];
  const dropped = [];

  for (const tpl of TEMPLATES) {
    if (!tpl.matches(fromDomain, subject, text)) continue;
    const v = verifyItems(tpl.extract({ subject, text, receivedAt }), corpus);
    if (v.items.length) return { items: v.items, method: 'template', confidence: Math.max(...v.items.map((i) => i.confidence)), notes: [`template ${tpl.id}`], dropped: v.dropped };
  }

  const rules = extractByRules({ subject, text, receivedAt });
  notes.push(...rules.notes);
  const rv = verifyItems(rules.items, corpus);
  dropped.push(...rv.dropped);
  let items = rv.items;
  let method = items.length ? 'rules' : 'none';

  const needAi = items.length === 0 || items.every((i) => !i.deadline);
  let aiOutcome;
  if (needAi && llm) {
    const avail = await llm.available();
    if (avail.ok) {
      const ai = await extractByAi({ subject, text, llm, messageId, accountId, maxChars });
      aiOutcome = ai.outcome;
      dropped.push(...ai.dropped);
      if (ai.items.length) { items = ai.items; method = 'ai'; }
    } else {
      aiOutcome = `unavailable:${avail.reason}`;
    }
  }
  const confidence = items.length ? Math.max(...items.map((i) => i.confidence)) : 0;
  return { items, method, confidence, notes, dropped, ...(aiOutcome ? { ai: aiOutcome } : {}) };
}
