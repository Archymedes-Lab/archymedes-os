/**
 * Data sources: uploads, a CSV link (e.g. a published Google Sheet) or a
 * billing connector. Every source lands through the same mapping, preview and
 * duplicate checks as a manual import.
 */
export interface MappingSuggestion {
  externalId: string | null;
  occurredAt: string | null;
  amount: string | null;
  currency: string | null;
  /** Other columns kept as fields. */
  extra: Record<string, string>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const RULES: { field: "externalId" | "occurredAt" | "amount" | "currency"; patterns: RegExp[] }[] = [
  { field: "externalId", patterns: [/^(invoice|order|transaction|payment|deal|charge|receipt)( (id|number|no|ref|reference))?$/, /\b(id|number|ref|reference)$/, /^id$/] },
  { field: "occurredAt", patterns: [/\b(date|paid at|paid on|created at|created|closed at|close date|timestamp|posted)\b/, /^(when|day|time)$/, /\bdate\b/] },
  { field: "amount", patterns: [/\b(amount|total|revenue|net|gross|price|value|sales)\b/] },
  { field: "currency", patterns: [/^(currency|ccy|currency code)$/, /\bcurrency\b/] },
];

export function suggestMapping(header: string[]): MappingSuggestion {
  const out: MappingSuggestion = { externalId: null, occurredAt: null, amount: null, currency: null, extra: {} };
  const used = new Set<string>();
  for (const rule of RULES)
    for (const pattern of rule.patterns) {
      if (out[rule.field]) break;
      const hit = header.find((h) => !used.has(h) && pattern.test(norm(h)));
      if (hit) {
        out[rule.field] = hit;
        used.add(hit);
      }
    }
  for (const h of header) if (!used.has(h)) out.extra[norm(h).replace(/ /g, "_").slice(0, 40) || "column"] = h;
  return out;
}
