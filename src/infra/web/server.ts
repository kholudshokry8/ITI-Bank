import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import jwt from '@fastify/jwt';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assessApplication } from '../../app/pipeline';
import { ingestAll } from '../../app/ingest';
import { answerQuestion, type QaDeps } from '../../app/qa';
import {
  assertCanApprove,
  assertCanIssue,
  assertCanReject,
  type Role,
} from '../../domain/approval';
import { splitPack } from '../../domain/application';
import { DomainError, InvalidApplication } from '../../domain/errors';
import { selectEdition } from '../../domain/policy';
import { rateFor, segmentFor } from '../../domain/pricing';
import { evaluateCalculation } from './calculate';
import type { Container } from '../bootstrap';
import { fileLoader, loadDocMeta, policyDir } from '../config';

const ROLE_ORDER: Role[] = [
  'loan_officer',
  'credit_officer',
  'senior_credit_officer',
  'head_of_consumer_credit',
];

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string; role: Role };
    user: { sub: string; username: string; role: Role };
  }
}

export function qaDeps(c: Container): QaDeps {
  return {
    llm: c.llm,
    knowledge: c.knowledge,
    prompts: c.pipeline.prompts,
    threshold: Number(c.env.RELEVANCE_THRESHOLD ?? 0.25),
    asOf: c.env.AS_OF_DATE || new Date().toISOString().slice(0, 10),
    editions: c.pipeline.policy.editions,
  };
}

const CommentBody = z.object({ comment: z.string().trim().min(1).max(2000) });
const AskBody = z.object({ question: z.string().trim().min(3).max(1000) });
const CalcBody = z.object({
  amount: z.number().positive(),
  tenor_months: z.number().int().positive(),
  net_income: z.number().positive(),
  existing_obligations: z.number().min(0),
  application_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  salary_transferred: z.boolean().default(false),
});

