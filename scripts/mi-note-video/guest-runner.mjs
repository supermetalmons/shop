import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNativeBackend, nativeBackend } from './native-config.mjs';
import { nativeFramesSha256 } from './capture-release.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(directory, 'contract.json'), 'utf8'));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const within = (path, parent) => path === parent || path.startsWith(parent + sep);
const requireValue = (condition, message) => { if (!condition) throw Error(message); };

export function validateJob(job) {
  requireValue(job?.version === 1 && /^[a-f0-9-]{36}$/i.test(job.jobId || ''), 'Invalid job identity.');
  requireValue(/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.name || '') && /^[a-f0-9]{64}$/.test(job.sourceId || ''), 'Invalid job name or source identity.');
  requireValue(Number.isSafeInteger(job.catalogCount) && job.catalogCount > 0 && Array.isArray(job.ids) && job.ids.length > 0 && job.ids.length <= job.catalogCount
    && job.ids.every((id, index) => Number.isInteger(id) && id >= 1 && id <= job.catalogCount && (index === 0 || id > job.ids[index - 1])), 'Card IDs must be distinct, sorted integers from the pinned catalog.');
  requireValue(Object.hasOwn(contract.profiles, job.profile) && contract.motions.includes(job.motion), 'Unsupported profile or motion.');
  for (const key of ['root', 'sourceRoot', 'python']) requireValue(typeof job[key] === 'string' && isAbsolute(job[key]) && resolve(job[key]) === job[key], `Invalid ${key}.`);
  requireValue(!within(job.root, job.sourceRoot) && !within(job.sourceRoot, job.root), 'Job data and rendering source must not overlap.');
  nativeBackend(job.backend);
  if (Object.hasOwn(job, 'pipeline')) requireValue(job.backend === 'host' && job.ids.length === 1
    && job.pipeline?.version === 1 && job.pipeline.maxUnfinished === 2
    && /^[a-f0-9-]{36}$/i.test(job.pipeline.catalogJobId || '')
    && JSON.stringify(Object.keys(job.pipeline).sort()) === JSON.stringify(['catalogJobId', 'maxUnfinished', 'version']), 'Invalid host pipeline execution contract.');
  return job;
}

export function assertJobBackend(job, environmentBackend = process.env.MI_NOTE_RENDER_BACKEND, system = {}) {
  const backend = nativeBackend(job.backend);
  requireValue(nativeBackend(environmentBackend) === backend, 'Rendering backend environment differs from the pinned job backend.');
  return assertNativeBackend(backend, system);
}

export function assertJobSources(job) {
  const contractPath = join(job.sourceRoot, 'scripts/mi-note-video/contract.json');
  requireValue(hash(regular(contractPath)) === job.contractSha256, 'Job contract checksum changed.');
  const snapshot = read(regular(join(job.sourceRoot, 'source-snapshot.json')));
  requireValue(snapshot.version === 1 && snapshot.sourceId === job.sourceId && snapshot.files && !Array.isArray(snapshot.files), 'Job source snapshot identity changed.');
  const ordered = Object.fromEntries(Object.keys(snapshot.files).sort().map(name => [name, snapshot.files[name]]));
  const canonical = JSON.stringify(ordered).replace(/[\u0080-\uffff]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'));
  requireValue(createHash('sha256').update(canonical).digest('hex') === job.sourceId, 'Job source inventory checksum changed.');
  for (const [name, expected] of Object.entries(ordered)) {
    const path = resolve(job.sourceRoot, name);
    requireValue(!isAbsolute(name) && !name.split(/[\\/]/).includes('..') && within(path, job.sourceRoot)
      && /^[a-f0-9]{64}$/.test(expected) && hash(regular(path)) === expected, `Job source changed: ${name}`);
  }
  requireValue(ordered['scripts/mi-note-video/contract.json'] === job.contractSha256, 'Source snapshot does not bind the selected contract.');
  const catalog = readFileSync(regular(join(job.sourceRoot, 'src/lib/miNoteCards.ts')), 'utf8').match(/export const MI_NOTE_CARD_COUNT = (\d+);/);
  requireValue(catalog && Number(catalog[1]) === job.catalogCount, 'Job catalog size differs from its source snapshot.');
  if (job.pipeline) {
    const capability = read(regular(join(job.sourceRoot, 'scripts/mi-note-video/pipeline.json')));
    const expected = { version: 1, maxUnfinished: 2, captureRelease: 1, streamProcessing: 1 };
    requireValue(Object.keys(capability).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => capability[key] === value), 'Pinned source does not support the pipeline contract.');
  }
}

