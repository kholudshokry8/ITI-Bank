import {
  chunkCsv,
  chunkMarkdown,
  chunkPdfPages,
  embeddingText,
} from './chunking';
import type {
  Chunk,
  DocMeta,
  DocumentReport,
  KnowledgeStore,
  LlmProvider,
} from './ports';

export type RawDocument =
  | { kind: 'pdf'; pages: string[] }
  | { kind: 'text'; text: string };
export type DocumentLoader = (meta: DocMeta) => Promise<RawDocument>;

/** extract -> chunk */
export async function extractAndChunk(
  meta: DocMeta,
  load: DocumentLoader,
): Promise<Chunk[]> {
  const raw = await load(meta);
  if (raw.kind === 'pdf') return chunkPdfPages(raw.pages, meta);
  return meta.file.endsWith('.csv')
    ? chunkCsv(raw.text, meta)
    : chunkMarkdown(raw.text, meta);
}

/** embed -> index. Chunk ids are deterministic, so re-running replaces instead of duplicating. */
export async function embedAndIndex(
  chunks: Chunk[],
  llm: LlmProvider,
  knowledge: KnowledgeStore,
): Promise<void> {
  const { vectors, model } = await llm.embed(chunks.map(embeddingText));
  await knowledge.upsertChunks(chunks, vectors, model);
}

/** One failing document never stops the others; every outcome is recorded. */
export async function ingestAll(
  docs: DocMeta[],
  deps: { llm: LlmProvider; knowledge: KnowledgeStore; load: DocumentLoader },
): Promise<DocumentReport[]> {
  const reports: DocumentReport[] = [];
  for (const meta of docs) {
    let report: DocumentReport;
    try {
      const chunks = await extractAndChunk(meta, deps.load);
      await embedAndIndex(chunks, deps.llm, deps.knowledge);
      report = { file: meta.file, status: 'ok', chunks: chunks.length };
    } catch (err) {
      report = {
        file: meta.file,
        status: 'failed',
        chunks: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    await deps.knowledge.recordDocument(report);
    reports.push(report);
  }
  return reports;
}
