import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverInterruptedEncodes } from '../encoding-recovery.mjs';
import { StreamProcessing } from '../stream-processing.mjs';

const sha256 = 'a'.repeat(64);
const preparedSha256 = 'b'.repeat(64);
const record = frame => ({ frame, path: `/frames/${frame}.png`, sha256 });
const tick = () => new Promise(resolve => setImmediate(resolve));

class WorkerFixture {
  requests = [];
  active = new Map();
  closed = false;

  request(operation, args, options) {
    this.requests.push({ operation, args, options });
    if (this.closed) return Promise.reject(new Error('Worker closed'));
    if (operation === 'init') return Promise.resolve({ ready: true });
    if (operation === 'quality') return Promise.resolve({ qualityReport: { passed: true }, preparation: {} });
    if (operation === 'finish') return Promise.resolve({ video: 'complete' });
    return new Promise((resolve, reject) => this.active.set(args.frame, { resolve, reject, args }));
  }

  complete(frame, extra = {}) {
    const request = this.active.get(frame);
    this.active.delete(frame);
    request.resolve({ frame, sourceSha256: request.args.sha256, preparedSha256, ...extra });
  }

  async close() {
    this.closed = true;
    for (const request of this.active.values()) request.reject(new Error('Worker closed'));
    this.active.clear();
  }
}

function fixture(context, count = 3) {
  const worker = new WorkerFixture();
  const failures = [];
  const stream = new StreamProcessing(worker, { cardId: 1 }, { frameCount: count, onError: error => failures.push(error) });
  context.after(() => stream.close());
  return { worker, stream, failures };
}

test('two committed frames may process while the producer continues, with backpressure on the third', async context => {
  const { worker, stream } = fixture(context);
  await stream.enqueue(record(0));
  await stream.enqueue(record(1));
  assert.equal(worker.active.size, 2);
  let admitted = false;
  const third = stream.enqueue(record(2)).then(() => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  assert.equal(worker.requests.filter(item => item.operation === 'frame').length, 2);
  worker.complete(0);
  await third;
  assert.equal(worker.active.size, 2);
  let finished = false;
  const ending = stream.finish({ after: '/proof.png' }).then(result => { finished = true; return result; });
  await tick();
  assert.equal(finished, false);
  assert.equal(worker.requests.some(item => item.operation === 'finish'), false);
  worker.complete(1);
  worker.complete(2);
  assert.deepEqual(await ending, { video: 'complete' });
  assert.deepEqual(worker.requests.filter(item => item.operation === 'frame').map(item => item.args.frame), [0, 1, 2]);
});

test('initialization can wait for the same encoder budget as finalization', async context => {
  const { worker, stream } = fixture(context, 1);
  await stream.enqueue(record(0));
  worker.complete(0);
  await stream.finish({});
  assert.equal(worker.requests.find(item => item.operation === 'init').options.timeoutMilliseconds, 600_000);
  assert.deepEqual(worker.requests.find(item => item.operation === 'init').options,
    worker.requests.find(item => item.operation === 'finish').options);
});

test('finalization waits for the quality checkpoint and a failed checkpoint cannot publish', async context => {
  for (const failure of [false, true]) {
    const { worker, stream } = fixture(context, 1);
    await stream.enqueue(record(0));
    worker.complete(0);
    let completeCheckpoint;
    const checkpoint = new Promise((resolve, reject) => { completeCheckpoint = failure ? reject : resolve; });
    const finishing = stream.finish({ after: '/proof.png' }, async result => {
      assert.equal(result.qualityReport.passed, true);
      await checkpoint;
    });
    const result = failure ? assert.rejects(finishing, /checkpoint failed/) : finishing;
    await tick();
    assert.ok(worker.requests.some(item => item.operation === 'quality'));
    assert.equal(worker.requests.some(item => item.operation === 'finish'), false);
    completeCheckpoint(failure ? new Error('checkpoint failed') : undefined);
    await result;
    assert.equal(worker.requests.some(item => item.operation === 'finish'), !failure);
    if (failure) assert.equal(worker.closed, true);
  }
});

test('interrupted finalization retains the quality checkpoint needed by existing encode recovery', async context => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stream-recovery-')));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const published of [false, true]) {
    const root = join(directory, String(published));
    const output = join(root, 'output');
    const cache = join(root, 'cache');
    mkdirSync(output, { recursive: true });
    mkdirSync(cache);
    writeFileSync(join(cache, '.capture-owner.json'), JSON.stringify({ ownerId: 'owner', output, cache, ids: [1] }));
    const qualityPath = join(cache, 'quality.json');
    const manifestPath = join(output, '.render-manifest.json');
    const worker = new WorkerFixture();
    const request = worker.request.bind(worker);
    worker.request = (operation, args, options) => {
      if (operation !== 'finish') return request(operation, args, options);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.qualityReports[1].sha256, digest(readFileSync(qualityPath)));
      const path = published ? join(output, '1.mp4') : join(output, '.1.' + 'a'.repeat(32) + '.pending.mp4');
      writeFileSync(path, 'encoded bytes');
      return Promise.reject(new Error('Interrupted before finalization response'));
    };
    const stream = new StreamProcessing(worker, {}, { frameCount: 1 });
    context.after(() => stream.close());
    await stream.enqueue(record(0));
    worker.complete(0);
    await assert.rejects(stream.finish({}, async result => {
      writeFileSync(qualityPath, JSON.stringify(result.qualityReport));
      writeFileSync(manifestPath, JSON.stringify({ qualityReports: {
        1: { path: qualityPath, sha256: digest(readFileSync(qualityPath)) },
      } }));
    }), /Interrupted before finalization response/);
    const quality = JSON.parse(readFileSync(manifestPath, 'utf8')).qualityReports[1];
    const allowFinal = digest(readFileSync(quality.path)) === quality.sha256
      && JSON.parse(readFileSync(quality.path, 'utf8')).passed;
    const recovered = recoverInterruptedEncodes({ output, cache, ownerId: 'owner', id: 1, allowFinal });
    assert.equal(recovered.journals[0].complete, true);
    assert.equal(recovered.journals[0].entries[0].kind, published ? 'uncommitted-final' : 'pending-encode');
  }
});

