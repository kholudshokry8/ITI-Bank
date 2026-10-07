import type Database from 'better-sqlite3';
import type {
  Chunk,
  DocumentReport,
  Hit,
  KnowledgeStore,
} from '../../app/ports';

interface Row {
  id: string;
  doc_id: string;
  source_file: string;
  page: number;
  clause_id: string;
  title: string;
  text: string;
  edition: string | null;
  doc_type: Chunk['docType'];
  effective_from: string;
  effective_to: string | null;
  status: Chunk['status'];
  embedding: string;
  embedding_model: string;
}

const dot = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

/** Vectors are stored as JSON in SQLite and searched by exact cosine similarity (vectors are unit length). */
export class SqliteKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: Database.Database) {}

  async upsertChunks(
    chunks: Chunk[],
    vectors: number[][],
    model: string,
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (id, doc_id, source_file, page, clause_id, title, text, edition, doc_type, effective_from, effective_to, status, embedding, embedding_model)
      VALUES (@id, @docId, @sourceFile, @page, @clauseId, @title, @text, @edition, @docType, @effectiveFrom, @effectiveTo, @status, @embedding, @model)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text, page=excluded.page, title=excluded.title, edition=excluded.edition,
        effective_from=excluded.effective_from, effective_to=excluded.effective_to, status=excluded.status,
        embedding=excluded.embedding, embedding_model=excluded.embedding_model`);
    this.db.transaction(() => {
      chunks.forEach((c, i) =>
        stmt.run({ ...c, embedding: JSON.stringify(vectors[i]), model }),
      );
    })();
  }

  async search(
    query: number[],
    opts: { k: number; model: string; filter: (c: Chunk) => boolean },
  ): Promise<Hit[]> {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE embedding_model = ?')
      .all(opts.model) as Row[];
    return rows
      .map((r) => ({
        chunk: {
          id: r.id,
          docId: r.doc_id,
          sourceFile: r.source_file,
          page: r.page,
          clauseId: r.clause_id,
          title: r.title,
          text: r.text,
          edition: r.edition,
          docType: r.doc_type,
          effectiveFrom: r.effective_from,
          effectiveTo: r.effective_to,
          status: r.status,
        } satisfies Chunk,
        score: dot(query, JSON.parse(r.embedding) as number[]),
      }))
      .filter((h) => opts.filter(h.chunk))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.k);
  }

  async recordDocument(r: DocumentReport): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO documents (file, status, chunks, error, ingested_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(file) DO UPDATE SET status=excluded.status, chunks=excluded.chunks, error=excluded.error, ingested_at=excluded.ingested_at`,
      )
      .run(
        r.file,
        r.status,
        r.chunks,
        r.error ?? null,
        new Date().toISOString(),
      );
  }

  async listDocuments(): Promise<DocumentReport[]> {
    return (
      this.db
        .prepare(
          'SELECT file, status, chunks, error FROM documents ORDER BY file',
        )
        .all() as Array<DocumentReport & { error: string | null }>
    ).map((d) => ({
      file: d.file,
      status: d.status,
      chunks: d.chunks,
      ...(d.error ? { error: d.error } : {}),
    }));
  }

  async chunkCount(): Promise<number> {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    ).n;
  }
}
