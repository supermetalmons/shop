import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sqlSchemaFingerprint } from '../scripts/shared/sqlSchemaFingerprint.ts';

test('SQL fingerprints preserve line-comment boundaries', () => {
  const twoColumns = `CREATE TABLE sample (
    first TEXT -- second follows
    , second TEXT
  )`;
  const oneColumn = `CREATE TABLE sample (
    first TEXT -- second follows , second TEXT
  )`;
  const columnCounts = [twoColumns, oneColumn].map((sql) => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql);
      return db.prepare('PRAGMA table_info(sample)').all().length;
    } finally {
      db.close();
    }
  });

  assert.deepEqual(columnCounts, [2, 1]);
  assert.notEqual(sqlSchemaFingerprint(twoColumns), sqlSchemaFingerprint(oneColumn));
  assert.notEqual(
    sqlSchemaFingerprint(twoColumns),
    sqlSchemaFingerprint(twoColumns.replace('\n    , second', '\r    , second')),
  );
});

test('SQL fingerprints isolate quotes and block comments from SQL whitespace', () => {
  assert.equal(
    sqlSchemaFingerprint(`CREATE TABLE sample (value TEXT /* ' -- */ , other TEXT)`),
    sqlSchemaFingerprint(`CREATE   TABLE sample (value   TEXT /* ' -- */   ,
      other   TEXT)`),
  );
  assert.notEqual(
    sqlSchemaFingerprint(`CREATE TABLE sample (value TEXT DEFAULT 'a b')`),
    sqlSchemaFingerprint(`CREATE TABLE sample (value TEXT DEFAULT 'a  b')`),
  );
  assert.notEqual(
    sqlSchemaFingerprint(`CREATE TABLE sample (value TEXT /* a b */)`),
    sqlSchemaFingerprint(`CREATE TABLE sample (value TEXT /* a  b */)`),
  );
});

test('SQL fingerprints do not treat Unicode identifier characters as whitespace', () => {
  const unicodeSpace = `CREATE TABLE sample (first\u00a0second TEXT)`;
  const asciiSpace = 'CREATE TABLE sample (first second TEXT)';
  const columnNames = [unicodeSpace, asciiSpace].map((sql) => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql);
      return String(db.prepare('PRAGMA table_info(sample)').get()!.name);
    } finally {
      db.close();
    }
  });
  assert.notEqual(columnNames[0], columnNames[1]);
  assert.notEqual(sqlSchemaFingerprint(unicodeSpace), sqlSchemaFingerprint(asciiSpace));
});
