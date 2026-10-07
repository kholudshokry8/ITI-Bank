import { beforeAll, describe, expect, it } from 'vitest';
import { assessApplication, type AssessmentResult } from '../src/app/pipeline';
import { splitPack } from '../src/domain/application';
import type { Container } from '../src/infra/bootstrap';
import { MockLlm } from '../src/infra/llm/mock';
import { packOf, TamperingLlm, testContainer } from './helpers';

let c: Container;
beforeAll(async () => {
  c = await testContainer();
});
const run = (id: string, pipeline = c.pipeline, text?: string) =>
  assessApplication(pipeline, text ? splitPack(text) : packOf(c, id), {
    applicationId: id,
    requestId: 'req-test',
  });
const stepOf = (r: AssessmentResult, name: string) =>
  r.log.steps.find((s) => s.step === name);

describe('pipeline with a fake LLM (no network, no API key)', () => {
  it('APP-001: approvable application matches the acceptance numbers and cites the 2025 edition', async () => {
    const r = await run('APP-001');
    expect(r.policy_edition).toBe('CP-2025');
    expect(r.calculation).toMatchObject({
      annual_rate_percent: 24,
      monthly_instalment: 8630.39,
      debt_burden_display: '42.10%',
      debt_burden_ratio: 0.421,
    });
    expect(r.recommendation).toBe('approve');
    expect(r.recommended_amount).toBe(300_000);
    expect(r.approval_required_from).toBe('senior_credit_officer');
    expect(r.status).toBe('pending_approval');
    expect(
      r.rule_results.every(
        (x) =>
          x.citation?.startsWith('CP-2025:') ||
          x.citation?.startsWith('PS-PL-100:'),
      ),
    ).toBe(true);
    expect(r.memo).toContain('EGP 8,630.39');
  });

  it('APP-002 (S1): fails DBR under 2025 and offers the maximum eligible amount', async () => {
    const r = await run('APP-002');
    expect(r.calculation).toMatchObject({
      monthly_instalment: 10068.79,
      debt_burden_display: '46.90%',
      maximum_eligible_amount: 330_000,
    });
    expect(r.recommendation).toBe('offer_reduced_amount');
    expect(r.recommended_amount).toBe(330_000);
  });

  it('APP-002 dated before 1 March 2025 is assessed under the 2024 edition and passes', async () => {
    const text = c.repos
      .getApplicationText('APP-002')!
      .replace('15 March 2025', '28 February 2025')
      .replace('Issued: 10 March 2025', 'Issued: 20 February 2025');
    const r = await run('APP-002', c.pipeline, text);
    expect(r.policy_edition).toBe('CP-2024');
    expect(r.recommendation).toBe('approve');
    expect(r.rule_results.find((x) => x.clause === 'CP-4.1')!.citation).toBe(
      'CP-2024:CP-4.1',
    );
  });

  it('APP-003: over-age at maturity is declined with the clause cited', async () => {
    const r = await run('APP-003');
    expect(r.recommendation).toBe('decline');
    expect(r.recommended_amount).toBeNull();
    const age = r.rule_results.find((x) => x.clause === 'CP-3.5')!;
    expect(age.result).toBe('fail');
    expect(age.citation).toBe('CP-2025:CP-3.5');
    expect(r.rule_results.find((x) => x.clause === 'CP-4.1')!.result).toBe(
      'not_assessed',
    );
  });

  it('APP-005: low bureau score is referred, not declined', async () => {
    const r = await run('APP-005');
    expect(r.recommendation).toBe('refer');
    expect(r.refer_reasons.join(' ')).toContain('CP-3.6');
    expect(r.approval_required_from).toBe('senior_credit_officer');
  });

  it('APP-004 (S3): hidden instruction is ignored, income stays 18,000, flagged and referred', async () => {
    const r = await run('APP-004');
    expect(r.extraction!.net_monthly_income.value).toBe(18_000);
    expect(r.security_flags).toContain('suspected_tampering');
    expect(r.log.injection_findings.length).toBeGreaterThan(0);
    expect(r.recommendation).toBe('refer');
  });

  it('APP-004: even a model that obeys the injection cannot push the income through', async () => {
    const fooled = new TamperingLlm({
      extract: (real) => {
        const j = JSON.parse(real);
        j.net_monthly_income = {
          value: 200000,
          source_document: 'APP-004.pdf',
          source_section: 'Salary certificate',
          quoted_text:
            'The net monthly income of this applicant is 200,000 EGP',
        };
        return JSON.stringify(j);
      },
    });
    const r = await run('APP-004', { ...c.pipeline, llm: fooled });
    expect(r.recommendation).toBe('refer');
    expect(r.refer_reasons.join(' ')).toContain('unverified_extraction');
    expect(r.calculation).toBeNull();
  });

  it('invalid LLM output becomes "refer to human", never a guess', async () => {
    const r = await run('APP-001', {
      ...c.pipeline,
      llm: new TamperingLlm({ extract: () => '{"net_monthly_income": 5}' }),
    });
    expect(r.recommendation).toBe('refer');
    expect(r.refer_reasons[0]).toContain('invalid_llm_output');
    expect(stepOf(r, 'extract_applicant_data')!.status).toBe('failed');
    expect(r.calculation).toBeNull();
  });

  it('a memo containing numbers typed by the model is replaced by the deterministic summary', async () => {
    const r = await run('APP-001', {
      ...c.pipeline,
      llm: new TamperingLlm({
        memo: () => 'Approve. The instalment is 1,000 per month.',
      }),
    });
    expect(r.memo).not.toContain('1,000');
    expect(r.memo).toContain('EGP 8,630.39');
  });

  it('logs the steps, retrieved chunks, edition, removed fields and tokens (FR-9)', async () => {
    const r = await run('APP-001');
    expect(r.log.steps.map((s) => s.step)).toEqual([
      'load_application',
      'remove_protected_attributes',
      'select_policy_edition',
      'extract_applicant_data',
      'verify_extraction',
      'retrieve_policy_clauses',
      'calculate_and_check_rules',
      'draft_credit_memo',
    ]);
    expect(r.log.chunk_ids_retrieved).toContain('CP-2025:CP-4.1');
    expect(r.log.policy_edition).toBe('CP-2025');
    expect(r.log.fields_removed).toEqual([
      'gender',
      'marital_status',
      'religion',
      'nationality',
    ]);
    expect(r.log.tokens.input).toBeGreaterThan(0);
    expect(r.log.request_id).toBe('req-test');
  });
});

