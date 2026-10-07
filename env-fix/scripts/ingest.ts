import '../src/infra/load-env';
import { ingestAll } from '../src/app/ingest';
import { fileLoader, loadDocMeta, policyDir } from '../src/infra/config';
import { buildContainer } from '../src/infra/bootstrap';

const c = buildContainer();
const reports = await ingestAll(loadDocMeta(), {
  llm: c.llm,
  knowledge: c.knowledge,
  load: fileLoader(policyDir(c.env)),
});
for (const r of reports)
  console.log(
    `${r.status === 'ok' ? 'OK    ' : 'FAILED'} ${r.file} chunks=${r.chunks}${r.error ? ' error=' + r.error : ''}`,
  );
console.log(`total chunks in store: ${await c.knowledge.chunkCount()}`);
process.exit(reports.some((r) => r.status === 'failed') ? 1 : 0);
