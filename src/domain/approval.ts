import {
  AuthorityLimitExceeded,
  FourEyesViolation,
  InvalidStateTransition,
} from './errors';
import type { Recommendation } from './rules';

export type Status = 'pending_approval' | 'approved' | 'rejected' | 'issued';
export type Role =
  | 'loan_officer'
  | 'credit_officer'
  | 'senior_credit_officer'
  | 'head_of_consumer_credit';

const ORDER: Role[] = [
  'loan_officer',
  'credit_officer',
  'senior_credit_officer',
  'head_of_consumer_credit',
];
const rank = (r: Role) => ORDER.indexOf(r);

export interface ApprovalContext {
  status: Status;
  recommendation: Recommendation;
  recommendedAmount: number | null;
  preparedBy: string; // user id of the preparer (four-eyes principle, PM-3)
}

export interface Actor {
  id: string;
  role: Role;
}

type Limits = Record<string, number>;

/** Lowest role that may approve an amount. Referred files go to a Senior Credit Officer (PM-4). */
export function requiredRole(
  limits: Limits,
  amount: number | null,
  recommendation: Recommendation,
): Role {
  const floor: Role =
    recommendation === 'refer' ? 'senior_credit_officer' : 'credit_officer';
  const found = ORDER.find(
    (r) => rank(r) >= rank(floor) && (limits[r] ?? 0) >= (amount ?? 0),
  );
  return found ?? 'head_of_consumer_credit';
}

function assertPending(ctx: ApprovalContext, verb: string): void {
  if (ctx.status !== 'pending_approval') {
    throw new InvalidStateTransition(`Cannot ${verb} from ${ctx.status}`);
  }
}

/** Throws unless the actor may approve this recommendation. Enforced on the server (FR-5). */
export function assertCanApprove(
  limits: Limits,
  ctx: ApprovalContext,
  actor: Actor,
): void {
  assertPending(ctx, 'approve');
  if (ctx.recommendation === 'decline') {
    throw new InvalidStateTransition(
      'A decline recommendation can only be rejected',
    );
  }
  const limit = limits[actor.role] ?? 0;
  const amount = ctx.recommendedAmount ?? 0;
  if (limit <= 0) throw new AuthorityLimitExceeded(actor.role, 0, amount);
  if (actor.id === ctx.preparedBy) throw new FourEyesViolation();
  const needsSenior =
    ctx.recommendation === 'refer' &&
    rank(actor.role) < rank('senior_credit_officer');
  if (amount > limit || needsSenior) {
    throw new AuthorityLimitExceeded(actor.role, limit, amount);
  }
}

export function assertCanReject(
  limits: Limits,
  ctx: ApprovalContext,
  actor: Actor,
): void {
  assertPending(ctx, 'reject');
  if ((limits[actor.role] ?? 0) <= 0) {
    throw new AuthorityLimitExceeded(actor.role, 0, ctx.recommendedAmount ?? 0);
  }
  if (actor.id === ctx.preparedBy) throw new FourEyesViolation();
}

export function assertCanIssue(status: Status): void {
  if (status !== 'approved') {
    throw new InvalidStateTransition(
      `Only an approved offer can be issued (status: ${status})`,
    );
  }
}
