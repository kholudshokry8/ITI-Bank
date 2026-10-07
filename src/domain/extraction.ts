import { z } from 'zod';
import { MONTH_PATTERN, parseLongDate } from './dates';
import { InvalidLLMOutput, UnverifiedExtraction } from './errors';

const source = {
  source_document: z.string().min(1),
  source_section: z.enum(['Salary certificate', 'Credit bureau summary']),
  quoted_text: z.string().min(1),
};
const field = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, ...source });

export const ExtractionSchema = z.object({
  net_monthly_income: field(z.number().positive()),
  existing_monthly_obligations: field(z.number().min(0)),
  employment_start_date: field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  bureau_score: field(z.number().int().min(0).max(1000)),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Parses the LLM's JSON and validates it against the schema. Anything else is InvalidLLMOutput. */
export function parseExtraction(raw: string): Extraction {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim());
  } catch {
    throw new InvalidLLMOutput('Extraction is not valid JSON');
  }
  const parsed = ExtractionSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidLLMOutput(
      'Extraction does not match schema: ' +
        parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  return parsed.data;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const numbersIn = (s: string): number[] =>
  [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, '')),
  );

export interface SourceTexts {
  salaryCertificate: string;
  bureauSummary: string;
}

/**
 * Code check of what the model returned: the quote must really appear in the cited section,
 * and the value must appear inside the quote. Income is also cross-checked against the
 * certificate's own arithmetic (gross - deductions = net).
 */
export function verifyExtraction(e: Extraction, docs: SourceTexts): void {
  const check = (
    name: string,
    f: { value: unknown; source_section: string; quoted_text: string },
  ) => {
    const doc =
      f.source_section === 'Salary certificate'
        ? docs.salaryCertificate
        : docs.bureauSummary;
    if (!squash(doc).includes(squash(f.quoted_text))) {
      throw new UnverifiedExtraction(
        `${name}: quoted text not found in ${f.source_section}`,
      );
    }
    if (typeof f.value === 'number') {
      if (!numbersIn(f.quoted_text).includes(f.value)) {
        throw new UnverifiedExtraction(
          `${name}: value ${f.value} does not appear in the quoted text`,
        );
      }
    } else if (parseLongDate(f.quoted_text) !== f.value) {
      throw new UnverifiedExtraction(
        `${name}: date ${String(f.value)} does not appear in the quoted text`,
      );
    }
  };
  check('net_monthly_income', e.net_monthly_income);
  check('existing_monthly_obligations', e.existing_monthly_obligations);
  check('employment_start_date', e.employment_start_date);
  check('bureau_score', e.bureau_score);

  const gross = /gross monthly salary\s+([\d,]+(?:\.\d+)?)/i.exec(
    docs.salaryCertificate,
  );
  const ded = /deductions\s+([\d,]+(?:\.\d+)?)/i.exec(docs.salaryCertificate);
  if (gross && ded) {
    const net =
      Number(gross[1]!.replace(/,/g, '')) - Number(ded[1]!.replace(/,/g, ''));
    if (net !== e.net_monthly_income.value) {
      throw new UnverifiedExtraction(
        `net_monthly_income ${e.net_monthly_income.value} disagrees with gross - deductions (${net})`,
      );
    }
  }
}

/** The certificate issue date is read by code, not by the model (CP-5). */
export function certificateIssueDate(salaryCertificate: string): string | null {
  const m = new RegExp(
    `Issued:\\s*(\\d{1,2}\\s+(?:${MONTH_PATTERN})\\s+\\d{4})`,
    'i',
  ).exec(salaryCertificate);
  return m ? parseLongDate(m[1]!) : null;
}