export function assertRuntimeMatches(expected, actual) {
  const versionKeys = [...Object.keys(contract.runtime), 'safari', 'macos'].sort();
  const executableKeys = ['ffmpeg', 'ffprobe', 'node', 'python'];
  for (const runtime of [expected, actual]) {
    requireValue(runtime && JSON.stringify(Object.keys(runtime.versions || {}).sort()) === JSON.stringify(versionKeys)
      && JSON.stringify(Object.keys(runtime.executableSha256 || {}).sort()) === JSON.stringify(executableKeys), 'Incomplete pinned runtime identity.');
  }
  for (const key of versionKeys) {
    requireValue(typeof expected.versions[key] === 'string' && expected.versions[key].length > 0
      && (!Object.hasOwn(contract.runtime, key) || expected.versions[key] === contract.runtime[key]), `Pinned runtime ${key} differs from the rendering contract.`);
    requireValue(actual.versions[key] === expected.versions[key], `Runtime ${key} changed: expected ${expected.versions[key]}, found ${actual.versions[key]}.`);
  }
  for (const key of executableKeys) requireValue(/^[a-f0-9]{64}$/.test(expected.executableSha256[key] || '')
    && actual.executableSha256[key] === expected.executableSha256[key], `Runtime ${key} executable checksum changed.`);
  return actual;
}

export function assertJobRuntime(job) {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
  const paths = { node: process.execPath, python: job.python };
  for (const name of ['ffmpeg', 'ffprobe']) {
    paths[name] = process.env[`MI_NOTE_${name.toUpperCase()}`] || run('/usr/bin/which', [name]);
    requireValue(isAbsolute(paths[name]) && !paths[name].includes('\n'), `Runtime ${name} executable was not found in PATH.`);
  }
  const versions = JSON.parse(run(job.python, ['-c', 'import json,platform,numpy;from PIL import Image,features;print(json.dumps({"python":platform.python_version(),"pillow":Image.__version__,"numpy":numpy.__version__,"littlecms":features.version("littlecms2")}))']));
  versions.node = process.version.replace(/^v/, '');
  for (const name of ['ffmpeg', 'ffprobe']) versions[name] = run(paths[name], ['-version']).split('\n')[0].split(/\s+/)[2];
  versions.safari = run('/usr/bin/safaridriver', ['--version']);
  versions.macos = run('/usr/bin/sw_vers', ['-productVersion']);
  const executableSha256 = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, hash(path)]));
  return assertRuntimeMatches(job.runtime, { versions, executableSha256 });
}

export function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  syncPath(temporary);
  renameSync(temporary, path);
  syncPath(dirname(path));
}

function syncPath(path) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function ackMatches(ack, ready) {
  return ack?.version === 1 && ['jobId', 'sourceId', 'cardId', 'verificationId'].every(key => ack[key] === ready[key])
    && ack.videoSha256 === ready.video.sha256 && ack.evidenceSha256 === ready.evidence.sha256;
}

function regular(path) {
  requireValue(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path && lstatSync(path).isFile(), `Expected a regular file: ${path}`);
  return path;
}

function filesUnder(path) {
  requireValue(realpathSync(path) === path && lstatSync(path).isDirectory(), `Expected an owned directory: ${path}`);
  return readdirSync(path, { withFileTypes: true }).flatMap(item => {
    const child = join(path, item.name);
    if (item.isDirectory()) return filesUnder(child);
    requireValue(item.isFile(), `Unexpected non-file evidence: ${child}`);
    return [regular(child)];
  });
}

