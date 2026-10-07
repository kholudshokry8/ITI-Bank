import {
  parseApplicationForm,
  type ApplicationPack,
} from '../domain/application';
import { requiredRole, type Role } from '../domain/approval';
import {
  DomainError,
  EvidenceMissing,
  InvalidLLMOutput,
} from '../domain/errors';
import {
  certificateIssueDate,
  parseExtraction,
  verifyExtraction,
  type Extraction,
} from '../domain/extraction';
import { detectInjection, type InjectionFinding } from '../domain/injection';
import {
  selectEdition,
  type PolicyConfig,
  type PolicyEdition,
} from '../domain/policy';
import { rateFor, segmentFor, type PricingRow } from '../domain/pricing';
import { PROTECTED_FIELDS, redactForm, redactText } from '../domain/redaction';
import {
  evaluateRules,
  type Calculation,
  type Recommendation,
  type RuleOutcome,
} from '../domain/rules';
import { inScope } from './qa';
import {
  renderTemplate,
  type KnowledgeStore,
  type LlmProvider,
  type Prompts,
  type Tokens,
} from './ports';

export interface PipelineDeps {
  llm: LlmProvider;
  knowledge: KnowledgeStore;
  policy: PolicyConfig;
  pricing: PricingRow[];
  prompts: Prompts;
  newId: () => string;
}

export interface StepLog {
  step: string;
  status: 'ok' | 'failed';
  detail?: string;
}
export interface RunLog {
  request_id: string;
  run_id: string;
  steps: StepLog[];
  chunk_ids_retrieved: string[];
  policy_edition: string | null;
  fields_removed: string[];
  tokens: Tokens;
  injection_findings: InjectionFinding[];
}
export interface AssessmentResult {
  application_id: string;
  run_id: string;
  policy_edition: string | null;
  protected_attributes_removed: string[];
  fields_masked: string[];
  extraction: Extraction | null;
  calculation: Calculation | null;
  rule_results: Array<RuleOutcome & { citation: string | null }>;
  recommendation: Recommendation;
  recommended_amount: number | null;
  approval_required_from: Role;
  status: 'pending_approval';
  refer_reasons: string[];
  security_flags: string[];
  memo: string;
  log: RunLog;
}

/** One search query per rule: what a credit officer would look up to find the clause. */
export const RULE_QUERIES: Record<string, string> = {
  'CP-3.2': 'minimum employment duration months with current employer',
  'CP-3.3': 'minimum net monthly income',
  'CP-3.4': 'minimum age at application',
  'CP-3.5': 'maximum age at maturity',
  'CP-3.6': 'credit bureau score minimum',
  'PS-3': 'minimum and maximum loan amount and tenor',
  'CP-5':
    'income verification salary certificate issued within the last 60 days',
  'CP-4.1': 'maximum debt burden ratio',
};

const MEMO_TOKEN = /\[\[(\w+)\]\]/g;
const ID_PATTERN = /[A-Z]{1,4}(?:-[A-Z0-9]+)*-\d+(?:\.\d+)?|\d{4}\/\d{2}/g;

/** The model may not type numbers: after removing placeholders and clause ids, no digit may remain. */
export function validateMemo(
  text: string,
  facts: Record<string, string>,
): string {
  const stripped = text.replace(MEMO_TOKEN, '').replace(ID_PATTERN, '');
  if (/\d/.test(stripped))
    throw new InvalidLLMOutput('Memo contains numbers not supplied by code');
  const unknown = [...text.matchAll(MEMO_TOKEN)].find((m) => !(m[1]! in facts));
  if (unknown)
    throw new InvalidLLMOutput(`Memo uses unknown placeholder ${unknown[0]}`);
  return text.replace(MEMO_TOKEN, (_, k: string) => facts[k]!);
}

const egp = (n: number) => `EGP ${n.toLocaleString('en-US')}`;

