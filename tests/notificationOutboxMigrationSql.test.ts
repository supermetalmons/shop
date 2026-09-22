import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { unstable_splitSqlQuery } from 'wrangler';

test('notification migration remains complete when SQL is split into individual statements', (context) => {
  const directory = new URL('../cloud/workers/api/commerce-migrations/', import.meta.url);
  const migrationName = '0013_notification_outbox.sql';
  const sql = readFileSync(new URL(migrationName, directory), 'utf8');
  assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i, 'D1 remote trigger parsing requires parenthesized CASE expressions');
  const statements = unstable_splitSqlQuery(sql);
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  for (const statement of statements) {
    assert.ok((statement.match(/\bCREATE\b/g) ?? []).length <= 1, 'A split statement must not swallow later schema definitions');
    db.prepare(statement).run();
  }
  const expectedObjects = [...sql.matchAll(/CREATE\s+(TABLE|INDEX|TRIGGER)\s+(\w+)/g)]
    .map(([, type, name]) => ({ type: type.toLowerCase(), name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actualObjects = db.prepare(`SELECT type, name FROM sqlite_schema
    WHERE name LIKE 'commerce_notification_%' OR name = 'commerce_commit_guard_notification_outbox_validate'`)
    .all().map((row) => ({ type: row.type, name: String(row.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(actualObjects, expectedObjects);
  assert.equal(db.prepare('SELECT storage_mode FROM commerce_notification_outbox_control').get()?.storage_mode, 'legacy');
  assert.ok(db.prepare('PRAGMA table_info(commerce_commit_guards)').all()
    .some((row) => row.name === 'notification_outbox_expectations_json'));
  assert.throws(() => db.exec('DELETE FROM commerce_notification_outbox_control'), /cannot be deleted/);
  assert.throws(() => db.exec("UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing'"), /maintenance is not ready/);
});
