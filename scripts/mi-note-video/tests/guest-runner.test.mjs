import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ackMatches, assertJobSources, assertRuntimeMatches, atomicJson, preserveIncomplete, runQueue, validateJob } from '../guest-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => digest(readFileSync(path));

function fixture(context, ids = [1, 2]) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-queue-test-')));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const sourceRoot = join(temporary, 'source');
  const root = join(temporary, 'vm/jobs/test');
  mkdirSync(join(sourceRoot, 'scripts/mi-note-video'), { recursive: true });
  mkdirSync(join(sourceRoot, 'src/lib'), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(sourceRoot, 'scripts/mi-note-video/contract.json'), readFileSync(join(here, '../contract.json')));
  writeFileSync(join(sourceRoot, 'src/lib/miNoteCards.ts'), 'export const MI_NOTE_CARD_COUNT = 1430;\n');
  const files = Object.fromEntries(['scripts/mi-note-video/contract.json', 'src/lib/miNoteCards.ts'].map(path => [path, fileHash(join(sourceRoot, path))]));
  const sourceId = digest(JSON.stringify(files));
  atomicJson(join(sourceRoot, 'source-snapshot.json'), { version: 1, sourceId, files });
  const job = { version: 1, jobId: randomUUID(), name: 'test', ids, catalogCount: 1430, sourceRoot, sourceId, root,
    profile: 'sideways-1980', motion: 'breathing-swing', python: '/usr/bin/python3', node: process.execPath,
    contractSha256: files['scripts/mi-note-video/contract.json'] };
  atomicJson(join(root, 'job.json'), job);
  return { job, root, sourceRoot };
}

function completedUnit(job, id) {
  const unit = join(job.root, 'cards', String(id));
  for (const name of ['capture', 'preflight', 'output', 'transfer']) {
    mkdirSync(join(unit, name), { recursive: true });
    writeFileSync(join(unit, name, 'sentinel'), name);
  }
  const receipts = join(job.root, 'screenshot-transfers');
  mkdirSync(receipts, { recursive: true });
  const receipt = join(receipts, `${id}.json`);
  atomicJson(receipt, { destination: join(unit, 'capture', 'native.png'), passed: true });
  const inventory = join(unit, 'evidence-manifest.json');
  atomicJson(inventory, { files: [{ guestPath: receipt, sha256: fileHash(receipt) }] });
  const ready = { version: 1, jobId: job.jobId, sourceId: job.sourceId, cardId: id, profile: job.profile, motion: job.motion,
    unitRoot: unit, verificationId: 'previous-attempt', video: { output: join(unit, 'output', `${id}.mp4`), sha256: 'b'.repeat(64) },
    evidence: { path: inventory, sha256: fileHash(inventory) } };
  atomicJson(join(unit, 'completed.json'), { version: 1, jobId: job.jobId, sourceId: job.sourceId, cardId: id, status: 'acknowledged', ready });
  return { unit, receipt, ready };
}

function acknowledgment(ready) {
  return { version: 1, jobId: ready.jobId, sourceId: ready.sourceId, cardId: ready.cardId, verificationId: ready.verificationId,
    videoSha256: ready.video.sha256, evidenceSha256: ready.evidence.sha256 };
}

test('full pinned catalog is accepted and out-of-catalog or noncanonical IDs are rejected', context => {
  const { job } = fixture(context, Array.from({ length: 1430 }, (_, index) => index + 1));
  assert.equal(validateJob(job).ids.length, 1430);
  for (const ids of [[1, 1], [2, 1], [0], [1431], []]) assert.throws(() => validateJob({ ...job, ids }));
  assert.throws(() => validateJob({ ...job, sourceId: 'short-id' }), /source identity/);
});

test('source inventory, selected contract, and catalog are pinned to immutable bytes', context => {
  const { job, sourceRoot } = fixture(context);
  assertJobSources(job);
  assert.throws(() => assertJobSources({ ...job, contractSha256: 'f'.repeat(64) }), /contract checksum/);
  assert.throws(() => assertJobSources({ ...job, sourceId: 'f'.repeat(64) }), /snapshot identity/);
  assert.throws(() => assertJobSources({ ...job, catalogCount: 1429 }), /catalog size/);
  writeFileSync(join(sourceRoot, 'src/lib/miNoteCards.ts'), 'export const MI_NOTE_CARD_COUNT = 42;\n');
  assert.throws(() => assertJobSources(job), /source changed/);
});

