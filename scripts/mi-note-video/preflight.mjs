import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { tsImport } from 'tsx/esm/api';
import { Safari } from './safari.mjs';
import { FrameWorker } from './frame-worker.mjs';
import { runCaptureOverlap } from './capture-overlap.mjs';
import { frameScrollAction } from './frame-scroll-action.mjs';
import { sourceRoot, contract, parseOptions, profileFor, motionFor, renderingSourceHashes, runtimeVersions, assertSourceHashes, viteOptions, assertProfileGrid, warmupFrames, assertNativeBackend, catalogCount } from './native-config.mjs';

const root = sourceRoot;
const options = parseOptions(process.argv.slice(2), 'preflight');
if (options.help) {
  console.log('Native preflight: --profile sideways-1980|upright-2160 --motion original|vertical-swing|breathing-swing --id ID --output DIR --python PATH [--verify-resume]');
  process.exit(0);
}
const backend = assertNativeBackend();
options.activate = true;
options.port = 5178;
const profile = profileFor(options.profile);
const { nativeSize, deliverySize, captureScale } = profile;
const output = options.output;
const approvedPath = join(output, 'approved.json');
const runDirectory = join(output, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const check = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (value, label) => {
  const rounded = Math.round(value);
  check(Number.isFinite(value) && Math.abs(value - rounded) <= 0.075, `${label} is not an integer native pixel: ${value}`);
  return rounded;
};
const sourceHashes = renderingSourceHashes();
const preset = JSON.parse(readFileSync(join(root, 'scripts/mi-note-video/preset.json'), 'utf8'));
const identity = { backend, root, profile: options.profile, motion: options.motion, ids: options.ids, nativeSize, deliverySize,
  captureScale, frameCount: 276, frameRate: 60, sourceHashes, versions: runtimeVersions(options.python) };
let envelope;
let currentMotion = 'original';
let validatingProfile = false;
const { nativeScrollQuantum, tileAxisPositions, chooseLandscapeViewport } = await tsImport('./captureGeometry.ts', import.meta.url);
const { computeRecordingFrameStyle } = await tsImport('./motion.ts', import.meta.url);
const effectKeys = { pointerX: '--pointer-x', pointerY: '--pointer-y', backgroundX: '--background-x', backgroundY: '--background-y',
  pointerFromCenter: '--pointer-from-center', opacity: '--card-opacity', rotateX: '--rotate-x', rotateY: '--rotate-y',
  scale: '--card-scale', translateX: '--translate-x', translateY: '--translate-y' };
const processList = () => new Map(run('/bin/ps', ['-axo', 'pid=,lstart=,command=']).split('\n')
  .filter(line => line.trim().endsWith('/Safari.app/Contents/MacOS/Safari -ApplePersistenceIgnoreStateQuietly YES --automation'))
  .map(line => [Number(line.trim().split(/\s+/)[0]), line.trim()]));
const report = { status: 'running', identity, directory: runDirectory, startedAt: new Date().toISOString(), cards: [] };
let safari, server, ownedProcess, processBaseline, tab, interrupted, staticReference, nativeIcc, viewport, frameWorker;
const checkActive = () => { if (interrupted) throw interrupted; };
const imageHelper = async (operation, args, checkCapture = checkActive) => {
  checkActive();
  checkCapture();
  frameWorker ||= new FrameWorker(options.python, ['-u', join(root, 'scripts/mi-note-video/frame_worker.py')]);
  const result = await frameWorker.request(operation, args);
  checkActive();
  checkCapture();
  return result;
};
const compare = (first, second) => imageHelper('compare', { first, second });
const assertSources = () => assertSourceHashes(sourceHashes);

async function focusOwned() {
  const current = processList();
  if (!ownedProcess) {
    const created = [...current].filter(([pid, description]) => processBaseline.get(pid) !== description);
    check(created.length === 1, 'Cannot uniquely identify the preflight-owned Safari automation process.');
    ownedProcess = { pid: created[0][0], identity: created[0][1] };
    report.ownedSafari = ownedProcess;
  }
  check(current.get(ownedProcess.pid) === ownedProcess.identity, 'Owned Safari process changed.');
  if (options.activate) {
    check(run('/usr/bin/osascript', ['-e', `use framework "AppKit"
set captureApp to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:${ownedProcess.pid}
if captureApp is missing value then error "The owned capture process has ended."
if (captureApp's bundleIdentifier() as text) is not "com.apple.Safari" then error "The owned process is not Safari."
return captureApp's activateWithOptions:(current application's NSApplicationActivateIgnoringOtherApps)`]) === 'true', 'Owned Safari activation failed.');
    await delay(200);
  }
}

async function wait(predicate = () => true, checkCapture = checkActive, resultToken) {
  const deadline = Date.now() + 120_000;
  let state;
  while (Date.now() < deadline) {
    checkActive();
    checkCapture();
    const observed = await safari.evaluate(`return window.miNoteCaptureComparison ? {...window.miNoteCaptureComparison.snapshot(),completedAction:window.__vmPreflightCompleted,asyncError:window.__vmPreflightError${resultToken ? ',actionResult:window.__vmPreflightResult' : ''}} : {harnessMissing:true,page:{url:location.href,readyState:document.readyState,visibility:document.visibilityState}}`);
    checkActive();
    checkCapture();
    const { actionResult, ...snapshot } = observed;
    state = snapshot;
    if (state.error || state.asyncError) throw new Error(state.error || state.asyncError);
    if (state.ready && state.paintReady && state.viewport?.visibility === 'visible' && predicate(state)) {
      if (!resultToken) return state;
      check(actionResult?.token === resultToken && actionResult.value, 'Preflight action result is missing or stale.');
      return { snapshot: state, result: actionResult.value };
    }
    await delay(50);
  }
  throw new Error(`Preflight readiness timed out: ${JSON.stringify(state)}`);
}

async function action(expression, predicate = () => true, checkCapture = checkActive, readResult = false) {
  checkActive();
  checkCapture();
  const token = randomUUID();
  await safari.evaluate(`window.__vmPreflightCompleted=null;window.__vmPreflightError=null;window.__vmPreflightResult=null;void(async()=>(${expression}))().then(value=>{${readResult ? `window.__vmPreflightResult={token:${JSON.stringify(token)},value};` : ''}window.__vmPreflightCompleted=${JSON.stringify(token)};},error=>window.__vmPreflightError=error.message);return true;`);
  return wait(state => state.completedAction === token && predicate(state), checkCapture, readResult ? token : undefined);
}

async function remount(id) {
  await focusOwned();
  await action('window.miNoteCaptureComparison.setScrollPixels(0,0)');
  for (const current of [id === catalogCount() ? 1 : catalogCount(), id]) {
    await action(`window.miNoteCaptureComparison.setCard(${current})`, state => state.cardId === current && state.frame === 0);
    await action('(async()=>{await document.querySelector(".drif-effect-card__front img").decode();await new Promise(resolve=>setTimeout(resolve,500));return window.miNoteCaptureComparison.setFrame(0)})()');
  }
  return action('(async()=>{for(let frame=1;frame<276;frame++)await window.miNoteCaptureComparison.setFrame(frame);return window.miNoteCaptureComparison.setFrame(0)})()', state => state.cardId === id && state.frame === 0);
}

function assertSnapshot(state, id, frame, rotation, scroll) {
  check(state.ready && state.paintReady && state.viewport?.visibility === 'visible' && state.cardId === id && state.frame === frame
    && state.nativePixels && state.captureScale === captureScale && state.dpr === 2 && state.motionLoop === (motionFor(currentMotion) || null)
    && state.motionVersion === (currentMotion === 'original' ? null : 1), `Capture identity, readiness or native scale changed for ${id}:${frame}.`);
  check(state.rotationDegrees === rotation && state.background === '#000000' && state.shadowEnabled === false && state.effect?.shadow === 'none', 'Black shadow-free scene changed.');
  for (const [key, expected] of Object.entries({ x: 32, y: 32, width: nativeSize, height: nativeSize })) {
    check(Math.abs(state.stageDocumentPixels?.[key] - expected) <= 0.075, `Native stage ${key} changed.`);
  }
  const dimensions = { width: integer(state.viewport.width * 2, 'viewport width'), height: integer(state.viewport.height * 2, 'viewport height') };
  if (viewport) check(dimensions.width === viewport.width && dimensions.height === viewport.height, 'Native viewport changed.');
  if (scroll) check(Math.abs(state.scrollPixels.x - scroll.x) <= 0.075 && Math.abs(state.scrollPixels.y - scroll.y) <= 0.075, 'Native capture scroll changed.');
  const assetUrl = value => value?.trim().replace(/^url\((['"]?)(.*?)\1\)$/, '$2');
  check(state.assets?.front === `https://cdn.lil.org/nft/mi_note_cards/fronts/${id}.png`
    && state.assets.naturalWidth === 2000 && state.assets.naturalHeight === 2800
    && assetUrl(state.assets.mask) === `https://cdn.lil.org/nft/mi_note_cards/masks/${id}.webp`
    && assetUrl(state.assets.grain) === 'https://cdn.lil.org/nft/poncho_drifella/misc/grain.webp', 'Approved artwork, processed mask or grain changed.');
  const expected = Object.fromEntries(computeRecordingFrameStyle(frame, 276, { ...preset, tilt: true, lightPath: 'orbit', motionLoop: motionFor(currentMotion) }).split(';').map(value => value.split(':')));
  for (const [key, variable] of Object.entries(effectKeys)) check(Math.abs(Number.parseFloat(state.effect[key]) - Number.parseFloat(expected[variable])) <= 1e-9, `Motion variable ${key} changed.`);
  const rect = state.unrotatedRotatorRect;
  check(rect && rect.x >= 2 && rect.y >= 2 && rect.x + rect.width <= nativeSize - 2 && rect.y + rect.height <= nativeSize - 2, 'Moving card exceeds the native scene.');
  if (envelope) {
    const [left, top, right, bottom] = envelope.bounds;
    check(rect.x >= left - 0.075 && rect.y >= top - 0.075 && rect.x + rect.width <= right + 0.075 && rect.y + rect.height <= bottom + 0.075, 'Motion exceeds the original movement area.');
  }
  return dimensions;
}

function excludedBounds(state) {
  const card = state.unrotatedCardRect;
  check(card, 'Missing unrotated card rectangle.');
  return [Math.max(0, Math.floor(card.x) - Math.ceil(80 * captureScale)), Math.max(0, Math.floor(card.y) - Math.ceil(80 * captureScale)),
    Math.min(nativeSize, Math.ceil(card.x + card.width) + Math.ceil(80 * captureScale)), Math.min(nativeSize, Math.ceil(card.y + card.height) + Math.ceil(80 * captureScale))];
}

async function acquireCapture(id, frame, label, rotation, directory, initial, checkCapture = checkActive) {
  checkCapture();
  const dimensions = { ...viewport };
  const quantum = nativeScrollQuantum(captureScale, 2);
  const axis = (size, documentLength) => tileAxisPositions({ length: nativeSize, viewport: size, documentLength: integer(documentLength, 'document dimension'), gutterPixels: 32, seamBandPixels: 128, scrollQuantum: quantum });
  const grid = rotation === 90 ? { xs: [0], ys: [0] }
    : { xs: axis(dimensions.width, initial.documentPixels.width), ys: axis(dimensions.height, initial.documentPixels.height) };
  if (validatingProfile) assertProfileGrid(profile, grid);
  const captureProfile = validatingProfile ? profile.id : null;
  let selection;
  const tiles = [];
  for (let row = 0; row < grid.ys.length; row += 1) for (let col = 0; col < grid.xs.length; col += 1) {
    checkCapture();
    await safari.call('switch_tab', tab);
    checkCapture();
    let snapshot, scroll;
    if (rotation === 90) {
      const pose = await action(`window.miNoteCaptureComparison.setFrame(${frame})`, state => state.frame === frame, checkCapture);
      assertSnapshot(pose, id, frame, rotation);
      selection = chooseLandscapeViewport(pose, dimensions);
      scroll = selection.scroll;
      snapshot = await action(`window.miNoteCaptureComparison.setScrollPixels(${scroll.x},${scroll.y})`, () => true, checkCapture);
    } else {
      selection = null;
      scroll = { x: grid.xs[col], y: grid.ys[row] };
      const completed = await action(frameScrollAction({ cardId: id, frame, scroll, pollMilliseconds: 50 }), state => state.frame === frame, checkCapture, true);
      check(completed.result?.pose && completed.result.scrolled, 'Preflight frame and scroll snapshots are missing.');
      assertSnapshot(completed.result.pose, id, frame, rotation);
      assertSnapshot(completed.result.scrolled, id, frame, rotation, scroll);
      snapshot = completed.snapshot;
    }
    assertSnapshot(snapshot, id, frame, rotation, scroll);
    const path = join(directory, `${label}-${row}-${col}.png`);
    checkCapture();
    await safari.call('screenshot', { full_page: false, savePath: path });
    checkCapture();
    tiles.push({ path, row, col, originX: integer(-snapshot.stageRect.x * 2, 'tile origin X'),
      originY: integer(-snapshot.stageRect.y * 2, 'tile origin Y'), viewportWidth: dimensions.width, viewportHeight: dimensions.height, snapshot });
  }
  const mode = rotation === 90 ? { singleViewportCapture: true, landscapeViewportCapture: true, captureRotationDegrees: 90,
    backgroundRgb: [0, 0, 0], shadows: false, backgroundReference: { path: staticReference.path, sha256: staticReference.sha256, excludedBounds: excludedBounds(initial) } } : {};
  return { id, frame, label, rotation, directory, dimensions, grid, captureProfile, selection, tiles, mode };
}

async function completeCapture(acquired, checkCapture = checkActive) {
  checkCapture();
  const { id, frame, label, rotation, directory, dimensions, grid, captureProfile, selection, mode } = acquired;
  const tiles = [];
  for (const tile of acquired.tiles) {
    const inspected = await imageHelper('inspect', { input: tile.path }, checkCapture);
    check(inspected.width === dimensions.width && inspected.height === dimensions.height && inspected.icc, 'Native screenshot geometry or ICC is missing.');
    if (nativeIcc) check(inspected.icc.sha256 === nativeIcc, 'Native display ICC changed during capture.');
    nativeIcc = inspected.icc.sha256;
    tiles.push({ path: tile.path, sha256: hash(tile.path), row: tile.row, col: tile.col, originX: tile.originX,
      originY: tile.originY, viewportWidth: tile.viewportWidth, viewportHeight: tile.viewportHeight,
      iccSha256: nativeIcc, snapshot: tile.snapshot });
  }
  checkCapture();
  const metadata = join(directory, `${label}-tiles.json`);
  save(metadata, { id, frame, ...(captureProfile ? { profile: captureProfile } : {}), backgroundRgb: [0, 0, 0], shadows: false, captureRotationDegrees: rotation, captureScale, width: nativeSize, height: nativeSize, columns: grid.xs.length, rows: grid.ys.length, ...mode, tiles });
  const path = join(directory, `${label}.png`);
  const stitched = await imageHelper('stitch', { metadata, output: path, deliverySize, deliverySpaces: ['p3'] }, checkCapture);
  check(stitched.passed && stitched.iccPreservedByteForByte, 'Native stitch or lossless transpose failed.');
  const stitchReport = join(directory, `${label}-stitch.json`);
  save(stitchReport, stitched);
  return { id, frame, path, sha256: hash(path), metadata, stitchReport, selection };
}

async function capture(id, frame, label, rotation, directory, initial) {
  return completeCapture(await acquireCapture(id, frame, label, rotation, directory, initial));
}

async function captureSequence(id, entries, rotation, directory, initial, { prepare = false, results = [] } = {}) {
  await runCaptureOverlap({ frames: entries, check: checkActive,
    acquire: ({ frame, label }, { check: checkCapture }) => acquireCapture(id, frame, label, rotation, directory, initial, checkCapture),
    complete: async ({ label }, acquired) => {
      const sample = await completeCapture(acquired);
      if (prepare) {
        const preparedPath = join(directory, `${label}-p3-${deliverySize}.png`);
        sample.prepared = await imageHelper('prepare', { input: sample.path, output: preparedPath, space: 'p3', size: deliverySize });
      }
      return sample;
    },
    commit: (_, completed) => { checkActive(); results.push(completed); } });
  return results;
}

async function calibrate(id, rotation, directory, initial, baselinePath) {
  const controls = [];
  let consecutive = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const control = await capture(id, 0, `${baselinePath ? 'end' : 'start'}-control-${attempt}`, rotation, directory, initial);
    const reference = baselinePath || controls.at(-1)?.path;
    if (reference) {
      control.repeat = await compare(reference, control.path);
      consecutive = control.repeat.passed ? consecutive + 1 : 0;
    }
    controls.push(control);
    if (consecutive >= (baselinePath ? 2 : 1)) return { baseline: baselinePath || controls.at(-2).path, controls };
  }
  save(join(directory, `failed-${baselinePath ? 'end' : 'start'}-controls.json`), controls);
  throw new Error(`Card ${id} did not produce exact independent cycle-start controls.`);
}

async function selectTab(motion, rotation) {
  currentMotion = motion;
  const loop = motionFor(motion);
  tab = await safari.createTab(`http://localhost:${options.port}/scripts/mi-note-video/index.html?id=${options.id}${loop ? `&loop=${loop}` : ''}`);
  if (!report.auxiliary) report.auxiliary = await safari.createTab('about:blank');
  await safari.call('switch_tab', tab);
  await safari.call('set_viewport_size', { width: 1664, height: profile.tiles === 1 ? 1260 : 1060 });
  await focusOwned();
  await wait();
  await action(`window.miNoteCaptureComparison.configureViewport({nativePixels:true,gutterPixels:32,captureScale:${captureScale},rotationDegrees:${rotation},background:'#000000',shadowEnabled:false})`);
  const initial = await remount(options.id);
  const dimensions = assertSnapshot(initial, options.id, 0, rotation, { x: 0, y: 0 });
  if (!viewport) viewport = dimensions;
  report.viewport = viewport;
  return initial;
}

function captureGrid(initial, rotation) {
  if (rotation === 90) return { xs: [0], ys: [0] };
  const quantum = nativeScrollQuantum(captureScale, 2);
  const axis = (size, documentLength) => tileAxisPositions({ length: nativeSize, viewport: size, documentLength: integer(documentLength, 'document dimension'), gutterPixels: 32, seamBandPixels: 128, scrollQuantum: quantum });
  return { xs: axis(viewport.width, initial.documentPixels.width), ys: axis(viewport.height, initial.documentPixels.height) };
}

async function geometryScan(initial, rotation, name) {
  await action('(async()=>{window.__vmPreflightGeometry=[];for(let frame=0;frame<276;frame++){window.__vmPreflightGeometry.push(await window.miNoteCaptureComparison.setFrame(frame));}return window.miNoteCaptureComparison.setFrame(0)})()');
  const snapshots = await safari.evaluate('return window.__vmPreflightGeometry');
  check(snapshots.length === 276, 'Missing all-pose geometry evidence.');
  const grid = captureGrid(initial, rotation);
  if (validatingProfile) assertProfileGrid(profile, grid);
  const geometry = snapshots.map((snapshot, frame) => {
    assertSnapshot(snapshot, options.id, frame, rotation, { x: 0, y: 0 });
    return { frame, snapshot, grid, ...(rotation === 90 ? { selection: chooseLandscapeViewport(snapshot, viewport) } : {}) };
  });
  save(join(runDirectory, name), geometry);
  return geometry;
}

async function warm(id, rotation, directory, initial) {
  return captureSequence(id, warmupFrames().map((frame, index) => ({ frame, label: `warmup-${index}` })), rotation, directory, initial);
}

function validateApproval(approved) {
  check(approved.status === 'passed' && JSON.stringify({ backend: 'vm', ...approved.identity }) === JSON.stringify(identity), 'Existing preflight identity changed; use a fresh output directory.');
  for (const [path, expected] of Object.entries(approved.evidenceHashes)) check(hash(path) === expected, `Preflight evidence changed: ${path}`);
  check(hash(approved.staticReference.path) === approved.staticReference.sha256
    && hash(approved.nativeStart.path) === approved.nativeStart.sha256, 'Preflight native controls changed.');
  assertSources();
}

async function main() {
  let existing;
  if (existsSync(approvedPath)) {
    existing = JSON.parse(readFileSync(approvedPath, 'utf8'));
    validateApproval(existing);
    if (!options.verifyResume) {
      console.log(JSON.stringify({ status: 'reused', approved: approvedPath, staticReference: existing.staticReference }));
      return;
    }
  }
  check(!options.verifyResume || existing, '--verify-resume requires a completed preflight.');
  mkdirSync(runDirectory, { recursive: true });
  save(join(runDirectory, 'start.json'), report);
  server = await createServer(viteOptions(options.port));
  await server.listen();
  processBaseline = processList();
  safari = new Safari();
  report.safariMcp = await safari.initialize();
  const upright = await selectTab('original', 0);
  const original = await geometryScan(upright, 0, 'original-orbit-geometry.json');
  const rectangles = original.map(item => item.snapshot.unrotatedRotatorRect);
  envelope = { version: 1, nativeSize, deliverySize, bounds: [Math.min(...rectangles.map(rect => rect.x)), Math.min(...rectangles.map(rect => rect.y)),
    Math.max(...rectangles.map(rect => rect.x + rect.width)), Math.max(...rectangles.map(rect => rect.y + rect.height))],
    source: { path: join(runDirectory, 'original-orbit-geometry.json'), sha256: hash(join(runDirectory, 'original-orbit-geometry.json')), motion: 'original', frames: 276 } };
  report.motionEnvelope = envelope;
  const uprightDirectory = join(runDirectory, 'upright-reference');
  mkdirSync(uprightDirectory);
  report.uprightWarmup = await warm(options.id, 0, uprightDirectory, upright);
  report.uprightCalibration = await calibrate(options.id, 0, uprightDirectory, upright);
  const referencePath = report.uprightCalibration.baseline;
  const exterior = await imageHelper('black-exterior', { input: referencePath, bounds: excludedBounds(upright), size: nativeSize });
  check(exterior.passed, 'Fresh upright static reference has a non-black exterior.');
  staticReference = { path: referencePath, sha256: hash(referencePath), nativeIccSha256: nativeIcc, exterior,
    provenance: 'Independent native upright black scene captured in this guest and joined without resampling.' };
  report.staticReference = staticReference;
  console.log(JSON.stringify({ phase: 'fresh-native-reference', profile: profile.id, nativeSize, viewport }));
  validatingProfile = true;
  const initial = await selectTab(options.motion, profile.rotationDegrees);
  const directory = join(runDirectory, 'selected-motion');
  mkdirSync(directory);
  const geometry = await geometryScan(initial, profile.rotationDegrees, 'selected-motion-geometry.json');
  const card = { id: options.id, initial, geometryPath: join(runDirectory, 'selected-motion-geometry.json'), geometryFrames: geometry.length, samples: [] };
  report.cards.push(card);
  card.warmup = await warm(options.id, profile.rotationDegrees, directory, initial);
  card.start = await calibrate(options.id, profile.rotationDegrees, directory, initial);
  if (options.verifyResume) {
    check(JSON.stringify(viewport) === JSON.stringify(existing.viewport), 'Resume viewport differs from preflight.');
    const controlsDirectory = join(runDirectory, 'resume-controls');
    mkdirSync(controlsDirectory);
    report.resumeControls = await calibrate(options.id, profile.rotationDegrees, controlsDirectory, initial, existing.nativeStart.path);
    report.status = 'resume-verified';
    report.approval = { path: approvedPath, sha256: hash(approvedPath) };
    report.finishedAt = new Date().toISOString();
    assertSources();
    save(join(directory, 'report.json'), card);
    const verification = join(runDirectory, 'resume-verification.json');
    save(verification, report);
    console.log(JSON.stringify({ status: 'resume-verified', verification, controls: report.resumeControls.controls.length }));
    return;
  }
  await captureSequence(options.id, contract.capture.controlFrames.map(frame => ({ frame, label: String(frame).padStart(4, '0') })),
    profile.rotationDegrees, directory, initial, { prepare: true, results: card.samples });
  card.frameZeroRepeat = await compare(card.start.baseline, card.samples[0].path);
  check(card.frameZeroRepeat.passed, 'Sample frame zero differs from the independent baseline.');
  card.end = await calibrate(options.id, profile.rotationDegrees, directory, initial, card.start.baseline);
  save(join(directory, 'report.json'), card);
  assertSources();
  report.status = 'passed';
  report.finishedAt = new Date().toISOString();
  save(join(runDirectory, 'report.json'), report);
  const evidenceHashes = {};
  const visit = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else { check(item.isFile(), 'Unexpected non-file preflight evidence.'); evidenceHashes[path] = hash(path); }
    }
  };
  visit(runDirectory);
  const approved = { status: 'passed', identity, viewport, staticReference, motionEnvelope: envelope,
    nativeStart: { path: card.start.baseline, sha256: hash(card.start.baseline), nativeIccSha256: nativeIcc },
    report: join(runDirectory, 'report.json'), evidenceHashes };
  const pending = join(output, `.approved-${randomUUID()}.pending.json`);
  save(pending, approved);
  check(!existsSync(approvedPath), 'Another preflight completed in this output directory.');
  renameSync(pending, approvedPath);
  console.log(JSON.stringify({ status: 'passed', approved: approvedPath, profile: profile.id, motion: options.motion, geometryFrames: 552, nativeSamples: 5 }));
}

const interrupt = signal => {
  interrupted = new Error(`Interrupted by ${signal}`);
  frameWorker?.fail(interrupted);
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await main();
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  if (existsSync(runDirectory)) save(join(runDirectory, 'failure.json'), report);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try {
    await safari?.close();
    if (ownedProcess && processList().get(ownedProcess.pid) === ownedProcess.identity) {
      try { process.kill(ownedProcess.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } finally {
    try { await server?.close(); }
    finally { await frameWorker?.close(); }
  }
}
