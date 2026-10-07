import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineDeps } from '../app/pipeline';
import type { LlmProvider } from '../app/ports';
import { splitPack } from '../domain/application';
import {
  applicationsDir,
  loadPolicyConfig,
  loadPricing,
  loadPrompts,
  readPdfPages,
} from './config';
import { migrate } from './db/migrate';
import { Repos } from './db/repos';
import { createLlm } from './llm';
import { SqliteKnowledgeStore } from './vector/sqlite-knowledge-store';

export interface Container {
  db: Database.Database;
  repos: Repos;
  knowledge: SqliteKnowledgeStore;
  llm: LlmProvider;
  pipeline: PipelineDeps;
  env: NodeJS.ProcessEnv;
}

/** Composition root: the only place infrastructure is wired to the application layer. */
export function buildContainer(
  env: NodeJS.ProcessEnv = process.env,
  llm?: LlmProvider,
): Container {
  const db = new Database(env.DATABASE_PATH ?? 'data/credit-copilot.db');
  db.pragma('journal_mode = WAL');
  migrate(db);
  const knowledge = new SqliteKnowledgeStore(db);
  const provider = llm ?? createLlm(env);
  return {
    db,
    repos: new Repos(db),
    knowledge,
    llm: provider,
    env,
    pipeline: {
      llm: provider,
      knowledge,
      policy: loadPolicyConfig(),
      pricing: loadPricing(env),
      prompts: loadPrompts(),
      newId: randomUUID,
    },
  };
}

/** Loads the five application packs into the untrusted `applications` table (never into `chunks`). */
export async function seedApplications(c: Container): Promise<string[]> {
  const dir = applicationsDir(c.env);
  const ids: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /^APP-\d{3}\.pdf$/.test(f))
    .sort()) {
    const text = (await readPdfPages(join(dir, file))).join('\n');
    splitPack(text); // fail early if the pack is malformed
    const id = file.replace('.pdf', '');
    c.repos.upsertApplication(id, file, text);
    ids.push(id);
  }
  return ids;
}

export function seedUsers(c: Container): void {
  c.repos.upsertUser('u-loan', 'loan.officer', 'Demo-Loan-1', 'loan_officer');
  c.repos.upsertUser(
    'u-credit',
    'credit.officer',
    'Demo-Credit-1',
    'credit_officer',
  );
  c.repos.upsertUser(
    'u-senior',
    'senior.officer',
    'Demo-Senior-1',
    'senior_credit_officer',
  );
}
