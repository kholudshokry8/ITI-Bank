import { PolicyEditionNotFound } from './errors';

export interface PolicyEdition {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null; // exclusive
  maxDbr: number;
  minNetIncome: number;
  minAge: number;
  maxAgeAtMaturity: number;
  minEmploymentMonths: number;
  minBureauScore: number;
  circularMaxTenor: number;
}

export interface ProductLimits {
  minAmount: number;
  maxAmount: number;
  minTenor: number;
  maxTenor: number;
}

export interface PolicyConfig {
  editions: PolicyEdition[];
  product: ProductLimits;
  certificateMaxAgeDays: number;
  authorityLimits: Record<string, number>;
}

/** The edition in force on the application date (ISO yyyy-mm-dd). Code, never the LLM. */
export function selectEdition(
  editions: PolicyEdition[],
  applicationDate: string,
): PolicyEdition {
  const hits = editions.filter(
    (e) =>
      e.effectiveFrom <= applicationDate &&
      (e.effectiveTo === null || applicationDate < e.effectiveTo),
  );
  if (hits.length !== 1) throw new PolicyEditionNotFound(applicationDate);
  return hits[0]!;
}

/** Product sheet PS-3: 60 months or the circular maximum, whichever is lower. */
export const effectiveMaxTenor = (
  product: ProductLimits,
  edition: PolicyEdition,
): number => Math.min(product.maxTenor, edition.circularMaxTenor);
