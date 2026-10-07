/** Interfaces the application layer depends on. Infrastructure implements them. */

export type LlmTask = 'extract' | 'memo' | 'qa';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  user: string;
  json?: boolean;
}
export interface Tokens {
  input: number;
  output: number;
}
export interface LlmResponse {
  text: string;
  tokens: Tokens;
}
export interface EmbedResponse {
  vectors: number[][];
  tokens: number;
  model: string;
}

/** The only LLM surface the pipeline sees. Switching provider = one new adapter + config. */
export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  embed(texts: string[]): Promise<EmbedResponse>;
}

export type DocType = 'policy' | 'manual' | 'product' | 'pricing' | 'circular';

export interface DocMeta {
  file: string;
  docId: string;
  docType: DocType;
  edition: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'in_force' | 'superseded';
  noSplit: string[];
}

export interface Chunk {
  id: string; // `${docId}:${clauseId}`
  docId: string;
  sourceFile: string;
  page: number;
  clauseId: string;
  title: string;
  text: string;
  edition: string | null;
  docType: DocType;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'in_force' | 'superseded';
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

export interface DocumentReport {
  file: string;
  status: 'ok' | 'failed';
  chunks: number;
  error?: string;
}

/** Trusted policy knowledge base: chunks + vectors + ingestion status. */
export interface KnowledgeStore {
  upsertChunks(
    chunks: Chunk[],
    vectors: number[][],
    model: string,
  ): Promise<void>;
  search(
    query: number[],
    opts: { k: number; model: string; filter: (c: Chunk) => boolean },
  ): Promise<Hit[]>;
  recordDocument(report: DocumentReport): Promise<void>;
  listDocuments(): Promise<DocumentReport[]>;
  chunkCount(): Promise<number>;
}

export interface Prompts {
  extractSystem: string;
  extractUser: string;
  memoSystem: string;
  memoUser: string;
  qaSystem: string;
  qaUser: string;
}

export const renderTemplate = (
  tpl: string,
  vars: Record<string, string>,
): string => tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
