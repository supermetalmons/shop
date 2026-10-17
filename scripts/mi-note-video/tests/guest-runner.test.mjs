import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ackMatches, assertJobBackend, assertJobSources, assertPipelinePeers, assertRuntimeMatches, atomicJson, preserveIncomplete, runQueue, validateCaptureRelease, validateJob } from '../guest-runner.mjs';
import { nativeFramesSha256, sourceHashesSha256 } from '../capture-release.mjs';

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

test('execution jobs accept explicit backends without rewriting legacy VM identities', context => {
  const { job } = fixture(context);
  const before = structuredClone(job);
  assert.equal(validateJob(job), job);
  assert.deepEqual(job, before);
  for (const backend of ['host', 'vm']) assert.equal(validateJob({ ...job, backend }).backend, backend);
  for (const backend of ['', 'auto', null, 1]) assert.throws(() => validateJob({ ...job, backend }), /Unsupported native rendering backend/);
});

test('execution backend is pinned to both its environment and physical hardware', () => {
  const host = { platform: 'darwin', model: 'Mac14,5' };
  const vm = { platform: 'darwin', model: 'VirtualMac2,1' };
  assert.equal(assertJobBackend({}, 'vm', vm), 'vm');
  assert.equal(assertJobBackend({ backend: 'vm' }, 'vm', vm), 'vm');
  assert.equal(assertJobBackend({ backend: 'host' }, 'host', host), 'host');
  assert.throws(() => assertJobBackend({}, 'host', host), /environment differs from the pinned job backend/);
  assert.throws(() => assertJobBackend({ backend: 'vm' }, 'host', host), /environment differs from the pinned job backend/);
  assert.throws(() => assertJobBackend({ backend: 'host' }, 'vm', vm), /environment differs from the pinned job backend/);
  assert.throws(() => assertJobBackend({ backend: 'host' }, 'host', vm), /physical Mac hardware/);
  assert.throws(() => assertJobBackend({ backend: 'vm' }, 'vm', host), /configured macOS VM/);
  assert.throws(() => assertJobBackend({ backend: 'host' }, 'auto', host), /Unsupported native rendering backend/);
});

