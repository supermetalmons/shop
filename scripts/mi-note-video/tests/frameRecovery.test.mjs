import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverUncommittedFrames } from '../frame-recovery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(context) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-frame-recovery-')));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const cache = join(directory, 'capture');
  const raw = join(cache, 'raw', '312c');
  mkdirSync(output);
  mkdirSync(raw, { recursive: true });
  const committed = join(raw, '0000.png');
  writeFileSync(committed, 'committed native bytes');
  const options = { output, cache, ownerId: 'owned-capture', id: 312, frameCount: 4, incomplete: true, compacted: false,
    nativeFrames: { '312:0': { id: 312, frame: 0, path: committed, sha256: digest(readFileSync(committed)) } } };
  writeFileSync(join(cache, '.capture-owner.json'), JSON.stringify({ ownerId: options.ownerId, output, cache, ids: [312] }));
  return { directory, raw, committed, options };
}

test('PNG written before its frame checkpoint is reported read-only and preserved before recapture', context => {
  const { raw, committed, options } = fixture(context);
  const orphan = join(raw, '0001.png');
  writeFileSync(orphan, 'uncommitted native bytes');
  mkdirSync(join(options.cache, 'tiles'), { recursive: true });
  const diagnostic = join(options.cache, 'tiles', 'original-attempt.png');
  writeFileSync(diagnostic, 'original tile diagnostics');
  const before = readFileSync(committed);
  const readOnly = recoverUncommittedFrames({ ...options, checkOnly: true });
  assert.equal(readOnly.pending.length, 1);
  assert.equal(readOnly.pending[0].frame, 1);
  assert.equal(existsSync(orphan), true);
  assert.equal(existsSync(join(options.cache, 'frame-recovery')), false);
  const recovered = recoverUncommittedFrames(options);
  assert.equal(recovered.journals[0].complete, true);
  assert.equal(existsSync(orphan), false);
  assert.equal(readFileSync(recovered.journals[0].entries[0].destination, 'utf8'), 'uncommitted native bytes');
  assert.deepEqual(readFileSync(committed), before);
  assert.equal(readFileSync(diagnostic, 'utf8'), 'original tile diagnostics');
  assert.equal(Object.hasOwn(options.nativeFrames, '312:1'), false);
  writeFileSync(orphan, 'freshly recaptured and committed bytes');
  options.nativeFrames['312:1'] = { id: 312, frame: 1, path: orphan, sha256: digest(readFileSync(orphan)) };
  assert.equal(recoverUncommittedFrames(options).journals.length, 1);
  assert.equal(readFileSync(orphan, 'utf8'), 'freshly recaptured and committed bytes');
});

test('an interrupted quarantine resumes after one PNG move without changing committed frames', context => {
  const { raw, committed, options } = fixture(context);
  writeFileSync(join(raw, '0001.png'), 'first orphan');
  writeFileSync(join(raw, '0002.png'), 'second orphan');
  const original = readFileSync(committed);
  assert.throws(() => recoverUncommittedFrames({ ...options, onMove() { throw new Error('Interrupted after PNG move'); } }), /Interrupted after PNG move/);
  assert.equal(readdirSync(raw).length, 2);
  const readOnly = recoverUncommittedFrames({ ...options, checkOnly: true });
  assert.equal(readOnly.journals[0].complete, false);
  assert.equal(readOnly.pending.length, 2);
  const journal = readFileSync(readOnly.journals[0].path);
  recoverUncommittedFrames({ ...options, checkOnly: true });
  assert.deepEqual(readFileSync(readOnly.journals[0].path), journal);
  const resumed = recoverUncommittedFrames(options);
  assert.equal(resumed.journals[0].complete, true);
  assert.deepEqual(readdirSync(raw), ['0000.png']);
  assert.deepEqual(readFileSync(committed), original);
  for (const entry of resumed.journals[0].entries) assert.equal(digest(readFileSync(entry.destination)), entry.sha256);
});

test('completed captures cannot reclassify missing checkpoints as recoverable frames', context => {
  const { raw, options } = fixture(context);
  writeFileSync(join(raw, '0001.png'), 'orphan');
  for (const state of [{ incomplete: false }, { incomplete: false, compacted: true }]) {
    assert.throws(() => recoverUncommittedFrames({ ...options, ...state }), /without a committed checkpoint/);
  }
  assert.equal(existsSync(join(raw, '0001.png')), true);
  assert.equal(existsSync(join(options.cache, 'frame-recovery')), false);
});

test('unknown names, symlinks and committed hash mismatches fail before any orphan moves', context => {
  const { raw, committed, options } = fixture(context);
  const orphan = join(raw, '0001.png');
  writeFileSync(orphan, 'orphan');
  writeFileSync(join(raw, 'notes.png'), 'unknown');
  assert.throws(() => recoverUncommittedFrames(options), /Unknown native frame name/);
  rmSync(join(raw, 'notes.png'));
  symlinkSync(committed, join(raw, '0002.png'));
  assert.throws(() => recoverUncommittedFrames(options), /regular native frame/);
  rmSync(join(raw, '0002.png'));
  writeFileSync(committed, 'changed committed frame');
  assert.throws(() => recoverUncommittedFrames(options), /Committed native frame changed/);
  assert.equal(existsSync(orphan), true);
  assert.equal(existsSync(join(options.cache, 'frame-recovery')), false);
});

test('missing or malformed committed checkpoints fail without adopting available PNGs', context => {
  const { raw, committed, options } = fixture(context);
  writeFileSync(join(raw, '0001.png'), 'orphan');
  rmSync(committed);
  assert.throws(() => recoverUncommittedFrames(options));
  writeFileSync(committed, 'committed native bytes');
  options.nativeFrames['312:0'] = null;
  assert.throws(() => recoverUncommittedFrames(options), /checkpoint is invalid/);
  assert.equal(existsSync(join(raw, '0001.png')), true);
  assert.equal(existsSync(join(options.cache, 'frame-recovery')), false);
});