export async function buildServer(c: Container): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CreditCopilot Lite',
        version: '0.1.0',
        description: 'Synthetic training exercise. Not financial advice.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  const secret = c.env.JWT_SECRET;
  if (!secret || secret.length < 16)
    throw new Error('JWT_SECRET (16+ characters) is required');
  await app.register(jwt, { secret, sign: { expiresIn: '8h' } });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler(
    (
      err: Error & { statusCode?: number; validation?: unknown },
      req,
      reply,
    ) => {
      if (err instanceof DomainError) {
        return reply.status(err.httpStatus).send({
          error: { code: err.code, message: err.message, request_id: req.id },
        });
      }
      if (err instanceof z.ZodError) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: err.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
            request_id: req.id,
          },
        });
      }
      const status =
        err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
      if (status === 500) console.error(`[${req.id}]`, err);
      return reply.status(status).send({
        error: {
          code: status === 500 ? 'internal_error' : 'bad_request',
          message: status === 500 ? 'Internal error' : err.message,
          request_id: req.id,
        },
      });
    },
  );

  /** Role checks happen here, on the server. Hiding a button in the UI is not access control. */
  const auth =
    (minRole: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.status(401).send({
          error: {
            code: 'unauthenticated',
            message: 'Login required',
            request_id: req.id,
          },
        });
      }
      if (ROLE_ORDER.indexOf(req.user.role) < ROLE_ORDER.indexOf(minRole)) {
        return reply.status(403).send({
          error: {
            code: 'forbidden',
            message: `Requires role ${minRole} or higher`,
            request_id: req.id,
          },
        });
      }
    };
  const security = [{ bearer: [] }];

  app.get('/health', async () => ({ status: 'ok' }));

  app.post(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body as {
        username: string;
        password: string;
      };
      const user = c.repos.login(username, password);
      if (!user)
        return reply.status(401).send({
          error: {
            code: 'bad_credentials',
            message: 'Wrong username or password',
            request_id: req.id,
          },
        });
      return {
        token: app.jwt.sign({
          sub: user.id,
          username: user.username,
          role: user.role,
        }),
        role: user.role,
        username: user.username,
      };
    },
  );

  app.post(
    '/ingest',
    { preHandler: auth('credit_officer'), schema: { security } },
    async () => {
      const reports = await ingestAll(loadDocMeta(), {
        llm: c.llm,
        knowledge: c.knowledge,
        load: fileLoader(policyDir(c.env)),
      });
      return {
        documents: reports,
        total_chunks: await c.knowledge.chunkCount(),
      };
    },
  );
  app.get(
    '/ingest/status',
    { preHandler: auth('loan_officer'), schema: { security } },
    async () => ({
      documents: await c.knowledge.listDocuments(),
      total_chunks: await c.knowledge.chunkCount(),
    }),
  );

  app.post(
    '/ask',
    {
      preHandler: auth('loan_officer'),
      schema: {
        security,
        body: {
          type: 'object',
          required: ['question'],
          properties: { question: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const { question } = AskBody.parse(req.body);
      const deps = qaDeps(c);
      const inForce = selectEdition(c.pipeline.policy.editions, deps.asOf).id;
      return {
        request_id: req.id,
        ...(await answerQuestion(deps, question, inForce)),
      };
    },
  );

  app.post(
    '/calculate',
    { preHandler: auth('loan_officer'), schema: { security } },
    async (req) => {
      const b = CalcBody.parse(req.body);
      const edition = selectEdition(
        c.pipeline.policy.editions,
        b.application_date,
      );
      const rate = rateFor(
        c.pipeline.pricing,
        b.tenor_months,
        segmentFor(b.salary_transferred),
      );
      return {
        policy_edition: edition.id,
        ...evaluateCalculation(
          b.amount,
          b.tenor_months,
          rate,
          b.net_income,
          b.existing_obligations,
          edition.maxDbr,
        ),
      };
    },
  );

  app.get(
    '/applications',
    { preHandler: auth('loan_officer'), schema: { security } },
    async () => ({ applications: c.repos.listApplications() }),
  );

  app.post(
    '/applications/:id/assess',
    { preHandler: auth('loan_officer'), schema: { security } },
    async (req) => {
      const { id } = req.params as { id: string };
      const text = c.repos.getApplicationText(id);
      if (!text) throw new InvalidApplication(`Unknown application ${id}`);
      const result = await assessApplication(c.pipeline, splitPack(text), {
        applicationId: id,
        requestId: req.id,
      });
      const assessmentId = randomUUID();
      c.repos.insertAssessment(assessmentId, result, req.user.sub, req.id);
      return { assessment_id: assessmentId, ...result };
    },
  );

  const load = (id: string) => {
    const a = c.repos.getAssessment(id);
    if (!a)
      throw new DomainError('not_found', `Assessment ${id} not found`, 404);
    return a;
  };
  const ctxOf = (a: ReturnType<typeof load>) => ({
    status: a.status,
    recommendation: a.recommendation,
    recommendedAmount: a.recommended_amount,
    preparedBy: a.prepared_by,
  });
  const limits = c.pipeline.policy.authorityLimits;
  const actor = (req: FastifyRequest) => ({
    id: req.user.sub,
    role: req.user.role,
  });

  app.get(
    '/assessments/:id',
    { preHandler: auth('loan_officer'), schema: { security } },
    async (req) => {
      const a = load((req.params as { id: string }).id);
      return {
        ...a.result,
        assessment_id: a.id,
        status: a.status,
        prepared_by: a.prepared_by,
        decisions: c.repos.decisions(a.id),
      };
    },
  );

  const decide =
    (action: 'approve' | 'reject') => async (req: FastifyRequest) => {
      const a = load((req.params as { id: string }).id);
      const { comment } = CommentBody.parse(req.body);
      (action === 'approve' ? assertCanApprove : assertCanReject)(
        limits,
        ctxOf(a),
        actor(req),
      );
      c.db.transaction(() => {
        c.repos.setStatus(a.id, action === 'approve' ? 'approved' : 'rejected');
        c.repos.addDecision(a.id, action, actor(req), comment);
      })();
      return {
        assessment_id: a.id,
        status: action === 'approve' ? 'approved' : 'rejected',
        decided_by: req.user.username,
        comment,
      };
    };
  app.post(
    '/assessments/:id/approve',
    { preHandler: auth('credit_officer'), schema: { security } },
    decide('approve'),
  );
  app.post(
    '/assessments/:id/reject',
    { preHandler: auth('credit_officer'), schema: { security } },
    decide('reject'),
  );
  app.post(
    '/assessments/:id/issue',
    { preHandler: auth('credit_officer'), schema: { security } },
    async (req) => {
      const a = load((req.params as { id: string }).id);
      assertCanIssue(a.status);
      c.db.transaction(() => {
        c.repos.setStatus(a.id, 'issued');
        c.repos.addDecision(
          a.id,
          'issue',
          actor(req),
          'Offer issued after approval',
        );
      })();
      return { assessment_id: a.id, status: 'issued' };
    },
  );

  const ui = () => readFileSync(join(process.cwd(), 'ui/index.html'), 'utf8');
  app.get('/', async (_req, reply) => reply.type('text/html').send(ui()));
  app.get('/vendor/vue.js', async (_req, reply) =>
    reply
      .type('application/javascript')
      .send(
        readFileSync(
          join(process.cwd(), 'node_modules/vue/dist/vue.global.prod.js'),
          'utf8',
        ),
      ),
  );

  return app;
}
