import { describe, expect, it } from 'vitest';
import {
  ageAtMaturityRule,
  amountAndTenorRule,
  bureauScoreRule,
  dbrWithinLimit,
  debtBurdenRatio,
  displayDbr,
  employmentDurationRule,
  maxEligibleAmount,
  monthlyInstallment,
} from '../../src/domain/calculations';

const d = (s: string) => new Date(s + 'T00:00:00Z');

describe('worked example (S2 / APP-001)', () => {
  const inst = monthlyInstallment(300_000, 24, 60);
  it('installment is exactly 8630.39', () => {
    expect(inst.toFixed(2)).toBe('8630.39');
  });
  it('DBR is 42.10%', () => {
    expect(displayDbr(debtBurdenRatio(4000, inst, 30_000))).toBe('42.10%');
  });
  it('max eligible amount at 50% is 382,000', () => {
    expect(maxEligibleAmount(30_000, 4000, 0.5, 24, 60)).toBe(382_000);
  });
});

describe('S1 edition change', () => {
  const inst = monthlyInstallment(350_000, 24, 60);
  const dbr = debtBurdenRatio(4000, inst, 30_000);
  it('installment 10068.79, DBR 46.90%', () => {
    expect(inst.toFixed(2)).toBe('10068.79');
    expect(displayDbr(dbr)).toBe('46.90%');
  });
  it('passes under 2024 (50%) and fails under 2025 (45%)', () => {
    expect(dbrWithinLimit(dbr, 0.5)).toBe(true);
    expect(dbrWithinLimit(dbr, 0.45)).toBe(false);
  });
  it('max eligible under 45% is 330,000', () => {
    expect(maxEligibleAmount(30_000, 4000, 0.45, 24, 60)).toBe(330_000);
  });
});

describe('edge cases', () => {
  it('DBR exactly at the limit passes (compares exact value)', () => {
    // installment 6000 + 9000 existing = 15000 / 30000 = 0.5 exactly
    const dbr = debtBurdenRatio(9000, monthlyInstallment(6000, 0, 1), 30_000);
    expect(dbr.toString()).toBe('0.5');
    expect(dbrWithinLimit(dbr, 0.5)).toBe(true);
  });
  it('DBR slightly above the limit fails even if display rounds to limit', () => {
    const dbr = debtBurdenRatio(9000.1, monthlyInstallment(6000, 0, 1), 30_000);
    expect(displayDbr(dbr)).toBe('50.00%');
    expect(dbrWithinLimit(dbr, 0.5)).toBe(false);
  });
  it('zero existing obligations', () => {
    const inst = monthlyInstallment(300_000, 24, 60);
    expect(displayDbr(debtBurdenRatio(0, inst, 30_000))).toBe('28.77%');
    expect(maxEligibleAmount(30_000, 0, 0.5, 24, 60)).toBeGreaterThan(382_000);
  });
  it('no headroom => max eligible is 0', () => {
    expect(maxEligibleAmount(30_000, 15_000, 0.5, 24, 60)).toBe(0);
    expect(maxEligibleAmount(30_000, 20_000, 0.5, 24, 60)).toBe(0);
  });
  it('rounds half-up to 2dp', () => {
    expect(monthlyInstallment(1000, 0, 8).toFixed(2)).toBe('125.00');
    expect(monthlyInstallment(100, 0, 3).toFixed(2)).toBe('33.33');
    expect(monthlyInstallment(200, 0, 3).toFixed(2)).toBe('66.67');
  });
  it('rejects invalid inputs', () => {
    expect(() => monthlyInstallment(0, 24, 60)).toThrow(RangeError);
    expect(() => monthlyInstallment(1000, 24, 0)).toThrow(RangeError);
    expect(() => debtBurdenRatio(0, monthlyInstallment(1000, 0, 1), 0)).toThrow(
      RangeError,
    );
  });
});

describe('age at maturity (max 60)', () => {
  it('exactly at the limit passes', () => {
    // born 1970-01-01, applies 2020-01-01 (age 50), 120 months => 60
    expect(ageAtMaturityRule(d('1970-01-01'), d('2020-01-01'), 120, 60)).toBe(
      'pass',
    );
  });
  it('one month over fails', () => {
    expect(ageAtMaturityRule(d('1970-01-01'), d('2020-01-01'), 121, 60)).toBe(
      'fail',
    );
  });
  it('birthday not yet reached in the application month counts as younger', () => {
    // 49y 11m old; 121 months => 49y11m + 10y1m = 60y exactly
    expect(ageAtMaturityRule(d('1970-02-15'), d('2020-01-20'), 121, 60)).toBe(
      'pass',
    );
  });
});

describe('employment, bureau, limits', () => {
  it('employment duration', () => {
    expect(employmentDurationRule(d('2024-01-01'), d('2025-01-01'), 12)).toBe(
      'pass',
    );
    expect(employmentDurationRule(d('2024-01-02'), d('2025-01-01'), 12)).toBe(
      'fail',
    );
  });
  it('low bureau score refers to human, never auto-declines', () => {
    expect(bureauScoreRule(650, 650)).toBe('pass');
    expect(bureauScoreRule(649, 650)).toBe('refer');
  });
  const limits = {
    minAmount: 20_000,
    maxAmount: 500_000,
    minTenor: 12,
    maxTenor: 60,
  };
  it('amount and tenor at the product min/max pass, outside fail', () => {
    expect(amountAndTenorRule(20_000, 12, limits)).toBe('pass');
    expect(amountAndTenorRule(500_000, 60, limits)).toBe('pass');
    expect(amountAndTenorRule(19_999, 12, limits)).toBe('fail');
    expect(amountAndTenorRule(500_001, 60, limits)).toBe('fail');
    expect(amountAndTenorRule(100_000, 61, limits)).toBe('fail');
  });
});
