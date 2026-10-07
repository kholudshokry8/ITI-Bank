import type { Chunk, DocMeta } from './ports';

/**
 * Chunking is by clause/section (CP-4.1, PM-2, PS-3, C-2), not by character count: a clause is
 * the unit a credit officer cites, and one clause per chunk keeps citations exact.
 */

const base = (
  m: DocMeta,
  clauseId: string,
  title: string,
  text: string,
  page: number,
): Chunk => ({
  id: `${m.docId}:${clauseId}`,
  docId: m.docId,
  sourceFile: m.file,
  page,
  clauseId,
  title,
  text: text.trim(),
  edition: m.edition,
  docType: m.docType,
  effectiveFrom: m.effectiveFrom,
  effectiveTo: m.effectiveTo,
  status: m.status,
});

const HEADING: Record<string, RegExp> = {
  policy: /^(CP-\d+(?:\.\d+)?)\.?\s+(.*)$/,
  manual: /^(PM-\d+)\.\s+(.*)$/,
};
const TOP_LEVEL = /^[A-Z]+-\d+\.\s/;

export function chunkPdfPages(pages: string[], meta: DocMeta): Chunk[] {
  const heading = HEADING[meta.docType];
  if (!heading) throw new Error(`No PDF chunking rule for ${meta.docType}`);
  const out: Chunk[] = [];
  let cur = {
    clauseId: 'HEADER',
    title: 'Document header',
    page: 1,
    lines: [] as string[],
  };
  const flush = () => {
    const body = cur.lines.slice(cur.clauseId === 'HEADER' ? 0 : 1);
    // Table rows (CP-3.4 ...) are one line; only a bare top-level title such as "CP-4. Affordability" is dropped.
    if (
      cur.clauseId === 'HEADER' ||
      body.some((l) => l.trim()) ||
      !TOP_LEVEL.test(cur.lines[0]!)
    ) {
      out.push(
        base(meta, cur.clauseId, cur.title, cur.lines.join('\n'), cur.page),
      );
    }
  };
  pages.forEach((pageText, i) => {
    for (const line of pageText.split('\n')) {
      const m = heading.exec(line.trim());
      const inNoSplit = meta.noSplit.includes(cur.clauseId);
      if (m && (!inNoSplit || TOP_LEVEL.test(line.trim()))) {
        flush();
        cur = {
          clauseId: m[1]!,
          title: m[2]!.trim(),
          page: i + 1,
          lines: [line.trim()],
        };
      } else {
        cur.lines.push(line.trim());
      }
    }
  });
  flush();
  return dedupe(out);
}

export function chunkMarkdown(text: string, meta: DocMeta): Chunk[] {
  const out: Chunk[] = [];
  let cur = {
    clauseId: 'HEADER',
    title: 'Document header',
    lines: [] as string[],
  };
  const flush = () => {
    if (cur.lines.join('').trim())
      out.push(base(meta, cur.clauseId, cur.title, cur.lines.join('\n'), 1));
  };
  for (const line of text.split('\n')) {
    const m = /^###\s+([A-Z]+-\d+)\.?\s*(.*)$/.exec(line);
    if (m) {
      flush();
      cur = { clauseId: m[1]!, title: m[2]!.trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  flush();
  return dedupe(out);
}

export function chunkCsv(text: string, meta: DocMeta): Chunk[] {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header!.split(',');
  return rows.map((row, i) => {
    const v = Object.fromEntries(cols.map((c, j) => [c, row.split(',')[j]!]));
    const sentence =
      `Pricing table ${meta.docId}: tenor ${v.tenor_from_months} to ${v.tenor_to_months} months, ` +
      `segment ${v.segment}, annual interest rate ${v.annual_rate_percent}%`;
    return base(
      meta,
      `ROW-${i + 1}`,
      `Rate ${v.segment} ${v.tenor_from_months}-${v.tenor_to_months}`,
      sentence,
      1,
    );
  });
}

function dedupe(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  for (const c of chunks) {
    if (seen.has(c.id)) throw new Error(`Duplicate chunk id ${c.id}`);
    seen.add(c.id);
  }
  return chunks;
}

/** Text that is embedded: carries document, edition and clause context so retrieval can match it. */
export const embeddingText = (c: Chunk): string =>
  `${c.docId} ${c.clauseId} ${c.title}${c.edition ? ` (${c.edition})` : ''}\n${c.text}`;
