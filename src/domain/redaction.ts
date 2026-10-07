import type { ApplicationForm } from './application';

/** Fields that must never influence a decision (CP-9, PM-6, Circular 2025/02 C-4). */
export const PROTECTED_FIELDS = [
  'gender',
  'marital_status',
  'religion',
  'nationality',
] as const;

export type CleanForm = Omit<
  ApplicationForm,
  | 'gender'
  | 'maritalStatus'
  | 'religion'
  | 'nationality'
  | 'fullName'
  | 'nationalId'
  | 'mobile'
>;

export interface RedactedForm {
  clean: CleanForm;
  fieldsRemoved: readonly string[];
  fieldsMasked: string[];
}

/** Drops protected attributes from the structured form and masks direct identifiers. */
export function redactForm(form: ApplicationForm): RedactedForm {
  const {
    gender: _g,
    maritalStatus: _m,
    religion: _r,
    nationality: _n,
    fullName: _f,
    nationalId: _i,
    mobile: _p,
    ...clean
  } = form;
  return {
    clean,
    fieldsRemoved: PROTECTED_FIELDS,
    fieldsMasked: ['full_name', 'national_id', 'mobile'],
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Redacts free text before it is sent to any LLM: protected attributes (including gendered
 * titles and pronouns, which appear inside salary certificates), the applicant's name,
 * national ID numbers and phone numbers.
 */
export function redactText(
  text: string,
  form: Pick<ApplicationForm, 'fullName'>,
): string {
  let out = text;
  const nameParts = [
    form.fullName,
    ...form.fullName.split(/\s+/).filter((p) => p.length >= 3),
  ];
  for (const part of nameParts) {
    out = out.replace(
      new RegExp(`\\b${escapeRe(part)}\\b`, 'gi'),
      '[APPLICANT]',
    );
  }
  out = out.replace(/\b\d{14}\b/g, '[NATIONAL_ID]');
  out = out.replace(/\b0\d{2}[- ]?\d{4}[- ]?\d{4}\b/g, '[PHONE]');
  out = out.replace(/\b(Mr|Mrs|Ms|Miss|Mx)\b\.?/g, '[TITLE]');
  out = out.replace(
    /\b(he|she|his|her|hers|him|himself|herself)\b/gi,
    '[PRONOUN]',
  );
  out = out.replace(
    /\b(muslim|christian|coptic|egyptian|married|single|divorced|widowed|male|female)\b/gi,
    '[REDACTED]',
  );
  return out;
}
