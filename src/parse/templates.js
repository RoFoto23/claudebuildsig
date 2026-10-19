/**
 * Tier 1: sender-specific templates. INTENTIONALLY EMPTY.
 * No real BidNet, Arizona Procurement Portal, PlanHub or BuildingConnected alert has been inspected, and a layout
 * must never be guessed. A template is added only after real forwarded samples exist, and it must pass the
 * evaluation set (docs/inbox-detailed-design.md section 9) before it is enabled.
 *
 * Shape: { id, matches(fromDomain, subject, text) -> boolean, extract({ subject, text, receivedAt }) -> item[] }
 * Items use the same shape as rules.js; verify.js still checks every quote.
 */
export const TEMPLATES = [];
