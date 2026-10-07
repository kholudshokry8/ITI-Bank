import { readFileSync, writeFileSync } from 'node:fs';
import { ingestAll } from '../src/app/ingest';
import { assessApplication } from '../src/app/pipeline';
import { answerQuestion, REFUSAL_TEXT } from '../src/app/qa';
import { splitPack } from '../src/domain/application';
import {
  debtBurdenRatio,
  displayDbr,
  maxEligibleAmount,
  monthlyInstallment,
} from '../src/domain/calculations';
import {
  buildContainer,
  seedApplications,
  seedUsers,
} from '../src/infra/bootstrap';
import { fileLoader, loadDocMeta } from '../src/infra/config';
import { qaDeps } from '../src/infra/web/server';

const K = 5;
const env = {
  ...process.env,
  DATABASE_PATH: ':memory:',
  JWT_SECRET: 'eval-eval-eval-eval',
  AS_OF_DATE: '2025-06-01',
};
const c = buildContainer(env);
await ingestAll(loadDocMeta(), {
  llm: c.llm,
  knowledge: c.knowledge,
  load: fileLoader('data/policy'),
});
seedUsers(c);
await seedApplications(c);

interface Case {
  id: string;
  category: 'retrieval' | 'edition' | 'refusal' | 'calculation' | 'injection';
  name?: string;
  question?: string;
  expect_chunk?: string;
  expect_text?: string;
  input?: {
    amount: number;
    tenor: number;
    rate: number;
    income: number;
    obligations: number;
    max_dbr: number;
  };
  expect?: { installment: string; dbr: string; max_amount: number };
  application?: string;
  expect_income?: number;
  expect_recommendation?: string;
  forbid_text?: string;
}
interface Row {
  id: string;
  category: string;
  what: string;
  expected: string;
  actual: string;
  pass: boolean;
}
const must = <T>(v: T | undefined, field: string): T => {
  if (v === undefined) throw new Error(`eval case is missing ${field}`);
  return v;
};

const cases = JSON.parse(readFileSync('eval/cases.json', 'utf8')) as Case[];
const rows: Row[] = [];
const tally = {
  retrieval: [0, 0],
  refusal: [0, 0],
  calculation: [0, 0],
  injection: [0, 0],
} as Record<string, [number, number]>;
const record = (group: string, row: Row) => {
  tally[group]![1] += 1;
  if (row.pass) tally[group]![0] += 1;
  rows.push(row);
};
const deps = qaDeps(c);

for (const t of cases) {
  if (t.category === 'retrieval' || t.category === 'edition') {
    const question = must(t.question, 'question');
    const emb = await c.llm.embed([question]);
    const edition = await answerQuestion(deps, question, 'CP-2025'); // to learn which edition filter applies
    const hits = await c.knowledge.search(emb.vectors[0]!, {
      k: K,
      model: emb.model,
      filter: (ch) =>
        edition.edition_filter === null ||
        ch.edition === null ||
        ch.edition === edition.edition_filter,
    });
    const ids = hits.map((h) => h.chunk.id);
    const pass =
      ids.includes(must(t.expect_chunk, 'expect_chunk')) &&
      hits.some((h) =>
        h.chunk.text.includes(must(t.expect_text, 'expect_text')),
      );
    record('retrieval', {
      id: t.id,
      category: t.category,
      what: question,
      expected: `top-${K} contains ${t.expect_chunk} with "${t.expect_text}"`,
      actual: `top-${K}: ${ids.join(', ')}`,
      pass,
    });
  } else if (t.category === 'refusal') {
    const question = must(t.question, 'question');
    const r = await answerQuestion(deps, question, 'CP-2025');
    const pass = r.answer === REFUSAL_TEXT && r.citations.length === 0;
    record('refusal', {
      id: t.id,
      category: t.category,
      what: question,
      expected: 'refusal, no citations',
      actual: pass
        ? 'refused'
        : `answered: ${r.answer.slice(0, 70).replace(/\s+/g, ' ')} [${r.citations.map((x) => x.chunk_id).join(', ')}]`,
      pass,
    });
  } else if (t.category === 'calculation') {
    const i = must(t.input, 'input');
    const inst = monthlyInstallment(i.amount, i.rate, i.tenor);
    const got = {
      installment: inst.toFixed(2),
      dbr: displayDbr(debtBurdenRatio(i.obligations, inst, i.income)),
      max_amount: maxEligibleAmount(
        i.income,
        i.obligations,
        i.max_dbr,
        i.rate,
        i.tenor,
      ),
    };
    record('calculation', {
      id: t.id,
      category: t.category,
      what: must(t.name, 'name'),
      expected: JSON.stringify(t.expect),
      actual: JSON.stringify(got),
      pass: JSON.stringify(got) === JSON.stringify(t.expect),
    });
  } else if (t.application) {
    const r = await assessApplication(
      c.pipeline,
      splitPack(
        must(c.repos.getApplicationText(t.application), 'application text'),
      ),
      {
        applicationId: t.application,
        requestId: 'eval',
      },
    );
    record('injection', {
      id: t.id,
      category: t.category,
      what: must(t.name, 'name'),
      expected: `income ${t.expect_income}, ${t.expect_recommendation}, attempt logged`,
      actual: `income ${r.extraction?.net_monthly_income.value}, ${r.recommendation}, findings=${r.log.injection_findings.length}`,
      pass:
        r.extraction?.net_monthly_income.value === t.expect_income &&
        r.recommendation === t.expect_recommendation &&
        r.log.injection_findings.length > 0,
    });
  } else {
    const question = must(t.question, 'question');
    const forbid = must(t.forbid_text, 'forbid_text');
    const r = await answerQuestion(deps, question, 'CP-2025');
    record('injection', {
      id: t.id,
      category: t.category,
      what: must(t.name, 'name'),
      expected: `answer must not contain "${forbid}"; attempt flagged`,
      actual: `${r.answer.slice(0, 90).replace(/\s+/g, ' ')} [flagged=${r.injection_suspected}]`,
      pass: !r.answer.includes(forbid) && r.injection_suspected,
    });
  }
}

const pct = ([a, b]: [number, number]) =>
  `${a}/${b} (${Math.round((100 * a) / b)}%)`;
const summary = {
  provider: env.LLM_PROVIDER ?? 'mock',
  k: K,
  threshold: deps.threshold,
  retrieval_hit_rate: pct(tally.retrieval!),
  refusal_correctness: pct(tally.refusal!),
  calculation_exactness: pct(tally.calculation!),
  injection_resisted: pct(tally.injection!),
};
console.log(JSON.stringify(summary, null, 2));
for (const r of rows)
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.what}\n     expected: ${r.expected}\n     actual:   ${r.actual}`,
  );
writeFileSync(
  'eval/results.json',
  JSON.stringify({ summary, rows }, null, 2) + '\n',
);
