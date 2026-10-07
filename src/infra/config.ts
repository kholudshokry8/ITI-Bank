import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import type { DocMeta, Prompts } from '../app/ports';
import type { DocumentLoader } from '../app/ingest';
import type { PolicyConfig } from '../domain/policy';
import { parsePricingCsv, type PricingRow } from '../domain/pricing';

const root = process.cwd();
const json = <T>(p: string): T =>
  JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const text = (p: string): string => readFileSync(join(root, p), 'utf8');

export const loadPolicyConfig = (): PolicyConfig =>
  json<PolicyConfig>('config/policy-editions.json');
export const loadDocMeta = (): DocMeta[] =>
  json<{ documents: DocMeta[] }>('config/documents.json').documents;
export const policyDir = (env: NodeJS.ProcessEnv): string =>
  env.POLICY_DIR ?? 'data/policy';
export const applicationsDir = (env: NodeJS.ProcessEnv): string =>
  env.APPLICATIONS_DIR ?? 'data/applications';

/** The interest rate comes from the pricing CSV at run time, never from source code. */
export const loadPricing = (env: NodeJS.ProcessEnv): PricingRow[] =>
  parsePricingCsv(text(join(policyDir(env), 'pricing-table.csv')));

export const loadPrompts = (): Prompts => ({
  extractSystem: text('prompts/extract.system.txt'),
  extractUser: text('prompts/extract.user.txt'),
  memoSystem: text('prompts/memo.system.txt'),
  memoUser: text('prompts/memo.user.txt'),
  qaSystem: text('prompts/qa.system.txt'),
  qaUser: text('prompts/qa.user.txt'),
});

export async function readPdfPages(path: string): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return pages;
}

export const fileLoader =
  (dir: string): DocumentLoader =>
  async (meta) => {
    const path = join(dir, meta.file);
    return meta.file.endsWith('.pdf')
      ? { kind: 'pdf', pages: await readPdfPages(path) }
      : { kind: 'text', text: readFileSync(path, 'utf8') };
  };