test('same-session recovery replays committed frames exactly once and rejects changed hashes', async context => {
  const { worker, stream } = fixture(context);
  await stream.enqueue(record(0));
  worker.complete(0);
  await stream.enqueue(record(1));
  worker.complete(1);
  await stream.enqueue(record(0));
  await stream.enqueue(record(1));
  assert.equal(worker.requests.filter(item => item.operation === 'frame').length, 2);
  await assert.rejects(stream.enqueue({ ...record(0), sha256: 'c'.repeat(64) }), /identity changed/);
  assert.equal(worker.closed, true);
  await assert.rejects(stream.enqueue(record(2)), /identity changed/);
});

test('a resumed process can replay its durable native prefix then append fresh frames in order', async context => {
  const { worker, stream } = fixture(context);
  for (const saved of [record(0), record(1)]) {
    await stream.enqueue(saved);
    worker.complete(saved.frame);
  }
  await stream.enqueue(record(2));
  worker.complete(2);
  await stream.finish({ after: '/proof.png' });
  assert.deepEqual(worker.requests.filter(item => item.operation === 'frame').map(item => item.args),
    [0, 1, 2].map(frame => ({ frame, input: record(frame).path, sha256 })));
});

test('concurrent admissions retain order and an out-of-order checkpoint fails closed', async context => {
  const { worker, stream, failures } = fixture(context);
  await Promise.all([stream.enqueue(record(0)), stream.enqueue(record(1))]);
  assert.deepEqual([...worker.active.keys()], [0, 1]);
  await assert.rejects(stream.enqueue({ ...record(2), frame: 5 }), /Invalid committed/);
  assert.equal(worker.closed, true);
  assert.equal(failures.length, 1);
  const second = fixture(context);
  await assert.rejects(second.stream.enqueue(record(1)), /in order/);
  assert.equal(second.worker.closed, true);
});

test('worker failure or mismatched frame results cancels queued work and prevents finish', async context => {
  for (const mismatch of [false, true]) {
    const { worker, stream, failures } = fixture(context);
    await stream.enqueue(record(0));
    await stream.enqueue(record(1));
    const waiting = assert.rejects(stream.enqueue(record(2)), /fixture failure|does not match/);
    if (mismatch) worker.complete(0, { sourceSha256: 'c'.repeat(64) });
    else worker.active.get(0).reject(new Error('fixture failure'));
    await waiting;
    await assert.rejects(stream.finish({}), /fixture failure|does not match/);
    assert.equal(failures.length, 1);
    assert.equal(worker.closed, true);
    assert.equal(worker.requests.some(item => item.operation === 'finish'), false);
  }
});

test('closing during backpressure rejects pending admissions without publishing', async context => {
  const { worker, stream } = fixture(context);
  await stream.enqueue(record(0));
  await stream.enqueue(record(1));
  const pending = assert.rejects(stream.enqueue(record(2)), /closed/);
  await stream.close();
  await pending;
  assert.equal(worker.closed, true);
  assert.equal(worker.requests.some(item => item.operation === 'finish'), false);
});

test('an incomplete sequence cannot finish and a failed initialization cannot admit a frame', async context => {
  const { worker, stream } = fixture(context);
  await stream.enqueue(record(0));
  worker.complete(0);
  await assert.rejects(stream.finish({}), /exactly 3/);
  assert.equal(worker.requests.some(item => item.operation === 'finish'), false);
  const missing = new StreamProcessing({ request: () => Promise.reject(new Error('Worker exited')), close: async () => {} }, {});
  await assert.rejects(missing.enqueue(record(0)), /Worker exited/);
  await missing.close();
});
