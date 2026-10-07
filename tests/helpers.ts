import { ingestAll } from '../src/app/ingest';
import type { LlmProvider, LlmRequest } from '../src/app/ports';
import { splitPack, type ApplicationPack } from '../src/domain/application';
import {
  buildContainer,
  seedApplications,
  seedUsers,
  type Container,
} from '../src/infra/bootstrap';
import { fileLoader, loadDocMeta } from '../src/infra/config';
import { MockLlm } from '../src/infra/llm/mock';

export const TEST_ENV = {
  ...process.env,
  DATABASE_PATH: ':memory:',
  JWT_SECRET: 'test-secret-test-secret',
  AS_OF_DATE: '2025-06-01',
};

export async function testContainer(
  llm: LlmProvider = new MockLlm(),
  env = TEST_ENV,
): Promise<Container> {
  const c = buildContainer(env, llm);
  await ingestAll(loadDocMeta(), {
    llm: c.llm,
    knowledge: c.knowledge,
    load: fileLoader('data/policy'),
  });
  seedUsers(c);
  await seedApplications(c);
  return c;
}

export const packOf = (c: Container, id: string): ApplicationPack =>
  splitPack(c.repos.getApplicationText(id)!);

/** Wraps a provider and lets a test corrupt the answer for one task. Used instead of a real model. */
export class TamperingLlm implements LlmProvider {
  readonly inner = new MockLlm();
  constructor(
    private readonly override: Partial<
      Record<LlmRequest['task'], (real: string) => string>
    >,
  ) {}
  async complete(req: LlmRequest) {
    const res = await this.inner.complete(req);
    const f = this.override[req.task];
    return f ? { ...res, text: f(res.text) } : res;
  }
  embed(texts: string[]) {
    return this.inner.embed(texts);
  }
}
