import { h, each } from './html.js';

const REVIEW = h`<div class="notice bad"><b>ATTORNEY REVIEW REQUIRED.</b> This is a plain-language draft written by the product team, not legal advice. It has not been reviewed by a lawyer and should not be relied on until it has been.</div>`;

export function termsPage(c) {
  const s = [
    ['What the service is', `${c.brand} is an information service. It reads public records and published solicitations, ranks them against the profile you enter, and gives you editable drafts. It is not a bidding agent, a broker, a marketplace or a source of legal, accounting or contracting advice.`],
    ['You stay in control of every bid', `${c.brand} never submits a bid, proposal or message for you. Under Arizona law (see A.R.S. §§ 32-1101 and 32-1151) submitting a bid is acting as a contractor, so you review everything and submit it yourself under your own license. You are responsible for the accuracy of anything you send, for your licensing, bonding and insurance, and for following each agency's rules.`],
    ['No guarantee of work', `Public records show what has been filed, not who will be hired, and they can be late, incomplete or wrong. Permit values are not contract prices. We do not promise leads, wins or revenue, and a listed project may already be awarded.`],
    ['Self-reported details', `License numbers, classifications, certifications, bonding and insurance are what you typed. They are shown as unverified unless you confirm them on the official Arizona Registrar of Contractors lookup. Drafts only use information you entered.`],
    ['Subscription', `Plans are billed monthly through Stripe. Each plan starts with a free trial. If a card is required, it is charged the plan price when the trial ends unless you cancel first. You can pause or cancel at any time from Settings (one click, through the billing portal); access continues to the end of the period you paid for. Prices are shown on the pricing page and may change with notice before your next renewal.`],
    ['Your content', `You own the profile, rate card and notes you enter. We use them only to run the service for you. We do not use your data to train AI models. You can export or delete your data from Settings.`],
    ['Acceptable use', `Do not scrape or resell the service, attempt to bypass limits, or use drafts to misrepresent your qualifications. We may suspend accounts that do.`],
    ['Liability', `The service is provided "as is". To the extent the law allows, our liability is limited to the amount you paid in the last three months. [Attorney to confirm limits, governing law for Arizona, and dispute terms.]`],
  ];
  return h`<div class="wrap narrow"><h1>Terms of Service</h1>${REVIEW}${each(s, ([t, p]) => h`<h2>${t}</h2><p>${p}</p>`)}<p class="small muted">Draft v0.1. Questions: reply to any ${c.brand} email.</p></div>`;
}

export function privacyPage(c) {
  const s = [
    ['What we collect', `Your email; the business profile you enter (business name, contact name, phone, trades, service area, ZIP codes, job-size range, license number and classes, certifications, optional bonding and insurance limits, rate card, capability blurb); your taps on digest items (Interested, Not for me, Already knew) and pipeline updates; email delivery and open events; and, if you are on the waitlist, the email, trade and ZIP you gave us. Payment details are handled by Stripe and never touch our servers.`],
    ['What we do not collect', `No homeowner contact data, no property-owner names, no data-broker or people-search enrichment, and no portal passwords. We do not use advertising trackers.`],
    ['How we use it', `To match opportunities to you, send your digests and reminders, build your drafts, run billing, prevent abuse and improve the ranking from your own taps. Email opens are measured with a small image; some mail apps load it automatically, so open counts are approximate.`],
    ['AI and training', `The current matching is rule-based. If AI models are added to read solicitation documents, your profile and uploads will not be used to train models, and documents will be treated as untrusted text.`],
    ['Forwarded alert emails (only if you use this feature)', `If you forward bid-alert emails to your private BuildSignal address, we store each email's subject and text for 30 days, then delete that content. We read them with fixed rules. We never open links in them or download attachments. Emails the rules cannot read may be reviewed by BuildSignal staff, who can see their text, so that we can add the bid for you. If an AI service is switched on for unreadable emails, the email text is sent to that provider only to extract the title, dates and link; we do not use your data to train models, and we will name the provider here before it is switched on. [Attorney and owner to confirm the chosen provider's terms before enabling.] Items extracted from your emails are shown only to you.`],
    ['Who sees it', `Service providers that run the product for us: our hosting provider, database provider, email sender and payment processor (Stripe). We do not sell your data.`],
    ['Retention, export, deletion', `You can export your data as a file and delete your account in Settings; deletion removes your profile, matches and login records. Billing records may be kept as required for tax and accounting. Waitlist emails can be removed by replying to any message.`],
    ['Email', `Marketing-type messages (digests, reminders) include a one-tap unsubscribe and our mailing address. Account and billing messages may still be sent.`],
    ['Contact', `Reply to any ${c.brand} email. [Attorney to add legal entity name, address and any state-specific rights language.]`],
  ];
  return h`<div class="wrap narrow"><h1>Privacy Policy</h1>${REVIEW}${each(s, ([t, p]) => h`<h2>${t}</h2><p>${p}</p>`)}<p class="small muted">Draft v0.1.</p></div>`;
}

export function refundPage(c) {
  const s = [
    ['Free trial', `Every plan starts with a free trial. Cancel before it ends and you are not charged.`],
    ['Cancel or pause', `Cancel or pause in one click from Settings. No call, no form.`],
    ['Refunds', `If you were charged and you tell us within 7 days of the charge that the service was not usable, we will refund that charge. We review other requests case by case. Refunds go back to the original card through Stripe. [Attorney to confirm.]`],
    ['What a refund does not cover', `Work you did or did not win. ${c.brand} does not guarantee any job, and a record that turns out to be already awarded is not a billing error.`],
  ];
  return h`<div class="wrap narrow"><h1>Refund Policy</h1>${REVIEW}${each(s, ([t, p]) => h`<h2>${t}</h2><p>${p}</p>`)}<p class="small muted">Draft v0.1.</p></div>`;
}
