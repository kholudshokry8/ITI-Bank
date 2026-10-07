import './infra/load-env';
import { buildContainer } from './infra/bootstrap';
import { buildServer } from './infra/web/server';

const container = buildContainer();
const app = await buildServer(container);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(
  `CreditCopilot Lite listening on :${port}  (docs at /docs, provider=${process.env.LLM_PROVIDER ?? 'mock'})`,
);
