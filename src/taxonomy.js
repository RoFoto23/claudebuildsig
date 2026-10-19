/**
 * Canonical vocabularies shared by the UI, the matching rules and the tests.
 * ROC license classifications are intentionally NOT mapped here: the official ROC list could not be
 * verified when this was built (see docs/DECISIONS.md D-07). License classes are self-reported free text.
 */

export const JURISDICTIONS = {
  mesa: { id: 'mesa', label: 'Mesa' },
  phoenix: { id: 'phoenix', label: 'Phoenix' },
  scottsdale: { id: 'scottsdale', label: 'Scottsdale' },
  maricopa_county: { id: 'maricopa_county', label: 'Unincorporated Maricopa County' },
  tempe: { id: 'tempe', label: 'Tempe' },
  chandler: { id: 'chandler', label: 'Chandler' },
  gilbert: { id: 'gilbert', label: 'Gilbert' },
  glendale: { id: 'glendale', label: 'Glendale' },
  peoria: { id: 'peoria', label: 'Peoria' },
  statewide: { id: 'statewide', label: 'Statewide / federal' },
};
export const JURISDICTION_IDS = Object.keys(JURISDICTIONS);
/** Jurisdictions with a live data source adapter today. */
export const COVERED_JURISDICTIONS = ['mesa', 'phoenix'];

export const CERTIFICATIONS = {
  small_business: 'Small business',
  dbe: 'DBE (disadvantaged business enterprise)',
  veteran_owned: 'Veteran-owned',
  woman_owned: 'Woman-owned',
  minority_owned: 'Minority-owned',
  sdvosb: 'Service-disabled veteran-owned',
  hubzone: 'HUBZone',
  eight_a: '8(a)',
};

export const STAGES = {
  planning: 'Planning / pre-application',
  in_review: 'Plan review',
  issued: 'Permit issued',
  active: 'Open / active',
  open_bid: 'Open for bids',
  completed: 'Completed',
  other: 'Other',
};

export const TRADE_GROUPS = {
  site_structure: { id: 'site_structure', label: 'Site and structure' },
  envelope_finish: { id: 'envelope_finish', label: 'Envelope and finishes' },
  mep: { id: 'mep', label: 'Electrical, plumbing and mechanical' },
  services: { id: 'services', label: 'Service businesses' },
};

/**
 * Each trade: NAICS (U.S. Census NAICS 2022 codes), CSI MasterFormat division where one applies,
 * and weighted text signals used by the deterministic fit rule. `signals` are matched against the
 * project's scope text, work type and title (lowercased). `negative` signals subtract.
 * `stageBias` nudges timing (the best moment to call differs by trade).
 */