function validateVideo(job, id, unit, manifest) {
  const profile = contract.profiles[job.profile];
  requireValue(nativeBackend(manifest.backend) === nativeBackend(job.backend), 'Unit capture backend differs from the pinned job backend.');
  requireValue(manifest.status === 'complete' && manifest.profile === job.profile && manifest.motion === job.motion
    && JSON.stringify(manifest.ids) === JSON.stringify([id]) && manifest.videos.length === 1, 'Unit render identity is incomplete.');
  const video = manifest.videos[0];
  requireValue(video.id === id && video.method === 'd' && video.output === join(unit, 'output', `${id}.mp4`)
    && video.fullyDecoded === true && video.width === profile.deliverySize && video.height === profile.deliverySize, 'Unexpected unit video.');
  for (const key of ['frames', 'frameRate', 'duration', 'space', 'encoder', 'crf', 'preset', 'keyframeInterval']) requireValue(video[key] === contract.video[key], `Video ${key} changed.`);
  requireValue(/^[a-f0-9]{64}$/.test(video.sha256) && lstatSync(regular(video.output)).size === video.bytes && hash(video.output) === video.sha256, 'Video checksum changed.');
  const compacted = manifest.compacted?.[id];
  requireValue(compacted?.status === 'complete' && compacted.videos?.d === video.sha256, 'Unit native evidence is not compacted.');
  const entry = manifest.qualityReports?.[id];
  requireValue(entry && within(entry.path, join(unit, 'capture')) && hash(regular(entry.path)) === entry.sha256, 'Unit quality provenance changed.');
  const quality = read(entry.path);
  requireValue(quality.passed === true && quality.restRepeatExact === true && quality.cardId === id && quality.frameCount === contract.video.frames
    && quality.frames.length === contract.video.frames && quality.frames.every((frame, index) => frame.frame === index && frame.sha256 === manifest.nativeFrames?.[`${id}:${index}`]?.sha256), 'Unit native quality audit is incomplete.');
  return video;
}

