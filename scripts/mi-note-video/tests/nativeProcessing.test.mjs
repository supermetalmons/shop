import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { cleanupPublicationCopy, finishNativeVideo, NativeProcessing } from '../native-processing.mjs';
import { hashFile, verifyCompletedCard } from '../native-config.mjs';

const sha256 = 'a'.repeat(64);
const record = frame => ({ frame, path: `/native/${String(frame).padStart(4, '0')}.png`, sha256 });
const receipt = frame => ({ frame, sourceSha256: sha256, preparedSha256: 'b'.repeat(64),
  preparation: { input: record(frame).path }, qualityRow: { frame, sha256 } });

class WorkerFixture {
  requests = [];
  pending = [];
  closed = false;
  mutate = value => value;

  async request(operation, args) {
    this.requests.push({ operation, args });
    if (this.closed) throw new Error('Worker closed');
    if (operation === 'init') return { ready: true, cardId: args.cardId, workers: args.workers, capacity: args.capacity };
    if (operation === 'frame') {
      const completed = this.pending.length >= 2 ? [receipt(this.pending.shift())] : [];
      this.pending.push(args.frame);
      return this.mutate({ acceptedFrame: args.frame, acceptedSha256: args.sha256, completed });
    }
    if (operation === 'quality') return this.mutate({ completed: this.pending.splice(0).map(receipt), qualityReport: { passed: true }, preparation: {} });
    if (operation === 'finish') return { video: 'complete' };
    throw new Error('Unknown operation');
  }

  async close() { this.closed = true; }
}

function fixture(context, frameCount = 4) {
  const worker = new WorkerFixture();
  const stream = new NativeProcessing(worker, { cardId: 17 }, { frameCount });
  context.after(() => stream.close());
  return { worker, stream };
}

test('ordered admissions and deferred receipts all complete before publication', async context => {
  const { worker, stream } = fixture(context);
  await Promise.all([0, 1, 2, 3].map(frame => stream.enqueue(record(frame))));
  assert.deepEqual([...stream.completed.keys()], [0, 1]);
  assert.deepEqual(await stream.finish({}, async checkpoint => {
    assert.equal(checkpoint.qualityReport.passed, true);
    assert.equal(stream.completed.size, 4);
    assert.equal(worker.requests.some(request => request.operation === 'finish'), false);
  }), { video: 'complete' });
  assert.deepEqual([...stream.completed.keys()], [0, 1, 2, 3]);
  assert.deepEqual(worker.requests.filter(request => request.operation === 'frame').map(request => request.args.frame), [0, 1, 2, 3]);
});

test('duplicate unchanged admissions are idempotent and changed checkpoints stop processing', async context => {
  const { worker, stream } = fixture(context);
  await stream.enqueue(record(0));
  await stream.enqueue(record(0));
  assert.equal(worker.requests.filter(request => request.operation === 'frame').length, 1);
  await assert.rejects(stream.enqueue({ ...record(0), sha256: 'c'.repeat(64) }), /identity changed/);
  assert.equal(worker.closed, true);
});

test('incorrect admission identity fails before another frame is accepted', async context => {
  const { worker, stream } = fixture(context);
  worker.mutate = result => ({ ...result, acceptedFrame: 99 });
  await assert.rejects(stream.enqueue(record(0)), /admission differs/);
  assert.equal(worker.closed, true);
  await assert.rejects(stream.enqueue(record(1)), /admission differs/);
});

test('incorrect, missing, and reordered completion receipts never publish', async context => {
  for (const invalid of ['hash', 'order', 'missing', 'input']) {
    const { worker, stream } = fixture(context, 2);
    await stream.enqueue(record(0));
    await stream.enqueue(record(1));
    worker.mutate = result => {
      if (invalid === 'missing') result.completed.pop();
      if (invalid === 'order') result.completed.reverse();
      if (invalid === 'hash') result.completed[0].sourceSha256 = 'c'.repeat(64);
      if (invalid === 'input') result.completed[0].preparation.input = '/wrong.png';
      return result;
    };
    await assert.rejects(stream.finish({}), /checkpoint|every admitted/);
    assert.equal(worker.closed, true);
    assert.equal(worker.requests.some(request => request.operation === 'finish'), false);
  }
});

