import {
  debtBurdenRatio,
  displayDbr,
  maxEligibleAmount,
  monthlyInstallment,
} from '../../domain/calculations';

export function evaluateCalculation(
  amount: number,
  tenor: number,
  rate: number,
  income: number,
  obligations: number,
  maxDbr: number,
) {
  const inst = monthlyInstallment(amount, rate, tenor);
  const dbr = debtBurdenRatio(obligations, inst, income);
  return {
    annual_rate_percent: rate,
    monthly_instalment: inst.toNumber(),
    debt_burden_ratio: dbr.toDecimalPlaces(4).toNumber(),
    debt_burden_display: displayDbr(dbr),
    within_limit: dbr.lte(maxDbr),
    max_dbr: maxDbr,
    maximum_eligible_amount: maxEligibleAmount(
      income,
      obligations,
      maxDbr,
      rate,
      tenor,
    ),
  };
}