export function prepareReady(job, id, attempt) {
  assertJobRuntime(job);
  const unit = join(job.root, 'cards', String(id));
  const manifestPath = join(unit, 'output', '.render-manifest.json');
  const approvalPath = join(unit, 'preflight', 'approved.json');
  const manifest = read(regular(manifestPath));
  const approval = read(regular(approvalPath));
  requireValue(approval.status === 'passed' && nativeBackend(approval.identity.backend) === nativeBackend(job.backend)
    && approval.identity.profile === job.profile && approval.identity.motion === job.motion
    && JSON.stringify(approval.identity.ids) === JSON.stringify([id]), 'Unit preflight identity changed.');
  requireValue(manifest.preflight?.path === approvalPath && manifest.preflight.sha256 === hash(approvalPath), 'Render is not bound to the unit preflight.');
  const video = validateVideo(job, id, unit, manifest);
  const auditPath = regular(join(unit, 'audit.json'));
  const audit = read(auditPath);
  requireValue(audit.passed === true && audit.jobId === job.jobId && audit.sourceId === job.sourceId && audit.cardId === id
    && audit.profile === job.profile && audit.motion === job.motion && audit.videoSha256 === video.sha256
    && audit.auditSourceSha256 === hash(regular(join(directory, 'audit.py'))), 'Independent unit audit is missing or differs from the video.');
  const files = new Set([regular(join(job.root, 'job.json')), manifestPath, approvalPath, auditPath]);
  if (job.pipeline) {
    requireValue(/^[a-f0-9]{64}$/.test(video.decodeCertificate?.sha256 || '')
      && audit.decodeCertificateSha256 === video.decodeCertificate.sha256
      && within(video.decodeCertificate.path || '', join(unit, 'output'))
      && hash(regular(video.decodeCertificate.path)) === video.decodeCertificate.sha256,
    'Pipeline video lacks an independently verified decode certificate.');
    files.add(regular(join(unit, 'capture-complete.json')));
  }
  for (const name of ['preflight', 'capture', 'output']) for (const path of filesUnder(join(unit, name))) {
    if (path === video.output) continue;
    if (name === 'capture') requireValue(!['raw', 'prepared', 'tiles'].includes(relative(join(unit, name), path).split(sep)[0]), 'Uncompacted working images remain.');
    files.add(path);
  }
  for (const hashes of [manifest.sourceHashes, approval.identity.sourceHashes]) {
    requireValue(hashes && Object.keys(hashes).length > 0, 'Rendering source hashes are missing.');
    for (const [name, expected] of Object.entries(hashes)) {
      const path = resolve(job.sourceRoot, name);
      requireValue(!isAbsolute(name) && within(path, job.sourceRoot) && path !== job.sourceRoot && hash(regular(path)) === expected, `Rendering source changed: ${name}`);
      files.add(path);
    }
  }
  const receipts = join(job.root, 'screenshot-transfers');
  if (existsSync(receipts)) for (const path of filesUnder(receipts)) {
    const receipt = read(path);
    if (within(receipt.destination || '', unit)) {
      requireValue(receipt.passed === true ? receipt.sourceSha256 === receipt.destinationSha256
        : receipt.passed === false && typeof receipt.error === 'string' && receipt.error.length > 0, 'Invalid screenshot transfer diagnostic.');
      files.add(path);
    }
  }
  const inventory = { version: 1, jobId: job.jobId, sourceId: job.sourceId, cardId: id,
    manifest: { path: manifestPath, sha256: hash(manifestPath) }, approval: { path: approvalPath, sha256: hash(approvalPath) },
    files: [...files].sort().map(path => ({ guestPath: path, archivePath: path.slice(1), bytes: lstatSync(path).size, sha256: hash(path) })) };
  const bytes = inventory.files.reduce((total, file) => total + file.bytes, 0);
  requireValue(bytes <= 8 * 1024 ** 3, 'Unit retained evidence exceeds 8 GiB.');
  const inventoryPath = join(unit, 'evidence-manifest.json');
  atomicJson(inventoryPath, inventory);
  return { version: 1, jobId: job.jobId, sourceId: job.sourceId, cardId: id, profile: job.profile, motion: job.motion,
    verificationId: attempt, requiresHostVerification: false, unitRoot: unit, video,
    audit: { path: auditPath, sha256: hash(auditPath) },
    evidence: { path: inventoryPath, sha256: hash(inventoryPath), files: inventory.files.length, bytes, archivePath: join(unit, 'transfer', 'evidence.tar') },
    readyAt: new Date().toISOString() };
}

export function preserveIncomplete(unit) {
  const paths = ['output', 'capture'].map(name => ({ name, source: join(unit, name) }));
  const journal = join(unit, 'initialization-recovery.json');
  if (!existsSync(journal) && (existsSync(join(unit, 'output', '.render-manifest.json')) || !paths.some(item => existsSync(item.source)))) return;
  requireValue(!existsSync(join(unit, 'output', '.render-manifest.json')), 'Initialization recovery conflicts with a saved manifest.');
  let recovery;
  if (existsSync(journal)) {
    recovery = read(journal);
    requireValue(/^[a-f0-9-]{36}$/.test(recovery.id || '') && recovery.directory === join(unit, 'incomplete', recovery.id), 'Invalid initialization recovery.');
    requireValue(recovery.entries?.length > 0 && recovery.entries.length <= 2 && new Set(recovery.entries.map(item => item.name)).size === recovery.entries.length
      && recovery.entries.every(item => paths.some(path => path.name === item.name && path.source === item.source) && item.destination === join(recovery.directory, item.name)), 'Invalid initialization recovery paths.');
  } else {
    const id = randomUUID();
    const target = join(unit, 'incomplete', id);
    mkdirSync(target, { recursive: true });
    recovery = { id, directory: target, entries: paths.filter(item => existsSync(item.source)).map(item => ({ ...item, destination: join(target, item.name) })) };
    atomicJson(journal, recovery);
  }
  for (const item of recovery.entries) {
    if (existsSync(item.source)) {
      requireValue(!existsSync(item.destination), 'Initialization recovery has conflicting copies.');
      renameSync(item.source, item.destination);
    } else requireValue(existsSync(item.destination), 'Initialization recovery is missing preserved data.');
  }
  renameSync(journal, join(recovery.directory, 'recovery.json'));
}