test('failed quality checkpoint prevents encoder finalization', async context => {
  const { worker, stream } = fixture(context, 1);
  await stream.enqueue(record(0));
  await assert.rejects(stream.finish({}, async () => { throw new Error('checkpoint failed'); }), /checkpoint failed/);
  assert.equal(worker.closed, true);
  assert.equal(worker.requests.some(request => request.operation === 'finish'), false);
});

test('out of order and incomplete input cannot be finalized', async context => {
  const { stream } = fixture(context);
  await assert.rejects(stream.enqueue(record(1)), /in order/);
  const second = fixture(context);
  await second.stream.enqueue(record(0));
  await assert.rejects(second.stream.finish({}), /exactly 4/);
});

test('worker count and bounded capacity reject invalid configurations', () => {
  for (const options of [{ workers: 0 }, { workers: 4 }, { workers: 2, capacity: 1 }, { capacity: 5 }]) {
    assert.throws(() => new NativeProcessing({}, {}, options), /worker count or capacity/);
  }
});

test('cancellation during quality or encoder finalization closes the worker and rejects late success', async context => {
  for (const phase of ['quality', 'finish']) {
    const { worker, stream } = fixture(context, 1);
    await stream.enqueue(record(0));
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const original = worker.request.bind(worker);
    worker.request = async (...args) => {
      const result = await original(...args);
      if (args[0] === phase) { entered.resolve(); await release.promise; }
      return result;
    };
    const completed = stream.finish({});
    await entered.promise;
    stream.fail(new Error('interrupted'));
    assert.equal(worker.closed, true);
    release.resolve();
    await assert.rejects(completed, /interrupted/);
    assert.notEqual(stream.finished, true);
    if (phase === 'quality') assert.equal(worker.requests.some(request => request.operation === 'finish'), false);
  }
});

function publicationFixture(context) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-publication-')));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stagedPath = join(directory, '.video.staged.mp4'), output = join(directory, '17.mp4');
  const content = Buffer.from('validated encoded video');
  const result = { qualityReport: { passed: true }, video: { fullyDecoded: true, output: stagedPath,
    sha256: createHash('sha256').update(content).digest('hex') } };
  const processing = {
    async finish(args, checkpoint) {
      await checkpoint(result);
      writeFileSync(stagedPath, content);
      return result;
    },
    async close() {},
  };
  return { processing, result, content, stagedPath, output };
}

test('validated staged video is published without changing bytes', async context => {
  const data = publicationFixture(context);
  const result = await finishNativeVideo(data.processing, {}, { ...data, verify() {} });
  assert.deepEqual(readFileSync(data.output), data.content);
  assert.equal(result.video.output, data.output);
  assert.equal(result.video.sha256, data.result.video.sha256);
  assert.equal(existsSync(data.stagedPath), false);
});

test('failed publication checkpoint and cancellation during checkpoint never publish', async context => {
  for (const failure of ['checkpoint', 'cancellation']) {
    const data = publicationFixture(context);
    let interrupted = false;
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data,
      verify() { if (interrupted) throw new Error('interrupted'); },
      checkpointPublication(result) {
        assert.equal(existsSync(data.output), false);
        assert.equal(result.video.output, data.output);
        assert.equal(hashFile(data.stagedPath), result.video.sha256);
        if (failure === 'checkpoint') throw new Error('checkpoint failed');
        interrupted = true;
      } }), /checkpoint failed|interrupted/);
    assert.equal(existsSync(data.output), false);
    assert.deepEqual(readFileSync(data.stagedPath), data.content);
  }
});

