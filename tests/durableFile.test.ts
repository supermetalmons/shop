import assert from 'node:assert/strict';
import {
  existsSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeDurableFile, type DurableFileIo } from '../scripts/shared/durableFile.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'durable-file-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'evidence');
  return { directory, filePath, options: { filePath, verificationMessage: 'File verification failed.' } };
}

test('durable replacement creates and replaces exact text with the requested permissions', t => {
  const f = fixture(t);
  for (const [source, permissions] of [['{"id":1}\n{"id":2}\n', 0o600], ['Résumé\r\nwithout trailing newline', 0o640]] as const) {
    assert.equal(writeDurableFile({ ...f.options, source, mode: 'replace', permissions }), source);
    assert.equal(readFileSync(f.filePath, 'utf8'), source);
    assert.equal(statSync(f.filePath).mode & 0o777, permissions & ~process.umask());
    assert.deepEqual(readdirSync(f.directory), ['evidence']);
  }
});

test('durable creation is exclusive and private by default', t => {
  const f = fixture(t);
  writeDurableFile({ ...f.options, source: 'original', mode: 'create' });
  assert.equal(statSync(f.filePath).mode & 0o777, 0o600 & ~process.umask());
  assert.throws(() => writeDurableFile({ ...f.options, source: 'replacement', mode: 'create' }), { code: 'EEXIST' });
  assert.equal(readFileSync(f.filePath, 'utf8'), 'original');
  assert.deepEqual(readdirSync(f.directory), ['evidence']);
});

test('durable text writes require the existing parent directory', t => {
  const f = fixture(t);
  const parent = join(f.directory, 'missing');
  assert.throws(() => writeDurableFile({ ...f.options, filePath: join(parent, 'evidence'), source: 'text', mode: 'replace' }), { code: 'ENOENT' });
  assert.equal(existsSync(parent), false);
});

for (const mode of ['create', 'replace'] as const) {
  for (const failure of ['write', 'file-sync', 'publish'] as const) {
    test(`durable ${mode} ${failure} failure preserves prior evidence and closes and removes its temporary`, t => {
      const f = fixture(t);
      if (mode === 'replace') writeFileSync(f.filePath, 'previous evidence');
      let descriptor: number | undefined;
      const interrupted = () => { throw new Error('interrupted'); };
      const io: Partial<DurableFileIo> = {
        openSync: (...args) => {
          descriptor = openSync(...args);
          return descriptor;
        },
      };
      if (failure === 'write') io.writeFileSync = (file, data, options) => { writeFileSync(file, data, options); interrupted(); };
      if (failure === 'file-sync') io.fsyncSync = interrupted;
      if (failure === 'publish') { io.linkSync = interrupted; io.renameSync = interrupted; }
      assert.throws(() => writeDurableFile({ ...f.options, source: 'new evidence', mode }, io), /interrupted/);
      assert.notEqual(descriptor, undefined);
      assert.throws(() => fstatSync(descriptor!), { code: 'EBADF' });
      assert.deepEqual(readdirSync(f.directory), mode === 'replace' ? ['evidence'] : []);
      if (mode === 'replace') assert.equal(readFileSync(f.filePath, 'utf8'), 'previous evidence');
    });
  }
}

test('failed exclusive temporary creation leaves the unowned file intact', t => {
  const f = fixture(t);
  let temporary = '';
  assert.throws(() => writeDurableFile({ ...f.options, source: 'new evidence', mode: 'replace' }, {
    openSync: (filePath, flags, mode) => {
      temporary = String(filePath);
      writeFileSync(filePath, 'unowned file');
      return openSync(filePath, flags, mode);
    },
  }), { code: 'EEXIST' });
  assert.equal(readFileSync(temporary, 'utf8'), 'unowned file');
  assert.equal(existsSync(f.filePath), false);
});

test('directory sync failure retains published replacement evidence and closes the directory', t => {
  const f = fixture(t);
  writeFileSync(f.filePath, 'previous evidence');
  let directoryDescriptor: number | undefined;
  let syncCount = 0;
  assert.throws(() => writeDurableFile({ ...f.options, source: 'new evidence', mode: 'replace' }, {
    openSync: (filePath, ...args) => {
      const descriptor = openSync(filePath, ...args);
      if (filePath === f.directory) directoryDescriptor = descriptor;
      return descriptor;
    },
    fsyncSync: descriptor => {
      if (++syncCount === 2) throw new Error('directory sync failed');
      fsyncSync(descriptor);
    },
  }), /directory sync failed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), 'new evidence');
  assert.notEqual(directoryDescriptor, undefined);
  assert.throws(() => fstatSync(directoryDescriptor!), { code: 'EBADF' });
  assert.deepEqual(readdirSync(f.directory), ['evidence']);
});

test('failed replacement verification retains published evidence for recovery', t => {
  const f = fixture(t);
  assert.throws(() => writeDurableFile({ ...f.options, source: 'new evidence', mode: 'replace' }, {
    renameSync: (...args) => { renameSync(...args); writeFileSync(f.filePath, 'changed evidence'); },
  }), /File verification failed/);
  assert.equal(readFileSync(f.filePath, 'utf8'), 'changed evidence');
  assert.deepEqual(readdirSync(f.directory), ['evidence']);
});