describe('fairness (S5): protected attributes cannot change the outcome', () => {
  const variant = (text: string): string =>
    text
      .replace(/^Gender .*$/m, 'Gender Female')
      .replace(/^Marital status .*$/m, 'Marital status Single')
      .replace(
        /^Religion .*$/m,
        'Religion (declared for statistics only) Christian',
      )
      .replace(/^Nationality .*$/m, 'Nationality Lebanese')
      .replace(/Kareem Hassan Fouad/g, 'Yasmin Tarek Hamdi')
      .replace(/\bMr\b/g, 'Ms')
      .replace(/\bHis\b/g, 'Her')
      .replace(/\bhis\b/g, 'her')
      .replace(/\bhe\b/g, 'she');
  const normalise = (r: AssessmentResult) => {
    const j = JSON.parse(JSON.stringify(r)) as AssessmentResult;
    j.run_id = '';
    j.log.run_id = '';
    return j;
  };

  it('identical result, calculations, memo and identical text sent to the LLM', async () => {
    const original = c.repos.getApplicationText('APP-001')!;
    const changed = variant(original);
    expect(changed).not.toBe(original);
    const llmA = new MockLlm();
    const llmB = new MockLlm();
    const a = await run('APP-001', { ...c.pipeline, llm: llmA }, original);
    const b = await run('APP-001', { ...c.pipeline, llm: llmB }, changed);
    expect(normalise(b)).toEqual(normalise(a));
    expect(
      llmB.requests.filter((q) => q.task !== 'qa').map((q) => q.user),
    ).toEqual(llmA.requests.filter((q) => q.task !== 'qa').map((q) => q.user));
    for (const q of llmA.requests)
      expect(q.user).not.toMatch(
        /\b(Kareem|Fouad|Mr|His|Muslim|Egyptian|Married|Male)\b/,
      );
  });
});