test('source changes before or during finalization leave no published video', async context => {
  for (const phase of ['before', 'during']) {
    const data = publicationFixture(context);
    let changed = phase === 'before';
    const original = data.processing.finish;
    data.processing.finish = async (...args) => { const result = await original(...args); changed = true; return result; };
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data,
      verify() { if (changed) throw new Error('Rendering source changed'); } }), /source changed/);
    assert.equal(existsSync(data.output), false);
    assert.equal(existsSync(data.stagedPath), phase === 'during');
  }
});

test('cancellation after encoding but before publication retains only staged evidence', async context => {
  const data = publicationFixture(context);
  let interrupted = false;
  data.processing.close = async () => { interrupted = true; };
  await assert.rejects(finishNativeVideo(data.processing, {}, { ...data,
    verify() { if (interrupted) throw new Error('interrupted'); } }), /interrupted/);
  assert.equal(existsSync(data.output), false);
  assert.deepEqual(readFileSync(data.stagedPath), data.content);
});

test('failed quality, decode, and checksum checks cannot publish', async context => {
  for (const invalid of ['quality', 'decode', 'checksum', 'path']) {
    const data = publicationFixture(context);
    if (invalid === 'quality') data.result.qualityReport.passed = false;
    if (invalid === 'decode') data.result.video.fullyDecoded = false;
    if (invalid === 'checksum') data.result.video.sha256 = '0'.repeat(64);
    if (invalid === 'path') data.result.video.output = '/wrong.mp4';
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, verify() {} }), /did not pass|checksum/);
    assert.equal(existsSync(data.output), false);
  }
});

test('publication never overwrites an existing video', async context => {
  const data = publicationFixture(context);
  writeFileSync(data.output, 'existing video');
  await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, verify() {} }), { code: 'EEXIST' });
  assert.equal(readFileSync(data.output, 'utf8'), 'existing video');
  assert.equal(existsSync(data.stagedPath), true);
});

function crossVolumePublication(data, onCopy = () => {}) {
  const copiedPaths = [];
  return {
    copiedPaths,
    publicationFs: {
      linkSync(source, destination) {
        if (source === data.stagedPath) throw Object.assign(new Error('Different volume'), { code: 'EXDEV' });
        assert.equal(existsSync(data.stagedPath), true);
        assert.deepEqual(readFileSync(source), data.content);
        linkSync(source, destination);
      },
      copyFileSync(source, destination, flags) {
        assert.equal(flags, constants.COPYFILE_EXCL);
        assert.equal(dirname(destination), dirname(data.output));
        assert.ok(basename(destination).startsWith(`.${basename(data.output)}.`));
        copiedPaths.push(destination);
        copyFileSync(source, destination, flags);
        onCopy(destination);
      },
      unlinkSync,
    },
  };
}

test('cross-volume publication copies and revalidates before exclusively publishing complete bytes', async context => {
  const data = publicationFixture(context);
  let copied = false, verifiedCopy = false, checkpoint;
  const publication = crossVolumePublication(data, destination => {
    assert.equal(checkpoint.publicationCopyPath, destination);
    assert.equal(existsSync(data.output), false);
    copied = true;
  });
  const linkCopy = publication.publicationFs.linkSync;
  publication.publicationFs.linkSync = (source, destination) => {
    if (source !== data.stagedPath) assert.equal(verifiedCopy, true);
    linkCopy(source, destination);
  };
  const result = await finishNativeVideo(data.processing, {}, { ...data, ...publication,
    checkpointPublication(result) {
      if (result.publicationCopyPath) assert.equal(existsSync(result.publicationCopyPath), false);
      checkpoint = JSON.parse(JSON.stringify(result));
    },
    verify() { if (copied) { assert.equal(existsSync(data.output), false); verifiedCopy = true; } } });
  assert.equal(result.video.output, data.output);
  assert.deepEqual(readFileSync(data.output), data.content);
  assert.equal(existsSync(data.stagedPath), false);
  assert.equal(publication.copiedPaths.length, 1);
  assert.equal(existsSync(publication.copiedPaths[0]), false);
});

