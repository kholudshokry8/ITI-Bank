import { InvalidApplication } from './errors';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export const MONTH_PATTERN = MONTHS.map(
  (m) => m[0]!.toUpperCase() + m.slice(1),
).join('|');

/** "15 March 2025" -> "2025-03-15". Returns null when it does not match. */
export function parseLongDate(text: string): string | null {
  const m = new RegExp(
    `(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})`,
    'i',
  ).exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

export function toDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
    throw new InvalidApplication(`Bad date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()))
    throw new InvalidApplication(`Bad date: ${iso}`);
  return d;
}

export const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / 86_400_000);
