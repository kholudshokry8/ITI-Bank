import type Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role, Status } from '../../domain/approval';
import type { AssessmentResult } from '../../app/pipeline';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(password, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UserRow {
  id: string;
  username: string;
  role: Role;
}
export interface StoredAssessment {
  id: string;
  application_id: string;
  prepared_by: string;
  status: Status;
  recommendation: AssessmentResult['recommendation'];
  recommended_amount: number | null;
  approval_required_from: Role;
  result: AssessmentResult;
  created_at: string;
}
export interface DecisionRow {
  action: string;
  user_id: string;
  role: string;
  comment: string;
  decided_at: string;
}

/** All SQL is parameterised. */
export class Repos {
  constructor(private readonly db: Database.Database) {}

  upsertUser(id: string, username: string, password: string, role: Role): void {
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role`,
      )
      .run(id, username, hashPassword(password), role);
  }
  login(username: string, password: string): UserRow | null {
    const r = this.db
      .prepare(
        'SELECT id, username, role, password_hash FROM users WHERE username = ?',
      )
      .get(username) as (UserRow & { password_hash: string }) | undefined;
    return r && verifyPassword(password, r.password_hash)
      ? { id: r.id, username: r.username, role: r.role }
      : null;
  }

  upsertApplication(id: string, sourceFile: string, packText: string): void {
    this.db
      .prepare(
        `INSERT INTO applications (id, source_file, pack_text, loaded_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pack_text=excluded.pack_text, source_file=excluded.source_file`,
      )
      .run(id, sourceFile, packText, new Date().toISOString());
  }
  getApplicationText(id: string): string | null {
    const r = this.db
      .prepare('SELECT pack_text FROM applications WHERE id = ?')
      .get(id) as { pack_text: string } | undefined;
    return r?.pack_text ?? null;
  }
  listApplications(): Array<{ id: string; source_file: string }> {
    return this.db
      .prepare('SELECT id, source_file FROM applications ORDER BY id')
      .all() as Array<{ id: string; source_file: string }>;
  }

  insertAssessment(
    id: string,
    result: AssessmentResult,
    preparedBy: string,
    requestId: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO assessments (id, application_id, run_id, request_id, prepared_by, recommendation, recommended_amount,
        approval_required_from, status, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
      )
      .run(
        id,
        result.application_id,
        result.run_id,
        requestId,
        preparedBy,
        result.recommendation,
        result.recommended_amount,
        result.approval_required_from,
        JSON.stringify(result),
        new Date().toISOString(),
      );
  }
  getAssessment(id: string): StoredAssessment | null {
    const r = this.db
      .prepare('SELECT * FROM assessments WHERE id = ?')
      .get(id) as
      | {
          id: string;
          application_id: string;
          prepared_by: string;
          status: Status;
          recommendation: StoredAssessment['recommendation'];
          recommended_amount: number | null;
          approval_required_from: Role;
          result_json: string;
          created_at: string;
        }
      | undefined;
    return r
      ? { ...r, result: JSON.parse(r.result_json) as AssessmentResult }
      : null;
  }
  setStatus(id: string, status: Status): void {
    this.db
      .prepare('UPDATE assessments SET status = ? WHERE id = ?')
      .run(status, id);
  }
  addDecision(
    assessmentId: string,
    action: 'approve' | 'reject' | 'issue',
    user: { id: string; role: Role },
    comment: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO decisions (assessment_id, action, user_id, role, comment, decided_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        assessmentId,
        action,
        user.id,
        user.role,
        comment,
        new Date().toISOString(),
      );
  }
  decisions(assessmentId: string): DecisionRow[] {
    return this.db
      .prepare(
        'SELECT action, user_id, role, comment, decided_at FROM decisions WHERE assessment_id = ? ORDER BY id',
      )
      .all(assessmentId) as DecisionRow[];
  }
}