test('runtime identity rejects version, system, executable, and missing-field changes', () => {
  const contract = JSON.parse(readFileSync(join(here, '../contract.json')));
  const pinned = { versions: { ...contract.runtime, safari: 'Pinned Safari version', macos: '27.0.1' },
    executableSha256: Object.fromEntries(['ffmpeg', 'ffprobe', 'node', 'python'].map((name, index) => [name, String(index).repeat(64)])) };
  assert.deepEqual(assertRuntimeMatches(pinned, structuredClone(pinned)), pinned);
  for (const name of Object.keys(pinned.versions)) {
    const changed = structuredClone(pinned);
    changed.versions[name] += '-updated';
    assert.throws(() => assertRuntimeMatches(pinned, changed), new RegExp(`Runtime ${name} changed`));
  }
  for (const name of Object.keys(pinned.executableSha256)) {
    const changed = structuredClone(pinned);
    changed.executableSha256[name] = 'f'.repeat(64);
    assert.throws(() => assertRuntimeMatches(pinned, changed), new RegExp(`Runtime ${name} executable checksum`));
  }
  const missing = structuredClone(pinned);
  delete missing.versions.safari;
  assert.throws(() => assertRuntimeMatches(pinned, missing), /Incomplete pinned runtime identity/);
  assert.throws(() => assertRuntimeMatches(undefined, pinned), /Incomplete pinned runtime identity/);
  const changedContract = structuredClone(pinned);
  changedContract.versions.ffmpeg = '0.0.0';
  assert.throws(() => assertRuntimeMatches(changedContract, changedContract), /differs from the rendering contract/);
});

test('queue waits for fresh acknowledgments before cleanup and advancing', async context => {
  const { job, sourceRoot } = fixture(context);
  const first = completedUnit(job, 1);
  const second = completedUnit(job, 2);
  const acknowledged = [];
  const status = await runQueue(job, { attempt: 'new-attempt', saveStatus() {},
    stage() { throw Error('Completed units must not invoke the renderer'); },
    async waitForAck(ready) {
      assert.equal(ready.verificationId, 'new-attempt');
      assert.equal(ready.requiresHostVerification, true);
      assert.ok(existsSync(join(ready.unitRoot, 'capture/sentinel')));
      if (ready.cardId === 2) {
        assert.equal(existsSync(join(first.unit, 'capture')), false);
        assert.equal(existsSync(first.receipt), false);
      }
      acknowledged.push(ready.cardId);
      return acknowledgment(ready);
    } });
  assert.deepEqual(acknowledged, [1, 2]);
  assert.equal(status.status, 'complete');
  assert.equal(status.currentCard, null);
  assert.equal(existsSync(join(second.unit, 'output')), false);
  assert.equal(existsSync(second.receipt), false);
  assert.ok(existsSync(join(first.unit, 'completed.json')));
  assert.ok(existsSync(join(sourceRoot, 'source-snapshot.json')));
  assertJobSources(job);
});

test('interruption while waiting preserves checkpoints and receipts', async context => {
  const { job } = fixture(context, [1]);
  const { unit, receipt } = completedUnit(job, 1);
  const states = [];
  const interrupted = Object.assign(Error('Stopped by test'), { code: 'INTERRUPTED' });
  await assert.rejects(runQueue(job, { saveStatus: value => states.push(structuredClone(value)),
    stage() { throw Error('Unexpected renderer'); }, waitForAck() { throw interrupted; } }), /Stopped by test/);
  assert.equal(states.at(-1).status, 'interrupted');
  assert.ok(existsSync(join(unit, 'capture/sentinel')));
  assert.ok(existsSync(receipt));
});

