import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Container } from '../src/infra/bootstrap';
import { buildServer } from '../src/infra/web/server';
import { testContainer } from './helpers';

let app: FastifyInstance;
let c: Container;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  c = await testContainer();
  app = await buildServer(c);
  for (const [k, u, p] of [
    ['loan', 'loan.officer', 'Demo-Loan-1'],
    ['credit', 'credit.officer', 'Demo-Credit-1'],
    ['senior', 'senior.officer', 'Demo-Senior-1'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: u, password: p },
    });
    tokens[k] = res.json().token;
  }
});
afterAll(() => app.close());

const call = (
  who: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    payload,
    headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
  });
const assess = async (who: string, id: string) =>
  (await call(who, 'POST', `/applications/${id}/assess`)).json();

describe('authentication and roles (enforced on the server)', () => {
  it('rejects bad credentials and missing tokens', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'loan.officer', password: 'nope' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await call(null, 'GET', '/applications')).statusCode).toBe(401);
  });
  it('a loan officer can ask and assess but cannot ingest, approve or reject', async () => {
    expect(
      (
        await call('loan', 'POST', '/ask', {
          question: 'What is the maximum debt burden ratio?',
        })
      ).statusCode,
    ).toBe(200);
    expect((await call('loan', 'POST', '/ingest')).statusCode).toBe(403);
    const a = await assess('loan', 'APP-005');
    expect(
      (
        await call('loan', 'POST', `/assessments/${a.assessment_id}/approve`, {
          comment: 'x',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('loan', 'POST', `/assessments/${a.assessment_id}/reject`, {
          comment: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });
  it('every response carries a request id', async () => {
    expect(
      (await call('loan', 'GET', '/applications')).headers['x-request-id'],
    ).toBeTruthy();
  });
});

describe('approval flow (S6)', () => {
  it('the server rejects a credit officer approving 300,000; a senior may; then issue', async () => {
    const a = await assess('loan', 'APP-001');
    expect(a.recommendation).toBe('approve');
    expect(a.approval_required_from).toBe('senior_credit_officer');
    const denied = await call(
      'credit',
      'POST',
      `/assessments/${a.assessment_id}/approve`,
      { comment: 'looks fine' },
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('authority_limit_exceeded');
    expect(
      (await call('loan', 'GET', `/assessments/${a.assessment_id}`)).json()
        .status,
    ).toBe('pending_approval');

    expect(
      (await call('credit', 'POST', `/assessments/${a.assessment_id}/issue`))
        .statusCode,
    ).toBe(409); // not approved yet
    const ok = await call(
      'senior',
      'POST',
      `/assessments/${a.assessment_id}/approve`,
      { comment: 'Within policy' },
    );
    expect(ok.statusCode).toBe(200);
    expect(
      (
        await call(
          'senior',
          'POST',
          `/assessments/${a.assessment_id}/approve`,
          { comment: 'again' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('credit', 'POST', `/assessments/${a.assessment_id}/issue`)
      ).json().status,
    ).toBe('issued');

    const final = (
      await call('loan', 'GET', `/assessments/${a.assessment_id}`)
    ).json();
    expect(final.status).toBe('issued');
    expect(final.decisions.map((d: { action: string }) => d.action)).toEqual([
      'approve',
      'issue',
    ]);
    expect(final.decisions[0]).toMatchObject({
      user_id: 'u-senior',
      role: 'senior_credit_officer',
      comment: 'Within policy',
    });
  });
  it('a comment is required', async () => {
    const a = await assess('loan', 'APP-003');
    expect(
      (
        await call(
          'credit',
          'POST',
          `/assessments/${a.assessment_id}/reject`,
          {},
        )
      ).statusCode,
    ).toBe(400);
  });
  it('a decline recommendation can be rejected but not approved', async () => {
    const a = await assess('loan', 'APP-003');
    expect(a.recommendation).toBe('decline');
    expect(
      (
        await call(
          'credit',
          'POST',
          `/assessments/${a.assessment_id}/approve`,
          { comment: 'try' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('credit', 'POST', `/assessments/${a.assessment_id}/reject`, {
          comment: 'CP-3.5 age at maturity',
        })
      ).json().status,
    ).toBe('rejected');
  });
  it('four-eyes: the preparer cannot approve their own assessment', async () => {
    const a = await assess('senior', 'APP-001');
    const res = await call(
      'senior',
      'POST',
      `/assessments/${a.assessment_id}/approve`,
      { comment: 'self' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('four_eyes_violation');
  });
  it('an unknown assessment is a 404', async () => {
    expect(
      (
        await call('senior', 'POST', '/assessments/nope/approve', {
          comment: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('other endpoints', () => {
  it('/calculate reproduces the worked example from the pricing table', async () => {
    const res = await call('loan', 'POST', '/calculate', {
      amount: 300000,
      tenor_months: 60,
      net_income: 30000,
      existing_obligations: 4000,
      application_date: '2025-04-03',
    });
    expect(res.json()).toMatchObject({
      policy_edition: 'CP-2025',
      annual_rate_percent: 24,
      monthly_instalment: 8630.39,
      debt_burden_display: '42.10%',
      within_limit: true,
    });
  });
  it('/ask refuses out-of-corpus questions with the documented shape', async () => {
    const res = (
      await call('loan', 'POST', '/ask', {
        question: 'What is the policy on crypto-backed loans?',
      })
    ).json();
    expect(res).toMatchObject({
      citations: [],
      reason: 'no_chunk_above_threshold',
    });
  });
  it('an unknown application is a named 422 error', async () => {
    const res = await call('loan', 'POST', '/applications/APP-999/assess');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_application');
  });
  it('serves OpenAPI docs', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/docs/json' })).json().openapi,
    ).toMatch(/^3\./);
  });
});
