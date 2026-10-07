import { beforeAll, describe, expect, it } from 'vitest';
import { ingestAll } from '../src/app/ingest';
import { answerQuestion, REFUSAL_TEXT } from '../src/app/qa';
import { fileLoader, loadDocMeta } from '../src/infra/config';
import type { Container } from '../src/infra/bootstrap';
import { qaDeps } from '../src/infra/web/server';
import { testContainer } from './helpers';

let c: Container;
beforeAll(async () => {
  c = await testContainer();
});
const ask = (q: string) => answerQuestion(qaDeps(c), q, 'CP-2025');
const ids = (r: Awaited<ReturnType<typeof ask>>) =>
  r.citations.map((x) => x.chunk_id);

describe('ingestion', () => {
  it('is idempotent: running twice does not create duplicates', async () => {
    const before = await c.knowledge.chunkCount();
    const reports = await ingestAll(loadDocMeta(), {
      llm: c.llm,
      knowledge: c.knowledge,
      load: fileLoader('data/policy'),
    });
    expect(await c.knowledge.chunkCount()).toBe(before);
    expect(reports.every((r) => r.status === 'ok')).toBe(true);
  });
  it('reports a failing document without stopping the others', async () => {
    const meta = [
      ...loadDocMeta(),
      { ...loadDocMeta()[0]!, file: 'missing.pdf', docId: 'X' },
    ];
    const reports = await ingestAll(meta, {
      llm: c.llm,
      knowledge: c.knowledge,
      load: fileLoader('data/policy'),
    });
    expect(
      reports.filter((r) => r.status === 'failed').map((r) => r.file),
    ).toEqual(['missing.pdf']);
    expect(reports.filter((r) => r.status === 'ok')).toHaveLength(7);
  });
  it('stores source file, page, clause id, edition and dates on each chunk', async () => {
    const row = c.db
      .prepare("SELECT * FROM chunks WHERE id = 'CP-2024:CP-4.1'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      source_file: 'credit-policy-2024.pdf',
      page: 2,
      clause_id: 'CP-4.1',
      edition: 'CP-2024',
      effective_from: '2024-01-01',
      effective_to: '2025-03-01',
    });
  });
  it('never puts applicant documents in the policy knowledge base', () => {
    expect(
      c.db
        .prepare("SELECT COUNT(*) n FROM chunks WHERE source_file LIKE 'APP-%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(c.db.prepare('SELECT COUNT(*) n FROM applications').get()).toEqual({
      n: 5,
    });
  });
});

describe('question answering', () => {
  it('answers with citations to the edition in force', async () => {
    const r = await ask('What is the maximum debt burden ratio?');
    expect(ids(r)[0]).toBe('CP-2025:CP-4.1');
    expect(r.answer).toContain('45%');
    expect(r.edition_filter).toBe('CP-2025');
  });
  it('answers from the 2024 edition when the question names it', async () => {
    const r = await ask(
      'What was the maximum debt burden ratio in the 2024 policy?',
    );
    expect(ids(r)[0]).toBe('CP-2024:CP-4.1');
    expect(r.answer).toContain('50%');
  });
  it('searches both editions when the question compares them', async () => {
    const r = await ask(
      'How does the 2025 maximum debt burden ratio differ from the 2024 edition?',
    );
    expect(r.edition_filter).toBeNull();
    expect(ids(r).some((i) => i.startsWith('CP-2024'))).toBe(true);
    expect(ids(r).some((i) => i.startsWith('CP-2025'))).toBe(true);
  });
  it('does not cite the superseded circular for a current question', async () => {
    const r = await ask('What is the maximum tenor allowed by the circular?');
    expect(ids(r)).not.toContain('CIRC-2024-07:C-1');
    expect(
      ids(r).some(
        (i) =>
          i.startsWith('CIRC-2025-02') ||
          i.startsWith('CP-2025:CP-14') ||
          i.startsWith('PS-PL-100'),
      ),
    ).toBe(true);
  });
  it('S4: refuses an out-of-corpus question', async () => {
    const r = await ask("What is the bank's policy on crypto-backed loans?");
    expect(r.answer).toBe(REFUSAL_TEXT);
    expect(r.citations).toEqual([]);
    expect(r.reason).toBe('no_chunk_above_threshold');
  });
});
