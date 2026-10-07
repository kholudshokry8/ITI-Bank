import {
  renderTemplate,
  type Chunk,
  type KnowledgeStore,
  type LlmProvider,
  type Prompts,
  type Tokens,
} from './ports';
import { detectInjection } from '../domain/injection';

export const REFUSAL_TEXT =
  'The documents do not contain enough information to answer this question.';

export interface Citation {
  chunk_id: string;
  source_file: string;
  page: number;
  clause_id: string;
  edition: string | null;
  score: number;
}
export interface QaResult {
  answer: string;
  citations: Citation[];
  reason?: 'no_chunk_above_threshold' | 'llm_declined';
  edition_filter: string | null;
  injection_suspected: boolean;
  tokens: Tokens;
}
export interface QaDeps {
  llm: LlmProvider;
  knowledge: KnowledgeStore;
  prompts: Prompts;
  threshold: number;
  asOf: string; // ISO date used to decide which documents are in force
  editions: Array<{ id: string; effectiveFrom: string }>; // known policy editions
}

/** If the question names exactly one edition year, filter to it; otherwise use the one in force. */
export function inferEdition(
  question: string,
  editions: string[],
  inForce: string,
): string | null {
  const named = editions.filter((e) => question.includes(e.replace('CP-', '')));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return null; // comparing editions: search both
  return inForce;
}

export const inScope =
  (edition: string | null, asOf: string) =>
  (c: Chunk): boolean =>
    c.effectiveFrom <= asOf &&
    (c.effectiveTo === null || asOf < c.effectiveTo) &&
    (edition === null || c.edition === null || c.edition === edition);

export async function answerQuestion(
  deps: QaDeps,
  question: string,
  inForceEdition: string,
): Promise<QaResult> {
  const edition = inferEdition(
    question,
    deps.editions.map((e) => e.id),
    inForceEdition,
  );
  const compare = edition === null;
  const tokens: Tokens = { input: 0, output: 0 };
  const emb = await deps.llm.embed([question]);
  tokens.input += emb.tokens;

  // Comparing editions, or asking about an old edition, means superseded documents are relevant.
  const asOf =
    deps.editions.find((e) => e.id === edition && e.id !== inForceEdition)
      ?.effectiveFrom ?? deps.asOf;
  const filter = compare ? () => true : inScope(edition, asOf);
  const hits = (
    await deps.knowledge.search(emb.vectors[0]!, {
      k: 5,
      model: emb.model,
      filter,
    })
  ).filter((h) => h.score >= deps.threshold);
  const base = {
    edition_filter: edition,
    injection_suspected: detectInjection(question).length > 0,
  };
  if (hits.length === 0) {
    return {
      answer: REFUSAL_TEXT,
      citations: [],
      reason: 'no_chunk_above_threshold',
      tokens,
      ...base,
    };
  }

  const used = hits.slice(0, 3);
  const context = used
    .map((h) => `<chunk id="${h.chunk.id}">\n${h.chunk.text}\n</chunk>`)
    .join('\n');
  const res = await deps.llm.complete({
    task: 'qa',
    system: deps.prompts.qaSystem,
    user: renderTemplate(deps.prompts.qaUser, { context, question }),
  });
  tokens.input += res.tokens.input;
  tokens.output += res.tokens.output;
  const citations: Citation[] = used.map((h) => ({
    chunk_id: h.chunk.id,
    source_file: h.chunk.sourceFile,
    page: h.chunk.page,
    clause_id: h.chunk.clauseId,
    edition: h.chunk.edition,
    score: Number(h.score.toFixed(3)),
  }));
  if (/^\s*INSUFFICIENT/i.test(res.text)) {
    return {
      answer: REFUSAL_TEXT,
      citations: [],
      reason: 'llm_declined',
      tokens,
      ...base,
    };
  }
  return { answer: res.text.trim(), citations, tokens, ...base };
}