export const TRADES = {
  roll_off: {
    id: 'roll_off', label: 'Roll-off dumpsters and construction hauling', group: 'services',
    naics: ['562111', '562119'], csi: ['01 74 19'],
    keywords: ['dumpster', 'roll-off', 'hauling', 'debris'],
    signals: [
      [/demoli|wrecking|tear.?down|gut(ting)?\b/, 30, 'demolition work'],
      [/new (building|construction)|ground.?up|shell\b/, 24, 'new construction'],
      [/addition|expansion|build.?out/, 16, 'building expansion'],
      [/tenant improvement|remodel|renovat|conversion/, 14, 'interior remodel or conversion'],
      [/multi.?family|apartment|dwelling units|\d+.?unit/, 12, 'multifamily scale'],
      [/warehouse|industrial|manufactur/, 8, 'industrial scale'],
    ],
    negative: [[/sign\b|signage|alarm only|inspection only|solar|photovoltaic|electric(al)? only/, 30, 'scope has little debris']],
  },
  demolition: {
    id: 'demolition', label: 'Demolition', group: 'site_structure',
    naics: ['238910'], csi: ['02 41 00'], keywords: ['demolition', 'wrecking', 'abatement'],
    signals: [
      [/demoli|wrecking|tear.?down/, 55, 'demolition scope'],
      [/gut(ting)?\b|strip.?out|remove existing/, 30, 'strip-out scope'],
      [/tenant improvement|remodel|renovat|conversion/, 18, 'interior remodel (selective demolition)'],
    ],
    negative: [[/sign\b|signage|solar|photovoltaic/, 30, 'scope has no demolition']],
  },
  concrete: {
    id: 'concrete', label: 'Concrete and flatwork', group: 'site_structure',
    naics: ['238110'], csi: ['03 30 00'], keywords: ['concrete', 'slab', 'foundation', 'flatwork'],
    signals: [
      [/foundation|footing|slab|concrete|flatwork|curb|sidewalk|stem wall/, 45, 'concrete scope'],
      [/new (building|construction)|ground.?up|shell\b/, 28, 'new construction (foundations)'],
      [/addition|expansion/, 16, 'building addition'],
      [/parking|paving|site (work|permit)/, 14, 'site work'],
    ],
    negative: [[/tenant improvement \(interior only\)|interior only/, 20, 'interior-only work']],
  },
  framing: {
    id: 'framing', label: 'Framing and carpentry', group: 'site_structure',
    naics: ['238130', '238350'], csi: ['06 10 00'], keywords: ['framing', 'carpentry', 'wood frame'],
    signals: [
      [/multi.?family|apartment|dwelling units|\d+.?unit|type v/, 40, 'wood-frame multifamily'],
      [/new (building|construction)|ground.?up/, 28, 'new construction'],
      [/addition|expansion|build.?out|tenant improvement|partition|demising/, 18, 'framing and partition scope'],
    ],
    negative: [[/solar|photovoltaic|sign\b/, 30, 'no framing scope']],
  },
  excavation_sitework: {
    id: 'excavation_sitework', label: 'Excavation and site work', group: 'site_structure',
    naics: ['238910'], csi: ['31 20 00'], keywords: ['grading', 'excavation', 'site work', 'utilities'],
    signals: [
      [/grading|excavat|site (work|permit)|utilit(y|ies)|drainage|underground|trench/, 45, 'site work scope'],
      [/new (building|construction)|ground.?up/, 25, 'new construction'],
      [/parking|paving/, 18, 'paving and site'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 25, 'interior-only work']],
  },
  paving: {
    id: 'paving', label: 'Paving and asphalt', group: 'site_structure',
    naics: ['237310'], csi: ['32 12 00'], keywords: ['paving', 'asphalt', 'parking lot', 'striping'],
    signals: [
      [/paving|asphalt|parking (lot|area)|drive aisle|striping|pavement/, 50, 'paving scope'],
      [/new (building|construction)|ground.?up|shell\b/, 24, 'new construction (site paving)'],
      [/site (work|permit)|grading/, 16, 'site work'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 25, 'interior-only work']],
  },
  fencing: {
    id: 'fencing', label: 'Fencing and gates', group: 'site_structure',
    naics: ['238990'], csi: ['32 31 00'], keywords: ['fence', 'fencing', 'gate', 'screen wall'],
    signals: [
      [/fenc(e|ing)|gate|screen wall|enclosure|perimeter wall|bollard/, 50, 'fence or gate scope'],
      [/new (building|construction)|ground.?up|shell\b/, 22, 'new construction (site security)'],
      [/warehouse|industrial|yard|storage/, 14, 'industrial site'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 25, 'interior-only work']],
  },
  roofing: {
    id: 'roofing', label: 'Roofing', group: 'envelope_finish',
    naics: ['238160'], csi: ['07 50 00'], keywords: ['roofing', 'reroof', 'tpo', 'membrane'],
    signals: [
      [/re.?roof|roof(ing)?|tpo|membrane|shingle|tile roof|parapet/, 55, 'roof scope'],
      [/new (building|construction)|ground.?up|shell\b/, 30, 'new construction (new roof)'],
      [/addition|expansion/, 18, 'building addition (roof tie-in)'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 30, 'interior-only work']],
  },
  drywall: {
    id: 'drywall', label: 'Drywall and interior finishes', group: 'envelope_finish',
    naics: ['238310'], csi: ['09 20 00'], keywords: ['drywall', 'partition', 'ceiling', 'interior'],
    signals: [
      [/tenant improvement|build.?out|remodel|renovat|partition|demising|interior/, 40, 'interior build-out'],
      [/new (building|construction)|ground.?up|shell\b|multi.?family|\d+.?unit/, 30, 'new construction (interior finish)'],
      [/restaurant|office|medical|retail|clinic/, 10, 'commercial interior type'],
    ],
    negative: [[/solar|photovoltaic|sign\b|roof(ing)? only|exterior only/, 30, 'no interior scope']],
  },
  painting: {
    id: 'painting', label: 'Painting and coatings', group: 'envelope_finish',
    naics: ['238320'], csi: ['09 90 00'], keywords: ['painting', 'coatings', 'stucco'],
    signals: [
      [/tenant improvement|build.?out|remodel|renovat|interior/, 28, 'interior finish scope'],
      [/new (building|construction)|ground.?up|shell\b|multi.?family|\d+.?unit/, 36, 'new construction (finish painting)'],
      [/exterior|stucco|facade|repaint|restoration/, 24, 'exterior finish scope'],
    ],
    negative: [[/solar|photovoltaic|sign\b|underground|grading only/, 30, 'no finish scope']],
  },
  landscaping: {
    id: 'landscaping', label: 'Landscaping and irrigation', group: 'services',
    naics: ['561730'], csi: ['32 90 00'], keywords: ['landscape', 'irrigation', 'turf'],
    signals: [
      [/landscap|irrigation|turf|planting/, 55, 'landscape scope'],
      [/new (building|construction)|ground.?up|shell\b|multi.?family|\d+.?unit/, 32, 'new development (new landscape)'],
      [/site (work|permit)|parking/, 14, 'site work'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 30, 'interior-only work']],
  },
  electrical: {
    id: 'electrical', label: 'Electrical', group: 'mep',
    naics: ['238210'], csi: ['26 05 00'], keywords: ['electrical', 'panel', 'lighting', 'power'],
    signals: [
      [/electric|panel|switchgear|lighting|power|generator|ev charg|photovoltaic|solar/, 40, 'electrical scope'],
      [/tenant improvement|build.?out|remodel|renovat|new (building|construction)|ground.?up|shell\b/, 30, 'build-out or new construction'],
      [/mechanical, electrical|mep|struc\/mech\/elec|elec/, 14, 'combined trades permit'],
    ],
    negative: [[/demolition only|fence only|landscap/, 25, 'no electrical scope']],
  },
  plumbing: {
    id: 'plumbing', label: 'Plumbing', group: 'mep',
    naics: ['238220'], csi: ['22 05 00'], keywords: ['plumbing', 'restroom', 'water heater'],
    signals: [
      [/plumb|restroom|fixtures|water heater|backflow|sewer|grease|medical gas/, 42, 'plumbing scope'],
      [/restaurant|medical|clinic|multi.?family|\d+.?unit|dwelling units/, 22, 'plumbing-heavy building type'],
      [/tenant improvement|build.?out|remodel|renovat|new (building|construction)|ground.?up|shell\b/, 26, 'build-out or new construction'],
    ],
    negative: [[/solar|photovoltaic|sign\b|fence only|landscap/, 25, 'no plumbing scope']],
  },
  hvac: {
    id: 'hvac', label: 'HVAC and mechanical', group: 'mep',
    naics: ['238220'], csi: ['23 05 00'], keywords: ['hvac', 'mechanical', 'rtu', 'ductwork'],
    signals: [
      [/hvac|mechanical|rtu|rooftop unit|duct|air handl|chiller|refrigerat|exhaust|ventilat/, 45, 'mechanical scope'],
      [/tenant improvement|build.?out|remodel|renovat|new (building|construction)|ground.?up|shell\b/, 28, 'build-out or new construction'],
      [/restaurant|medical|clinic|warehouse|manufactur/, 14, 'mechanical-heavy building type'],
    ],
    negative: [[/solar|photovoltaic|sign\b|fence only|landscap/, 25, 'no mechanical scope']],
  },
  janitorial: {
    id: 'janitorial', label: 'Janitorial and post-construction cleaning', group: 'services',
    naics: ['561720'], csi: ['01 74 23'], keywords: ['janitorial', 'cleaning', 'final clean'],
    stageBias: 'late',
    signals: [
      [/new (building|construction)|ground.?up|shell\b|multi.?family|\d+.?unit/, 32, 'new building (final cleaning, then recurring service)'],
      [/tenant improvement|build.?out|remodel|renovat/, 26, 'finished tenant space (move-in cleaning)'],
      [/office|medical|clinic|school|retail|restaurant/, 14, 'occupied commercial type'],
    ],
    negative: [[/solar|photovoltaic|sign\b|grading|underground|demolition only/, 30, 'no cleaning scope']],
  },
  tree_trimming: {
    id: 'tree_trimming', label: 'Tree trimming and land clearing', group: 'services',
    naics: ['561730'], csi: ['31 10 00'], keywords: ['tree', 'clearing', 'vegetation'],
    signals: [
      [/tree|vegetation|land clearing|clear(ing)? and grub|brush/, 55, 'tree or clearing scope'],
      [/site (work|permit)|grading|new (building|construction)|ground.?up/, 24, 'site preparation'],
    ],
    negative: [[/interior only|tenant improvement \(interior only\)/, 30, 'interior-only work']],
  },
  maintenance: {
    id: 'maintenance', label: 'General maintenance and facility services', group: 'services',
    naics: ['561210', '561790'], csi: [], keywords: ['maintenance', 'facility', 'repair'],
    stageBias: 'late',
    signals: [
      [/multi.?family|apartment|dwelling units|\d+.?unit/, 34, 'multifamily (ongoing maintenance need)'],
      [/new (building|construction)|ground.?up|shell\b/, 24, 'new building (future maintenance contract)'],
      [/office|medical|clinic|retail|school|warehouse/, 16, 'commercial property type'],
    ],
    negative: [[/solar|photovoltaic|sign\b|demolition only/, 30, 'no maintenance angle']],
  },
};
export const TRADE_IDS = Object.keys(TRADES);

export const tradesInGroup = (groupId) => TRADE_IDS.filter((t) => TRADES[t].group === groupId);
export const groupOfTrade = (tradeId) => TRADES[tradeId]?.group ?? null;

/** Distinct trade groups touched by a list of trade ids. */
export function groupsForTrades(tradeIds) {
  return [...new Set((tradeIds || []).map(groupOfTrade).filter(Boolean))];
}

/** Multi-value validation helper used by onboarding and settings. */
export function cleanMulti(input, allowed) {
  const arr = Array.isArray(input) ? input : input == null || input === '' ? [] : [input];
  const set = new Set(allowed);
  return [...new Set(arr.map((v) => String(v).trim()).filter((v) => set.has(v)))];
}

/** ZIP codes: accepts "85201, 85202 85203" (comma, space or newline separated). Returns unique valid 5-digit codes. */
export function parseZips(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  return [...new Set(raw.split(/[\s,;]+/).filter((z) => /^\d{5}$/.test(z)))];
}
