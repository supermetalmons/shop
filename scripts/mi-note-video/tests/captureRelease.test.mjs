import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureReleaseRecord, confirmOwnedProcessesStopped, nativeFramesSha256, releaseCaptureResources, saveCaptureRelease, sourceHashesSha256 } from '../capture-release.mjs';
import { Safari } from '../safari.mjs';

const hash = 'a'.repeat(64);

function manifest() {
  return { ids: [18], profile: 'upright-2160', motion: 'breathing-swing', backend: 'host', ownerId: 'owned',
    preflight: { path: '/preflight.json', sha256: hash }, sourceHashes: { 'capture.mjs': hash },
    nativeFrames: Object.fromEntries(Array.from({ length: 276 }, (_, frame) => [`18:${frame}`, {
      id: 18, frame, path: `/raw/${frame}.png`, sha256: hash, iccSha256: hash, stitchReportSha256: hash,
    }])),
    nativeProofs: { 18: { before: { path: '/before.png', sha256: hash }, after: { path: '/after.png', sha256: hash } } },
    captures: [{ id: 18, method: 'c', repeat: { checks: [{ equal: true, iccEqual: true }] } }],
    captureWindows: [{ pid: 123, identity: 'owned Safari identity' }] };
}

const job = { jobId: 'job', sourceId: hash, backend: 'host', profile: 'upright-2160', motion: 'breathing-swing' };

test('release binds complete native pixels and proofs and remains stable after compaction metadata changes', () => {
  const saved = manifest();
  const record = captureReleaseRecord({ manifest: saved, job, attempt: 'attempt', runId: 'run', cardId: 18 });
  assert.equal(record.frameCount, 276);
  assert.equal(record.nativeFramesSha256, nativeFramesSha256(saved.nativeFrames));
  assert.equal(record.sourceHashesSha256, sourceHashesSha256(saved.sourceHashes));
  saved.nativeFrames['18:0'].archivePath = '/archive/0000.png';
  saved.nativeFrames['18:0'].viewportSources = [{ path: '/archive/tile.png' }];
  assert.equal(record.nativeFramesSha256, nativeFramesSha256(saved.nativeFrames));
  saved.nativeFrames['18:0'].sha256 = 'b'.repeat(64);
  assert.notEqual(record.nativeFramesSha256, nativeFramesSha256(saved.nativeFrames));
});

test('release rejects incomplete checkpoints, missing rest proof, and a changed job identity', () => {
  for (const mutate of [value => delete value.nativeFrames['18:275'], value => { value.nativeFrames['18:275'].frame = 274; },
    value => { value.nativeFrames['18:275'].sha256 = 'wrong'; }, value => delete value.nativeProofs[18].after,
    value => { value.captures[0].repeat.checks[0].equal = false; }, value => { value.backend = 'vm'; }]) {
    const saved = manifest();
    mutate(saved);
    assert.throws(() => captureReleaseRecord({ manifest: saved, job, attempt: 'attempt', runId: 'run', cardId: 18 }), /Capture release/);
  }
});

test('owned process confirmation waits for the exact process identity and refuses a live owner', async () => {
  let calls = 0;
  await confirmOwnedProcessesStopped([{ pid: 1, identity: 'original' }], () => new Map(++calls === 1 ? [[1, 'original']] : [[1, 'reused PID']]),
    { timeoutMilliseconds: 50, pollMilliseconds: 1 });
  assert.equal(calls, 2);
  await assert.rejects(confirmOwnedProcessesStopped([{ pid: 1, identity: 'original' }], () => new Map([[1, 'original']]),
    { timeoutMilliseconds: 2, pollMilliseconds: 1 }), /did not stop/);
});

test('resource release and durable milestone occur while CPU processing may still be unfinished', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-release-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const events = [];
  let finishCpu;
  let cpuComplete = false;
  const cpu = new Promise(resolve => { finishCpu = resolve; }).then(() => { cpuComplete = true; });
  await releaseCaptureResources({ stopSafari: async () => { events.push('Safari stopped'); },
    stopServer: async () => { events.push('server stopped'); }, closeWorker: async () => { events.push('stitch worker stopped'); },
    identities: [{ pid: 1, identity: 'owned' }], processList: () => { events.push('confirmed process exit'); return new Map(); } });
  const record = captureReleaseRecord({ manifest: manifest(), job, attempt: 'attempt', runId: 'run', cardId: 18 });
  const path = join(directory, 'capture-complete.json');
  saveCaptureRelease(path, record);
  assert.deepEqual(events, ['Safari stopped', 'server stopped', 'confirmed process exit', 'stitch worker stopped']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record);
  assert.deepEqual(readdirSync(directory), ['capture-complete.json']);
  assert.equal(cpuComplete, false);
  finishCpu();
  await cpu;
});

test('a failed browser shutdown cannot reach the server or milestone stages', async () => {
  await assert.rejects(releaseCaptureResources({ stopSafari: async () => { throw new Error('driver alive'); },
    stopServer: () => assert.fail('release proceeded'), closeWorker: () => assert.fail('release proceeded'),
    identities: [], processList: () => assert.fail('release proceeded') }), /driver alive/);
});

test('Safari driver close waits for the actual owned child exit', async () => {
  const safari = new Safari(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.id)process.stdout.write(JSON.stringify({id:request.id,result:{serverInfo:{}}})+'\\n');
    });
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),40));
    setInterval(()=>{},1000);
  `]);
  await safari.initialize();
  await safari.close();
  assert.notEqual(safari.child.exitCode, null);
  assert.throws(() => process.kill(safari.child.pid, 0), { code: 'ESRCH' });
  await safari.close();
});

test('a Safari driver that ignores SIGTERM is killed before release can complete', async () => {
  const safari = new Safari(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.id)process.stdout.write(JSON.stringify({id:request.id,result:{serverInfo:{}}})+'\\n');
    });
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);
  `]);
  await safari.initialize();
  await safari.close(20);
  assert.equal(safari.child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(safari.child.pid, 0), { code: 'ESRCH' });
});