test('failed copy-path checkpoint and cancellation prevent cross-volume copying', async context => {
  for (const failure of ['checkpoint', 'cancellation']) {
    const data = publicationFixture(context);
    const publication = crossVolumePublication(data);
    let interrupted = false, checkpoints = 0;
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, ...publication,
      verify() { if (interrupted) throw new Error('interrupted'); },
      checkpointPublication(result) {
        checkpoints++;
        if (!result.publicationCopyPath) return;
        assert.equal(existsSync(result.publicationCopyPath), false);
        if (failure === 'checkpoint') throw new Error('copy checkpoint failed');
        interrupted = true;
      } }), /copy checkpoint failed|interrupted/);
    assert.equal(checkpoints, 2);
    assert.deepEqual(publication.copiedPaths, []);
    assert.equal(existsSync(data.output), false);
    assert.deepEqual(readFileSync(data.stagedPath), data.content);
  }
});

test('interrupted partial copies are cleaned only from the persisted publication receipt', async context => {
  const data = publicationFixture(context);
  const publication = crossVolumePublication(data);
  const receiptPath = join(dirname(data.output), 'publication.json');
  const unrelated = join(dirname(data.output), `.${basename(data.output)}.${randomUUID()}.tmp`);
  writeFileSync(unrelated, 'unrelated temporary file');
  publication.publicationFs.copyFileSync = (source, destination) => {
    const persisted = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(persisted.publicationCopyPath, destination);
    assert.equal(existsSync(destination), false);
    writeFileSync(destination, 'partial');
    throw new Error('copy interrupted');
  };
  await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, ...publication, verify() {},
    checkpointPublication(result) { writeFileSync(receiptPath, JSON.stringify(result)); } }), /copy interrupted/);
  const persisted = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(readFileSync(persisted.publicationCopyPath, 'utf8'), 'partial');
  assert.equal(existsSync(data.output), false);
  cleanupPublicationCopy(persisted, data.output);
  cleanupPublicationCopy(persisted, data.output);
  assert.equal(existsSync(persisted.publicationCopyPath), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'unrelated temporary file');
  assert.deepEqual(readFileSync(data.stagedPath), data.content);
});

test('publication copy cleanup rejects unsafe receipts and nonregular files', context => {
  const data = publicationFixture(context);
  writeFileSync(data.output, 'published video');
  const validPath = join(dirname(data.output), `.${basename(data.output)}.${randomUUID()}.tmp`);
  const result = { video: { output: data.output }, publicationCopyPath: validPath };
  cleanupPublicationCopy(undefined, data.output);
  cleanupPublicationCopy({}, data.output);
  for (const publicationCopyPath of [null, data.output, basename(validPath), join(dirname(data.output), '.17.mp4.invalid.tmp'),
    join(dirname(data.output), 'other', basename(validPath)), `${dirname(data.output)}/other/../${basename(validPath)}`]) {
    assert.throws(() => cleanupPublicationCopy({ ...result, publicationCopyPath }, data.output), /Invalid.*receipt/);
  }
  assert.throws(() => cleanupPublicationCopy({ ...result, video: { output: data.stagedPath } }, data.output), /Invalid.*receipt/);
  symlinkSync(data.output, validPath);
  assert.throws(() => cleanupPublicationCopy(result, data.output), /not a regular file/);
  unlinkSync(validPath);
  mkdirSync(validPath);
  assert.throws(() => cleanupPublicationCopy(result, data.output), /not a regular file/);
  assert.equal(readFileSync(data.output, 'utf8'), 'published video');
});