function processStart(pid) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}

function otherRunners() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && Number(match[1]) !== process.pid && match[2].includes('/scripts/mi-note-video/guest-runner.mjs --job ')
      && !match[2].startsWith('/usr/bin/caffeinate ') && !match[2].includes(' -e ') && !match[2].includes(' --eval ')
      ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

export function assertPipelinePeers(job, peers) {
  requireValue(peers.length === 0 || job.pipeline && peers.length < job.pipeline.maxUnfinished
    && peers.every(peer => peer.job?.pipeline?.catalogJobId === job.pipeline.catalogJobId
      && peer.job.pipeline.version === 1 && peer.job.pipeline.maxUnfinished === 2
      && peer.job.backend === 'host' && peer.job.sourceId === job.sourceId
      && peer.owner.jobId === peer.job.jobId && peer.owner.sourceId === peer.job.sourceId
      && peer.owner.pid === peer.pid && peer.owner.started === peer.started), 'Another rendering job is active outside this bounded pipeline.');
}

function assertCompatibleRunners(job) {
  const peers = otherRunners().map(peer => {
    const path = peer.command.split('/scripts/mi-note-video/guest-runner.mjs --job ')[1];
    const other = validateJob(read(regular(path)));
    const ownerPath = join(dirname(dirname(other.root)), 'execution-locks', other.jobId, 'owner.json');
    const owner = existsSync(ownerPath) ? read(regular(ownerPath)) : {};
    return { ...peer, job: other, owner, started: processStart(peer.pid) };
  });
  assertPipelinePeers(job, peers);
}

