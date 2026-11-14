import assert from 'node:assert/strict';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeDurableJsonJournal } from '../scripts/shared/durableJsonJournal.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'durable-json-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'journal.json');
  return {
    directory,
    filePath,
    options: { filePath, changedMessage: 'Journal changed.', verificationMessage: 'Journal verification failed.' },
  };
}

test('journal creation and replacement preserve exact JSON bytes and private permissions', (t) => {
  const f = fixture(t);
  const source = writeDurableJsonJournal({ ...f.options, value: { status: 'prepared' } });
  assert.equal(source, '{\n  "status": "prepared"\n}\n');
  assert.equal(readFileSync(f.filePath, 'utf8'), source);
  assert.equal(statSync(f.filePath).mode & 0o777, 0o600);
  const next = writeDurableJsonJournal({ ...f.options, value: { status: 'signed' }, expectedSource: source });
  assert.equal(readFileSync(f.filePath, 'utf8'), next);
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});

test('journal creation cannot overwrite an existing file and replacement rejects stale source', (t) => {
  const f = fixture(t);
  writeFileSync(f.filePath, 'existing evidence');
  assert.throws(() => writeDurableJsonJournal({ ...f.options, value: {} }), { code: 'EEXIST' });
  assert.throws(() => writeDurableJsonJournal({ ...f.options, value: {}, expectedSource: 'older evidence' }), /Journal changed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), 'existing evidence');
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});

test('failed journal file sync preserves existing evidence and removes temporary data', (t) => {
  const f = fixture(t);
  const failedSync = { fsyncSync: () => { throw new Error('disk sync failed'); } };
  assert.throws(() => writeDurableJsonJournal({ ...f.options, value: {} }, failedSync), /disk sync failed/);
  assert.equal(existsSync(f.filePath), false);
  assert.deepEqual(readdirSync(f.directory), []);
  writeFileSync(f.filePath, 'existing evidence');
  assert.throws(() => writeDurableJsonJournal({ ...f.options, value: {}, expectedSource: 'existing evidence' }, failedSync), /disk sync failed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), 'existing evidence');
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});

test('failed journal directory sync retains the published journal for recovery', (t) => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => writeDurableJsonJournal({ ...f.options, value: { signed: true } }, {
    fsyncSync: (descriptor) => {
      if (++calls === 2) throw new Error('directory sync failed');
      fsyncSync(descriptor);
    },
  }), /directory sync failed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), '{\n  "signed": true\n}\n');
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});
