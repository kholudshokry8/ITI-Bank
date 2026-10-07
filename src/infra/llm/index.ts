import type { LlmProvider } from '../../app/ports';
import { GeminiLlm } from './gemini';
import { MockLlm } from './mock';

/** Provider factory: the only place that knows which adapters exist. Add a new case + adapter here. */
export function createLlm(env: NodeJS.ProcessEnv): LlmProvider {
  switch (env.LLM_PROVIDER ?? 'mock') {
    case 'mock':
      return new MockLlm();
    case 'gemini':
      if (!env.GEMINI_API_KEY)
        throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
      return new GeminiLlm({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
        embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? 'text-embedding-004',
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  }
}
