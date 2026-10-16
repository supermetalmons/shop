import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync,
  lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { createServer } from 'vite';
import { Safari } from './safari.mjs';
import { preparedWorkingFramePattern, recoverInterruptedEncodes } from './encoding-recovery.mjs';
import { nativePendingFramePattern, recoverUncommittedFrames } from './frame-recovery.mjs';
import { sourceRoot, contract, parseOptions, profileFor, motionFor, renderingSourceHashes, runtimeVersions, viteOptions, assertProfileGrid, warmNativeCapture, assertNativeVM, catalogCount, assertPreflightBinding } from './native-config.mjs';

const root = sourceRoot;
const options = parseOptions(process.argv.slice(2), 'capture');
if (options.help) {
  console.log('Capture one native Mi Note video: --profile sideways-1980|upright-2160 --motion original|vertical-swing|breathing-swing --ids ID --output DIR --cache DIR --preflight approved.json --python PATH [--resume|--check-resume]');
  process.exit(0);
}
assertNativeVM();
const profile = profileFor(options.profile);
const approval = JSON.parse(readFileSync(options.preflight, 'utf8'));
if (approval.status !== 'passed' || approval.identity?.root !== root || approval.identity?.profile !== options.profile || approval.identity?.motion !== options.motion
  || JSON.stringify(approval.identity?.ids) !== JSON.stringify(options.ids)) throw new Error('Preflight does not match this profile, motion, and card.');
for (const [path, expected] of Object.entries(approval.evidenceHashes || {})) {
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error(`Preflight evidence changed: ${path}`);
}
Object.assign(options, { nft2Tilt: true, methods: ['d'], compactFrames: true, activateCaptureWindow: true,
  landscapeBlackCapture: profile.rotationDegrees === 90, singleViewportCapture: profile.tiles === 1,
  staticReference: approval.staticReference.path, pipelineProcessing: false, port: 5179 });
const gutterPixels = contract.capture.gutterPixels;
const seamBandPixels = contract.capture.seamBandPixels;
const nativeRecoveryMilliseconds = 120_000;
const stitchAttempts = 3;
const profileSampleInterval = 60;
const frameHelper = join(root, 'scripts/mi-note-video/frames.py');
const retainedFrames = contract.capture.controlFrames;
const harnessPath = '/scripts/mi-note-video/index.html';
const { nativeScrollQuantum, tileAxisPositions, chooseLandscapeViewport } = await tsImport('./captureGeometry.ts', import.meta.url);
const { RECORDING_MOTION_LOOPS } = await tsImport('./motion.ts', import.meta.url);
const motionLoop = RECORDING_MOTION_LOOPS.find(loop => loop.id === motionFor(options.motion));
const nativeMethods = ['d'];
const deliverySize = profile.deliverySize;
const captureScale = profile.captureScale;
const methodMapping = { d: { capture: `Safari native compositor at ${captureScale}× with original ICC; ${profile.tiles} native viewport capture(s), ${profile.rotationDegrees} degree orientation, black without shadow`,
  delivery: `One Lanczos downsample to ${deliverySize}, ICC-converted Display P3, 10-bit HEVC hvc1`, space: 'p3', width: deliverySize, height: deliverySize } };
const selectedMethods = methodMapping;
const deliverySpaces = ['p3'];
const qualitySource = 'scripts/mi-note-video/quality.py';
const qualityHelper = join(root, qualitySource);

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runSync(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function readPngDimensions(file) {
  const header = Buffer.alloc(24);
  const descriptor = openSync(file, 'r');
  try {
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || header.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid screenshot PNG header');
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    closeSync(descriptor);
  }
}

function physicalInteger(value, label) {
  const rounded = Math.round(value);
  if (!Number.isFinite(value) || Math.abs(value - rounded) > 0.075) throw new Error(`${label} is not aligned to an integer physical pixel: ${value}`);
  return rounded;
}

function axisTiles(length, viewport, documentLength, scrollQuantum) {
  return tileAxisPositions({ length, viewport, documentLength, scrollQuantum, gutterPixels, seamBandPixels });
}

function assertResumeSettings(previous, current) {
  if (JSON.stringify(previous.motionLoop ?? null) !== JSON.stringify(current.motionLoop ?? null)
    || JSON.stringify(previous.motionEnvelope ?? null) !== JSON.stringify(current.motionEnvelope ?? null)) throw new Error('Cannot resume: named motion or its original footprint changed.');
  if ((previous.singleViewportCapture ?? false) !== current.singleViewportCapture) throw new Error('Cannot resume: singleViewportCapture changed.');
  if ((previous.landscapeViewportCapture ?? false) !== current.landscapeViewportCapture) throw new Error('Cannot resume: landscapeViewportCapture changed.');
  for (const key of ['ids', 'profile', 'motion', 'preflight', 'preset', 'methods', 'output', 'cache', 'gutterPixels', 'captureScale', 'capturedSize', 'deliverySize']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) throw new Error(`Cannot resume: ${key} changed.`);
  }
  for (const [key, value] of Object.entries(current.versions)) {
    if (JSON.stringify(previous.versions?.[key]) !== JSON.stringify(value)) throw new Error(`Cannot resume: ${key} version changed.`);
  }
  const runner = 'scripts/mi-note-video/capture.mjs';
  const oldFiles = Object.keys(previous.sourceHashes || {}).sort();
  const newFiles = Object.keys(current.sourceHashes).sort();
  if (JSON.stringify(oldFiles) !== JSON.stringify(newFiles)) throw new Error('Cannot resume: rendering source inventory changed.');
  for (const file of newFiles) if (previous.sourceHashes[file] !== current.sourceHashes[file]) throw new Error(`Cannot resume: rendering source changed: ${file}`);
}

function verifyGeneratedDirectory(directory, filenamePattern) {
  if (!existsSync(directory)) return;
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to compact a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!stat.isFile() || !filenamePattern.test(relative(directory, path))) {
      throw new Error(`Unexpected file in generated capture data: ${path}`);
    }
  };
  visit(directory);
}

const repeatCheck = `import hashlib,json,sys
from PIL import Image
import numpy as np
paths=json.loads(sys.argv[1]);size=int(sys.argv[2]);images=[];profiles=[]
for path in paths:
    with Image.open(path) as image:
        image.load()
        if image.size!=(size,size): raise ValueError('Joined repeat dimensions differ')
        profiles.append(image.info.get('icc_profile'))
        images.append(np.asarray(image.convert('RGB'),dtype=np.int16))
checks=[]
for index in range(1,len(images)):
    difference=np.abs(images[0]-images[index])
    checks.append({'path':paths[index],'equal':bool(np.array_equal(images[0],images[index])),'iccEqual':profiles[0]==profiles[index],'maxChannelError':int(difference.max()),'differentPixels':int(np.any(difference>0,axis=2).sum())})
result={'width':size,'height':size,'reference':paths[0],'iccSha256':hashlib.sha256(profiles[0]).hexdigest() if profiles[0] else None,'checks':checks}
print(json.dumps(result))
if not profiles[0] or not all(item['equal'] and item['iccEqual'] for item in checks): sys.exit(2)
`;

const validateSavedPngs = `import hashlib,io,json,sys
from pathlib import Path
from PIL import Image
items=json.loads(Path(sys.argv[1]).read_text());size=int(sys.argv[2]);results=[]
for item in items:
    content=Path(item['path']).read_bytes();digest=hashlib.sha256(content).hexdigest()
    if item.get('sha256') and digest!=item['sha256']: raise ValueError('Saved PNG checksum changed: '+item['path'])
    with Image.open(io.BytesIO(content)) as image:
        image.load();profile=image.info.get('icc_profile')
        if image.size!=(size,size) or image.mode!='RGB': raise ValueError('Saved PNG geometry/mode changed: '+item['path'])
        if not profile or hashlib.sha256(profile).hexdigest()!=item['iccSha256']: raise ValueError('Saved PNG ICC changed: '+item['path'])
    results.append({**item,'sha256':digest,'bytes':len(content)})
print(json.dumps(results))
`;

const validateSavedViewports = `import hashlib,io,json,sys
from pathlib import Path
from PIL import Image
items=json.loads(Path(sys.argv[1]).read_text())
for item in items:
    content=Path(item['path']).read_bytes()
    if hashlib.sha256(content).hexdigest()!=item['sha256']: raise ValueError('Saved source viewport checksum changed: '+item['path'])
    with Image.open(io.BytesIO(content)) as image:
        image.load();profile=image.info.get('icc_profile')
        if image.size!=(item['width'],item['height']) or image.mode not in ('RGB','RGBA'): raise ValueError('Saved source viewport geometry/mode changed: '+item['path'])
        if not profile or hashlib.sha256(profile).hexdigest()!=item['iccSha256']: raise ValueError('Saved source viewport ICC changed: '+item['path'])
print(json.dumps({'checked':len(items)}))
`;

const staticExteriorCheck = `import hashlib,json,sys
from pathlib import Path
from PIL import Image
import numpy as np
reference=sys.argv[1];paths=json.loads(Path(sys.argv[2]).read_text());bounds=json.loads(sys.argv[3]);size=int(sys.argv[4])
with Image.open(reference) as image:
    image.load();profile=image.info.get('icc_profile')
    if image.size!=(size,size) or image.mode!='RGB' or not profile: raise ValueError('Invalid static reference')
    reference_pixels=np.asarray(image)
left,top,right,bottom=bounds
mask=np.ones((size,size),dtype=bool);mask[top:bottom,left:right]=False
expected=reference_pixels[mask];checks=[]
for path in paths:
    with Image.open(path) as image:
        image.load()
        if image.size!=(size,size) or image.mode!='RGB': raise ValueError('Invalid static-check frame: '+path)
        icc_equal=image.info.get('icc_profile')==profile
        pixels=np.asarray(image)[mask]
    different=np.any(expected!=pixels,axis=1);count=int(different.sum())
    if count:
        delta=np.abs(expected.astype(np.int16)-pixels.astype(np.int16));maximum=int(delta.max());mean=float(delta.mean())
    else: maximum=0;mean=0.0
    checks.append({'path':path,'equal':count==0,'iccEqual':icc_equal,'differentPixels':count,'maxChannelError':maximum,'meanChannelError':mean,'passed':count==0 and icc_equal})
print(json.dumps({'reference':reference,'iccSha256':hashlib.sha256(profile).hexdigest(),'excludedCardBounds':bounds,'expansionPixels':int(sys.argv[5]),'checks':checks,'passed':all(check['passed'] for check in checks)}))
`;

