import assert from 'node:assert/strict';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeDurableJsonJournal, writeDurableJsonJournalAsync } from '../scripts/shared/durableJsonJournal.ts';

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

test('async journal create is exclusive and replace can create or replace exact private JSON bytes', async t => {
  const f = fixture(t);
  const first = await writeDurableJsonJournalAsync({ ...f.options, mode: 'create', value: { status: 'prepared' } });
  assert.equal(first, '{\n  "status": "prepared"\n}\n');
  assert.equal(readFileSync(f.filePath, 'utf8'), first);
  assert.equal(statSync(f.filePath).mode & 0o777, 0o600);
  await assert.rejects(writeDurableJsonJournalAsync({ ...f.options, mode: 'create', value: {} }), { code: 'EEXIST' });
  assert.equal(readFileSync(f.filePath, 'utf8'), first);
  const second = await writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { status: 'complete' } });
  assert.equal(readFileSync(f.filePath, 'utf8'), second);
  assert.equal(statSync(f.filePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
  rmSync(f.filePath);
  assert.equal(await writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { status: 'complete' } }), second);
  assert.equal(readFileSync(f.filePath, 'utf8'), second);
});

for (const failure of ['write', 'file-sync', 'rename'] as const) {
  test(`async journal ${failure} interruption preserves previous evidence, closes the file, and cleans temporary data`, async t => {
    const f = fixture(t);
    writeFileSync(f.filePath, 'previous evidence');
    let closed = false;
    await assert.rejects(writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { status: 'complete' } }, {
      open: async (...args) => {
        const handle = await open(...args);
        return {
          writeFile: async (...parameters) => {
            await handle.writeFile(...parameters);
            if (failure === 'write') throw new Error('interrupted');
          },
          sync: async () => {
            if (failure === 'file-sync') throw new Error('interrupted');
            await handle.sync();
          },
          close: async () => { closed = true; await handle.close(); },
        };
      },
      rename: async (...args) => {
        if (failure === 'rename') throw new Error('interrupted');
        await rename(...args);
      },
    }), /interrupted/);
    assert.equal(closed, true);
    assert.equal(readFileSync(f.filePath, 'utf8'), 'previous evidence');
    assert.deepEqual(readdirSync(f.directory), ['journal.json']);
  });
}

test('async journal syncs before publication and verifies only after syncing and closing the directory', async t => {
  const f = fixture(t);
  const events: string[] = [];
  await writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { complete: true } }, {
    open: async (path, ...args) => {
      const kind = path === f.directory ? 'directory' : 'file';
      const handle = await open(path, ...args);
      return {
        writeFile: async (...parameters) => { events.push('write'); await handle.writeFile(...parameters); },
        sync: async () => { events.push(`sync-${kind}`); await handle.sync(); },
        close: async () => { events.push(`close-${kind}`); await handle.close(); },
      };
    },
    rename: async (...args) => { events.push('publish'); await rename(...args); },
    readFile: async (...args) => {
      events.push('verify');
      return readFile(...args);
    },
  });
  assert.deepEqual(events, ['write', 'sync-file', 'close-file', 'publish', 'sync-directory', 'close-directory', 'verify']);
});

test('async journal directory sync failure retains published evidence and closes the directory', async t => {
  const f = fixture(t);
  let directoryClosed = false;
  await assert.rejects(writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { complete: true } }, {
    open: async (path, ...args) => {
      const handle = await open(path, ...args);
      return {
        writeFile: (...parameters) => handle.writeFile(...parameters),
        sync: async () => {
          if (path === f.directory) throw new Error('directory sync failed');
          await handle.sync();
        },
        close: async () => { if (path === f.directory) directoryClosed = true; await handle.close(); },
      };
    },
  }), /directory sync failed/);
  assert.equal(directoryClosed, true);
  assert.equal(readFileSync(f.filePath, 'utf8'), '{\n  "complete": true\n}\n');
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});

test('async journal rejects unverified publication while retaining evidence for recovery', async t => {
  const f = fixture(t);
  await assert.rejects(writeDurableJsonJournalAsync({ ...f.options, mode: 'replace', value: { complete: true } }, {
    rename: async (...args) => { await rename(...args); writeFileSync(f.filePath, 'changed evidence'); },
  }), /Journal verification failed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), 'changed evidence');
  assert.deepEqual(readdirSync(f.directory), ['journal.json']);
});