function acquireLock(job, attempt, path) {
  if (existsSync(path)) {
    let owner;
    try { owner = read(join(path, 'owner.json')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    let active = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && typeof owner.started === 'string') {
      try { active = processStart(owner.pid) === owner.started; } catch {}
    }
    requireValue(!active, 'Another rendering job owns this execution or capture lock.');
    renameSync(path, `${path}.stale-${randomUUID()}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  requireValue(realpathSync(dirname(path)) === dirname(path), 'Lock parent contains a symbolic link.');
  mkdirSync(path, { mode: 0o700 });
  const owner = { pid: process.pid, started: processStart(process.pid), attempt, jobId: job.jobId, sourceId: job.sourceId };
  atomicJson(join(path, 'owner.json'), owner);
  return { path, owner };
}

function releaseLock(lock) {
  const owner = read(regular(join(lock.path, 'owner.json')));
  requireValue(owner.pid === lock.owner.pid && owner.attempt === lock.owner.attempt && owner.started === lock.owner.started, 'Rendering lock ownership changed.');
  rmSync(lock.path, { recursive: true });
  syncPath(dirname(lock.path));
}

export function validateCaptureRelease(job, attempt, path, manifest, marker, safariProcesses = new Map()) {
  const unit = join(job.root, 'cards', String(job.ids[0]));
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  requireValue(job.pipeline && path === join(unit, 'capture-complete.json') && marker?.version === 1 && marker.status === 'capture-complete'
    && marker.jobId === job.jobId && marker.sourceId === job.sourceId && marker.attempt === attempt
    && marker.cardId === job.ids[0] && marker.profile === job.profile && marker.motion === job.motion
    && marker.backend === job.backend && marker.frameCount === contract.video.frames && marker.safariReleased === true
    && marker.ownerId === manifest.ownerId && typeof marker.runId === 'string' && marker.runId.length > 0,
  'Native capture release identity or ownership changed.');
  requireValue(marker.preflight?.path === join(unit, 'preflight', 'approved.json') && marker.preflight.sha256 === manifest.preflight?.sha256
    && marker.sourceHashesSha256 === digest(manifest.sourceHashes) && marker.nativeFramesSha256 === nativeFramesSha256(manifest.nativeFrames), 'Capture release provenance differs from the saved manifest.');
  for (let frame = 0; frame < contract.video.frames; frame += 1) {
    const native = manifest.nativeFrames?.[`${job.ids[0]}:${frame}`];
    requireValue(native?.frame === frame && native.id === job.ids[0] && /^[a-f0-9]{64}$/.test(native.sha256 || ''), 'Capture release is missing a committed native frame.');
  }
  const capture = manifest.captures?.find(item => item.id === job.ids[0] && item.method === 'c');
  requireValue(Object.keys(manifest.nativeFrames).length === contract.video.frames && capture?.repeat?.checks?.length > 0
    && capture.repeat.checks.every(check => check.equal === true && check.iccEqual === true), 'Capture release lacks exact final rest verification.');
  for (const label of ['before', 'after']) requireValue(marker[label]?.sha256 === manifest.nativeProofs?.[job.ids[0]]?.[label]?.sha256
    && /^[a-f0-9]{64}$/.test(marker[label]?.sha256 || ''), 'Capture release is missing exact native controls.');
  requireValue(Array.isArray(marker.captureWindows) && marker.captureWindows.length > 0
    && JSON.stringify(marker.captureWindows) === JSON.stringify(manifest.captureWindows)
    && marker.captureWindows.every(window => Number.isSafeInteger(window.pid) && typeof window.identity === 'string'
      && safariProcesses.get(window.pid) !== window.identity), 'The released capture still owns a live Safari process.');
  return marker;
}

export async function runQueue(job, { stage, waitForAck, saveStatus, attempt = randomUUID() }) {
  const status = { version: 1, jobId: job.jobId, sourceId: job.sourceId, name: job.name, profile: job.profile, motion: job.motion,
    ids: job.ids, attempt, pid: process.pid, status: 'starting', currentCard: null, completed: {}, startedAt: new Date().toISOString() };
  const save = () => saveStatus({ ...status, updatedAt: new Date().toISOString() });
  save();
  try {
    for (const id of job.ids) {
      const unit = join(job.root, 'cards', String(id));
      mkdirSync(unit, { recursive: true });
      const completedPath = join(unit, 'completed.json');
      const readyPath = join(unit, 'ready.json');
      status.currentCard = id;
      let ready;
      if (existsSync(completedPath)) {
        const completed = read(completedPath);
        requireValue(completed.jobId === job.jobId && completed.sourceId === job.sourceId && completed.cardId === id, 'Completed unit belongs to another job.');
        ready = { ...completed.ready, verificationId: attempt, requiresHostVerification: true };
      } else if (existsSync(readyPath)) {
        ready = { ...read(readyPath), verificationId: attempt };
        requireValue(ready.jobId === job.jobId && ready.sourceId === job.sourceId && ready.cardId === id, 'Ready unit belongs to another job.');
        requireValue(hash(regular(ready.video.output)) === ready.video.sha256 && hash(regular(ready.evidence.path)) === ready.evidence.sha256, 'Ready unit changed before collection.');
      } else {
        status.status = 'preflight'; save();
        const savedManifest = existsSync(join(unit, 'output', '.render-manifest.json'));
        await stage('preflight', 'preflight.mjs', ['--profile', job.profile, '--motion', job.motion, '--id', String(id), '--output', join(unit, 'preflight'), '--python', job.python,
          ...(savedManifest || existsSync(join(unit, 'preflight', 'approved.json')) ? ['--verify-resume'] : [])]);
        preserveIncomplete(unit);
        const args = ['--profile', job.profile, '--motion', job.motion, '--ids', String(id), '--output', join(unit, 'output'), '--cache', join(unit, 'capture'), '--preflight', join(unit, 'preflight', 'approved.json'), '--python', job.python];
        const resume = existsSync(join(unit, 'output', '.render-manifest.json'));
        if (resume) { status.status = 'checking-resume'; save(); await stage('checking-resume', 'capture.mjs', [...args, '--check-resume']); }
        status.status = 'rendering'; save();
        await stage('rendering', 'capture.mjs', [...args, ...(resume ? ['--resume'] : [])], release => {
          status.captureReleased = release;
          status.status = 'processing'; save();
        });
        if (!job.pipeline || resume) {
          status.status = 'verifying'; save();
          await stage('verifying', 'capture.mjs', [...args, '--check-resume']);
        }
        status.status = 'auditing'; save();
        await stage('auditing', 'audit.py', ['--job', join(job.root, 'job.json'), '--id', String(id), '--output', join(unit, 'audit.json')]);
        ready = prepareReady(job, id, attempt);
      }
      requireValue(ready.jobId === job.jobId && ready.sourceId === job.sourceId && ready.cardId === id
        && ready.unitRoot === unit && ready.video.output === join(unit, 'output', `${id}.mp4`)
        && ready.evidence.path === join(unit, 'evidence-manifest.json'), 'Saved unit paths or identity changed.');
      atomicJson(readyPath, ready);
      status.status = 'awaiting-collection'; save();
      const ack = await waitForAck(ready);
      requireValue(ackMatches(ack, ready), 'Host acknowledgment does not match the completed unit.');
      const completed = { version: 1, jobId: job.jobId, sourceId: job.sourceId, cardId: id, ready, ack,
        status: 'acknowledged', acknowledgedAt: new Date().toISOString() };
      atomicJson(completedPath, completed);
      requireValue(hash(regular(ready.evidence.path)) === ready.evidence.sha256, 'Evidence inventory changed before cleanup.');
      const receiptRoot = join(job.root, 'screenshot-transfers');
      const receipts = read(ready.evidence.path).files.filter(item => item.guestPath.startsWith(receiptRoot + sep));
      for (const receipt of receipts) if (existsSync(receipt.guestPath)) requireValue(hash(regular(receipt.guestPath)) === receipt.sha256, 'Screenshot receipt changed before cleanup.');
      for (const name of ['capture', 'preflight', 'output', 'transfer']) {
        const path = join(unit, name);
        if (existsSync(path)) {
          requireValue(realpathSync(path) === path && lstatSync(path).isDirectory(), 'Unit cleanup path is not an owned directory.');
          rmSync(path, { recursive: true });
        }
      }
      for (const receipt of receipts) if (existsSync(receipt.guestPath)) rmSync(receipt.guestPath);
      completed.status = 'complete';
      completed.cleanedAt = new Date().toISOString();
      atomicJson(completedPath, completed);
      status.completed[id] = { videoSha256: ready.video.sha256, evidenceSha256: ready.evidence.sha256, acknowledgedAt: completed.acknowledgedAt };
      status.status = 'unit-complete'; save();
    }
    status.currentCard = null;
    status.status = 'complete';
    status.finishedAt = new Date().toISOString();
    save();
    return status;
  } catch (error) {
    status.status = error.code === 'INTERRUPTED' ? 'interrupted' : 'failed';
    status.error = error.stack || String(error);
    status.finishedAt = new Date().toISOString();
    save();
    throw error;
  }
}

async function main() {
  requireValue(process.argv.length === 4 && process.argv[2] === '--job', 'Usage: guest-runner.mjs --job /absolute/job.json');
  const job = validateJob(read(regular(resolve(process.argv[3]))));
  requireValue(resolve(process.argv[3]) === join(job.root, 'job.json') && directory === join(job.sourceRoot, 'scripts/mi-note-video'), 'Runner or job configuration has the wrong source root.');
  assertJobSources(job);
  assertJobBackend(job);
  assertJobRuntime(job);
  requireValue(!process.env.MI_NOTE_JOB_ROOT || process.env.MI_NOTE_JOB_ROOT === job.root, 'Job environment differs from its configuration.');
  process.env.MI_NOTE_JOB_ROOT = job.root;
  mkdirSync(join(job.root, 'ack'), { recursive: true });
  const attempt = randomUUID();
  assertCompatibleRunners(job);
  const backendRoot = dirname(dirname(job.root));
  const executionLock = acquireLock(job, attempt, join(backendRoot, 'execution-locks', job.jobId));
  let captureLock;
  const statusPath = join(job.root, 'job-status.json');
  let child;
  let interrupted = false;
  const stopped = () => { const error = Error('Rendering interrupted; checkpoints preserved.'); error.code = 'INTERRUPTED'; return error; };
  const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (existsSync(statusPath)) {
      mkdirSync(join(job.root, 'history'), { recursive: true });
      renameSync(statusPath, join(job.root, 'history', `${Date.now()}-${attempt}.json`));
    }
    await runQueue(job, { attempt, saveStatus: value => atomicJson(statusPath, value),
      stage: async (name, target, args, onCaptureReleased) => {
        if (interrupted) throw stopped();
        if (name === 'preflight' && !captureLock) captureLock = acquireLock(job, attempt, join(backendRoot, 'render.lock'));
        assertJobRuntime(job);
        let stageError;
        let released = false;
        const code = await new Promise((resolveStage, reject) => {
          const command = target === 'audit.py' ? job.python : process.execPath;
          const invocation = target === 'audit.py' ? [join(directory, target), ...args] : [join(directory, 'entry.mjs'), target, ...args];
          const environment = { ...process.env };
          delete environment.MI_NOTE_CAPTURE_ATTEMPT;
          delete environment.MI_NOTE_ENCODER_LOCK;
          if (job.pipeline) {
            environment.MI_NOTE_ENCODER_LOCK = join(backendRoot, 'encoder.lock');
            if (name === 'rendering') environment.MI_NOTE_CAPTURE_ATTEMPT = attempt;
          }
          child = spawn(command, invocation, { cwd: job.sourceRoot, env: environment,
            stdio: job.pipeline && name === 'rendering' ? ['ignore', 'inherit', 'inherit', 'ipc'] : 'inherit' });
          if (job.pipeline && name === 'rendering') child.on('message', message => {
            try {
              requireValue(message?.type === 'capture-complete' && !released && captureLock, 'Unexpected or duplicate native capture release.');
              const path = regular(message.path);
              const marker = read(path);
              const manifest = read(regular(join(job.root, 'cards', String(job.ids[0]), 'output', '.render-manifest.json')));
              const safariProcesses = new Map(execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' }).split('\n')
                .filter(line => line.trim().endsWith('/Safari.app/Contents/MacOS/Safari -ApplePersistenceIgnoreStateQuietly YES --automation'))
                .map(line => [Number(line.trim().split(/\s+/)[0]), line.trim()]));
              validateCaptureRelease(job, attempt, path, manifest, marker, safariProcesses);
              requireValue(hash(regular(marker.preflight.path)) === marker.preflight.sha256, 'Released capture preflight checksum changed.');
              releaseLock(captureLock);
              captureLock = undefined;
              released = true;
              onCaptureReleased({ path, sha256: hash(path), attempt, releasedAt: new Date().toISOString() });
            } catch (error) {
              stageError ||= error;
              child?.kill('SIGTERM');
            }
          });
          child.once('error', reject);
          child.once('close', resolveStage);
        });
        child = undefined;
        if (interrupted) throw stopped();
        if (stageError) throw stageError;
        requireValue(code === 0, `${name} stopped with ${code}; checkpoints preserved.`);
        if (job.pipeline && name === 'rendering') requireValue(released, 'Native rendering ended without releasing its capture lease.');
      },
      waitForAck: async ready => {
        const path = join(job.root, 'ack', `${ready.cardId}.json`);
        for (;;) {
          if (interrupted) throw stopped();
          if (existsSync(path)) {
            let ack;
            try { ack = read(regular(path)); }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
            if (ackMatches(ack, ready)) return ack;
          }
          await delay(1000);
        }
      } });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try { if (captureLock) releaseLock(captureLock); }
    finally { releaseLock(executionLock); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack || String(error)); process.exitCode = error.code === 'INTERRUPTED' ? 130 : 1; });
}