async function main() {
  const output = resolve(root, options.output);
  const cache = resolve(root, options.cache);
  if (containsPath(output, cache) || containsPath(cache, output)
    || [output, cache].some(path => containsPath(path, options.preflight))) throw new Error('Output, capture cache, and preflight evidence must not overlap.');
  for (const directory of [output, cache]) {
    if (options.resume ? !existsSync(directory) : existsSync(directory)) throw new Error(`${options.resume ? 'Resume directory is missing' : 'Directory already exists'}: ${directory}`);
  }
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { computeRecordingFrameStyle } = await tsImport('./motion.ts', import.meta.url);
  const preset = JSON.parse(readFileSync(join(root, 'scripts/mi-note-video/preset.json'), 'utf8'));
  if (options.nft2Tilt) Object.assign(preset, { tilt: true, lightPath: 'orbit' });
  if (motionLoop) Object.assign(preset, { motionLoop: motionLoop.id, motionVersion: 1 });
  Object.assign(preset, { background: '#000000', cardShadow: 'none' });
  const capturedSize = preset.width * captureScale;
  const motionEnvelope = approval.motionEnvelope;
  if (motionEnvelope?.version !== 1 || motionEnvelope.nativeSize !== capturedSize || motionEnvelope.deliverySize !== deliverySize
    || !Array.isArray(motionEnvelope.bounds) || motionEnvelope.bounds.length !== 4 || !motionEnvelope.bounds.every(Number.isFinite)) throw new Error('Preflight original-motion envelope is invalid.');
  if (preset.width !== 1080 || preset.height !== 1080 || preset.frames !== 276) throw new Error('Unexpected shared scene preset.');
  const versions = runtimeVersions(options.python);
  const currentSourceHashes = renderingSourceHashes();
  assertPreflightBinding(approval.identity, { root, profile: options.profile, motion: options.motion, ids: options.ids,
    versions, sourceHashes: currentSourceHashes });
  mkdirSync(output, { recursive: true });
  mkdirSync(cache, { recursive: true });
  for (const directory of ['raw', 'tiles', 'proofs', 'metadata', 'prepared', 'capture-attempts', 'archive']) mkdirSync(join(cache, directory), { recursive: true });
  for (const id of options.ids) mkdirSync(join(cache, 'raw', `${id}c`), { recursive: true });
  const captures = new Map();
  const activeChildren = new Set();
  let manifest = {
    createdAt: new Date().toISOString(), status: 'starting', ids: options.ids, profile: options.profile, motion: options.motion,
    preflight: { path: options.preflight, sha256: hash(options.preflight) }, preset, methods: selectedMethods,
    output, cache, versions, gutterPixels, captureScale, capturedSize, deliverySize, captures: [], videos: [],
    compactFrames: Boolean(options.compactFrames), singleViewportCapture: Boolean(options.singleViewportCapture),
    pipelineProcessing: Boolean(options.pipelineProcessing),
    landscapeViewportCapture: Boolean(options.landscapeBlackCapture),
    motionLoop: { id: options.motion, name: motionLoop?.name || 'Original full circle', version: 1 }, motionEnvelope,
    captureRotationDegrees: profile.rotationDegrees, backgroundRgb: [0, 0, 0], shadows: false,
    sourceHashes: currentSourceHashes,
  };
  if (options.resume) {
    const previous = JSON.parse(readFileSync(join(output, '.render-manifest.json'), 'utf8'));
    options.compactFrames ??= Boolean(previous.compactFrames);
    assertResumeSettings(previous, manifest);
    const runner = 'scripts/mi-note-video/capture.mjs';
    manifest = {
      ...previous, sourceHashes: manifest.sourceHashes, compactFrames: Boolean(options.compactFrames),
      pipelineProcessing: Boolean(options.pipelineProcessing),
      singleViewportCapture: Boolean(options.singleViewportCapture), status: 'validating-resume',
      landscapeViewportCapture: Boolean(options.landscapeBlackCapture),
      resumeHistory: [...(previous.resumeHistory || []), {
        runId, at: new Date().toISOString(), previousStatus: previous.status, previousError: previous.error || null,
        previousRunnerSha256: previous.sourceHashes[runner], runnerSha256: manifest.sourceHashes[runner],
      }],
    };
    delete manifest.error;
  }
  manifest.nativeFrames ||= {};
  manifest.nativeProofs ||= {};
  manifest.qualityReports ||= {};
  manifest.compacted ||= {};
  const ownerPath = join(cache, '.capture-owner.json');
  if (!options.resume) {
    manifest.ownerId = runId;
    writeFileSync(ownerPath, JSON.stringify({ ownerId: runId, cache, output, ids: options.ids }) + '\n', { flag: 'wx' });
  }
  const assertOwnedPath = path => {
    if (realpathSync(cache) !== cache) throw new Error('Capture cache has a symbolic-link ancestor.');
    if (!containsPath(cache, resolve(path))) throw new Error(`Generated path escapes the owned cache: ${path}`);
    for (const candidate of [cache, ...relative(cache, path).split('/').filter(Boolean).map((_, index, parts) => join(cache, ...parts.slice(0, index + 1)))]) {
      try { if (lstatSync(candidate).isSymbolicLink()) throw new Error(`Generated path contains a symbolic link: ${candidate}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const assertCacheOwner = () => {
    assertOwnedPath(cache);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!manifest.ownerId || owner.ownerId !== manifest.ownerId || owner.cache !== cache || owner.output !== output
      || JSON.stringify(owner.ids) !== JSON.stringify(options.ids)) throw new Error('Capture cache ownership marker does not match this run.');
  };
  const savedFrames = new Map(options.ids.map(id => [id, new Map()]));
  const savedGeometry = new Map();
  const saveManifest = () => {
    const pending = join(output, '.render-manifest.pending.json');
    writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(pending, join(output, '.render-manifest.json'));
  };
  const assertSources = () => {
    for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
      if (hash(join(root, file)) !== expected) throw new Error(`Rendering source changed during capture: ${file}`);
    }
    if (hash(options.preflight) !== manifest.preflight.sha256) throw new Error('Preflight approval changed.');
  };
  const captureCapacity = () => {
    const disk = statfsSync(cache);
    const immediateBytes = disk.bavail * disk.bsize;
    let availableBytes = immediateBytes;
    let source = 'statfs';
    if (motionLoop && process.platform === 'darwin') {
      try {
        const capacity = Number(runSync('/usr/bin/swift', ['-e',
          'import Foundation; let url = URL(fileURLWithPath: CommandLine.arguments.last!); let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]); print(values.volumeAvailableCapacityForImportantUsage ?? -1)', cache]));
        if (Number.isSafeInteger(capacity) && capacity > 0) {
          availableBytes = Math.max(immediateBytes, capacity);
          source = 'Foundation.volumeAvailableCapacityForImportantUsage';
        }
      } catch {}
    }
    return { immediateBytes, availableBytes, source };
  };
  if (!options.resume) {
    writeFileSync(join(output, '.methods.json'), JSON.stringify(selectedMethods, null, 2) + '\n', { flag: 'wx' });
    saveManifest();
  } else if (JSON.stringify(JSON.parse(readFileSync(join(output, '.methods.json'), 'utf8'))) !== JSON.stringify(selectedMethods)) {
    throw new Error('Cannot resume: method legend changed.');
  }
  let aborted = null;
  let safari;
  let safariAuxiliary;
  let safariProcessBaseline = new Map();
  let safariOwnedProcess;
  let server;
  let nativeIcc;
  let staticReference;
  let pendingProcessing;
  const checkActive = () => { if (aborted) throw aborted; };
  const stopProcessingChildren = () => {
    for (const child of activeChildren) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const automationProcesses = () => new Map(runSync('/bin/ps', ['-axo', 'pid=,lstart=,command=']).split('\n')
    .filter(line => line.trim().endsWith('/Safari.app/Contents/MacOS/Safari -ApplePersistenceIgnoreStateQuietly YES --automation'))
    .map(line => [Number(line.trim().split(/\s+/)[0]), line.trim()]));
  const shutdownCapture = async () => {
    const ownedSafari = safari;
    const ownedProcess = safariOwnedProcess;
    safari = undefined;
    safariAuxiliary = undefined;
    safariOwnedProcess = undefined;
    if (ownedSafari) await ownedSafari.close();
    if (ownedProcess && automationProcesses().get(ownedProcess.pid) === ownedProcess.identity) {
      try { process.kill(ownedProcess.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const interrupt = () => {
    aborted ||= new Error('Comparison interrupted; completed files and capture evidence were preserved.');
    stopProcessingChildren();
    void shutdownCapture();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const run = (command, args) => new Promise((resolveCommand, reject) => {
    checkActive();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.on('error', error => { activeChildren.delete(child); reject(error); });
    child.on('close', code => {
      activeChildren.delete(child);
      if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr || stdout}`));
      else resolveCommand(stdout);
    });
  });
  const helper = async args => JSON.parse(await run(options.python, [frameHelper, ...args]));
  const readQuality = id => {
    const entry = manifest.qualityReports[id];
    if (!entry) return null;
    if (!containsPath(cache, resolve(entry.path)) || hash(entry.path) !== entry.sha256
      || entry.helperSha256 !== manifest.sourceHashes[qualitySource]) throw new Error(`Quality report changed for card ${id}.`);
    const report = JSON.parse(readFileSync(entry.path, 'utf8'));
    if (!report.passed || report.cardId !== id || report.frameCount !== preset.frames || !report.restRepeatExact
      || report.frames.length !== preset.frames || report.frames.some((frame, index) => frame.frame !== index
        || frame.sha256 !== manifest.nativeFrames[`${id}:${index}`]?.sha256)) throw new Error(`Quality report does not cover the saved frames for card ${id}.`);
    return report;
  };
  const ensureQuality = async id => {
    if (readQuality(id)) return;
    const capture = captures.get(`${id}c`);
    const proofs = manifest.nativeProofs[id];
    if (!capture || !proofs?.before || !proofs?.after) throw new Error(`Card ${id} is not ready for full-sequence QA.`);
    const path = join(cache, 'metadata', `${id}c-quality-${runId}.json`);
    manifest.status = 'quality-audit';
    saveManifest();
    console.log(`Auditing all native colors and detail for card ${id}`);
    await run(options.python, [qualityHelper, '--frames', capture.raw, '--before', proofs.before.path,
      '--after', proofs.after.path, '--output', path, '--card-id', String(id), '--card-bounds', JSON.stringify(staticBounds(capture.initial)),
      ...(options.nft2Tilt ? ['--native-size', String(capturedSize)] : [])]);
    manifest.qualityReports[id] = { path, sha256: hash(path), helperSha256: manifest.sourceHashes[qualitySource] };
    readQuality(id);
    saveManifest();
  };
  const encodeCard = async id => {
    const encodeMethod = async method => {
      checkActive();
      assertSources();
      const capture = captures.get(`${id}c`);
      const space = methodMapping[method].space;
      const originalPrepared = join(cache, 'prepared', `${id}${method}`);
      const prepared = existsSync(originalPrepared) ? join(cache, 'prepared', `${id}${method}-${runId}`) : originalPrepared;
      manifest.status = 'encoding';
      saveManifest();
      console.log(`Preparing ${id}${method} (${space}, ${deliverySize}x${deliverySize})`);
      const preparation = await helper(['prepare-sequence', '--input', capture.raw, '--output', prepared, '--space', space, '--size', String(deliverySize)]);
      writeFileSync(join(cache, 'metadata', `${id}${method}-preparation-${runId}.json`), JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx' });
      console.log(`Encoding ${id}.mp4`);
      const video = await helper(['encode', '--frames', prepared, '--output', join(output, `${id}.mp4`), '--space', space, '--size', String(deliverySize)]);
      if (!video.fullyDecoded || video.width !== deliverySize || video.height !== deliverySize || video.frames !== preset.frames) throw new Error(`Video validation is incomplete for ${id}${method}.`);
      manifest.videos.push({ id, method, prepared, ...video });
      saveManifest();
      console.log(`Verified ${id}.mp4 (${manifest.videos.length}/${options.ids.length})`);
    };
    const workers = options.methods.filter(method => method !== 'a' && !manifest.videos.some(video => video.id === id && video.method === method)).map(encodeMethod);
    try { await Promise.all(workers); }
    catch (error) {
      aborted ||= error;
      stopProcessingChildren();
      await Promise.allSettled(workers);
      throw error;
    }
  };
  const compactCard = async id => {
    if (!options.compactFrames || manifest.compacted[id]?.status === 'complete') return;
    assertCacheOwner();
    readQuality(id) || (() => { throw new Error(`Cannot compact card ${id} without a passing quality report.`); })();
    for (const proof of ['before', 'after'].map(label => manifest.nativeProofs[id]?.[label])) {
      if (!proof?.path || !proof.sha256 || hash(proof.path) !== proof.sha256) throw new Error(`Native rest proof changed before compacting card ${id}.`);
    }
    const videos = nativeMethods.map(method => manifest.videos.find(video => video.id === id && video.method === method));
    if (videos.some(video => !video?.fullyDecoded || video.stream?.width !== deliverySize || video.stream?.height !== deliverySize
      || Number(video.stream?.nb_frames) !== preset.frames || hash(join(output, `${id}.mp4`)) !== video.sha256)) {
      throw new Error(`Cannot compact card ${id}: all requested native videos must be validated.`);
    }
    const raw = join(cache, 'raw', `${id}c`);
    const tiles = join(cache, 'tiles', `${id}c`);
    const prepared = readdirSync(join(cache, 'prepared')).filter(name => new RegExp(`^${id}[cd](?:-\\d+-[a-f0-9]{8})?$`).test(name))
      .map(name => join(cache, 'prepared', name));
    for (const directory of [raw, tiles, ...prepared, join(cache, 'archive', `${id}c`)]) assertOwnedPath(directory);
    verifyGeneratedDirectory(raw, /^\d{4}\.png$/);
    verifyGeneratedDirectory(tiles, /^(?:\d{4}|before|after|resume-\d+-[a-f0-9]{8}|baseline-control-\d+-[a-f0-9]{8}|raster-warmup-[0-5]-\d+-[a-f0-9]{8}|after-calibration-\d+-[a-f0-9]{8}-[1-8])\/run-\d+-[a-f0-9]{8}\/attempt-\d+\/\d+-\d+\.png$/);
    for (const directory of prepared) verifyGeneratedDirectory(directory, preparedWorkingFramePattern);
    const archive = join(cache, 'archive', `${id}c`);
    mkdirSync(archive, { recursive: true });
    const retained = retainedFrames.map(frame => {
      const record = manifest.nativeFrames[`${id}:${frame}`];
      if (!record) throw new Error(`Missing native checkpoint for ${id}:${frame}`);
      const originalPath = join(raw, `${String(frame).padStart(4, '0')}.png`);
      if (resolve(record.originalPath || record.path) !== originalPath) throw new Error('Native frame checkpoint escapes its card directory.');
      const path = join(archive, `${String(frame).padStart(4, '0')}.png`);
      const source = existsSync(path) ? path : record.path;
      if (hash(source) !== record.sha256) throw new Error(`Retained native frame changed: ${id}:${frame}`);
      let viewportSource;
      let viewportSources;
      if (hash(record.stitchReport) !== record.stitchReportSha256) throw new Error('Source viewport stitch report changed before compaction.');
      if (options.singleViewportCapture) {
        const report = JSON.parse(readFileSync(record.stitchReport, 'utf8'));
        const metadata = JSON.parse(readFileSync(report.metadata, 'utf8'));
        const viewport = report.backgroundPadding?.sourceViewport;
        if (report.singleViewportCapture !== true || metadata.tiles.length !== 1
          || viewport?.path !== metadata.tiles[0].path || !/^[a-f0-9]{64}$/i.test(viewport.sha256 || '')) {
          throw new Error('Source viewport provenance is missing before compaction.');
        }
        viewportSource = { path: join(archive, `${String(frame).padStart(4, '0')}-viewport.png`), originalPath: viewport.path, sha256: viewport.sha256 };
        assertOwnedPath(viewportSource.path);
        assertOwnedPath(viewportSource.originalPath);
        const viewportPath = existsSync(viewportSource.path) ? viewportSource.path : viewportSource.originalPath;
        if (hash(viewportPath) !== viewportSource.sha256) throw new Error(`Retained source viewport changed: ${id}:${frame}`);
      } else {
        const report = JSON.parse(readFileSync(record.stitchReport, 'utf8'));
        if (hash(report.metadata) !== report.metadataSha256) throw new Error('Source tile metadata changed before compaction.');
        const metadata = JSON.parse(readFileSync(report.metadata, 'utf8'));
        if (metadata.tiles.length !== profile.tiles) throw new Error('Missing upright source viewports.');
        viewportSources = metadata.tiles.map(tile => {
          const item = { path: join(archive, `${String(frame).padStart(4, '0')}-viewport-${tile.row}-${tile.col}.png`),
            originalPath: tile.path, sha256: tile.sha256, row: tile.row, col: tile.col };
          assertOwnedPath(item.path);
          assertOwnedPath(item.originalPath);
          const current = existsSync(item.path) ? item.path : item.originalPath;
          if (hash(current) !== item.sha256) throw new Error('Upright source viewport changed before compaction.');
          return item;
        });
      }
      return { ...record, path, originalPath, ...(viewportSource ? { viewportSource } : {}), ...(viewportSources ? { viewportSources } : {}) };
    });
    if (existsSync(raw)) for (const filename of readdirSync(raw)) {
      const frame = Number(filename.slice(0, 4));
      if (hash(join(raw, filename)) !== manifest.nativeFrames[`${id}:${frame}`]?.sha256) throw new Error(`Native frame changed before compaction: ${id}:${frame}`);
    }
    manifest.compacted[id] = { status: 'retaining', startedAt: new Date().toISOString(), retained,
      qualityReport: manifest.qualityReports[id], videos: Object.fromEntries(videos.map(video => [video.method, video.sha256])),
      removedDirectories: [raw, tiles, ...prepared] };
    saveManifest();
    for (const record of retained) {
      if (!existsSync(record.path)) renameSync(record.originalPath, record.path);
      if (record.viewportSource && !existsSync(record.viewportSource.path)) renameSync(record.viewportSource.originalPath, record.viewportSource.path);
      for (const viewport of record.viewportSources || []) if (!existsSync(viewport.path)) renameSync(viewport.originalPath, viewport.path);
      manifest.nativeFrames[`${id}:${record.frame}`].archivePath = record.path;
      if (record.viewportSource) manifest.nativeFrames[`${id}:${record.frame}`].viewportSource = record.viewportSource;
      if (record.viewportSources) manifest.nativeFrames[`${id}:${record.frame}`].viewportSources = record.viewportSources;
    }
    manifest.compacted[id].status = 'retained';
    saveManifest();
    for (const directory of [raw, tiles, ...prepared]) rmSync(directory, { recursive: true, force: true });
    manifest.compacted[id].status = 'complete';
    manifest.compacted[id].finishedAt = new Date().toISOString();
    saveManifest();
    console.log(`Compacted card ${id}: retained proofs, five native control frames${options.singleViewportCapture ? ', five source viewports' : ''}, all hashes and QA reports`);
  };
  const validateResume = async () => {
    assertCacheOwner();
    const recoveryId = options.ids[0];
    const frameRecoveryOptions = { output, cache, ownerId: manifest.ownerId, id: recoveryId, frameCount: preset.frames,
      nativeFrames: manifest.nativeFrames, compacted: Boolean(manifest.compacted[recoveryId]),
      incomplete: !manifest.compacted[recoveryId] && !manifest.captures.some(capture => capture.id === recoveryId && capture.method === 'c') };
    recoverUncommittedFrames({ ...frameRecoveryOptions, checkOnly: true });
    const images = [];
    const viewportSources = new Map();
    const readStitch = (id, frame, file, reportPath, previous = {}) => {
      if (!containsPath(cache, resolve(reportPath)) || !existsSync(reportPath)) throw new Error(`Missing saved stitch report: ${reportPath}`);
      if (previous.stitchReportSha256 && hash(reportPath) !== previous.stitchReportSha256) throw new Error(`Saved stitch report changed: ${reportPath}`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (resolve(report.path) !== resolve(previous.originalPath || file) || !report.passed || !report.iccPreservedByteForByte
        || report.width !== capturedSize || report.height !== capturedSize || report.mode !== 'RGB'
        || report.guardPixels !== gutterPixels
        || (report.singleViewportCapture ?? false) !== Boolean(options.singleViewportCapture)
        || (report.landscapeViewportCapture ?? false) !== Boolean(options.landscapeBlackCapture)
        || (options.singleViewportCapture && (report.columns !== 1 || report.rows !== 1))
        || report.deliveryThresholds?.size !== deliverySize || !/^[a-f0-9]{64}$/i.test(report.icc?.sha256 || '')
        || report.seams.some(seam => !seam.passed || !seam.delivery?.passed
          || deliverySpaces.some(space => !seam.delivery.spaces?.[space]?.passed))) throw new Error(`Invalid saved stitch report: ${reportPath}`);
      if (nativeIcc && report.icc.sha256 !== nativeIcc) throw new Error('Saved native ICC profiles differ.');
      nativeIcc = report.icc.sha256;
      if (!containsPath(cache, resolve(report.metadata))) throw new Error('Saved tile metadata is outside the capture cache.');
      if (hash(report.metadata) !== report.metadataSha256) throw new Error('Saved tile metadata checksum changed.');
      const metadata = JSON.parse(readFileSync(report.metadata, 'utf8'));
      if (metadata.id !== id || metadata.frame !== frame || metadata.captureScale !== captureScale
        || metadata.width !== capturedSize || metadata.height !== capturedSize) throw new Error(`Saved tile identity differs: ${report.metadata}`);
      if (metadata.profile !== profile.id || metadata.columns !== 1 || metadata.rows !== profile.tiles
        || metadata.captureRotationDegrees !== profile.rotationDegrees || metadata.shadows !== false
        || JSON.stringify(metadata.backgroundRgb) !== '[0,0,0]') throw new Error('Saved profile or black scene settings differ.');
      if (profile.id === 'upright-2160' && (report.uprightCapture?.capturedExteriorExactBlack !== true
        || report.uprightCapture.nativePixelsPreserved !== true || report.uprightCapture.sourceViewports !== 2)) throw new Error('Saved upright black capture proof is invalid.');
      if ((metadata.singleViewportCapture ?? false) !== Boolean(options.singleViewportCapture)) throw new Error(`Saved viewport mode differs: ${report.metadata}`);
      if ((metadata.landscapeViewportCapture ?? false) !== Boolean(options.landscapeBlackCapture)) throw new Error(`Saved landscape mode differs: ${report.metadata}`);
      if (options.singleViewportCapture) {
        const reference = knownStaticReference();
        const padding = report.backgroundPadding;
        if (metadata.columns !== 1 || metadata.rows !== 1 || metadata.tiles.length !== 1
          || !reference || metadata.backgroundReference?.path !== reference.path || metadata.backgroundReference.sha256 !== reference.sha256
          || padding?.reference?.path !== reference.path || padding.reference.sha256 !== reference.sha256
          || JSON.stringify(padding.reference.excludedBounds) !== JSON.stringify(metadata.backgroundReference.excludedBounds)
          || padding?.nativePixelsPreserved !== true || padding.referenceIccMatches !== true) throw new Error(`Invalid saved background provenance: ${reportPath}`);
        if (options.landscapeBlackCapture) {
          if (metadata.captureRotationDegrees !== 90 || metadata.shadows !== false || JSON.stringify(metadata.backgroundRgb) !== '[0,0,0]'
            || padding.referenceExteriorExactBlack !== true || padding.referencePaddedRegionsExactBlack !== true
            || padding.capturedExteriorExactBlack !== true || padding.blackBordersExact !== true || padding.blackBorderRadiusPixels !== 8
            || padding.antialiasAllowancePixels !== 2 || padding.shadowAllowancePixels !== 0 || padding.losslessUnrotation !== true
            || padding.inverseRotationDegrees !== 90 || padding.inverseRotation?.captureClockwiseDegrees !== 90
            || padding.inverseRotation.restoreCounterclockwiseDegrees !== 90 || padding.inverseRotation.operation !== 'PIL.Image.Transpose.ROTATE_90'
            || padding.inverseRotation.losslessIntegerPermutation !== true || padding.inverseRotation.resampling !== false
            || JSON.stringify(padding.paddingRgb) !== '[0,0,0]') {
            throw new Error(`Invalid saved black landscape provenance: ${reportPath}`);
          }
        }
      }
      for (const tile of metadata.tiles) {
        if (!containsPath(cache, resolve(tile.path))) throw new Error('Saved tile is outside the capture cache.');
        if (!/^[a-f0-9]{64}$/.test(tile.sha256 || '')) throw new Error('Saved viewport checksum is missing.');
        assertSnapshot(tile.snapshot, id, frame, undefined, { x: tile.originX + gutterPixels, y: tile.originY + gutterPixels });
        if (options.singleViewportCapture) {
          const scroll = singleViewportScroll(tile.snapshot, { width: tile.viewportWidth, height: tile.viewportHeight });
          assertSnapshot(tile.snapshot, id, frame, undefined, scroll);
          if (physicalInteger(tile.originX + tile.snapshot.stageDocumentPixels.x, 'saved horizontal scroll') !== scroll.x
            || physicalInteger(tile.originY + tile.snapshot.stageDocumentPixels.y, 'saved vertical scroll') !== scroll.y
            || JSON.stringify(metadata.backgroundReference.excludedBounds) !== JSON.stringify(staticBounds(tile.snapshot))) {
            throw new Error(`Saved dynamic viewport geometry differs: ${report.metadata}`);
          }
          const source = report.backgroundPadding.sourceViewport;
          if (source?.path !== tile.path || !/^[a-f0-9]{64}$/i.test(source.sha256 || '')) throw new Error('Saved source viewport provenance changed.');
          if (source.sha256 !== tile.sha256) throw new Error('Saved viewport and stitch checksums differ.');
          const retained = previous.viewportSource;
          if (retained && (retained.originalPath !== tile.path || retained.sha256 !== source.sha256)) throw new Error('Retained source viewport differs from tile provenance.');
          if (!previous.compacted || retained) {
            const path = retained && existsSync(retained.path) ? retained.path : tile.path;
            assertOwnedPath(path);
            const item = { path, sha256: source.sha256, width: tile.viewportWidth, height: tile.viewportHeight, iccSha256: report.icc.sha256 };
            if (viewportSources.has(path) && JSON.stringify(viewportSources.get(path)) !== JSON.stringify(item)) throw new Error('Source viewport has inconsistent saved provenance.');
            viewportSources.set(path, item);
          }
        } else {
          const retained = previous.viewportSources?.find(item => item.row === tile.row && item.col === tile.col);
          if (retained && (retained.originalPath !== tile.path || retained.sha256 !== tile.sha256)) throw new Error('Retained upright source viewport provenance differs.');
          if (!previous.compacted || retained) {
            const path = retained && existsSync(retained.path) ? retained.path : tile.path;
            assertOwnedPath(path);
            viewportSources.set(path, { path, sha256: tile.sha256, width: tile.viewportWidth, height: tile.viewportHeight, iccSha256: report.icc.sha256 });
          }
        }
        if (!previous.compacted) {
          const dimensions = readPngDimensions(tile.path);
          if (dimensions.width !== tile.viewportWidth || dimensions.height !== tile.viewportHeight) throw new Error(`Saved tile dimensions changed: ${tile.path}`);
        }
      }
      const initialTile = metadata.tiles.find(tile => tile.row === 0 && tile.col === 0);
      const geometry = {
        initial: initialTile.snapshot,
        grid: options.singleViewportCapture ? { xs: [0], ys: [0] } : {
          xs: [...new Set(metadata.tiles.map(tile => tile.originX + gutterPixels))].sort((a, b) => a - b),
          ys: [...new Set(metadata.tiles.map(tile => tile.originY + gutterPixels))].sort((a, b) => a - b),
        },
        screenshotDimensions: { width: initialTile.viewportWidth, height: initialTile.viewportHeight },
      };
      const original = savedGeometry.get(id);
      if (original && (JSON.stringify(original.grid) !== JSON.stringify(geometry.grid)
        || JSON.stringify(original.screenshotDimensions) !== JSON.stringify(geometry.screenshotDimensions))) throw new Error(`Saved capture grid differs for card ${id}.`);
      if (!original) savedGeometry.set(id, geometry);
      const record = { id, frame, path: file, stitchReport: reportPath, stitchReportSha256: hash(reportPath),
        tileMetadata: report.metadata, iccSha256: report.icc.sha256, ...(previous.sha256 ? { sha256: previous.sha256 } : {}),
        ...(previous.originalPath ? { originalPath: previous.originalPath } : {}),
        ...(previous.viewportSource ? { viewportSource: previous.viewportSource } : {}) };
      if (previous.viewportSources) record.viewportSources = previous.viewportSources;
      images.push(record);
      return record;
    };
    const videoKeys = new Set();
    for (const video of manifest.videos) {
      const key = `${video.id}${video.method}`;
      const file = join(output, `${video.id}.mp4`);
      if (!options.ids.includes(video.id) || !options.methods.includes(video.method) || videoKeys.has(key)
        || !existsSync(file) || hash(file) !== video.sha256) throw new Error(`Saved video verification failed: ${key}`);
      const size = deliverySize;
      if (video.stream?.width !== size || video.stream?.height !== size || Number(video.stream?.nb_frames) !== preset.frames
        || video.stream?.avg_frame_rate !== '60/1') throw new Error(`Saved video format differs: ${key}`);
      videoKeys.add(key);
    }
    for (const id of options.ids) {
      const raw = join(cache, 'raw', `${id}c`);
      const compacted = manifest.compacted[id];
      if (compacted) {
        assertCacheOwner();
        if (!['retaining', 'retained', 'complete'].includes(compacted.status) || compacted.retained.length !== retainedFrames.length
          || JSON.stringify(compacted.retained.map(frame => frame.frame)) !== JSON.stringify(retainedFrames)) throw new Error(`Invalid compaction record for card ${id}.`);
        readQuality(id) || (() => { throw new Error(`Compacted card ${id} lacks its passing quality audit.`); })();
        if (compacted.qualityReport?.sha256 !== manifest.qualityReports[id].sha256) throw new Error(`Compacted quality provenance changed for card ${id}.`);
        for (const method of nativeMethods) {
          const video = manifest.videos.find(video => video.id === id && video.method === method);
          if (!video?.fullyDecoded || compacted.videos[method] !== video.sha256 || !videoKeys.has(`${id}${method}`)) throw new Error(`Compacted card ${id} lacks a verified ${method} video.`);
        }
        const completed = manifest.captures.find(capture => capture.id === id && capture.method === 'c');
        if (!completed) throw new Error(`Compacted card ${id} lacks completed capture metadata.`);
        for (const label of ['before', 'after']) {
          const proof = manifest.nativeProofs[id]?.[label];
          if (!proof?.path || !proof.sha256) throw new Error(`Compacted card ${id} lacks its ${label} proof.`);
          manifest.nativeProofs[id][label] = readStitch(id, 0, proof.path, proof.stitchReport, { ...proof, compacted: true });
        }
        for (const record of compacted.retained) {
          if (record.sha256 !== manifest.nativeFrames[`${id}:${record.frame}`]?.sha256) throw new Error('Compacted control checksum differs from its native checkpoint.');
          const expectedArchive = join(cache, 'archive', `${id}c`, `${String(record.frame).padStart(4, '0')}.png`);
          const expectedOriginal = join(raw, `${String(record.frame).padStart(4, '0')}.png`);
          if (record.path !== expectedArchive || record.originalPath !== expectedOriginal) throw new Error('Compacted frame path changed.');
          if (options.singleViewportCapture) {
            const expectedViewport = join(cache, 'archive', `${id}c`, `${String(record.frame).padStart(4, '0')}-viewport.png`);
            if (record.viewportSource?.path !== expectedViewport
              || (compacted.status === 'complete' && !existsSync(expectedViewport))) throw new Error('Compacted source viewport is missing from its archive.');
            assertOwnedPath(record.viewportSource.path);
            assertOwnedPath(record.viewportSource.originalPath);
          } else {
            if (record.viewportSources?.length !== profile.tiles) throw new Error('Compacted upright source viewports are missing.');
            for (const [row, viewport] of record.viewportSources.entries()) {
              const expected = join(cache, 'archive', `${id}c`, `${String(record.frame).padStart(4, '0')}-viewport-${row}-0.png`);
              if (viewport.row !== row || viewport.col !== 0 || viewport.path !== expected
                || (compacted.status === 'complete' && !existsSync(expected))) throw new Error('Compacted upright source viewport path changed.');
              assertOwnedPath(viewport.path);
              assertOwnedPath(viewport.originalPath);
            }
          }
          assertOwnedPath(record.path);
          assertOwnedPath(record.originalPath);
          const file = existsSync(record.path) ? record.path : record.originalPath;
          if (compacted.status === 'complete' && file !== record.path) throw new Error('Compacted control frame is missing from the archive.');
          savedFrames.get(id).set(record.frame, readStitch(id, record.frame, file, record.stitchReport, { ...record, compacted: true }));
        }
        captures.set(`${id}c`, completed);
        continue;
      }
      const before = manifest.nativeProofs[id]?.before || {
        path: join(cache, 'proofs', `${id}c-before.png`), stitchReport: join(cache, 'metadata', `${id}c-before-stitch.json`),
      };
      if (existsSync(before.path)) {
        manifest.nativeProofs[id] ||= {};
        manifest.nativeProofs[id].before = readStitch(id, 0, before.path, before.stitchReport, before);
      }
      for (const name of readdirSync(raw).filter(name => name.endsWith('.png'))) {
        if (nativePendingFramePattern.test(name)) {
          if (!options.checkResume) renameSync(join(raw, name), join(cache, 'capture-attempts', `${runId}-${name}`));
          continue;
        }
        if (!/^\d{4}\.png$/.test(name) || Number(name.slice(0, 4)) >= preset.frames) throw new Error(`Unexpected native frame: ${name}`);
        const frame = Number(name.slice(0, 4));
        if (!Object.hasOwn(manifest.nativeFrames, `${id}:${frame}`)) continue;
        const previous = manifest.nativeFrames[`${id}:${frame}`];
        const reportPath = previous.stitchReport;
        savedFrames.get(id).set(frame, readStitch(id, frame, join(raw, name), reportPath, previous));
      }
      if (savedFrames.get(id).size && !manifest.nativeProofs[id]?.before) throw new Error(`Saved native frames lack their original rest proof: ${id}`);
      const completed = manifest.captures.find(capture => capture.id === id && capture.method === 'c');
      if (completed) {
        if (savedFrames.get(id).size !== preset.frames) throw new Error(`Completed capture ${id} is missing frames.`);
        const after = manifest.nativeProofs[id]?.after || {
          path: join(cache, 'proofs', `${id}c-after.png`), stitchReport: join(cache, 'metadata', `${id}c-after-stitch.json`),
        };
        manifest.nativeProofs[id].after = readStitch(id, 0, after.path, after.stitchReport, after);
        captures.set(`${id}c`, completed);
      }
    }
    const listPath = join(cache, 'metadata', `resume-${runId}-images.json`);
    writeFileSync(listPath, JSON.stringify(images));
    const checked = JSON.parse(await run(options.python, ['-c', validateSavedPngs, listPath, String(capturedSize)]));
    if (viewportSources.size) {
      const viewportList = join(cache, 'metadata', `resume-${runId}-viewports.json`);
      writeFileSync(viewportList, JSON.stringify([...viewportSources.values()]));
      await run(options.python, ['-c', validateSavedViewports, viewportList]);
    }
    const checkedByPath = new Map(checked.map(item => [item.path, item]));
    for (const id of options.ids) {
      for (const [frame, record] of savedFrames.get(id)) {
        Object.assign(record, checkedByPath.get(record.path));
        manifest.nativeFrames[`${id}:${frame}`] = record;
      }
      for (const proof of Object.values(manifest.nativeProofs[id] || {})) {
        if (proof?.path && checkedByPath.has(proof.path)) Object.assign(proof, checkedByPath.get(proof.path));
      }
      if (captures.has(`${id}c`)) {
        const proof = manifest.nativeProofs[id];
        await run(options.python, ['-c', repeatCheck, JSON.stringify([proof.before.path, savedFrames.get(id).get(0).path, proof.after.path]), String(capturedSize)]);
      }
    }
    const staticAudit = await auditNative(false);
    if (!staticAudit.passed) throw new Error(`Saved native static scene differs; inspect ${staticAudit.path} before resuming.`);
    const frameRecovery = recoverUncommittedFrames({ ...frameRecoveryOptions, checkOnly: Boolean(options.checkResume) });
    if (!options.checkResume) manifest.nativeFrameRecoveries = frameRecovery.journals;
    const id = options.ids[0];
    const committed = manifest.videos.find(video => video.id === id);
    const allowFinal = !committed && captures.has(`${id}c`) && savedFrames.get(id).size === preset.frames && Boolean(readQuality(id));
    const encodingRecovery = recoverInterruptedEncodes({ output, cache, ownerId: manifest.ownerId, id, committed, allowFinal,
      checkOnly: Boolean(options.checkResume) });
    if (!options.checkResume) manifest.encodingRecoveries = encodingRecovery.journals;
    const validation = { runId, verifiedImages: checked.length, nativeFrames: Object.fromEntries([...savedFrames].map(([id, frames]) => [id, frames.size])), videos: manifest.videos.length, frameRecovery, encodingRecovery };
    writeFileSync(join(cache, 'metadata', `resume-${runId}-validation.json`), JSON.stringify({ ...validation, images: checked }, null, 2) + '\n');
    manifest.resumeHistory.at(-1).validation = validation;
    if (!options.checkResume) saveManifest();
    console.log(`Resume verified ${checked.length} native PNGs and ${manifest.videos.length} videos: ${JSON.stringify(validation.nativeFrames)}`);
  };
  const expectedVars = index => Object.fromEntries(computeRecordingFrameStyle(index, preset.frames, preset).split(';').map(value => value.split(':')));
  const effectKeys = {
    pointerX: '--pointer-x', pointerY: '--pointer-y', backgroundX: '--background-x', backgroundY: '--background-y',
    pointerFromCenter: '--pointer-from-center', opacity: '--card-opacity', rotateX: '--rotate-x', rotateY: '--rotate-y',
    scale: '--card-scale', translateX: '--translate-x', translateY: '--translate-y',
  };
  const documentCard = snapshot => options.landscapeBlackCapture ? {
    x: snapshot.unrotatedCardRect.x + snapshot.stageDocumentPixels.x,
    y: snapshot.unrotatedCardRect.y + snapshot.stageDocumentPixels.y,
    width: snapshot.unrotatedCardRect.width, height: snapshot.unrotatedCardRect.height,
  } : ({
    x: (snapshot.cardRect.x + snapshot.scrollX) * snapshot.dpr,
    y: (snapshot.cardRect.y + snapshot.scrollY) * snapshot.dpr,
    width: snapshot.cardRect.width * snapshot.dpr, height: snapshot.cardRect.height * snapshot.dpr,
  });
  const staticBounds = snapshot => {
    const card = documentCard(snapshot);
    const stage = snapshot.stageDocumentPixels;
    const margin = options.landscapeBlackCapture ? Math.ceil(80 * captureScale) : options.nft2Tilt ? 80 * captureScale : 4;
    return [
      Math.max(0, Math.floor(card.x - stage.x) - margin), Math.max(0, Math.floor(card.y - stage.y) - margin),
      Math.min(capturedSize, Math.ceil(card.x - stage.x + card.width) + margin),
      Math.min(capturedSize, Math.ceil(card.y - stage.y + card.height) + margin),
    ];
  };
  const knownStaticReference = () => {
    if (staticReference) return staticReference;
    const completedIds = manifest.captures.filter(capture => capture.method === 'c').map(capture => capture.id);
    completedIds.sort((left, right) => (left === 1 ? -1 : right === 1 ? 1 : left - right));
    for (const id of completedIds) {
      const proof = manifest.nativeProofs[id]?.before;
      if (proof?.path && existsSync(proof.path)) {
        if (proof.sha256 && hash(proof.path) !== proof.sha256) throw new Error('Trusted static reference checksum changed.');
        staticReference = { id, path: proof.path, sha256: hash(proof.path) };
        return staticReference;
      }
    }
    return null;
  };
  const seedStaticReference = async () => {
    if (manifest.staticReference?.path) {
      const recorded = manifest.staticReference;
      if (!containsPath(cache, resolve(recorded.path)) || hash(recorded.path) !== recorded.sha256) throw new Error('Copied static reference changed.');
      const inspected = await helper(['inspect', recorded.path]);
      if (inspected.width !== capturedSize || inspected.height !== capturedSize || inspected.mode !== 'RGB' || !inspected.icc) throw new Error('Copied static reference has invalid native geometry or ICC.');
      if (recorded.icc?.sha256 && recorded.icc.sha256 !== inspected.icc.sha256) throw new Error('Copied static reference ICC changed.');
      nativeIcc = inspected.icc.sha256;
      staticReference = recorded;
      return;
    }
    if (!options.staticReference) return;
    const source = resolve(root, options.staticReference);
    const inspected = await helper(['inspect', source]);
    if (inspected.width !== capturedSize || inspected.height !== capturedSize || inspected.mode !== 'RGB' || !inspected.icc) throw new Error(`Static reference must be an ICC-tagged ${capturedSize}-pixel RGB native proof.`);
    const sha256 = hash(source);
    const destination = join(cache, 'proofs', 'static-reference.png');
    assertOwnedPath(destination);
    if (options.checkResume) {
      staticReference = { id: null, path: source, sha256, icc: inspected.icc };
      nativeIcc = inspected.icc.sha256;
      return;
    }
    if (!existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL);
    if (hash(destination) !== sha256) throw new Error('Copied static reference differs from its approved source.');
    staticReference = { id: null, path: destination, sha256, icc: inspected.icc,
      provenance: { source, sha256, copiedAt: new Date().toISOString() } };
    nativeIcc = inspected.icc.sha256;
    manifest.staticReference = staticReference;
    saveManifest();
  };
  const checkStatic = async (files, initial, label) => {
    const reference = knownStaticReference();
    if (!reference) return null;
    const listPath = join(cache, 'metadata', `static-${label}-${runId}-${randomUUID().slice(0, 8)}-files.json`);
    writeFileSync(listPath, JSON.stringify(files), { flag: 'wx' });
    return JSON.parse(await run(options.python, ['-c', staticExteriorCheck, reference.path, listPath,
      JSON.stringify(staticBounds(initial)), String(capturedSize), String(options.landscapeBlackCapture ? Math.ceil(80 * captureScale) : options.nft2Tilt ? 80 * captureScale : 4)]));
  };
  const auditNative = async (includeAfter) => {
    const reports = [];
    for (const id of options.ids) {
      const proof = manifest.nativeProofs[id]?.before;
      if (!proof?.path || !existsSync(proof.path)) continue;
      const report = JSON.parse(readFileSync(proof.stitchReport, 'utf8'));
      const tiles = JSON.parse(readFileSync(report.metadata, 'utf8'));
      const initial = tiles.tiles.find(tile => tile.row === 0 && tile.col === 0).snapshot;
      const raw = join(cache, 'raw', `${id}c`);
      const nativeFiles = manifest.compacted[id]
        ? manifest.compacted[id].retained.map(record => existsSync(record.path) ? record.path : record.originalPath)
        : readdirSync(raw).filter(name => /^\d{4}\.png$/.test(name)
          && Object.hasOwn(manifest.nativeFrames, `${id}:${Number(name.slice(0, 4))}`)).sort().map(name => join(raw, name));
      const files = [proof.path, ...nativeFiles];
      if (includeAfter && manifest.nativeProofs[id]?.after?.path && existsSync(manifest.nativeProofs[id].after.path)) files.push(manifest.nativeProofs[id].after.path);
      const checked = await checkStatic(files, initial, `audit-${id}`);
      if (checked) reports.push({ id, ...checked });
    }
    const path = join(cache, 'metadata', `static-audit-${runId}-${includeAfter ? 'all' : 'frames'}.json`);
    const result = { path, reference: knownStaticReference(), passed: reports.every(report => report.passed), reports };
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
    console.log(`Static native audit: ${reports.reduce((count, report) => count + report.checks.length, 0)} images, ${reports.flatMap(report => report.checks).filter(check => !check.passed).length} failures; ${path}`);
    return result;
  };
  const singleViewportScroll = (snapshot, viewport) => chooseLandscapeViewport(snapshot, viewport).scroll;
  const assertSnapshot = (snapshot, id, frame, baseline, scroll) => {
    checkActive();
    if (!snapshot || snapshot.error || snapshot.asyncError || !snapshot.ready || !snapshot.paintReady
      || snapshot.cardId !== id || snapshot.frame !== frame || !snapshot.nativePixels || snapshot.captureScale !== captureScale
      || snapshot.viewport?.visibility !== 'visible') throw new Error(`Card ${id} frame ${frame} is not ready: ${JSON.stringify(snapshot)}`);
    if ((snapshot.motionLoop ?? null) !== (motionLoop?.id ?? null) || (snapshot.motionVersion ?? null) !== (motionLoop ? 1 : null)) {
      throw new Error('The browser is using a different motion loop.');
    }
    const stage = snapshot.stageDocumentPixels;
    if (!stage || ['x', 'y', 'width', 'height'].some((key, index) => Math.abs(stage[key] - [gutterPixels, gutterPixels, capturedSize, capturedSize][index]) > 0.075)) {
      throw new Error(`Capture stage geometry differs from the ${capturedSize}-pixel scene: ${JSON.stringify(snapshot)}`);
    }
    if (snapshot.assets?.front !== `https://cdn.lil.org/nft/mi_note_cards/fronts/${id}.png`
      || snapshot.assets.naturalWidth !== 2000 || snapshot.assets.naturalHeight !== 2800) throw new Error(`Card ${id}: incorrect PNG front image`);
    const assetUrl = value => value?.trim().replace(/^url\((['"]?)(.*?)\1\)$/, '$2');
    if (assetUrl(snapshot.assets.mask) !== `https://cdn.lil.org/nft/mi_note_cards/masks/${id}.webp`
      || assetUrl(snapshot.assets.grain) !== 'https://cdn.lil.org/nft/poncho_drifella/misc/grain.webp') {
      throw new Error(`Card ${id}: final processed mask or grain texture changed.`);
    }
    if (scroll && (Math.abs(snapshot.scrollPixels.x - scroll.x) > 0.075 || Math.abs(snapshot.scrollPixels.y - scroll.y) > 0.075)) throw new Error('Capture scroll changed.');
    const expected = expectedVars(frame);
    for (const [key, property] of Object.entries(effectKeys)) {
      const actual = Number.parseFloat(snapshot.effect?.[key]);
      if (!Number.isFinite(actual) || Math.abs(actual - Number.parseFloat(expected[property])) > 1e-9) throw new Error(`Card ${id} frame ${frame}: ${key} differs from the shared motion preset`);
    }
    if (options.landscapeBlackCapture) {
      if (snapshot.rotationDegrees !== 90 || snapshot.background !== '#000000' || snapshot.shadowEnabled !== false
        || snapshot.effect.shadow !== 'none' || !snapshot.unrotatedCardRect || !snapshot.unrotatedRotatorRect) {
        throw new Error('Landscape capture requires a black, shadow-free scene rotated exactly 90 degrees.');
      }
    }
    if (snapshot.rotationDegrees !== profile.rotationDegrees || snapshot.background !== '#000000' || snapshot.shadowEnabled !== false || snapshot.effect.shadow !== 'none' || snapshot.dpr !== 2) throw new Error('Native capture requires the selected orientation, DPR 2, black, and no shadow.');
    if (options.nft2Tilt) {
      const rect = snapshot.rotatorRect;
      if (!rect) throw new Error('Tilted card geometry is unavailable.');
      const bounds = staticBounds(snapshot);
      const shadow = 2;
      const checkedRect = options.landscapeBlackCapture ? snapshot.unrotatedRotatorRect : {
        x: (rect.x + snapshot.scrollX) * snapshot.dpr - stage.x,
        y: (rect.y + snapshot.scrollY) * snapshot.dpr - stage.y,
        width: rect.width * snapshot.dpr, height: rect.height * snapshot.dpr,
      };
      const { x, y } = checkedRect;
      if (motionEnvelope) {
        const [left, top, right, bottom] = motionEnvelope.bounds;
        if (x < left - 0.075 || y < top - 0.075 || x + checkedRect.width > right + 0.075 || y + checkedRect.height > bottom + 0.075) {
          throw new Error('Named motion exceeds the original orbit movement area.');
        }
      }
      if (x - shadow < bounds[0] || y - shadow < bounds[1]
        || x + checkedRect.width + shadow > bounds[2]
        || y + checkedRect.height + shadow > bounds[3]) throw new Error('Tilted card or shadow exceeds its audited motion bounds.');
      const neutral = motionLoop && Number.parseFloat(expected['--rotate-x']) === 0 && Number.parseFloat(expected['--rotate-y']) === 0;
      const identity = neutral && /^matrix\(\s*1,\s*0,\s*0,\s*1,\s*0,\s*0\s*\)$/.test(snapshot.effect.transform || '');
      if (!snapshot.effect.transform?.startsWith('matrix3d(') && !identity) throw new Error('Tilt transform is missing.');
    }
    if (baseline) {
      if (baseline.dpr !== snapshot.dpr || baseline.effect.shadow !== snapshot.effect.shadow
        || baseline.viewport.width !== snapshot.viewport.width || baseline.viewport.height !== snapshot.viewport.height) throw new Error('DPR, viewport, or shadow changed during capture');
      if (options.landscapeBlackCapture && (baseline.rotationDegrees !== snapshot.rotationDegrees || baseline.background !== snapshot.background
        || baseline.shadowEnabled !== snapshot.shadowEnabled)) throw new Error('Landscape scene settings changed during capture.');
      const actualCard = documentCard(snapshot);
      const initialCard = documentCard(baseline);
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs(actualCard[key] - initialCard[key]) > 0.075) throw new Error('Card document geometry moved during capture');
      }
    }
  };
  const startCaptureSafari = async () => {
    safariProcessBaseline = automationProcesses();
    safari = new Safari();
    manifest.versions.safariMcp = await safari.initialize();
  };
  const focusCaptureSafari = async () => {
    if (!options.activateCaptureWindow) return;
    const processes = automationProcesses();
    if (!safariOwnedProcess) {
      const created = [...processes].filter(([pid, identity]) => safariProcessBaseline.get(pid) !== identity);
      if (created.length !== 1) throw new Error('Cannot uniquely identify the renderer-owned Safari automation process.');
      safariOwnedProcess = { pid: created[0][0], identity: created[0][1] };
      manifest.captureWindows ||= [];
      manifest.captureWindows.push({ ...safariOwnedProcess, runId, focusedBy: 'Explicitly authorized AppleScript/AppKit' });
    }
    if (processes.get(safariOwnedProcess.pid) !== safariOwnedProcess.identity) throw new Error('The owned Safari automation process changed.');
    const activated = await run('/usr/bin/osascript', ['-e', `use framework "AppKit"
set captureApp to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:${safariOwnedProcess.pid}
if captureApp is missing value then error "The owned capture process has ended."
if (captureApp's bundleIdentifier() as text) is not "com.apple.Safari" then error "The owned process is not Safari."
return captureApp's activateWithOptions:(current application's NSApplicationActivateIgnoringOtherApps)`]);
    if (activated.trim() !== 'true') throw new Error('Safari capture window could not be activated.');
    await delay(200);
  };
  const safariSnapshot = () => safari.evaluate('const page={origin:location.origin,pathname:location.pathname,readyState:document.readyState,visibility:document.visibilityState};return window.miNoteCaptureComparison ? {...window.miNoteCaptureComparison.snapshot(),asyncError:window.__comparisonAsyncError||null,completedAction:window.__comparisonCompletedAction||null,page}:{ready:false,harnessMissing:true,page};');
  const safariWait = async (id, frame, nativePixels, predicate = () => true) => {
    const startedAt = Date.now();
    let deadline = startedAt + 45_000;
    let lastSnapshot = null;
    let polls = 0;
    let hiddenLogged = false;
    while (Date.now() < deadline) {
      checkActive();
      const snapshot = await safariSnapshot();
      lastSnapshot = snapshot;
      polls += 1;
      if (snapshot?.error || snapshot?.asyncError) throw new Error(snapshot.error || snapshot.asyncError);
      const visibility = snapshot?.viewport?.visibility || snapshot?.page?.visibility;
      if (visibility === 'hidden' && !hiddenLogged) {
        hiddenLogged = true;
        deadline = startedAt + 120_000;
        const diagnosticPath = join(cache, 'metadata', `${id}c-frame-${frame}-hidden-${startedAt}.json`);
        writeFileSync(diagnosticPath, JSON.stringify({ cardId: id, frame, nativePixels, snapshot }, null, 2) + '\n');
        console.error(`Safari card ${id} frame ${frame} is hidden; waiting up to 120 seconds for its capture window to become visible. Exit window overview/Mission Control if active. Diagnostic: ${diagnosticPath}`);
      }
      if (snapshot?.ready && snapshot.paintReady && visibility === 'visible'
        && snapshot.cardId === id && snapshot.frame === frame && snapshot.nativePixels === nativePixels && predicate(snapshot)) {
        if (hiddenLogged) console.log(`Safari card ${id} frame ${frame}: capture window is visible again`);
        return snapshot;
      }
      await delay(30);
    }
    const diagnosticPath = join(cache, 'metadata', `${id}c-frame-${frame}-wait-timeout-${Date.now()}.json`);
    writeFileSync(diagnosticPath, JSON.stringify({ cardId: id, frame, nativePixels, polls, lastSnapshot }, null, 2) + '\n');
    throw new Error(`Safari card ${id} frame ${frame} did not become ready. Last snapshot: ${JSON.stringify(lastSnapshot)}. Diagnostic: ${diagnosticPath}`);
  };
  const safariAction = async (expression, id, frame, predicate = () => true) => {
    const actionId = randomUUID();
    await safari.evaluate(`if(!window.miNoteCaptureComparison)throw new Error('Capture tab changed');window.__comparisonAsyncError=null;window.__comparisonCompletedAction=null;void (async()=>(${expression}))().then(()=>{window.__comparisonCompletedAction=${JSON.stringify(actionId)}},error=>{window.__comparisonAsyncError=error.message});return true;`);
    return safariWait(id, frame, true, state => state.completedAction === actionId && predicate(state));
  };
  const settleDisplayedImage = async id => safariAction(`(async()=>{
    const api=window.miNoteCaptureComparison;
    api.state.paintReady=false;
    const image=document.querySelector('.drif-effect-card__front img');
    if(!image)throw new Error('Displayed card image is unavailable');
    await image.decode();
    await new Promise(resolve=>setTimeout(resolve,500));
    return api.setFrame(0);
  })()`, id, 0);
  const remountCard = async (id, initial, reason) => {
    await focusCaptureSafari();
    const current = await safariSnapshot();
    await safariWait(current.cardId, current.frame, true);
    await safariAction('window.miNoteCaptureComparison.setScrollPixels(0,0)', current.cardId, current.frame,
      state => state.scrollPixels.x === 0 && state.scrollPixels.y === 0);
    const other = id === catalogCount() ? 1 : catalogCount();
    const alternate = await safariAction(`window.miNoteCaptureComparison.setCard(${other})`, other, 0,
      state => state.generation > current.generation);
    await settleDisplayedImage(other);
    await safariAction(`window.miNoteCaptureComparison.setCard(${id})`, id, 0,
      state => state.generation > alternate.generation);
    let mounted = await settleDisplayedImage(id);
    if (options.nft2Tilt) {
      mounted = await safariAction(`(async()=>{
        for(let frame=1;frame<${preset.frames};frame++)await window.miNoteCaptureComparison.setFrame(frame);
        return window.miNoteCaptureComparison.setFrame(0);
      })()`, id, 0);
    }
    assertSnapshot(mounted, id, 0, initial || undefined, { x: 0, y: 0 });
    console.log(`Safari ${id}c: remounted at capture scale ${captureScale} after ${reason}`);
    return mounted;
  };
  const safariScreenshot = async ({ tab, id, frame, row, col, scroll, file, initial, expectedDimensions }) => {
    if (existsSync(file)) throw new Error(`Capture output already exists: ${file}`);
    let actual;
    const recoveryDeadline = Date.now() + nativeRecoveryMilliseconds;
    let attempt = 0;
    let lastRecoveryLog = 0;
    while (Date.now() < recoveryDeadline) {
      attempt += 1;
      checkActive();
      if (attempt > 1 && Date.now() - lastRecoveryLog >= 5000) {
        console.log(`Recovering Safari ${id}c frame ${frame} tile ${row},${col}: reselect owned tab; ${Math.ceil((recoveryDeadline - Date.now()) / 1000)} seconds remain`);
        lastRecoveryLog = Date.now();
      }
      await safari.call('switch_tab', tab);
      if (attempt > 1) await delay(300);
      if (attempt > 1) await remountCard(id, initial, 'rejected native PNG header');
      const pose = await safariAction(`window.miNoteCaptureComparison.setFrame(${frame})`, id, frame);
      const captureScroll = options.singleViewportCapture ? singleViewportScroll(pose, expectedDimensions) : scroll;
      const snapshot = await safariAction(`window.miNoteCaptureComparison.setScrollPixels(${captureScroll.x},${captureScroll.y})`, id, frame,
        state => Math.abs(state.scrollPixels.x - captureScroll.x) <= 0.075 && Math.abs(state.scrollPixels.y - captureScroll.y) <= 0.075);
      assertSnapshot(snapshot, id, frame, initial, captureScroll);
      const pending = join(cache, 'capture-attempts', `${id}c-${frame}-${row}-${col}-${attempt}-${randomUUID()}.png`);
      await safari.call('screenshot', { full_page: false, savePath: pending });
      try { actual = readPngDimensions(pending); } catch (error) { actual = { error: error.message }; }
      if (actual.width === expectedDimensions.width && actual.height === expectedDimensions.height) {
        renameSync(pending, file);
        return { snapshot, screenshotDimensions: actual, captureAttempts: attempt };
      }
      appendFileSync(join(cache, 'metadata', `${id}c-retries.jsonl`), JSON.stringify({ frame, row, col, attempt, expectedDimensions, actual, rejected: pending, snapshot }) + '\n');
      if (attempt === 1) console.error(`Safari ${id}c frame ${frame}: rejected screenshot ${JSON.stringify(actual)}, expected ${expectedDimensions.width}x${expectedDimensions.height}. Waiting up to 120 seconds for window overview/minimization to end.`);
    }
    throw new Error(`Native Safari screenshot dimensions changed: ${JSON.stringify(actual)}. Exit window overview/Mission Control and unminimize Safari before starting a fresh run. Rejected evidence is preserved in ${join(cache, 'capture-attempts')}.`);
  };
  const captureJoinedFrame = async ({ tab, id, frame, label, file, initial, grid, screenshotDimensions }) => {
    const captureRunId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    for (let attempt = 1; attempt <= stitchAttempts; attempt += 1) {
      const tileDirectory = join(cache, 'tiles', `${id}c`, label, `run-${captureRunId}`, `attempt-${attempt}`);
      mkdirSync(tileDirectory, { recursive: true });
      const records = [];
      for (let row = 0; row < grid.ys.length; row += 1) for (let col = 0; col < grid.xs.length; col += 1) {
        const tileFile = join(tileDirectory, `${row}-${col}.png`);
        const captured = await safariScreenshot({ tab, id, frame, row, col, file: tileFile, initial,
          scroll: { x: grid.xs[col], y: grid.ys[row] }, expectedDimensions: screenshotDimensions });
        if (!nativeIcc) {
          const inspected = await helper(['inspect', tileFile]);
          if (!inspected.icc) throw new Error('Native Safari screenshot is missing its ICC profile');
          nativeIcc = inspected.icc.sha256;
        }
        records.push({ path: tileFile, sha256: hash(tileFile), row, col,
          originX: physicalInteger(-captured.snapshot.stageRect.x * captured.snapshot.dpr, 'tile originX'),
          originY: physicalInteger(-captured.snapshot.stageRect.y * captured.snapshot.dpr, 'tile originY'),
          viewportWidth: screenshotDimensions.width, viewportHeight: screenshotDimensions.height,
          iccSha256: nativeIcc, captureAttempts: captured.captureAttempts, snapshot: captured.snapshot });
      }
      const metadataPath = join(cache, 'metadata', `${id}c-${label}-tiles-${captureRunId}-${attempt}.json`);
      const reference = options.singleViewportCapture ? knownStaticReference() : null;
      if (options.singleViewportCapture && !reference) throw new Error('Single-viewport capture requires a verified native background reference.');
      writeFileSync(metadataPath, JSON.stringify({ id, frame, profile: profile.id, captureScale, width: capturedSize, height: capturedSize,
        ...(reference ? { singleViewportCapture: true, backgroundReference: {
          path: reference.path, sha256: reference.sha256, excludedBounds: staticBounds(initial),
        } } : {}),
        ...(options.landscapeBlackCapture ? { landscapeViewportCapture: true } : {}), captureRotationDegrees: profile.rotationDegrees, backgroundRgb: [0, 0, 0], shadows: false,
        columns: grid.xs.length, rows: grid.ys.length, tiles: records }, null, 2) + '\n', { flag: 'wx' });
      try {
        const stitched = await helper(['stitch', '--metadata', metadataPath, '--output', file,
          '--delivery-size', String(deliverySize), '--delivery-spaces', deliverySpaces.join(',')]);
        if (!stitched.passed || stitched.icc?.sha256 !== nativeIcc) throw new Error('Joined frame ICC or seam validation failed.');
        const staticCheck = await checkStatic([file], initial, `${id}-${label}-${attempt}`);
        if (staticCheck && !staticCheck.passed) {
          const rejectedPath = join(cache, 'capture-attempts', `${id}c-${label}-static-${captureRunId}-${attempt}.png`);
          renameSync(file, rejectedPath);
          writeFileSync(join(cache, 'metadata', `${id}c-${label}-static-rejected-${captureRunId}-${attempt}.json`),
            JSON.stringify({ rejectedPath, stitched, staticCheck }, null, 2) + '\n', { flag: 'wx' });
          throw new Error(`Static exterior QA failed: ${JSON.stringify(staticCheck)}`);
        }
        if (staticCheck) stitched.staticExterior = staticCheck;
        const stitchReport = join(cache, 'metadata', `${id}c-${label}-stitch-${captureRunId}.json`);
        writeFileSync(stitchReport, JSON.stringify(stitched, null, 2) + '\n', { flag: 'wx' });
        return { stitched, tiles: records, snapshot: records[0].snapshot, stitchReport };
      } catch (error) {
        if (!/Tile overlap\/seam QA failed|Static exterior QA failed/.test(error.message) || attempt === stitchAttempts) throw error;
        writeFileSync(join(cache, 'metadata', `${id}c-${label}-stitch-rejected-${captureRunId}-${attempt}.json`), JSON.stringify({ error: error.message, metadata: metadataPath }) + '\n');
        console.log(`Safari ${id}c frame ${frame}: retrying complete tile set after failed pixel QA (${attempt}/${stitchAttempts})`);
        await remountCard(id, initial, 'failed tile-set pixel QA');
      }
    }
    throw new Error('Native frame did not stitch.');
  };
  const captureSafari = async ids => {
    for (const id of ids) {
      const captureRunId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      checkActive();
      assertSources();
      if (captures.has(`${id}c`)) {
        console.log(`Reusing completed native capture ${id}c`);
        continue;
      }
      const tab = await safari.createTab(`http://localhost:${options.port}${harnessPath}?id=${id}${options.nft2Tilt ? '&motion=nft2' : ''}${motionLoop ? `&loop=${encodeURIComponent(motionLoop.id)}` : ''}`);
      if (!safariAuxiliary) safariAuxiliary = await safari.createTab('about:blank');
      try {
        await safari.call('switch_tab', tab);
        await safari.call('set_viewport_size', { width: 1664, height: options.singleViewportCapture ? 1260 : 1060 });
        await focusCaptureSafari();
        await delay(300);
        await safariWait(id, 0, false);
        const viewportOptions = { nativePixels: true, gutterPixels, captureScale,
          rotationDegrees: profile.rotationDegrees, background: '#000000', shadowEnabled: false };
        await safariAction(`window.miNoteCaptureComparison.configureViewport(${JSON.stringify(viewportOptions)})`, id, 0,
          state => state.captureScale === captureScale && state.gutterPixels === gutterPixels);
        const initial = await remountCard(id, null, 'initial capture preparation');
        assertSnapshot(initial, id, 0);
        const screenshotDimensions = {
          width: physicalInteger(initial.viewport.width * initial.dpr, 'viewport width'),
          height: physicalInteger(initial.viewport.height * initial.dpr, 'viewport height'),
        };
        const grid = options.singleViewportCapture ? { xs: [0], ys: [0] } : {
          xs: axisTiles(capturedSize, screenshotDimensions.width, physicalInteger(initial.documentPixels.width, 'document width'), nativeScrollQuantum(captureScale, initial.dpr)),
          ys: axisTiles(capturedSize, screenshotDimensions.height, physicalInteger(initial.documentPixels.height, 'document height'), nativeScrollQuantum(captureScale, initial.dpr)),
        };
        assertProfileGrid(profile, grid);
        if (options.singleViewportCapture) singleViewportScroll(initial, screenshotDimensions);
        const previousGeometry = savedGeometry.get(id);
        if (previousGeometry) {
          if (JSON.stringify(previousGeometry.grid) !== JSON.stringify(grid)
            || JSON.stringify(previousGeometry.screenshotDimensions) !== JSON.stringify(screenshotDimensions)
            || previousGeometry.initial.userAgent !== initial.userAgent) throw new Error(`Cannot resume card ${id}: browser, viewport, or tile grid changed.`);
          assertSnapshot(initial, id, 0, previousGeometry.initial, { x: 0, y: 0 });
        }
        console.log(`Safari ${id}c: ${capturedSize}x${capturedSize}, ${grid.xs.length}x${grid.ys.length} tiles in ${screenshotDimensions.width}x${screenshotDimensions.height} viewport`);
        const raw = join(cache, 'raw', `${id}c`);
        let before = manifest.nativeProofs[id]?.before?.path || join(cache, 'proofs', `${id}c-before.png`);
        const baseAfter = join(cache, 'proofs', `${id}c-after.png`);
        const after = existsSync(baseAfter) ? join(cache, 'proofs', `${id}c-after-${captureRunId}.png`) : baseAfter;
        const capture = (frame, label, file) => captureJoinedFrame({ tab, id, frame, label, file, initial, grid, screenshotDimensions });
        manifest.nativeProofs[id] ||= {};
        let first;
        const newRestBaseline = !existsSync(before);
        {
          manifest.nativeProofs[id].captureWarmup ||= [];
          await warmNativeCapture(async (frame, index) => {
            const label = `raster-warmup-${index}-${captureRunId}`;
            const path = join(cache, 'proofs', `${id}c-${label}.png`);
            const warmed = await capture(frame, label, path);
            manifest.nativeProofs[id].captureWarmup.push({ frame, path, sha256: hash(path),
              stitchReport: warmed.stitchReport, stitchReportSha256: hash(warmed.stitchReport) });
          });
          saveManifest();
          console.log(`Card ${id}: warmed native capture compositing through the complete tilt cycle`);
        }
        if (options.nft2Tilt && savedFrames.get(id).size === 0) {
          let previous;
          let settled = false;
          manifest.nativeProofs[id].calibrations ||= [];
          for (let attempt = 1; attempt <= 8; attempt += 1) {
            const proofId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
            const path = join(cache, 'proofs', `${id}c-resume-${proofId}.png`);
            first = await capture(0, `resume-${proofId}`, path);
            const proof = { path, sha256: hash(path), stitchReport: first.stitchReport, stitchReportSha256: hash(first.stitchReport) };
            manifest.nativeProofs[id].calibrations.push(proof);
            if (previous) {
              try {
                const repeat = JSON.parse(await run(options.python, ['-c', repeatCheck, JSON.stringify([previous.path, path]), String(capturedSize)]));
                manifest.nativeProofs[id].initialCalibration = { previousBefore: manifest.nativeProofs[id].before || null,
                  afterFullOrbitWarmup: true, independentRepeat: proof, repeat };
                manifest.nativeProofs[id].before = previous;
                before = previous.path;
                settled = true;
                break;
              } catch (error) {
                if (!/failed \(2\)/.test(error.message)) throw error;
              }
            }
            previous = proof;
          }
          if (!settled) throw new Error(`Native rest reference mismatch: card ${id} did not settle after the complete tilt warmup.`);
          if (!knownStaticReference()) staticReference = { id, path: before, sha256: hash(before) };
          console.log(`Card ${id}: calibrated two exact cycle-start proofs after the complete tilt warmup`);
        } else if (existsSync(before)) {
          await safariAction('window.miNoteCaptureComparison.setFrame(1)', id, 1);
          await safariAction('window.miNoteCaptureComparison.setFrame(0)', id, 0);
          let matchingProofs = 0;
          manifest.nativeProofs[id].resumes ||= [];
          for (let proofAttempt = 1; proofAttempt <= 8; proofAttempt += 1) {
            const proofId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
            const resumeProof = join(cache, 'proofs', `${id}c-resume-${proofId}.png`);
            first = await capture(0, `resume-${proofId}`, resumeProof);
            const originals = [before];
            if (savedFrames.get(id).has(0)) originals.push(join(raw, '0000.png'));
            originals.push(resumeProof);
            let repeat;
            try {
              repeat = JSON.parse(await run(options.python, ['-c', repeatCheck, JSON.stringify(originals), String(capturedSize)]));
              matchingProofs += 1;
            } catch (error) {
              if (!/failed \(2\)/.test(error.message)) throw error;
              matchingProofs = 0;
              repeat = { matched: false, error: error.message };
            }
            const reportPath = join(cache, 'metadata', `${id}c-resume-${proofId}-repeat.json`);
            writeFileSync(reportPath, JSON.stringify(repeat, null, 2) + '\n', { flag: 'wx' });
            manifest.nativeProofs[id].resumes.push({ captureRunId, proofId, path: resumeProof, sha256: hash(resumeProof),
              stitchReport: first.stitchReport, repeat: reportPath, matched: matchingProofs > 0 });
            if (matchingProofs === 2) break;
            console.log(`Card ${id}: rest settling check ${proofAttempt}/8; ${matchingProofs} consecutive exact matches`);
          }
          if (matchingProofs !== 2) throw new Error(`Native rest reference mismatch: card ${id} did not settle to two consecutive exact captures.`);
          console.log(`Card ${id}: two fresh rest proofs match original pixels and ICC; retaining ${savedFrames.get(id).size} native frames`);
        } else {
          first = await capture(0, 'before', before);
          manifest.nativeProofs[id].before = { path: before, sha256: hash(before), stitchReport: first.stitchReport, stitchReportSha256: hash(first.stitchReport) };
        }
        if (newRestBaseline && !options.nft2Tilt) {
          if (!knownStaticReference()) staticReference = { id, path: before, sha256: hash(before) };
          await remountCard(id, initial, 'initial static reference calibration');
          const controlPath = join(cache, 'proofs', `${id}c-baseline-control-${captureRunId}.png`);
          await capture(0, `baseline-control-${captureRunId}`, controlPath);
          const control = JSON.parse(await run(options.python, ['-c', repeatCheck, JSON.stringify([before, controlPath]), String(capturedSize)]));
          writeFileSync(join(cache, 'metadata', `${id}c-baseline-control-${captureRunId}.json`), JSON.stringify(control, null, 2) + '\n', { flag: 'wx' });
        }
        manifest.staticReference = knownStaticReference();
        const profileSamples = [{ path: before, icc: first.stitched.icc }];
        saveManifest();
        for (let frame = 0; frame < preset.frames; frame += 1) {
          checkActive();
          if (savedFrames.get(id).has(frame)) continue;
          const label = String(frame).padStart(4, '0');
          const file = join(raw, `${label}.png`);
          const captured = await capture(frame, label, file);
          const frameRecord = { id, frame, path: file, sha256: hash(file), stitchReport: captured.stitchReport,
            stitchReportSha256: hash(captured.stitchReport), tileMetadata: captured.stitched.metadata, iccSha256: captured.stitched.icc.sha256 };
          savedFrames.get(id).set(frame, frameRecord);
          manifest.nativeFrames[`${id}:${frame}`] = frameRecord;
          appendFileSync(join(cache, 'metadata', `${id}c.jsonl`), JSON.stringify({ frame, ...captured.snapshot,
            tileMetadata: captured.stitched.metadata, stitchReport: captured.stitchReport, captureRunId }) + '\n');
          saveManifest();
          if (frame % profileSampleInterval === 0 || frame === preset.frames - 1) profileSamples.push({ path: file, icc: captured.stitched.icc });
          if ((frame + 1) % 24 === 0) console.log(`Safari ${id}c: ${frame + 1}/${preset.frames} joined frames`);
        }
        {
          manifest.nativeProofs[id].afterCalibrations ||= [];
          let matchingProofs = 0;
          for (let attempt = 1; attempt <= 8; attempt += 1) {
            const label = `after-calibration-${captureRunId}-${attempt}`;
            const path = join(cache, 'proofs', `${id}c-${label}.png`);
            const control = await capture(0, label, path);
            let repeat;
            try {
              repeat = JSON.parse(await run(options.python, ['-c', repeatCheck,
                JSON.stringify([before, join(raw, '0000.png'), path]), String(capturedSize)]));
              matchingProofs += 1;
            } catch (error) {
              if (!/failed \(2\)/.test(error.message)) throw error;
              matchingProofs = 0;
              repeat = { matched: false, error: error.message };
            }
            manifest.nativeProofs[id].afterCalibrations.push({ path, sha256: hash(path),
              stitchReport: control.stitchReport, stitchReportSha256: hash(control.stitchReport), repeat, matched: matchingProofs > 0 });
            saveManifest();
            if (matchingProofs === 2) break;
          }
          if (matchingProofs !== 2) throw new Error(`Native rest reference mismatch: card ${id} did not restore two consecutive exact captures.`);
        }
        const restored = await capture(0, 'after', after);
        manifest.nativeProofs[id].after = { path: after, sha256: hash(after), stitchReport: restored.stitchReport, stitchReportSha256: hash(restored.stitchReport) };
        profileSamples.push({ path: after, icc: restored.stitched.icc });
        const repeat = JSON.parse(await run(options.python, ['-c', repeatCheck, JSON.stringify([before, join(raw, '0000.png'), after]), String(capturedSize)]));
        writeFileSync(join(cache, 'metadata', `${id}c-repeat-${captureRunId}.json`), JSON.stringify(repeat, null, 2) + '\n', { flag: 'wx' });
        assertSources();
        captures.set(`${id}c`, { id, method: 'c', raw, crop: [0, 0, capturedSize, capturedSize], captureScale,
          initial, restored: restored.snapshot, screenshotDimensions, grid, profileSamples, repeat });
        manifest.captures = [...captures.values()];
        saveManifest();
        console.log(`Captured ${id}c: ${preset.frames} high-resolution frames`);
      } finally {
        try {
          await safari.call('close_tab', tab, 5000);
          safari.tabs = safari.tabs.filter(owned => owned.handle !== tab.handle);
        } catch {}
      }
    }
  };
  const processCard = async id => {
    const stage = name => {
      if (!options.pipelineProcessing) return;
      manifest.processing ||= {};
      manifest.processing[id] = { stage: name, at: new Date().toISOString() };
      saveManifest();
    };
    stage('quality');
    await ensureQuality(id);
    stage('encoding');
    await encodeCard(id);
    stage('compacting');
    await compactCard(id);
    stage('complete');
  };
  const drainProcessing = async () => {
    if (pendingProcessing) {
      await pendingProcessing;
      pendingProcessing = undefined;
    }
    checkActive();
  };
  const startProcessing = id => {
    pendingProcessing = processCard(id).catch(error => {
      aborted ||= error;
      stopProcessingChildren();
    });
  };
  try {
    await seedStaticReference();
    if (options.auditNative) {
      const audit = await auditNative(true);
      if (!audit.passed) process.exitCode = 1;
      return;
    }
    if (options.resume) await validateResume();
    if (options.checkResume) return;
    if (options.methods.some(method => method !== 'a')) for (const id of options.ids) {
      checkActive();
      assertSources();
      if (!captures.has(`${id}c`)) {
        const available = statfsSync(cache);
        if (pendingProcessing && available.bavail * available.bsize < 12 * 1024 ** 3) await drainProcessing();
        const capacity = captureCapacity();
        if (capacity.availableBytes < 12 * 1024 ** 3) throw new Error('At least 12 GiB available capacity is required before capturing another card.');
        if (motionLoop) {
          manifest.diskChecks ||= [];
          manifest.diskChecks.push({ id, at: new Date().toISOString(), ...capacity });
          saveManifest();
        }
        if (!server) {
          server = await createServer(viteOptions(options.port));
          await server.listen();
        }
        if (!safari) await startCaptureSafari();
        manifest.status = 'capturing-safari';
        saveManifest();
        for (let attempt = 1; ; attempt += 1) {
          try {
            await captureSafari([id]);
            break;
          } catch (error) {
            if (attempt >= 10 || !/Static exterior QA failed|Native rest reference mismatch|owned capture process has ended|owned Safari automation process changed|Safari MCP exited/.test(error.message)) throw error;
            console.log(`Safari ${id}c: restarting the owned capture session (${attempt}/10)`);
            await shutdownCapture();
            await delay(500);
            await startCaptureSafari();
          }
        }
      }
      if (options.pipelineProcessing) {
        await drainProcessing();
        startProcessing(id);
      } else await processCard(id);
    }
    await drainProcessing();
    await shutdownCapture();
    checkActive();
    assertSources();
    if (manifest.videos.length !== options.ids.length * options.methods.length) throw new Error('Comparison is incomplete');
    manifest.status = 'complete';
    manifest.finishedAt = new Date().toISOString();
    saveManifest();
    console.log(`Comparison videos: ${output}`);
  } catch (error) {
    aborted ||= error;
    stopProcessingChildren();
    if (pendingProcessing) await pendingProcessing;
    manifest.status = 'failed';
    manifest.error = aborted.message;
    if (!options.checkResume) saveManifest();
    throw aborted;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await shutdownCapture();
    await server?.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