test('missing backend environment only permits a legacy or explicit VM execution', () => {
  const previous = process.env.MI_NOTE_RENDER_BACKEND;
  delete process.env.MI_NOTE_RENDER_BACKEND;
  try {
    const vm = { platform: 'darwin', model: 'VirtualMac2,1' };
    assert.equal(assertJobBackend({}, undefined, vm), 'vm');
    assert.equal(assertJobBackend({ backend: 'vm' }, undefined, vm), 'vm');
    assert.throws(() => assertJobBackend({ backend: 'host' }, undefined, vm), /environment differs from the pinned job backend/);
  } finally {
    if (previous !== undefined) process.env.MI_NOTE_RENDER_BACKEND = previous;
  }
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

test('pipeline admission permits one exact catalog peer and rejects unrelated or stale owners', context => {
  const { job } = fixture(context, [1]);
  const pipeline = { version: 1, catalogJobId: randomUUID(), maxUnfinished: 2 };
  const selected = { ...job, backend: 'host', pipeline };
  const peerJob = { ...selected, jobId: randomUUID() };
  const peer = { pid: 42, started: 'test-start', job: peerJob,
    owner: { jobId: peerJob.jobId, sourceId: peerJob.sourceId, pid: 42, started: 'test-start' } };
  assert.doesNotThrow(() => assertPipelinePeers(selected, [peer]));
  assert.throws(() => assertPipelinePeers(selected, [peer, peer]), /bounded pipeline/);
  assert.throws(() => assertPipelinePeers(job, [peer]), /bounded pipeline/);
  assert.throws(() => assertPipelinePeers(selected, [{ ...peer, started: 'replaced-process' }]), /bounded pipeline/);
  assert.throws(() => assertPipelinePeers(selected, [{ ...peer, job: { ...peerJob, pipeline: { ...pipeline, catalogJobId: randomUUID() } } }]), /bounded pipeline/);
  assert.throws(() => assertPipelinePeers(selected, [{ ...peer, job: { ...peerJob, sourceId: 'f'.repeat(64) } }]), /bounded pipeline/);
  assert.equal(validateJob(selected), selected);
  assert.throws(() => validateJob({ ...selected, backend: 'vm' }), /pipeline execution/);
  assert.throws(() => validateJob({ ...selected, ids: [1, 2] }), /pipeline execution/);
});

test('capture release binds every frame and proof and rejects a live owned Safari', context => {
  const { job } = fixture(context, [1]);
  job.backend = 'host';
  job.pipeline = { version: 1, catalogJobId: randomUUID(), maxUnfinished: 2 };
  const unit = join(job.root, 'cards/1');
  const path = join(unit, 'capture-complete.json');
  const manifest = { ownerId: 'owner', preflight: { path: join(unit, 'preflight/approved.json'), sha256: 'a'.repeat(64) },
    sourceHashes: { 'fixture.py': 'b'.repeat(64) }, nativeFrames: Object.fromEntries(Array.from({ length: 276 }, (_, frame) => [`1:${frame}`, {
      id: 1, frame, sha256: 'c'.repeat(64), iccSha256: 'd'.repeat(64), stitchReportSha256: 'e'.repeat(64),
    }])), nativeProofs: { 1: { before: { sha256: 'f'.repeat(64) }, after: { sha256: 'f'.repeat(64) } } },
    captures: [{ id: 1, method: 'c', repeat: { checks: [{ equal: true, iccEqual: true }] } }],
    captureWindows: [{ pid: 42, identity: 'owned-Safari' }] };
  const marker = { version: 1, status: 'capture-complete', jobId: job.jobId, sourceId: job.sourceId,
    attempt: 'current', cardId: 1, profile: job.profile, motion: job.motion, backend: job.backend, frameCount: 276,
    safariReleased: true, ownerId: 'owner', runId: 'run', preflight: manifest.preflight,
    nativeFramesSha256: nativeFramesSha256(manifest.nativeFrames), sourceHashesSha256: sourceHashesSha256(manifest.sourceHashes),
    before: { sha256: 'f'.repeat(64) }, after: { sha256: 'f'.repeat(64) }, captureWindows: [{ pid: 42, identity: 'owned-Safari' }] };
  assert.doesNotThrow(() => validateCaptureRelease(job, 'current', path, manifest, marker));
  manifest.nativeFrames['1:0'].archivePath = '/moved/after/compaction';
  assert.doesNotThrow(() => validateCaptureRelease(job, 'current', path, manifest, marker));
  assert.throws(() => validateCaptureRelease(job, 'current', path, manifest, marker, new Map([[42, 'owned-Safari']])), /live Safari/);
  assert.doesNotThrow(() => validateCaptureRelease(job, 'current', path, manifest, marker, new Map([[42, 'unrelated-reused-PID']])));
  for (const change of [{ attempt: 'stale' }, { sourceId: '0'.repeat(64) }, { cardId: 2 }, { safariReleased: false },
    { nativeFramesSha256: '0'.repeat(64) }, { after: { sha256: '0'.repeat(64) } }]) {
    assert.throws(() => validateCaptureRelease(job, 'current', path, manifest, { ...marker, ...change }));
  }
  assert.throws(() => validateCaptureRelease(job, 'current', join(unit, 'other.json'), manifest, marker));
  delete manifest.nativeFrames['1:275'];
  assert.throws(() => validateCaptureRelease(job, 'current', path, manifest, marker));
});

test('healthy pipeline drops duplicate check-resume while recovery retains both checks', async context => {
  for (const resume of [false, true]) {
    const { job } = fixture(context, [1]);
    job.backend = 'host';
    job.pipeline = { version: 1, catalogJobId: randomUUID(), maxUnfinished: 2 };
    if (resume) {
      const output = join(job.root, 'cards/1/output');
      mkdirSync(output, { recursive: true });
      atomicJson(join(output, '.render-manifest.json'), {});
    }
    const stages = [];
    const states = [];
    await assert.rejects(runQueue(job, { saveStatus: value => states.push(structuredClone(value)),
      stage(name, target, args, released) {
        stages.push(name);
        if (name === 'rendering') released({ attempt: 'fixture', path: 'fixture', sha256: 'a'.repeat(64) });
        if (name === 'auditing') throw Error('Stop at independent audit');
      }, waitForAck() { throw Error('Unexpected ack'); } }), /Stop at independent audit/);
    assert.deepEqual(stages, resume ? ['preflight', 'checking-resume', 'rendering', 'verifying', 'auditing'] : ['preflight', 'rendering', 'auditing']);
    assert.ok(states.some(value => value.status === 'processing' && value.captureReleased));
  }
});
