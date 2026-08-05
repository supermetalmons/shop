import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecordingFileStream,
  deliverRecordingBuffer,
  getRecordingBaseName,
  RECORDING_FRAME_RATE,
  RECORDING_VIDEO_BITRATE,
  resolveRecordingEncoder,
} from '../src/renderer/recordCardOutput';

test('recording output names preserve the base name and replace video extensions', () => {
  assert.equal(getRecordingBaseName(), 'holo-card');
  assert.equal(getRecordingBaseName('drop-card.mp4'), 'drop-card');
  assert.equal(getRecordingBaseName('drop-card.WEBM'), 'drop-card');
  assert.equal(getRecordingBaseName('drop-card'), 'drop-card');
});

test('recording encoder prefers the first supported MP4 profile', async () => {
  const attempts: string[] = [];
  const result = await resolveRecordingEncoder(
    { width: 1080, height: 1080 },
    false,
    async (codec, options) => {
      attempts.push(`${codec}:${options.fullCodecString}`);
      assert.equal(options.frameRate, RECORDING_FRAME_RATE);
      assert.equal(options.bitrate, RECORDING_VIDEO_BITRATE);
      assert.equal(options.latencyMode, 'realtime');
      return options.fullCodecString === 'avc1.42001f';
    },
  );

  assert.deepEqual(result, {
    container: 'mp4',
    codec: 'avc',
    fullCodecString: 'avc1.42001f',
  });
  assert.deepEqual(attempts, [
    'avc:avc1.64002a',
    'avc:avc1.640028',
    'avc:avc1.42001f',
  ]);
});

test('recording encoder falls back to WebM VP9 and then VP8', async () => {
  const attempts: string[] = [];
  const result = await resolveRecordingEncoder(
    { width: 720, height: 720 },
    false,
    async (codec, options) => {
      attempts.push(`${codec}:${options.fullCodecString}`);
      return codec === 'vp8';
    },
  );

  assert.equal(result.container, 'webm');
  assert.equal(result.codec, 'vp8');
  assert.deepEqual(attempts.slice(-2), ['vp9:vp09.00.10.08', 'vp8:vp8']);
});

test('recording encoder falls back to WebM when H.264 is unavailable at the actual frame rate', async () => {
  const attempts: string[] = [];
  const result = await resolveRecordingEncoder(
    { width: 1920, height: 1080 },
    false,
    async (codec, options) => {
      attempts.push(`${codec}:${options.frameRate}`);
      return codec === 'vp9' && options.frameRate === RECORDING_FRAME_RATE;
    },
  );

  assert.equal(result.container, 'webm');
  assert.equal(result.codec, 'vp9');
  assert.ok(attempts.slice(0, 5).every((attempt) => attempt === `avc:${RECORDING_FRAME_RATE}`));
  assert.equal(attempts[5], `vp9:${RECORDING_FRAME_RATE}`);
});

test('recording encoder skips H.264 for odd dimensions and falls back to WebM', async () => {
  const attempts: string[] = [];
  const result = await resolveRecordingEncoder(
    { width: 641, height: 481 },
    false,
    async (codec) => {
      attempts.push(codec);
      return true;
    },
  );

  assert.equal(result.container, 'webm');
  assert.equal(result.codec, 'vp9');
  assert.deepEqual(attempts, ['vp9']);
});

test('recording encoder reports MP4-only and general support failures', async () => {
  const unsupported = async () => false;
  await assert.rejects(
    resolveRecordingEncoder({ width: 640, height: 480 }, true, unsupported),
    /does not support MP4\/H\.264 encoding at 640x480/,
  );
  await assert.rejects(
    resolveRecordingEncoder({ width: 640, height: 480 }, false, unsupported),
    /does not support the WebCodecs encoder/,
  );
});

test('buffer recording output is delivered as a correctly typed blob', async () => {
  let savedBlob: Blob | null = null;
  let savedName = '';
  let downloaded = false;
  await deliverRecordingBuffer(
    Uint8Array.from([1, 2, 3]).buffer,
    'video/mp4',
    'card.mp4',
    (blob, name) => {
      savedBlob = blob;
      savedName = name;
    },
    () => {
      downloaded = true;
    },
  );

  assert.equal(savedBlob?.type, 'video/mp4');
  assert.equal(savedBlob?.size, 3);
  assert.equal(savedName, 'card.mp4');
  assert.equal(downloaded, false);
});

test('buffer recording output uses the download fallback', async () => {
  let downloadedName = '';
  await deliverRecordingBuffer(
    new ArrayBuffer(0),
    'video/webm',
    'card.webm',
    null,
    (_blob, name) => {
      downloadedName = name;
    },
  );
  assert.equal(downloadedName, 'card.webm');
  await assert.rejects(
    deliverRecordingBuffer(null, 'video/mp4', 'card.mp4', null, () => {}),
    /did not produce a buffer/,
  );
});

test('file recording stream forwards positioned writes and commits only after finalization', async () => {
  const writes: unknown[] = [];
  let closeCount = 0;
  let abortCount = 0;
  const destination = createRecordingFileStream({
    async write(chunk) {
      writes.push(chunk);
    },
    async close() {
      closeCount += 1;
    },
    async abort() {
      abortCount += 1;
    },
  });
  const writer = destination.stream.getWriter();
  const chunk = { type: 'write' as const, data: Uint8Array.from([4, 5]), position: 7 };
  await writer.write(chunk);
  await writer.close();

  assert.deepEqual(writes, [chunk]);
  assert.equal(closeCount, 0);
  assert.equal(abortCount, 0);

  await destination.commit();
  await destination.commit();

  assert.equal(closeCount, 1);
  assert.equal(abortCount, 0);
});

test('file recording stream can abort after Mediabunny closes it during failed finalization', async () => {
  const reason = new Error('encoding failed');
  let closeCount = 0;
  let abortReason: unknown = null;
  const destination = createRecordingFileStream({
    async write() {},
    async close() {
      closeCount += 1;
    },
    async abort(receivedReason) {
      abortReason = receivedReason;
    },
  });
  const writer = destination.stream.getWriter();
  await writer.close();
  await destination.abort(reason);

  assert.equal(abortReason, reason);
  assert.equal(closeCount, 0);
});

test('committed file recording streams ignore later cancellation', async () => {
  let closeCount = 0;
  let abortCount = 0;
  const destination = createRecordingFileStream({
    async write() {},
    async close() {
      closeCount += 1;
    },
    async abort() {
      abortCount += 1;
    },
  });
  const writer = destination.stream.getWriter();
  await writer.close();
  await destination.commit();
  await destination.abort(new Error('late failure'));

  assert.equal(closeCount, 1);
  assert.equal(abortCount, 0);
});

test('failed file aborts never fall back to committing partial output', async () => {
  let closeCount = 0;
  let abortCount = 0;
  const destination = createRecordingFileStream({
    async write() {},
    async close() {
      closeCount += 1;
    },
    async abort() {
      abortCount += 1;
      throw new Error('abort failed');
    },
  });
  const writer = destination.stream.getWriter();
  await writer.close();
  await destination.abort(new Error('encoding failed'));

  assert.equal(closeCount, 0);
  assert.equal(abortCount, 1);
});