test('cross-volume copy corruption and source changes prevent publication and remove the copy', async context => {
  for (const invalid of ['checksum', 'source']) {
    const data = publicationFixture(context);
    let changed = false;
    const publication = crossVolumePublication(data, destination => {
      if (invalid === 'checksum') writeFileSync(destination, 'corrupted copy');
      else changed = true;
    });
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, ...publication,
      verify() { if (changed) throw new Error('Rendering source changed'); } }), /checksum differs|source changed/);
    assert.equal(existsSync(data.output), false);
    assert.deepEqual(readFileSync(data.stagedPath), data.content);
    assert.equal(publication.copiedPaths.length, 1);
    assert.equal(existsSync(publication.copiedPaths[0]), false);
  }
});

test('cross-volume publication does not overwrite a final video created while copying', async context => {
  const data = publicationFixture(context);
  const publication = crossVolumePublication(data, () => writeFileSync(data.output, 'existing video'));
  await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, ...publication, verify() {} }), { code: 'EEXIST' });
  assert.equal(readFileSync(data.output, 'utf8'), 'existing video');
  assert.deepEqual(readFileSync(data.stagedPath), data.content);
  assert.equal(publication.copiedPaths.length, 1);
  assert.equal(existsSync(publication.copiedPaths[0]), false);
});

test('publication cleanup failures leave durable receipts that recover only the matching video', async context => {
  for (const crossVolume of [false, true]) {
    const data = publicationFixture(context);
    const root = dirname(data.output), evidenceDirectory = join(root, 'evidence', '17');
    mkdirSync(join(evidenceDirectory, 'certificate'), { recursive: true });
    const certificatePath = join(evidenceDirectory, 'certificate', 'certificate.json');
    const stream = { nb_read_frames: '276' };
    writeFileSync(certificatePath, JSON.stringify({ version: 1, kind: 'mi-note-video-decode', fullyDecoded: true,
      videoSha256: data.result.video.sha256, videoBytes: data.content.length, decodedFrames: 276, stream }));
    Object.assign(data.result.video, { bytes: data.content.length, stream,
      decodeCertificate: { path: certificatePath, sha256: hashFile(certificatePath) } });
    const publicationFs = crossVolume ? crossVolumePublication(data).publicationFs : { copyFileSync, linkSync, unlinkSync };
    publicationFs.unlinkSync = () => { throw new Error('cleanup failed'); };
    const summaryPath = join(root, 'summary.json');
    await assert.rejects(finishNativeVideo(data.processing, {}, { ...data, publicationFs, verify() {},
      checkpointPublication(result) {
        assert.equal(existsSync(data.output), false);
        assert.equal(hashFile(data.stagedPath), result.video.sha256);
        const summary = { id: 17, status: 'publishing', evidenceDirectory, frameCount: 276,
          qualityPassed: true, fullyDecoded: true, video: { path: data.output, sha256: result.video.sha256 } };
        const detail = { ...summary, result, frames: Array.from({ length: 276 }, (_, frame) => ({ frame,
          path: join(evidenceDirectory, 'native', `${String(frame).padStart(4, '0')}.png`),
          sha256: 'a'.repeat(64), pose: { cardId: 17, frame } })) };
        writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
        writeFileSync(summaryPath, JSON.stringify(summary));
      } }), /cleanup failed/);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const detail = verifyCompletedCard(root, 17, summary, root, { allowPublishing: true });
    assert.equal(detail.status, 'publishing');
    if (crossVolume) assert.equal(existsSync(detail.result.publicationCopyPath), true);
    cleanupPublicationCopy(detail.result, data.output);
    if (crossVolume) assert.equal(existsSync(detail.result.publicationCopyPath), false);
    assert.deepEqual(readFileSync(data.output), data.content);
    writeFileSync(data.output, 'unrelated video');
    assert.throws(() => verifyCompletedCard(root, 17, summary, root, { allowPublishing: true }), /checksum differs/);
  }
});
