/** Heuristic detector for instructions hidden in customer documents (PM-7). Findings are logged. */
const PATTERNS: Array<[string, RegExp]> = [
  [
    'ignore_instructions',
    /ignore (all |any )?(previous|prior|above) instructions/i,
  ],
  ['system_note', /system note|note for the (automated )?reviewer/i],
  ['approve_command', /\bapprove this application\b/i],
  ['skip_referral', /do not refer/i],
  ['override_claim', /already been completed by head office/i],
];

export interface InjectionFinding {
  pattern: string;
  excerpt: string;
}

export function detectInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [pattern, re] of PATTERNS) {
    const m = re.exec(text);
    if (m)
      findings.push({
        pattern,
        excerpt: text
          .slice(Math.max(0, m.index - 20), m.index + 80)
          .replace(/\s+/g, ' '),
      });
  }
  return findings;
}
