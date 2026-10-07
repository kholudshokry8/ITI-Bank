import { z } from 'zod';
import { parseLongDate, toDate } from './dates';
import { InvalidApplication } from './errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ApplicationFormSchema = z.object({
  reference: z.string().regex(/^APP-\d{3}$/),
  applicationDate: isoDate,
  branch: z.string().min(1),
  fullName: z.string().min(1),
  nationalId: z.string().min(1),
  dateOfBirth: isoDate,
  gender: z.string(),
  maritalStatus: z.string(),
  religion: z.string(),
  nationality: z.string(),
  mobile: z.string(),
  employer: z.string().min(1),
  jobTitle: z.string().min(1),
  requestedAmount: z.number().positive(),
  tenorMonths: z.number().int().positive(),
  purpose: z.string().min(1),
  salaryTransferred: z.boolean(),
  preparedBy: z.string().min(1),
});
export type ApplicationForm = z.infer<typeof ApplicationFormSchema>;

export interface ApplicationPack {
  formText: string;
  salaryCertificateText: string;
  bureauSummaryText: string;
}

/** Splits the extracted PDF text of a pack into its three parts. Pure string work. */
export function splitPack(text: string): ApplicationPack {
  const p2 = /^Part 2\s+—.*$/m.exec(text);
  const p3 = /^Part 3\s+—.*$/m.exec(text);
  if (!p2 || !p3)
    throw new InvalidApplication(
      'Pack does not contain Part 2 and Part 3 headings',
    );
  return {
    formText: text.slice(0, p2.index).trim(),
    salaryCertificateText: text.slice(p2.index, p3.index).trim(),
    bureauSummaryText: text.slice(p3.index).trim(),
  };
}

const LABELS: Array<[keyof RawForm, string]> = [
  ['reference', 'Application reference'],
  ['applicationDate', 'Application date'],
  ['branch', 'Branch'],
  ['fullName', 'Full name'],
  ['nationalId', 'National ID (synthetic)'],
  ['dateOfBirth', 'Date of birth'],
  ['gender', 'Gender'],
  ['maritalStatus', 'Marital status'],
  ['religion', 'Religion (declared for statistics only)'],
  ['nationality', 'Nationality'],
  ['mobile', 'Mobile'],
  ['employer', 'Employer'],
  ['jobTitle', 'Job title'],
  ['requestedAmount', 'Requested amount'],
  ['tenorMonths', 'Requested tenor'],
  ['purpose', 'Purpose'],
  ['salaryTransferred', 'Salary transferred to Delta'],
  ['preparedBy', 'Prepared by'],
];
type RawForm = Record<
  | 'reference'
  | 'applicationDate'
  | 'branch'
  | 'fullName'
  | 'nationalId'
  | 'dateOfBirth'
  | 'gender'
  | 'maritalStatus'
  | 'religion'
  | 'nationality'
  | 'mobile'
  | 'employer'
  | 'jobTitle'
  | 'requestedAmount'
  | 'tenorMonths'
  | 'purpose'
  | 'salaryTransferred'
  | 'preparedBy',
  string
>;

/** Reads "Label value" lines of the form and validates the result against the schema. */
export function parseApplicationForm(formText: string): ApplicationForm {
  const lines = formText.split('\n').map((l) => l.trim());
  const raw = {} as Partial<RawForm>;
  for (const [key, label] of LABELS) {
    const line = lines.find((l) => l.startsWith(label + ' '));
    if (line) raw[key] = line.slice(label.length).trim();
  }
  const money = (s?: string) => Number((s ?? '').replace(/[^\d.]/g, ''));
  const candidate = {
    ...raw,
    applicationDate: parseLongDate(raw.applicationDate ?? ''),
    dateOfBirth: parseLongDate(raw.dateOfBirth ?? ''),
    requestedAmount: money(raw.requestedAmount),
    tenorMonths: money(raw.tenorMonths),
    salaryTransferred: /^yes$/i.test(raw.salaryTransferred ?? ''),
  };
  const parsed = ApplicationFormSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidApplication(
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  const form = parsed.data;
  if (toDate(form.dateOfBirth) >= toDate(form.applicationDate)) {
    throw new InvalidApplication(
      'Date of birth must be before the application date',
    );
  }
  return form;
}
