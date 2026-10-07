/** Named, expected failures. Each maps to an HTTP status and, in the pipeline, to "refer to human". */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidApplication extends DomainError {
  constructor(message: string) {
    super('invalid_application', message, 422);
  }
}
export class PolicyEditionNotFound extends DomainError {
  constructor(date: string) {
    super(
      'policy_edition_not_found',
      `No policy edition in force on ${date}`,
      422,
    );
  }
}
export class PricingNotFound extends DomainError {
  constructor(message: string) {
    super('pricing_not_found', message, 422);
  }
}
export class UnverifiedExtraction extends DomainError {
  constructor(message: string) {
    super('unverified_extraction', message, 422);
  }
}
export class InvalidLLMOutput extends DomainError {
  constructor(message: string) {
    super('invalid_llm_output', message, 502);
  }
}
export class AuthorityLimitExceeded extends DomainError {
  constructor(role: string, limit: number, amount: number) {
    super(
      'authority_limit_exceeded',
      `Role ${role} may approve up to EGP ${limit}; recommended amount is EGP ${amount}`,
      403,
    );
  }
}
export class FourEyesViolation extends DomainError {
  constructor() {
    super(
      'four_eyes_violation',
      'The preparer of an assessment may not approve it',
      403,
    );
  }
}
export class InvalidStateTransition extends DomainError {
  constructor(message: string) {
    super('invalid_state_transition', message, 409);
  }
}
export class EvidenceMissing extends DomainError {
  constructor(message: string) {
    super('evidence_missing', message, 422);
  }
}
