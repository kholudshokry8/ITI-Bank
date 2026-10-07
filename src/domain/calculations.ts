import Decimal from 'decimal.js';

// Pure functions: no database, network, or LLM imports allowed in this file.

export type RuleResult = 'pass' | 'fail' | 'refer';

const toMoney = (d: Decimal): Decimal =>
  d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Reducing-balance installment: P*r / (1 - (1+r)^-n), rounded half-up to 2dp. */
export function monthlyInstallment(
  principal: number,
  annualRatePercent: number,
  months: number,
): Decimal {
  if (principal <= 0 || months <= 0 || annualRatePercent < 0) {
    throw new RangeError('principal and months must be > 0, rate >= 0');
  }
  const P = new Decimal(principal);
  const r = new Decimal(annualRatePercent).div(100).div(12);
  if (r.isZero()) return toMoney(P.div(months));
  const factor = new Decimal(1).minus(r.plus(1).pow(-months));
  return toMoney(P.mul(r).div(factor));
}

/** Exact DBR (not rounded). Use displayDbr() for presentation only. */
export function debtBurdenRatio(
  existingObligations: number,
  installment: Decimal,
  netIncome: number,
): Decimal {
  if (netIncome <= 0) throw new RangeError('netIncome must be > 0');
  return installment.plus(existingObligations).div(netIncome);
}

export const displayDbr = (dbr: Decimal): string =>
  dbr.mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) + '%';

/** Compares the exact value; exactly at the limit passes. */
export const dbrWithinLimit = (dbr: Decimal, maxDbr: number): boolean =>
  dbr.lte(maxDbr);

/** Largest P whose installment keeps DBR <= max, rounded DOWN to nearest 1,000. */
export function maxEligibleAmount(
  netIncome: number,
  existingObligations: number,
  maxDbr: number,
  annualRatePercent: number,
  months: number,
): number {
  const cap = new Decimal(netIncome).mul(maxDbr).minus(existingObligations);
  if (cap.lte(0)) return 0;
  const r = new Decimal(annualRatePercent).div(100).div(12);
  const raw = r.isZero()
    ? cap.mul(months)
    : cap.mul(new Decimal(1).minus(r.plus(1).pow(-months))).div(r);
  return raw.div(1000).floor().mul(1000).toNumber();
}

const monthsBetween = (from: Date, to: Date): number => {
  let m =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) m -= 1;
  return m;
};

/** Applicant must be at least `minAgeYears` old on the application date. */
export function minimumAgeRule(
  dateOfBirth: Date,
  applicationDate: Date,
  minAgeYears: number,
): RuleResult {
  return monthsBetween(dateOfBirth, applicationDate) >= minAgeYears * 12
    ? 'pass'
    : 'fail';
}

/** Age at application + tenor <= max age. Exactly at the limit passes. */
export function ageAtMaturityRule(
  dateOfBirth: Date,
  applicationDate: Date,
  tenorMonths: number,
  maxAgeYears: number,
): RuleResult {
  const ageMonths = monthsBetween(dateOfBirth, applicationDate);
  return ageMonths + tenorMonths <= maxAgeYears * 12 ? 'pass' : 'fail';
}

export function employmentDurationRule(
  employmentStart: Date,
  applicationDate: Date,
  minMonths: number,
): RuleResult {
  return monthsBetween(employmentStart, applicationDate) >= minMonths
    ? 'pass'
    : 'fail';
}

/** Below threshold => refer to human, never an automatic decline. */
export const bureauScoreRule = (score: number, minScore: number): RuleResult =>
  score >= minScore ? 'pass' : 'refer';

export function amountAndTenorRule(
  amount: number,
  tenorMonths: number,
  limits: {
    minAmount: number;
    maxAmount: number;
    minTenor: number;
    maxTenor: number;
  },
): RuleResult {
  const ok =
    amount >= limits.minAmount &&
    amount <= limits.maxAmount &&
    tenorMonths >= limits.minTenor &&
    tenorMonths <= limits.maxTenor;
  return ok ? 'pass' : 'fail';
}
