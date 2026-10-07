import { PricingNotFound } from './errors';

export interface PricingRow {
  documentId: string;
  tenorFrom: number;
  tenorTo: number;
  segment: string;
  annualRatePercent: number;
}

export function parsePricingCsv(csv: string): PricingRow[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const cols = header!.split(',');
  const idx = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0)
      throw new PricingNotFound(`Pricing CSV is missing column ${name}`);
    return i;
  };
  return lines.map((line) => {
    const c = line.split(',');
    return {
      documentId: c[idx('document_id')]!,
      tenorFrom: Number(c[idx('tenor_from_months')]),
      tenorTo: Number(c[idx('tenor_to_months')]),
      segment: c[idx('segment')]!,
      annualRatePercent: Number(c[idx('annual_rate_percent')]),
    };
  });
}

export function rateFor(
  rows: PricingRow[],
  tenorMonths: number,
  segment: string,
): number {
  const row = rows.find(
    (r) =>
      r.segment === segment &&
      tenorMonths >= r.tenorFrom &&
      tenorMonths <= r.tenorTo,
  );
  if (!row)
    throw new PricingNotFound(
      `No rate for ${tenorMonths} months, segment ${segment}`,
    );
  return row.annualRatePercent;
}

/** Standard pricing unless the salary is transferred to Delta (Appendix D). */
export const segmentFor = (salaryTransferred: boolean): string =>
  salaryTransferred ? 'payroll_transfer' : 'standard';
