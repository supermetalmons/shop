import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CommerceSqlQuery } from '../cloud/workers/api/src/commerceQueries.ts';
import { renderCommerceQuerySql } from '../scripts/shared/commerceQuerySql.ts';

function assertMatchesBindings(query: CommerceSqlQuery): void {
  const database = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(
      database.prepare(renderCommerceQuerySql(query)).all(),
      database.prepare(query.sql).all(...query.bindings),
    );
  } finally {
    database.close();
  }
}

test('renders ordered strings and numbers with the same results as SQLite bindings', () => {
  assertMatchesBindings({
    sql: 'SELECT ? AS owner, ? AS cursor, ? AS count, ? AS negative, ? AS fraction, ? AS exponent',
    bindings: ["owner's ? entry", "'; SELECT ?; --", 50, -3, 2.5, 1e30],
  });
});

test('preserves repeated UNION bindings and the final limit', () => {
  assertMatchesBindings({
    sql: `SELECT ? AS owner, ? AS path
      UNION
      SELECT ? AS owner, ? AS path
      ORDER BY path ASC
      LIMIT ?`,
    bindings: ["owner's ?", 'b', "owner's ?", 'a', 1],
  });
});

test('keeps negative numeric bindings separate from adjacent minus operators', () => {
  assertMatchesBindings({
    sql: 'SELECT -? AS positive, ?-? AS difference',
    bindings: [-3, 1, -2],
  });
});

test('ignores question marks in quoted text, identifiers, and comments', () => {
  assertMatchesBindings({
    sql: `SELECT 'literal ''?'' -- /*' AS "double""?", ? AS \`backtick\`\`?\`, ? AS [bracket?]
      /* ? ?42 ' " \` [ -- */
      -- ? ?123 ' " \` [ /*
      , ? AS plain`,
    bindings: ['first', 'second', 3],
  });
});

test('leaves SQL without bindings unchanged, including a trailing line comment', () => {
  const sql = `SELECT '?' AS [question?] /* ? */ -- ?`;
  assert.equal(renderCommerceQuerySql({ sql, bindings: [] }), sql);
  assertMatchesBindings({ sql, bindings: [] });
});

test('rejects both missing and unused bindings', () => {
  for (const query of [
    { sql: 'SELECT ?, ?', bindings: [1] },
    { sql: 'SELECT ?', bindings: [1, 2] },
    { sql: "SELECT '?'", bindings: [1] },
  ]) {
    assert.throws(() => renderCommerceQuerySql(query), /placeholder count does not match binding count/);
  }
});

test('rejects numbered placeholders', () => {
  assert.throws(
    () => renderCommerceQuerySql({ sql: 'SELECT ?2, ?1', bindings: [1, 2] }),
    /only supports anonymous \? placeholders/,
  );
});

test('rejects nonfinite numbers and unsupported runtime binding values', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, true, 1n, {}]) {
    assert.throws(
      () => renderCommerceQuerySql({ sql: 'SELECT ?', bindings: [value as string | number] }),
      /bindings must be strings or finite numbers/,
    );
  }
});
