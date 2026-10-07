import {
  ageAtMaturityRule,
  amountAndTenorRule,
  minimumAgeRule,
  bureauScoreRule,
  dbrWithinLimit,
  debtBurdenRatio,
  displayDbr,
  employmentDurationRule,
  maxEligibleAmount,
  monthlyInstallment,
} from './calculations';
import { daysBetween, toDate } from './dates';
import {
  effectiveMaxTenor,
  type PolicyEdition,
  type ProductLimits,
} from './policy';

export type Outcome = 'pass' | 'fail' | 'refer' | 'not_assessed';
export type Recommendation =
  | 'approve'
  | 'offer_reduced_amount'
  | 'decline'
  | 'refer';

export interface RuleOutcome {
  rule: string;
  clause: string; // clause id inside the selected policy edition (or product sheet)
  result: Outcome;
  detail: string;
}

export interface RuleInputs {
  edition: PolicyEdition;
  product: ProductLimits;
  certificateMaxAgeDays: number;
  annualRatePercent: number;
  application: {
    amount: number;
    tenorMonths: number;
    dateOfBirth: string;
    applicationDate: string;
  };
  extracted: {
    netIncome: number;
    obligations: number;
    employmentStart: string;
    bureauScore: number;
  };
  certificateIssued: string | null;
}

export interface Calculation {
  annual_rate_percent: number;
  monthly_instalment: number;
  debt_burden_ratio: number;
  debt_burden_display: string;
  max_dbr: number;
  maximum_eligible_amount: number;
}

export interface RuleEvaluation {
  calculation: Calculation;
  rules: RuleOutcome[];
  recommendation: Recommendation;
  recommendedAmount: number | null;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function evaluateRules(input: RuleInputs): RuleEvaluation {
  const { edition: ed } = input;
  const i = {
    ...input,
    requestedAmount: input.application.amount,
    tenorMonths: input.application.tenorMonths,
    dateOfBirth: input.application.dateOfBirth,
    applicationDate: input.application.applicationDate,
    netIncome: input.extracted.netIncome,
    existingObligations: input.extracted.obligations,
    employmentStart: input.extracted.employmentStart,
    bureauScore: input.extracted.bureauScore,
  };
  const maxTenor = effectiveMaxTenor(i.product, ed);

  // numbers: pure functions only
  const instalment = monthlyInstallment(
    i.requestedAmount,
    i.annualRatePercent,
    i.tenorMonths,
  );
  const dbr = debtBurdenRatio(i.existingObligations, instalment, i.netIncome);
  const maxAmount = maxEligibleAmount(
    i.netIncome,
    i.existingObligations,
    ed.maxDbr,
    i.annualRatePercent,
    i.tenorMonths,
  );
  const calculation: Calculation = {
    annual_rate_percent: i.annualRatePercent,
    monthly_instalment: instalment.toNumber(),
    debt_burden_ratio: dbr.toDecimalPlaces(4).toNumber(),
    debt_burden_display: displayDbr(dbr),
    max_dbr: ed.maxDbr,
    maximum_eligible_amount: maxAmount,
  };

  const appDate = toDate(i.applicationDate);
  const rules: RuleOutcome[] = [];
  const add = (rule: string, clause: string, result: Outcome, detail: string) =>
    rules.push({ rule, clause, result, detail });

  const empResult = employmentDurationRule(
    toDate(i.employmentStart),
    appDate,
    ed.minEmploymentMonths,
  );
  add(
    'Employment duration',
    'CP-3.2',
    empResult,
    `Employed since ${i.employmentStart}; minimum ${ed.minEmploymentMonths} months`,
  );

  add(
    'Minimum net monthly income',
    'CP-3.3',
    i.netIncome >= ed.minNetIncome ? 'pass' : 'fail',
    `Net income EGP ${fmt(i.netIncome)}; minimum EGP ${fmt(ed.minNetIncome)}`,
  );

  add(
    'Minimum age at application',
    'CP-3.4',
    minimumAgeRule(toDate(i.dateOfBirth), appDate, ed.minAge),
    `Applicant must be at least ${ed.minAge} years old at application`,
  );

  const ageRes = ageAtMaturityRule(
    toDate(i.dateOfBirth),
    appDate,
    i.tenorMonths,
    ed.maxAgeAtMaturity,
  );
  add(
    'Age at maturity',
    'CP-3.5',
    ageRes,
    `Age at application plus ${i.tenorMonths} months must not exceed ${ed.maxAgeAtMaturity} years`,
  );

  add(
    'Credit bureau score',
    'CP-3.6',
    bureauScoreRule(i.bureauScore, ed.minBureauScore),
    `Score ${i.bureauScore}; minimum ${ed.minBureauScore} (below minimum: refer, not decline)`,
  );

  add(
    'Amount and tenor limits',
    'PS-3',
    amountAndTenorRule(i.requestedAmount, i.tenorMonths, {
      ...i.product,
      maxTenor,
    }),
    `Amount EGP ${fmt(i.product.minAmount)}-${fmt(i.product.maxAmount)}, tenor ${i.product.minTenor}-${maxTenor} months`,
  );

  let certResult: Outcome = 'refer';
  let certDetail = 'Certificate issue date could not be read';
  if (i.certificateIssued) {
    const age = daysBetween(toDate(i.certificateIssued), appDate);
    certResult = age >= 0 && age <= i.certificateMaxAgeDays ? 'pass' : 'fail';
    certDetail = `Certificate issued ${i.certificateIssued}, ${age} days before application; maximum ${i.certificateMaxAgeDays}`;
  }
  add('Salary certificate recency', 'CP-5', certResult, certDetail);

  const eligibilityOk = rules.every((r) => r.result === 'pass');
  const eligibilityFailed = rules.some((r) => r.result === 'fail');
  const dbrOk = dbrWithinLimit(dbr, ed.maxDbr);
  // CP-4.4: affordability is assessed only for applicants who satisfy eligibility.
  const affordabilityAssessed = !eligibilityFailed && eligibilityOk;
  add(
    'Debt burden ratio',
    'CP-4.1',
    affordabilityAssessed ? (dbrOk ? 'pass' : 'fail') : 'not_assessed',
    `DBR ${calculation.debt_burden_display}; maximum ${(ed.maxDbr * 100).toFixed(0)}%` +
      (affordabilityAssessed
        ? ''
        : ' (shown for information; CP-4.4 requires eligibility first)'),
  );

  let recommendation: Recommendation;
  let recommendedAmount: number | null = i.requestedAmount;
  if (eligibilityFailed) {
    recommendation = 'decline';
    recommendedAmount = null;
  } else if (!eligibilityOk) {
    recommendation = 'refer';
  } else if (dbrOk) {
    recommendation = 'approve';
  } else if (maxAmount >= i.product.minAmount) {
    recommendation = 'offer_reduced_amount';
    recommendedAmount = maxAmount;
  } else {
    recommendation = 'decline';
    recommendedAmount = null;
  }
  return { calculation, rules, recommendation, recommendedAmount };
}
