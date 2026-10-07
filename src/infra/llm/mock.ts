import type {
  EmbedResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from '../../app/ports';
import { HASHING_MODEL, hashingEmbed } from './hashing-embedder';

const between = (s: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? m[1]! : '';
};
const lineWith = (text: string, re: RegExp): string | null => {
  for (const line of text.split('\n')) if (re.test(line)) return line.trim();
  return null;
};
const num = (s: string) => Number(s.replace(/,/g, ''));
const iso = (d: string): string => {
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(d)!;
  return `${m[3]}-${String(months.indexOf(m[2]!.toLowerCase()) + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
};

/**
 * Offline provider for tests and demos. It is NOT a language model: it reads the documents with
 * regular expressions and fills templates. It proves the pipeline wiring, not LLM behaviour.
 */
export class MockLlm implements LlmProvider {
  readonly requests: LlmRequest[] = [];

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const text = this.respond(req);
    return {
      text,
      tokens: {
        input: Math.ceil((req.system.length + req.user.length) / 4),
        output: Math.ceil(text.length / 4),
      },
    };
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    return {
      vectors: texts.map(hashingEmbed),
      tokens: texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
      model: HASHING_MODEL,
    };
  }

  private respond(req: LlmRequest): string {
    if (req.task === 'extract') return this.extract(req.user);
    if (req.task === 'memo') {
      return (
        'The recommendation follows the rule results below. The instalment is [[installment]] and the debt burden ratio is [[dbr]] against a limit of [[max_dbr]] (CP-4.1). ' +
        'The maximum eligible amount is [[max_amount]]. Eligibility was assessed under CP-3 before affordability (CP-4.4).'
      );
    }
    const chunks = [
      ...req.user.matchAll(/<chunk id="([^"]+)">\n([\s\S]*?)\n<\/chunk>/g),
    ];
    if (chunks.length === 0) return 'INSUFFICIENT';
    const [, id, body] = chunks[0]!;
    return `${body!.replace(/\s+/g, ' ').slice(0, 400)} [${id}]`;
  }

  private extract(user: string): string {
    const cert = between(user, 'salary_certificate');
    const bureau = between(user, 'bureau_summary');
    const doc = /Source document name: (\S+)/.exec(user)?.[1] ?? 'unknown.pdf';
    const income = lineWith(cert, /^Net monthly income\s+[\d,]+/);
    const since = /since\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/.exec(cert);
    const oblig = lineWith(bureau, /^Total monthly instalments/);
    const score = lineWith(bureau, /^Bureau score\s+\d+/);
    if (!income || !since || !oblig || !score) return '{}';
    return JSON.stringify({
      net_monthly_income: {
        value: num(/([\d,]+(?:\.\d+)?)$/.exec(income)![1]!),
        source_document: doc,
        source_section: 'Salary certificate',
        quoted_text: income,
      },
      existing_monthly_obligations: {
        value: num(/([\d,]+(?:\.\d+)?)$/.exec(oblig)![1]!),
        source_document: doc,
        source_section: 'Credit bureau summary',
        quoted_text: oblig,
      },
      employment_start_date: {
        value: iso(since[1]!),
        source_document: doc,
        source_section: 'Salary certificate',
        quoted_text: since[0],
      },
      bureau_score: {
        value: num(/(\d+)$/.exec(score)![1]!),
        source_document: doc,
        source_section: 'Credit bureau summary',
        quoted_text: score,
      },
    });
  }
}
