import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preparedWorkingFramePattern, recoverInterruptedEncodes } from '../encoding-recovery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const pendingName = `.312.${'a'.repeat(32)}.pending.mp4`;

function fixture(context) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-encoding-recovery-')));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const cache = join(directory, 'capture');
  mkdirSync(output);
  mkdirSync(cache);
  const options = { output, cache, ownerId: 'owned-test-capture', id: 312, allowFinal: true };
  writeFileSync(join(cache, '.capture-owner.json'), JSON.stringify({ ownerId: options.ownerId, output, cache, ids: [312] }));
  return { directory, ...options };
}

test('check-resume reports an owned pending encode without moving or creating anything', context => {
  const options = fixture(context);
  const pending = join(options.output, pendingName);
  writeFileSync(pending, 'partially written encoder output');
  const before = readFileSync(pending);
  const result = recoverInterruptedEncodes({ ...options, allowFinal: false, checkOnly: true });
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].kind, 'pending-encode');
  assert.deepEqual(readFileSync(pending), before);
  assert.deepEqual(readdirSync(options.cache), ['.capture-owner.json']);
  assert.deepEqual(readdirSync(options.output), [pendingName]);
});

test('pending and completed-but-uncommitted outputs are preserved for inspection, never adopted', context => {
  const options = fixture(context);
  const contents = new Map([[pendingName, 'unfinished bytes'], ['312.mp4', 'uncommitted final bytes']]);
  for (const [name, value] of contents) writeFileSync(join(options.output, name), value);
  const result = recoverInterruptedEncodes(options);
  assert.equal(result.journals.length, 1);
  assert.equal(result.journals[0].complete, true);
  assert.equal(result.journals[0].entries.length, 2);
  for (const entry of result.journals[0].entries) {
    assert.equal(existsSync(entry.source), false);
    assert.equal(readFileSync(entry.destination, 'utf8'), contents.get(entry.source.split('/').at(-1)));
    assert.equal(digest(readFileSync(entry.destination)), entry.sha256);
  }
  assert.deepEqual(readdirSync(options.output), []);
  assert.equal(result.committed, undefined);
});

test('quarantine resumes an interruption after the first move with exact original bytes', context => {
  const options = fixture(context);
  writeFileSync(join(options.output, pendingName), 'pending');
  writeFileSync(join(options.output, '312.mp4'), 'uncommitted');
  let moves = 0;
  assert.throws(() => recoverInterruptedEncodes({ ...options, onMove() { moves += 1; throw new Error('Simulated interruption'); } }), /Simulated interruption/);
  assert.equal(moves, 1);
  assert.equal(readdirSync(options.output).length, 1);
  const readonly = recoverInterruptedEncodes({ ...options, checkOnly: true });
  const journalBefore = readFileSync(readonly.journals[0].path);
  assert.equal(readonly.journals[0].complete, false);
  assert.equal(readonly.pending.length, 2);
  assert.deepEqual(readFileSync(readonly.journals[0].path), journalBefore);
  assert.equal(readdirSync(options.output).length, 1);
  const resumed = recoverInterruptedEncodes(options);
  assert.equal(resumed.journals.length, 1);
  assert.equal(resumed.journals[0].complete, true);
  assert.deepEqual(readdirSync(options.output), []);
  for (const entry of resumed.journals[0].entries) assert.equal(digest(readFileSync(entry.destination)), entry.sha256);
});

test('a new verified canonical video can reuse the filename after quarantine', context => {
  const options = fixture(context);
  const output = join(options.output, '312.mp4');
  writeFileSync(output, 'old uncommitted video');
  recoverInterruptedEncodes(options);
  const bytes = Buffer.from('new independently validated video');
  writeFileSync(output, bytes);
  const result = recoverInterruptedEncodes({ ...options, allowFinal: false,
    committed: { id: 312, output, bytes: bytes.length, sha256: digest(bytes) } });
  assert.deepEqual(readFileSync(output), bytes);
  assert.equal(result.journals.length, 1);
  assert.equal(result.journals[0].complete, true);
});

test('unknown video names fail before any recognized pending file moves', context => {
  const options = fixture(context);
  writeFileSync(join(options.output, pendingName), 'pending');
  writeFileSync(join(options.output, '312d.mp4'), 'another filename');
  assert.throws(() => recoverInterruptedEncodes(options), /Unrecognized uncommitted video/);
  assert.equal(existsSync(join(options.output, pendingName)), true);
  assert.equal(existsSync(join(options.output, '312d.mp4')), true);
  assert.equal(existsSync(join(options.cache, 'encoding-recovery')), false);
});

test('symlinked pending files and incorrect cache ownership are rejected', context => {
  const options = fixture(context);
  const external = join(options.directory, 'outside');
  writeFileSync(external, 'preserve external file');
  symlinkSync(external, join(options.output, pendingName));
  assert.throws(() => recoverInterruptedEncodes(options), /regular encoding recovery file/);
  assert.throws(() => recoverInterruptedEncodes({ ...options, ownerId: 'another-owner' }), /ownership differs/);
  assert.equal(readFileSync(external, 'utf8'), 'preserve external file');
  assert.equal(existsSync(join(options.cache, 'encoding-recovery')), false);
});

test('committed video hash mismatches and unverified orphan finals remain untouched', context => {
  const options = fixture(context);
  const output = join(options.output, '312.mp4');
  writeFileSync(output, 'mismatching final');
  assert.throws(() => recoverInterruptedEncodes({ ...options, allowFinal: false }), /lacks verified native evidence/);
  assert.throws(() => recoverInterruptedEncodes({ ...options, committed: { id: 312, output, bytes: 17, sha256: '0'.repeat(64) } }), /bytes changed/);
  assert.equal(readFileSync(output, 'utf8'), 'mismatching final');
  assert.equal(existsSync(join(options.cache, 'encoding-recovery')), false);
});

test('an interrupted journal with conflicting copies or an escaping destination is rejected', context => {
  const options = fixture(context);
  writeFileSync(join(options.output, pendingName), 'pending');
  assert.throws(() => recoverInterruptedEncodes({ ...options, onMove() { throw new Error('Interrupted'); } }), /Interrupted/);
  const result = recoverInterruptedEncodes({ ...options, checkOnly: true });
  const entry = result.journals[0].entries[0];
  copyFileSync(entry.destination, entry.source);
  assert.throws(() => recoverInterruptedEncodes(options), /conflicting or missing copies/);
  assert.equal(readFileSync(entry.source, 'utf8'), 'pending');
  assert.equal(readFileSync(entry.destination, 'utf8'), 'pending');
  const journal = JSON.parse(readFileSync(result.journals[0].path, 'utf8'));
  journal.entries[0].destination = join(options.directory, 'outside');
  writeFileSync(result.journals[0].path, JSON.stringify(journal));
  assert.throws(() => recoverInterruptedEncodes(options), /Invalid encoding recovery journal entry/);
  assert.equal(existsSync(join(options.directory, 'outside')), false);
});

test('prepared-frame cleanup recognizes only numbered images and exact encoder-owned pending names', () => {
  for (const name of ['0000.png', '0275.png', `.0000.${'a'.repeat(32)}.pending.png`]) assert.equal(preparedWorkingFramePattern.test(name), true);
  for (const name of ['notes.png', '.0000.pending.png', '.0000.abc.pending.png', `.0000.${'a'.repeat(32)}.pending.mp4`, 'nested/0000.png']) {
    assert.equal(preparedWorkingFramePattern.test(name), false);
  }
});
