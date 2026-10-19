/**
 * Maricopa-area agency names recognised by the rules parser. The match only labels the agency; it never
 * decides eligibility. `jurisdiction` uses ids from taxonomy.js JURISDICTIONS (null when there is no id).
 */
export const AGENCIES = [
  { re: /\bflood control district of maricopa county\b/i, name: 'Flood Control District of Maricopa County', jurisdiction: 'maricopa_county' },
  { re: /\bmaricopa county\b/i, name: 'Maricopa County', jurisdiction: 'maricopa_county' },
  { re: /\bmaricopa (?:county )?community colleges?\b/i, name: 'Maricopa Community Colleges', jurisdiction: 'maricopa_county' },
  { re: /\b(?:city|town) of phoenix\b/i, name: 'City of Phoenix', jurisdiction: 'phoenix' },
  { re: /\bcity of mesa\b/i, name: 'City of Mesa', jurisdiction: 'mesa' },
  { re: /\bcity of scottsdale\b/i, name: 'City of Scottsdale', jurisdiction: 'scottsdale' },
  { re: /\b(?:city|town) of tempe\b/i, name: 'City of Tempe', jurisdiction: 'tempe' },
  { re: /\bcity of chandler\b/i, name: 'City of Chandler', jurisdiction: 'chandler' },
  { re: /\b(?:town|city) of gilbert\b/i, name: 'Town of Gilbert', jurisdiction: 'gilbert' },
  { re: /\bcity of glendale\b/i, name: 'City of Glendale', jurisdiction: 'glendale' },
  { re: /\bcity of peoria\b/i, name: 'City of Peoria', jurisdiction: 'peoria' },
  { re: /\bcity of surprise\b/i, name: 'City of Surprise', jurisdiction: null },
  { re: /\bcity of goodyear\b/i, name: 'City of Goodyear', jurisdiction: null },
  { re: /\bcity of avondale\b/i, name: 'City of Avondale', jurisdiction: null },
  { re: /\btown of queen creek\b/i, name: 'Town of Queen Creek', jurisdiction: null },
  { re: /\barizona department of transportation\b|\bADOT\b/, name: 'Arizona Department of Transportation', jurisdiction: 'statewide' },
  { re: /\bvalley metro\b/i, name: 'Valley Metro', jurisdiction: null },
  { re: /\barizona state university\b/i, name: 'Arizona State University', jurisdiction: null },
  { re: /\bstate of arizona\b/i, name: 'State of Arizona', jurisdiction: 'statewide' },
];

const SCHOOL = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3} (?:Unified|Elementary|Union High|High) School District(?: No\.? ?\d+)?)\b/;
const LABELED = /(?:^|\n)\s*(?:agency|issued by|issuing agency|issuing entity|buyer|owner|department|organization|entity)\s*[:\-]\s*([^\n]{3,120})/i;

/** Returns { value, quote, jurisdiction } or null. A labelled line wins over a name match. */
export function findAgency(text) {
  const s = String(text || '');
  const lab = LABELED.exec(s);
  if (lab) {
    const quote = lab[1].trim().replace(/\s{2,}.*$/, '');
    const known = AGENCIES.find((a) => a.re.test(quote));
    return { value: known ? known.name : quote.slice(0, 120), quote, jurisdiction: known ? known.jurisdiction : null };
  }
  const school = SCHOOL.exec(s);
  if (school) return { value: school[1], quote: school[1], jurisdiction: null };
  for (const a of AGENCIES) {
    const m = a.re.exec(s);
    if (m) return { value: a.name, quote: m[0], jurisdiction: a.jurisdiction };
  }
  return null;
}
