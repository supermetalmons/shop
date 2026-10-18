import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { FrameWorker } from './frame-worker.mjs';
import { cleanupPublicationCopy, finishNativeVideo, NativeProcessing } from './native-processing.mjs';
import { assertBackgroundPresentation, assertNativeHost, assertResumeIdentity, assertSourceHashes, catalogCount, contract, engineDirectory, hashFile, renderingSourceHashes, verifyCompletedCard, viteOptions } from './native-config.mjs';
import { parseArguments } from './cli.mjs';
import { expectedIccSha256, runtimePaths, verifyNativeEnvironment } from './native-runtime.mjs';
import { nativeRunPaths, prepareNativeOutput, pruneNativeIntermediates } from './native-output.mjs';

const requested = parseArguments(process.argv.slice(2), catalogCount());
if (!['run', 'resume'].includes(requested.command)) throw new Error('Use cli.mjs for help and doctor.');
const paths = runtimePaths();
assertNativeHost();
const environment = verifyNativeEnvironment(paths);
const options = { ...requested, app: paths.app, python: paths.python, method: 'screen-capture-stream',
  port: 5198, 'expected-icc': expectedIccSha256, probe: false };
const ids = requested.cardIds;
const runPaths = nativeRunPaths(options);
const { stateDirectory, manifestPath } = runPaths;
process.env.MI_NOTE_FFMPEG = paths.ffmpeg;
process.env.MI_NOTE_FFPROBE = paths.ffprobe;
const save = (path, data) => {
  const pending = path + '.pending';
  writeFileSync(pending, JSON.stringify(data, null, 2) + '\n');
  renameSync(pending, path);
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
const timed = async action => {
  const start = performance.now();
  const result = await action();
  return { result, milliseconds: performance.now() - start };
};
const sourceHashes = renderingSourceHashes();
const identity = { version: 2, backend: 'native-webview', ids, method: options.method, profile: 'upright-2160', motion: 'breathing-swing',
  presentation: options.background ? 'offscreen' : 'foreground',
  contract, sourceHashes, app: environment.app, expectedIccSha256,
  captureColorSpace: 'display-p3',
  capture: { physicalWidth: 3304, physicalHeight: 3304, backingScale: 2, crop: { x: 32, y: 32, width: 3240, height: 3240 },
    pixelFormat: 'BGRA8', compositorPaintMarker: true, geometryWarmupFrames: 276, initialWarmupCaptures: options.background ? 1 : 0,
    startMatches: 2, endMatches: 2, maximumEndAttempts: 8 },
  processing: { workers: 2, capacity: 3, orderedEncoding: true },
  runtime: { root: environment.runtime.root, receiptSha256: environment.runtime.receiptSha256, verifiedEntries: environment.runtime.verifiedEntries },
  versions: environment.versions, executables: environment.executables,
  retention: options['retain-all'] ? 'all-frames' : 'receipts', output: options.output, stateDirectory };
const initialManifest = { ...identity, status: 'starting', pid: process.pid,
  startedAt: new Date().toISOString(), ids, method: options.method, profile: 'upright-2160', motion: 'breathing-swing',
  cards: {} };
prepareNativeOutput(options, runPaths, initialManifest);
const manifest = options.resume ? JSON.parse(readFileSync(manifestPath, 'utf8')) : initialManifest;
if (options.resume) {
  assertResumeIdentity(manifest, identity);
  if (manifest.pid !== process.pid) {
    try { process.kill(manifest.pid, 0); throw new Error('The previous native renderer is still running.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  manifest.pid = process.pid;
  manifest.resumedAt = new Date().toISOString();
  delete manifest.error;
}
const persist = () => {
  const cards = Object.fromEntries(Object.entries(manifest.cards).map(([id, record]) => {
    if (Number(id) === manifest.currentCard && record.frames && record.evidenceDirectory) save(join(record.evidenceDirectory, 'card.json'), record);
    const { frames, before, after, result, ...summary } = record;
    return [id, { ...summary, frameCount: frames?.length ?? record.frameCount,
      qualityPassed: result?.qualityReport?.passed ?? record.qualityPassed,
      fullyDecoded: result?.video?.fullyDecoded ?? record.fullyDecoded }];
  }));
  save(manifestPath, { ...manifest, cards });
};
function cleanupCard(record) {
  try {
    pruneNativeIntermediates(record.evidenceDirectory);
    record.retainedFrames = [];
    record.retainedDecodedSamples = [];
    delete record.cleanupError;
  } catch (error) {
    record.cleanupError = String(error.message || error);
    console.error(`Card ${record.id} is complete, but intermediate cleanup failed: ${record.cleanupError}`);
  }
  save(join(record.evidenceDirectory, 'card.json'), record);
}
if (options.resume) {
  for (const card of ids) {
    const previous = manifest.cards[card];
    const videoPath = join(options.output, `${card}.mp4`);
    if (previous?.status !== 'complete' && !existsSync(videoPath)) {
      if (previous?.status === 'publishing') {
        const evidenceDirectory = join(stateDirectory, 'evidence', String(card));
        const detail = JSON.parse(readFileSync(join(evidenceDirectory, 'card.json'), 'utf8'));
        check(detail.id === card && detail.status === 'publishing' && detail.evidenceDirectory === evidenceDirectory
          && detail.video?.path === videoPath && detail.video.sha256 === previous.video?.sha256,
        `Native card ${card} publication receipt differs.`);
        cleanupPublicationCopy(detail.result, videoPath);
      }
      continue;
    }
    const detail = verifyCompletedCard(options.output, card, previous, stateDirectory, { allowPublishing: true });
    cleanupPublicationCopy(detail.result, videoPath);
    detail.status = previous.status = 'complete';
    previous.finishedAt = detail.finishedAt ||= new Date().toISOString();
    save(join(detail.evidenceDirectory, 'card.json'), detail);
    persist();
    if (!options['retain-all']) {
      cleanupCard(detail);
      for (const key of ['retainedFrames', 'retainedDecodedSamples', 'cleanupError']) {
        if (detail[key] === undefined) delete previous[key];
        else previous[key] = detail[key];
      }
    }
  }
}
persist();
let app, images, server, processing, interrupted, paintSerial = 0;
const awake = spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
const stop = () => {
  if (interrupted) return;
  interrupted = new Error('Native review rendering interrupted; saved evidence is preserved.');
  processing?.fail(interrupted);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const active = () => { if (interrupted) throw interrupted; };
const verifyPublication = () => { active(); assertSourceHashes(sourceHashes); };
const evaluate = functionBody => app.request('evaluate', { functionBody });
const validate = (snapshot, card, frame) => {
  check(snapshot?.cardId === card && snapshot.frame === frame && snapshot.ready && snapshot.paintReady && !snapshot.error, 'Native frame readiness or identity differs.');
  check(snapshot.motionLoop === 'breathing-swing' && snapshot.captureScale === 3 && snapshot.rotationDegrees === 0,
    'Native frame motion or scale differs.');
  check(snapshot.background === '#000000' && snapshot.shadowEnabled === false && snapshot.dpr === 2, 'Native scene color, shadow, or device pixel ratio differs.');
  check(snapshot.scrollX === 0 && snapshot.scrollY === 0, 'Native whole-frame capture unexpectedly scrolled.');
  const scene = snapshot.stageDocumentPixels;
  check(scene && Math.abs(scene.x - 32) < .075 && Math.abs(scene.y - 32) < .075
    && Math.abs(scene.width - 3240) < .075 && Math.abs(scene.height - 3240) < .075, 'Native scene does not occupy the exact 3240-pixel crop.');
  check(snapshot.viewport.width * 2 === 3304 && snapshot.viewport.height * 2 === 3304, 'Native WebView dimensions changed from the exact capture raster.');
  return snapshot;
};
const setFrame = async (card, frame) => validate(await evaluate(`return await window.miNoteCaptureComparison.setFrame(${frame});`), card, frame);
async function capture(card, frame, path) {
  active();
  const pose = await setFrame(card, frame);
  const shot = await app.request('snapshot', { path, method: options.method,
    ...(options.method === 'screen-capture-stream' ? { colorSpace: 'display-p3' } : {}),
    rect: { x: 32, y: 32, width: 3240, height: 3240 } });
  if (options.background) assertBackgroundPresentation(shot.presentation);
  check(existsSync(path), 'Native capture did not save its image.');
  if (options.method !== 'webkit') {
    check(Number.isSafeInteger(shot.paintSerial) && shot.paintSerial > paintSerial, 'Native compositor frame marker did not advance.');
    paintSerial = shot.paintSerial;
  }
  const sha256 = hashFile(path);
  if (shot.sha256) check(shot.sha256 === sha256, 'Native capture checksum differs.');
  if (options['expected-icc']) check(shot.iccSha256 === options['expected-icc'], 'Native capture ICC differs from the preserved verified profile.');
  return { frame, path, sha256, pose, capture: shot };
}
async function renderCard(card) {
  active();
  assertSourceHashes(sourceHashes);
  const previous = manifest.cards[card];
  if (previous?.status === 'complete' && !options.probe) {
    return;
  }
  const capacity = statfsSync(stateDirectory);
  check(capacity.bavail * capacity.bsize > 10 * 1024 ** 3, 'Native rendering needs 10 GiB of free working space.');
  const started = performance.now();
  const root = join(stateDirectory, 'evidence', String(card));
  if (existsSync(root)) {
    const attempts = join(stateDirectory, 'attempts');
    mkdirSync(attempts, { recursive: true });
    const archived = join(attempts, `${card}-${Date.now()}`);
    renameSync(root, archived);
  }
  const native = join(root, 'native');
  const proofs = join(root, 'proofs');
  const stagedVideo = join(root, '.video.staged.mp4');
  const videoOutput = join(options.output, `${card}.mp4`);
  mkdirSync(native, { recursive: true });
  mkdirSync(proofs);
  const record = manifest.cards[card] = { id: card, evidenceDirectory: root, status: 'loading', startedAt: new Date().toISOString(), frames: [], timings: {} };
  manifest.currentCard = card;
  persist();
  await app.request('load', { url: `http://127.0.0.1:${options.port}/scripts/mi-note-video/index.html?id=${card}&loop=breathing-swing` });
  let ready;
  for (let attempt = 0; attempt < 450; attempt++) {
    active();
    ready = await evaluate('return window.miNoteCaptureComparison?.snapshot() ?? null;');
    if (ready?.error) throw new Error(ready.error);
    if (ready?.ready && ready.paintReady) break;
    await delay(100);
  }
  check(ready?.ready && ready.paintReady, 'Native card assets did not become ready.');
  await evaluate('return await window.miNoteCaptureComparison.configureViewport({nativePixels:true,gutterPixels:32,captureScale:3,rotationDegrees:0,background:"#000000",shadowEnabled:false});');
  validate(await evaluate(`return await window.miNoteCaptureComparison.setCard(${card});`), card, 0);
  const geometry = await timed(() => evaluate('const result=[]; for(let frame=0;frame<276;frame++) result.push(await window.miNoteCaptureComparison.setFrame(frame)); return result;'));
  check(geometry.result.length === 276, 'Native motion geometry is incomplete.');
  geometry.result.forEach((pose, frame) => validate(pose, card, frame));
  save(join(root, 'geometry.json'), geometry.result);
  record.timings.geometryMilliseconds = geometry.milliseconds;
  const rectangles = geometry.result.map(pose => pose.unrotatedRotatorRect);
  check(rectangles.every(Boolean), 'Native card bounds are unavailable.');
  const bounds = [Math.floor(Math.min(...rectangles.map(rect => rect.x))) - 2,
    Math.floor(Math.min(...rectangles.map(rect => rect.y))) - 2,
    Math.ceil(Math.max(...rectangles.map(rect => rect.x + rect.width))) + 2,
    Math.ceil(Math.max(...rectangles.map(rect => rect.y + rect.height))) + 2];
  check(bounds[0] >= 8 && bounds[1] >= 8 && bounds[2] <= 3232 && bounds[3] <= 3232, 'Native card motion clips the black border.');
  record.bounds = bounds;
  const warmup = await timed(async () => {
    if (options.background) record.surfaceWarmup = await capture(card, 0, join(proofs, 'warmup-1.png'));
    const before = await capture(card, 0, join(proofs, 'before.png'));
    const repeat = await capture(card, 0, join(proofs, 'before-repeat.png'));
    check((await images.request('compare', { first: before.path, second: repeat.path })).passed, 'Native independent cycle-start captures differ.');
    check((await images.request('black-exterior', { input: before.path, bounds, size: 3240 })).passed, 'Native reference exterior or profile is invalid.');
    return before;
  });
  record.before = warmup.result;
  record.timings.warmupMilliseconds = warmup.milliseconds;
  record.status = 'capturing';
  manifest.status = 'rendering';
  persist();
  const captureStart = performance.now();
  if (!options.probe) {
    const worker = new FrameWorker(options.python, ['-u', join(engineDirectory, 'native_processing_worker.py')]);
    processing = new NativeProcessing(worker, { cardId: card, nativeSize: 3240, size: 2160, space: 'p3',
      preparedDirectory: join(root, 'prepared'), output: stagedVideo,
      certificateDirectory: join(root, 'certificate'), before: record.before.path, beforeSha256: record.before.sha256, bounds });
  }
  const sequence = options.probe ? contract.capture.controlFrames : Array.from({ length: 276 }, (_, frame) => frame);
  for (const frame of sequence) {
    const captured = await capture(card, frame, join(native, `${String(frame).padStart(4, '0')}.png`));
    record.frames.push(captured);
    if (processing) await processing.enqueue(captured);
    if (frame % 24 === 0 || frame === 275) {
      persist();
      console.log(JSON.stringify({ card, frame, count: record.frames.length, phase: 'native-capture' }));
    }
  }
  record.timings.captureMilliseconds = performance.now() - captureStart;
  if (options.probe) {
    const reset = await timed(() => evaluate('for(let frame=0;frame<276;frame++) await window.miNoteCaptureComparison.setFrame(frame); return await window.miNoteCaptureComparison.setFrame(0);'));
    validate(reset.result, card, 0);
    record.timings.probeCycleResetMilliseconds = reset.milliseconds;
  }
  const restStart = performance.now();
  record.endControls = [];
  let matches = 0;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const control = await capture(card, 0, join(proofs, `after-${attempt}.png`));
    control.repeat = await images.request('compare', { first: record.before.path, second: control.path });
    record.endControls.push(control);
    matches = control.repeat.passed ? matches + 1 : 0;
    if (matches === 2) { record.after = control; break; }
  }
  check(record.after, 'Native cycle-end pixels did not settle to two exact matches of the independent start.');
  record.timings.restVerificationMilliseconds = performance.now() - restStart;
  if (processing) {
    record.status = 'verifying';
    persist();
    const finish = await timed(() => finishNativeVideo(processing,
      { after: record.after.path, afterSha256: record.after.sha256, qualityOutput: join(root, 'quality.json') },
      { stagedPath: stagedVideo, output: videoOutput, verify: verifyPublication,
        checkpointPublication(result) {
          record.status = 'publishing';
          record.result = result;
          record.video = { path: videoOutput, sha256: result.video.sha256 };
          persist();
        } }));
    record.result = finish.result;
    record.timings.finishMilliseconds = finish.milliseconds;
    processing = undefined;
    record.video = { path: videoOutput, sha256: record.result.video.sha256 };
  }
  record.status = options.probe ? 'probe-complete' : 'complete';
  record.finishedAt = new Date().toISOString();
  record.timings.totalMilliseconds = performance.now() - started;
  save(join(root, 'card.json'), record);
  persist();
  if (!options['retain-all'] && !options.probe) {
    cleanupCard(record);
    persist();
  }
  console.log(JSON.stringify({ card, status: record.status, seconds: record.timings.totalMilliseconds / 1000 }));
}
try {
  const config = viteOptions(options.port);
  config.resolve = { alias: { 'react-dom': join(engineDirectory, 'node_modules/react-dom'), react: join(engineDirectory, 'node_modules/react') } };
  config.optimizeDeps.entries = ['scripts/mi-note-video/index.html'];
  server = await createServer(config);
  await server.listen();
  app = new FrameWorker(options.app, [], { timeoutMilliseconds: 120_000 });
  images = new FrameWorker(options.python, ['-u', join(engineDirectory, 'frame_worker.py')]);
  manifest.application = await app.request('initialize', { physicalWidth: 3304, physicalHeight: 3304, title: 'Mi Note Native Capture', background: options.background });
  if (options.background) assertBackgroundPresentation(manifest.application.presentation);
  if (options.method === 'screen-capture-stream') {
    manifest.application.stream = await app.request('start-stream', { colorSpace: 'display-p3' });
  }
  persist();
  for (const card of ids) await renderCard(card);
  active();
  manifest.status = options.probe ? 'probe-complete' : 'complete';
  manifest.currentCard = null;
  manifest.finishedAt = new Date().toISOString();
  persist();
} catch (error) {
  manifest.status = interrupted ? 'interrupted' : 'failed';
  manifest.error = String(error.stack || error);
  persist();
  console.error(manifest.error);
  process.exitCode = 1;
} finally {
  await processing?.close().catch(() => {});
  if (app && !app.error) await app.request('close', {}).catch(() => {});
  await app?.close().catch(() => {});
  await images?.close().catch(() => {});
  await server?.close();
  awake.kill();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