export async function assessApplication(
  deps: PipelineDeps,
  pack: ApplicationPack,
  ctx: { applicationId: string; requestId: string },
): Promise<AssessmentResult> {
  const runId = deps.newId();
  const log: RunLog = {
    request_id: ctx.requestId,
    run_id: runId,
    steps: [],
    chunk_ids_retrieved: [],
    policy_edition: null,
    fields_removed: [],
    tokens: { input: 0, output: 0 },
    injection_findings: [],
  };
  const state: {
    edition?: PolicyEdition;
    extraction?: Extraction;
    calculation?: Calculation;
    rules: AssessmentResult['rule_results'];
    recommendation: Recommendation;
    amount: number | null;
    requested: number | null;
    referReasons: string[];
    flags: string[];
    memo: string;
  } = {
    rules: [],
    recommendation: 'refer',
    amount: null,
    requested: null,
    referReasons: [],
    flags: [],
    memo: '',
  };

  const step = async <T>(
    name: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      const r = await fn();
      log.steps.push({ step: name, status: 'ok' });
      return r;
    } catch (err) {
      log.steps.push({
        step: name,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
  const addTokens = (t: Tokens) => {
    log.tokens.input += t.input;
    log.tokens.output += t.output;
  };

  try {
    const form = await step('load_application', () =>
      parseApplicationForm(pack.formText),
    );
    state.requested = form.requestedAmount;

    const redacted = await step('remove_protected_attributes', () =>
      redactForm(form),
    );
    log.fields_removed = [...PROTECTED_FIELDS];
    const certificate = redactText(pack.salaryCertificateText, form);
    const bureau = redactText(pack.bureauSummaryText, form);

    const edition = await step('select_policy_edition', () =>
      selectEdition(deps.policy.editions, redacted.clean.applicationDate),
    );
    state.edition = edition;
    log.policy_edition = edition.id;

    log.injection_findings = detectInjection(`${certificate}\n${bureau}`);
    if (log.injection_findings.length > 0) {
      state.flags.push('suspected_tampering');
      state.referReasons.push(
        'Instructions found inside a customer document (PM-7): refer and report to the Fraud Unit',
      );
    }

    const extraction = await step('extract_applicant_data', async () => {
      const res = await deps.llm.complete({
        task: 'extract',
        json: true,
        system: deps.prompts.extractSystem,
        user: renderTemplate(deps.prompts.extractUser, {
          source_document: `${ctx.applicationId}.pdf`,
          salary_certificate: certificate,
          bureau_summary: bureau,
        }),
      });
      addTokens(res.tokens);
      return parseExtraction(res.text);
    });
    await step('verify_extraction', () =>
      verifyExtraction(extraction, {
        salaryCertificate: certificate,
        bureauSummary: bureau,
      }),
    );
    state.extraction = extraction;

    const rate = rateFor(
      deps.pricing,
      redacted.clean.tenorMonths,
      segmentFor(redacted.clean.salaryTransferred),
    );
    const evaluation = evaluateRules({
      edition,
      product: deps.policy.product,
      certificateMaxAgeDays: deps.policy.certificateMaxAgeDays,
      annualRatePercent: rate,
      application: {
        amount: redacted.clean.requestedAmount,
        tenorMonths: redacted.clean.tenorMonths,
        dateOfBirth: redacted.clean.dateOfBirth,
        applicationDate: redacted.clean.applicationDate,
      },
      extracted: {
        netIncome: extraction.net_monthly_income.value,
        obligations: extraction.existing_monthly_obligations.value,
        employmentStart: extraction.employment_start_date.value,
        bureauScore: extraction.bureau_score.value,
      },
      certificateIssued: certificateIssueDate(certificate),
    });

    const citations = await step('retrieve_policy_clauses', async () => {
      const clauses = evaluation.rules.map((r) => r.clause);
      const emb = await deps.llm.embed(
        clauses.map((c) => RULE_QUERIES[c] ?? c),
      );
      addTokens({ input: emb.tokens, output: 0 });
      const found: Record<string, string> = {};
      for (const [i, clause] of clauses.entries()) {
        const hits = await deps.knowledge.search(emb.vectors[i]!, {
          k: 8,
          model: emb.model,
          filter: inScope(edition.id, redacted.clean.applicationDate),
        });
        hits.forEach(
          (h) =>
            log.chunk_ids_retrieved.includes(h.chunk.id) ||
            log.chunk_ids_retrieved.push(h.chunk.id),
        );
        const hit = hits.find((h) => h.chunk.clauseId === clause);
        if (!hit)
          throw new EvidenceMissing(
            `Clause ${clause} was not retrieved for edition ${edition.id}`,
          );
        found[clause] = hit.chunk.id;
      }
      return found;
    });

    await step('calculate_and_check_rules', () => {
      state.calculation = evaluation.calculation;
      state.rules = evaluation.rules.map((r) => ({
        ...r,
        citation: citations[r.clause] ?? null,
      }));
      state.recommendation = evaluation.recommendation;
      state.amount = evaluation.recommendedAmount;
      for (const r of evaluation.rules.filter((x) => x.result === 'refer')) {
        state.referReasons.push(`${r.clause}: ${r.detail}`);
      }
    });
    if (state.flags.includes('suspected_tampering'))
      state.recommendation = 'refer';

    state.memo = await step('draft_credit_memo', () =>
      draftMemo(deps, ctx.applicationId, edition, state, addTokens),
    );
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    state.recommendation = 'refer';
    state.referReasons.push(`${err.code}: ${err.message}`);
    state.memo = `Referred to a human credit officer: ${err.message}.`;
  }

  const requiredAmount = state.amount ?? state.requested ?? 0;
  return {
    application_id: ctx.applicationId,
    run_id: runId,
    policy_edition: state.edition?.id ?? null,
    protected_attributes_removed: log.fields_removed,
    fields_masked: ['full_name', 'national_id', 'mobile'],
    extraction: state.extraction ?? null,
    calculation: state.calculation ?? null,
    rule_results: state.rules,
    recommendation: state.recommendation,
    recommended_amount:
      state.recommendation === 'decline'
        ? null
        : (state.amount ?? state.requested),
    approval_required_from: requiredRole(
      deps.policy.authorityLimits,
      requiredAmount,
      state.recommendation,
    ),
    status: 'pending_approval',
    refer_reasons: state.referReasons,
    security_flags: state.flags,
    memo: state.memo,
    log,
  };
}

async function draftMemo(
  deps: PipelineDeps,
  applicationId: string,
  edition: PolicyEdition,
  state: {
    calculation?: Calculation;
    extraction?: Extraction;
    rules: AssessmentResult['rule_results'];
    recommendation: Recommendation;
    amount: number | null;
    requested: number | null;
  },
  addTokens: (t: Tokens) => void,
): Promise<string> {
  const calc = state.calculation!;
  const ex = state.extraction!;
  const facts: Record<string, string> = {
    installment: egp(calc.monthly_instalment),
    dbr: calc.debt_burden_display,
    max_dbr: `${calc.max_dbr * 100}%`,
    max_amount: egp(calc.maximum_eligible_amount),
    requested_amount: egp(state.requested ?? 0),
    recommended_amount: state.amount === null ? 'none' : egp(state.amount),
    tenor: 'the requested tenor',
    rate: `${calc.annual_rate_percent}%`,
    income: egp(ex.net_monthly_income.value),
    obligations: egp(ex.existing_monthly_obligations.value),
    bureau_score: String(ex.bureau_score.value),
  };
  const rules = state.rules
    .map((r) => `- ${r.rule} [${r.clause}] ${r.result}: ${r.detail}`)
    .join('\n');
  const plain = `Policy ${edition.id}: recommendation ${state.recommendation}. Instalment ${facts.installment}, DBR ${facts.dbr} against ${facts.max_dbr}, maximum eligible amount ${facts.max_amount}.`;
  try {
    const res = await deps.llm.complete({
      task: 'memo',
      system: deps.prompts.memoSystem,
      user: renderTemplate(deps.prompts.memoUser, {
        application_id: applicationId,
        edition: edition.id,
        recommendation: state.recommendation,
        rules,
      }),
    });
    addTokens(res.tokens);
    return validateMemo(res.text, facts);
  } catch (err) {
    if (err instanceof InvalidLLMOutput) return plain; // plain deterministic summary is acceptable
    throw err;
  }
}
