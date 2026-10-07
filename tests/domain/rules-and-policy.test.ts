import { describe, expect, it } from 'vitest';
import {
  assertCanApprove,
  assertCanReject,
  requiredRole,
} from '../../src/domain/approval';
import { minimumAgeRule } from '../../src/domain/calculations';
import {
  AuthorityLimitExceeded,
  FourEyesViolation,
  InvalidStateTransition,
  PolicyEditionNotFound,
  PricingNotFound,
} from '../../src/domain/errors';
import { loadPolicyConfig } from '../../src/infra/config';
import { effectiveMaxTenor, selectEdition } from '../../src/domain/policy';
import { parsePricingCsv, rateFor, segmentFor } from '../../src/domain/pricing';
import { evaluateRules, type RuleInputs } from '../../src/domain/rules';
import { readFileSync } from 'node:fs';

const policy = loadPolicyConfig();
const pricing = parsePricingCsv(
  readFileSync('data/policy/pricing-table.csv', 'utf8'),
);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('policy edition selection', () => {
  it('uses 2024 until the day before 1 March 2025 and 2025 from that day', () => {
    expect(selectEdition(policy.editions, '2025-02-28').id).toBe('CP-2024');
    expect(selectEdition(policy.editions, '2025-03-01').id).toBe('CP-2025');
    expect(selectEdition(policy.editions, '2024-01-01').id).toBe('CP-2024');
  });
  it('throws a named error when no edition is in force', () => {
    expect(() => selectEdition(policy.editions, '2023-12-31')).toThrow(
      PolicyEditionNotFound,
    );
  });
  it('caps tenor at the lower of product sheet and circular', () => {
    expect(effectiveMaxTenor(policy.product, policy.editions[1]!)).toBe(60); // circular allows 72, product says 60
  });
});

describe('pricing from the CSV', () => {
  it('selects by tenor band and segment', () => {
    expect(rateFor(pricing, 36, 'standard')).toBe(22);
    expect(rateFor(pricing, 37, 'standard')).toBe(24);
    expect(rateFor(pricing, 60, segmentFor(true))).toBe(22);
  });
  it('throws when no band matches', () => {
    expect(() => rateFor(pricing, 6, 'standard')).toThrow(PricingNotFound);
  });
});

describe('minimum age', () => {
  it('21 on the day passes, one day short fails', () => {
    expect(minimumAgeRule(d('2004-03-01'), d('2025-03-01'), 21)).toBe('pass');
    expect(minimumAgeRule(d('2004-03-02'), d('2025-03-01'), 21)).toBe('fail');
  });
});

const base = (
  over: Partial<RuleInputs['application']> = {},
  ex: Partial<RuleInputs['extracted']> = {},
): RuleInputs => ({
  edition: policy.editions[1]!,
  product: policy.product,
  certificateMaxAgeDays: 60,
  annualRatePercent: 24,
  application: {
    amount: 300_000,
    tenorMonths: 60,
    dateOfBirth: '1987-04-12',
    applicationDate: '2025-04-03',
    ...over,
  },
  extracted: {
    netIncome: 30_000,
    obligations: 4_000,
    employmentStart: '2019-09-01',
    bureauScore: 712,
    ...ex,
  },
  certificateIssued: '2025-03-28',
});

