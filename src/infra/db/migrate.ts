import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Applies migrations/NNN_*.sql in order, once each. The schema is never created by ad-hoc code. */
export function migrate(
  db: Database.Database,
  dir = join(process.cwd(), 'migrations'),
): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (
      db.prepare('SELECT name FROM schema_migrations').all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(file)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare(
        'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      ).run(file, new Date().toISOString());
    })();
    applied.push(file);
  }
  return applied;
}
