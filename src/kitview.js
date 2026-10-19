import { h, each, when } from './html.js';
import { checklistList } from './views.js';

/** The response kit, shared by the public demo (sample data) and the signed-in app. All text comes from kit.js templates. */
export function kitSections({ kit, demo = false, icsHref = null, capHref = null }) {
  const { email, script, cap, proposal, forms } = kit;
  const missing = [...new Set([...(email.missing || []), ...(proposal.missing || [])])];
  return h`
<div class="notice">${demo ? 'Demo: this kit is built from a sample profile and a sample record. ' : ''}These are drafts for you to read, edit and send yourself. <b>BuildSignal never submits a bid or sends a message for you.</b> Anything in [brackets] is something you still need to fill in.</div>
${when(missing.length > 0, h`<div class="notice warn" style="margin-top:10px"><b>Missing from your profile:</b> ${missing.join(', ')}. ${demo ? '' : h`<a href="/app/settings">Add them in Settings</a>.`}</div>`)}
<details open><summary>1. Draft intro email</summary>
<p class="small muted">Subject: <b>${email.subject}</b></p><pre class="draft">${email.body}</pre></details>
<details><summary>2. Call script</summary>
<ol>${each(script.steps, (s) => h`<li>${s}</li>`)}</ol><pre class="draft">${script.voicemail}</pre></details>
<details><summary>3. Capability statement</summary>
<h3>${cap.title}</h3><p class="small muted">${cap.contact}</p>
${each(cap.sections, (s) => h`<p><b>${s.h}.</b> ${s.p || h`<span class="muted">[not entered yet]</span>`}</p>`)}
${when(capHref, h`<p><a class="btn sm alt" href="${capHref}">Open print-ready page (save as PDF)</a></p>`)}</details>
<details><summary>4. Draft proposal (from your rate card)</summary>
<pre class="draft">${proposal.text}</pre></details>
<details><summary>5. Forms and documents checklist</summary>
<div class="scroll"><table class="t"><thead><tr><th>Item</th><th>Status</th><th>Note</th></tr></thead><tbody>${each(forms, (f) => h`<tr><td>${f.item}</td><td>${f.status}</td><td>${f.note}</td></tr>`)}</tbody></table></div></details>
${when(icsHref, h`<p><a class="btn sm" href="${icsHref}">Add to calendar (.ics)</a></p>`)}`;
}

export function capabilityPage(cap, { demo = false } = {}) {
  return h`<div class="wrap narrow" style="padding-top:20px">
<p class="notice noprint">${demo ? 'Sample capability statement. ' : ''}To save as PDF, use your browser's Share or Print menu and choose "Save as PDF". Check every line before you send it; license details are self-reported.</p>
<h1>${cap.title}</h1><p class="muted">${cap.contact}</p>
${each(cap.sections.filter((s) => s.p), (s) => h`<h2>${s.h}</h2><p>${s.p}</p>`)}
${when(cap.missing.length > 0, h`<p class="small muted noprint">Not shown because it is empty: ${cap.missing.join(', ')}.</p>`)}
</div>`;
}

export { checklistList };
