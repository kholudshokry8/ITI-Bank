import type {
  EmbedResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from '../../app/ports';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  embeddingModel: string;
}

/**
 * Google Gemini adapter (free-tier API key from Google AI Studio).
 * NOTE: written against the public REST API but not exercised against the live service in this
 * repository's tests. Model names are configuration; check they are current before relying on them.
 */
export class GeminiLlm implements LlmProvider {
  constructor(private readonly cfg: GeminiConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok)
      throw new Error(
        `Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    return (await res.json()) as T;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const data = await this.post<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    }>(`models/${this.cfg.model}:generateContent`, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: 0,
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
      },
    });
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      '';
    return {
      text,
      tokens: {
        input: data.usageMetadata?.promptTokenCount ?? 0,
        output: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    const data = await this.post<{ embeddings: Array<{ values: number[] }> }>(
      `models/${this.cfg.embeddingModel}:batchEmbedContents`,
      {
        requests: texts.map((t) => ({
          model: `models/${this.cfg.embeddingModel}`,
          content: { parts: [{ text: t }] },
        })),
      },
    );
    return {
      vectors: data.embeddings.map((e) => e.values),
      tokens: texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
      model: this.cfg.embeddingModel,
    };
  }
}