describe('rules engine', () => {
  it('approves the worked example under 2025', () => {
    const r = evaluateRules(base());
    expect(r.recommendation).toBe('approve');
    expect(r.calculation.monthly_instalment).toBe(8630.39);
    expect(r.calculation.debt_burden_display).toBe('42.10%');
  });
  it('S1: same figures pass under 2024 (50%) but get a reduced offer under 2025 (45%)', () => {
    const request = { amount: 350_000 };
    const under2025 = evaluateRules(base(request));
    const under2024 = evaluateRules({
      ...base(request),
      edition: policy.editions[0]!,
    });
    expect(under2025.recommendation).toBe('offer_reduced_amount');
    expect(under2025.recommendedAmount).toBe(330_000);
    expect(under2024.recommendation).toBe('approve');
  });
  it('declines when age at maturity exceeds 60', () => {
    expect(
      evaluateRules(
        base({ dateOfBirth: '1968-06-20', applicationDate: '2025-04-10' }),
      ).recommendation,
    ).toBe('decline');
  });
  it('a low bureau score refers, it does not decline', () => {
    expect(evaluateRules(base({}, { bureauScore: 580 })).recommendation).toBe(
      'refer',
    );
  });
  it('does not assess DBR when eligibility fails (CP-4.4)', () => {
    const r = evaluateRules(base({}, { netIncome: 9_000 }));
    expect(r.rules.find((x) => x.clause === 'CP-4.1')!.result).toBe(
      'not_assessed',
    );
  });
  it('a stale salary certificate fails CP-5', () => {
    expect(
      evaluateRules({ ...base(), certificateIssued: '2025-01-01' })
        .recommendation,
    ).toBe('decline');
  });
});

describe('approval authority (S6)', () => {
  const pending = {
    status: 'pending_approval' as const,
    recommendation: 'approve' as const,
    recommendedAmount: 300_000,
    preparedBy: 'u-loan',
  };
  it('credit officer cannot approve above 250,000', () => {
    expect(() =>
      assertCanApprove(policy.authorityLimits, pending, {
        id: 'u-credit',
        role: 'credit_officer',
      }),
    ).toThrow(AuthorityLimitExceeded);
  });
  it('senior can approve 300,000; exactly 250,000 is allowed for a credit officer', () => {
    expect(() =>
      assertCanApprove(policy.authorityLimits, pending, {
        id: 'u-senior',
        role: 'senior_credit_officer',
      }),
    ).not.toThrow();
    expect(() =>
      assertCanApprove(
        policy.authorityLimits,
        { ...pending, recommendedAmount: 250_000 },
        { id: 'u-credit', role: 'credit_officer' },
      ),
    ).not.toThrow();
  });
  it('loan officer may not approve; the preparer may not approve their own file', () => {
    expect(() =>
      assertCanApprove(policy.authorityLimits, pending, {
        id: 'x',
        role: 'loan_officer',
      }),
    ).toThrow(AuthorityLimitExceeded);
    expect(() =>
      assertCanApprove(policy.authorityLimits, pending, {
        id: 'u-loan',
        role: 'senior_credit_officer',
      }),
    ).toThrow(FourEyesViolation);
    expect(() =>
      assertCanReject(policy.authorityLimits, pending, {
        id: 'u-loan',
        role: 'credit_officer',
      }),
    ).toThrow(FourEyesViolation);
  });
  it('referred files need a senior; declines cannot be approved; no double decisions', () => {
    const referred = {
      ...pending,
      recommendation: 'refer' as const,
      recommendedAmount: 100_000,
    };
    expect(() =>
      assertCanApprove(policy.authorityLimits, referred, {
        id: 'c',
        role: 'credit_officer',
      }),
    ).toThrow(AuthorityLimitExceeded);
    expect(() =>
      assertCanApprove(
        policy.authorityLimits,
        { ...pending, recommendation: 'decline' },
        { id: 's', role: 'senior_credit_officer' },
      ),
    ).toThrow(InvalidStateTransition);
    expect(() =>
      assertCanApprove(
        policy.authorityLimits,
        { ...pending, status: 'approved' },
        { id: 's', role: 'senior_credit_officer' },
      ),
    ).toThrow(InvalidStateTransition);
  });
  it('computes the lowest role that can approve an amount', () => {
    expect(requiredRole(policy.authorityLimits, 250_000, 'approve')).toBe(
      'credit_officer',
    );
    expect(requiredRole(policy.authorityLimits, 300_000, 'approve')).toBe(
      'senior_credit_officer',
    );
    expect(requiredRole(policy.authorityLimits, 50_000, 'refer')).toBe(
      'senior_credit_officer',
    );
  });
});