test('interruption inside a capture stage preserves that stage checkpoint', async context => {
  const { job } = fixture(context, [1]);
  const checkpoint = join(job.root, 'cards/1/preflight/checkpoint');
  const states = [];
  await assert.rejects(runQueue(job, { saveStatus: value => states.push(structuredClone(value)),
    stage() {
      mkdirSync(dirname(checkpoint), { recursive: true });
      writeFileSync(checkpoint, 'preserve native evidence');
      throw Object.assign(Error('Interrupted child'), { code: 'INTERRUPTED' });
    }, waitForAck() { throw Error('Unfinished render must not request acknowledgment'); } }), /Interrupted child/);
  assert.equal(states.at(-1).status, 'interrupted');
  assert.equal(readFileSync(checkpoint, 'utf8'), 'preserve native evidence');
});

test('an approved preflight is natively reverified after interruption before the first capture manifest', async context => {
  const { job } = fixture(context, [1]);
  const unit = join(job.root, 'cards/1');
  const approval = join(unit, 'preflight/approved.json');
  const manifest = join(unit, 'output/.render-manifest.json');
  await assert.rejects(runQueue(job, { saveStatus() {},
    stage(name, target, args) {
      if (name === 'preflight') {
        assert.equal(args.includes('--verify-resume'), false);
        mkdirSync(dirname(approval), { recursive: true });
        atomicJson(approval, { status: 'passed', fixture: 'preserved approval' });
        return;
      }
      assert.equal(name, 'rendering');
      assert.equal(target, 'capture.mjs');
      assert.equal(args.includes('--resume'), false);
      throw Object.assign(Error('Interrupted before capture initialization'), { code: 'INTERRUPTED' });
    }, waitForAck() { throw Error('Uncaptured unit cannot request acknowledgment'); } }), /Interrupted before capture initialization/);
  const original = readFileSync(approval);
  assert.equal(existsSync(manifest), false);
  const resumed = [];
  await assert.rejects(runQueue(job, { saveStatus() {},
    stage(name, target, args) {
      resumed.push(name);
      assert.equal(name, 'preflight');
      assert.equal(target, 'preflight.mjs');
      assert.equal(args.includes('--verify-resume'), true);
      throw Error('Stopped after verifying native preflight dispatch');
    }, waitForAck() { throw Error('Unverified unit cannot request acknowledgment'); } }), /Stopped after verifying native preflight dispatch/);
  assert.deepEqual(resumed, ['preflight']);
  assert.deepEqual(readFileSync(approval), original);
  assert.equal(existsSync(manifest), false);
});

test('stale or mismatching acknowledgments never authorize unit cleanup', async context => {
  const { job } = fixture(context, [1]);
  const { unit } = completedUnit(job, 1);
  await assert.rejects(runQueue(job, { attempt: 'current', saveStatus() {}, stage() {},
    waitForAck(ready) { return { ...acknowledgment(ready), verificationId: 'previous' }; } }), /acknowledgment/);
  assert.ok(existsSync(join(unit, 'output/sentinel')));
  const ready = JSON.parse(readFileSync(join(unit, 'ready.json')));
  assert.equal(ackMatches(acknowledgment(ready), ready), true);
  assert.equal(ackMatches({ ...acknowledgment(ready), evidenceSha256: '0'.repeat(64) }, ready), false);
});

test('manifestless initialization preserves both directories and resumes a partial quarantine', context => {
  const { root } = fixture(context);
  const unit = join(root, 'cards/1');
  for (const name of ['capture', 'output']) {
    mkdirSync(join(unit, name), { recursive: true });
    writeFileSync(join(unit, name, 'sentinel'), name);
  }
  preserveIncomplete(unit);
  const [recovery] = readdirSync(join(unit, 'incomplete'));
  const saved = join(unit, 'incomplete', recovery);
  assert.equal(readFileSync(join(saved, 'capture/sentinel'), 'utf8'), 'capture');
  assert.equal(readFileSync(join(saved, 'output/sentinel'), 'utf8'), 'output');
  renameSync(join(saved, 'capture'), join(unit, 'capture'));
  renameSync(join(saved, 'recovery.json'), join(unit, 'initialization-recovery.json'));
  preserveIncomplete(unit);
  assert.equal(readFileSync(join(saved, 'capture/sentinel'), 'utf8'), 'capture');
  assert.equal(existsSync(join(unit, 'initialization-recovery.json')), false);
});
