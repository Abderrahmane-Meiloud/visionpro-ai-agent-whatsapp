/**
 * Pure helpers for knowledge/vocabulary management. No DB or network — unit-testable in isolation.
 */

export type LintWarning = { type: string; excerpt: string };

// Patterns that indicate VOLATILE business facts which must come from a tool/human, never from static
// knowledge: prices/amounts, stock quantities, explicit dates, and promotional offers.
const VOLATILE: { type: string; re: RegExp }[] = [
  { type: 'price', re: /(?:\b\d[\d.,]*\s?(?:MRU|UM|ouguiya|€|\$|usd|eur)\b|[€$]\s?\d)/gi },
  { type: 'percentage', re: /\b\d{1,3}\s?%/g },
  { type: 'stock', re: /\b(?:in stock|out of stock|en stock|rupture|\d+\s+(?:units?|pcs?|pieces?|en stock))\b/gi },
  { type: 'date', re: /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g },
  { type: 'promotion', re: /\b(promo(?:tion)?|discount|offre|solde|sale|coupon|-\s?\d{1,3}\s?%)\b/gi },
];

/** Flags volatile content in a knowledge article. Returns [] when clean. */
export function lintArticle(content: string): LintWarning[] {
  const out: LintWarning[] = [];
  const text = content ?? '';
  for (const { type, re } of VOLATILE) {
    const m = text.match(re);
    if (m && m.length) out.push({ type, excerpt: m.slice(0, 3).join(', ').slice(0, 120) });
  }
  return out;
}

export function isVolatile(content: string): boolean {
  return lintArticle(content).length > 0;
}

export type VocabRow = { term: string; alternates: string[]; language: string | null; meaning: string | null; examples: string[] };
export type VocabImportResult = { rows: VocabRow[]; errors: string[] };

function cleanRow(raw: any, idx: number, errors: string[]): VocabRow | null {
  const term = String(raw?.term ?? '').trim();
  if (!term) { errors.push(`row ${idx + 1}: missing term`); return null; }
  if (term.length > 200) { errors.push(`row ${idx + 1}: term too long`); return null; }
  const toArr = (v: any): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
      : typeof v === 'string' ? v.split(';').map((x) => x.trim()).filter(Boolean) : [];
  return {
    term,
    alternates: toArr(raw?.alternates).slice(0, 50),
    language: raw?.language ? String(raw.language).trim().slice(0, 20) : null,
    meaning: raw?.meaning ? String(raw.meaning).trim().slice(0, 1000) : null,
    examples: toArr(raw?.examples).slice(0, 50),
  };
}

/** Parse + validate a bulk vocabulary import. `format` is 'json' (array of objects) or 'csv'
 *  (header row with columns term,alternates,language,meaning,examples; alternates/examples use ';'). */
export function parseVocabImport(format: string, raw: string): VocabImportResult {
  const errors: string[] = [];
  const rows: VocabRow[] = [];
  const data = String(raw ?? '').trim();
  if (!data) return { rows, errors: ['empty import'] };

  if (format === 'json') {
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { return { rows, errors: ['invalid JSON'] }; }
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
    if (!arr) return { rows, errors: ['JSON must be an array of rows'] };
    if (arr.length > 2000) return { rows, errors: ['too many rows (max 2000)'] };
    arr.forEach((r: any, i: number) => { const c = cleanRow(r, i, errors); if (c) rows.push(c); });
    return { rows, errors };
  }

  if (format === 'csv') {
    const lines = data.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { rows, errors: ['CSV needs a header row and at least one data row'] };
    if (lines.length > 2001) return { rows, errors: ['too many rows (max 2000)'] };
    const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col('term') < 0) return { rows, errors: ['CSV header must include a "term" column'] };
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const c = cleanRow({
        term: cells[col('term')],
        alternates: col('alternates') >= 0 ? cells[col('alternates')] : '',
        language: col('language') >= 0 ? cells[col('language')] : '',
        meaning: col('meaning') >= 0 ? cells[col('meaning')] : '',
        examples: col('examples') >= 0 ? cells[col('examples')] : '',
      }, i - 1, errors);
      if (c) rows.push(c);
    }
    return { rows, errors };
  }

  return { rows, errors: [`unknown format "${format}" (use json or csv)`] };
}

/** Minimal CSV line splitter supporting double-quoted fields with embedded commas and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
