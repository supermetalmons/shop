import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const sourceHashesSha256 = sourceHashes => digest(sourceHashes);

export function nativeFramesSha256(nativeFrames) {
  return digest(Object.entries(nativeFrames).sort(([left], [right]) => left.localeCompare(right)).map(([key, record]) => [key, {
    id: record.id, frame: record.frame, sha256: record.sha256, iccSha256: record.iccSha256,
    stitchReportSha256: record.stitchReportSha256,
  }]));
}

export async function confirmOwnedProcessesStopped(identities, processList, { timeoutMilliseconds = 10_000, pollMilliseconds = 100 } = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const processes = processList();
    const active = identities.filter(item => processes.get(item.pid) === item.identity);
    if (!active.length) return;
    if (Date.now() >= deadline) throw new Error(`Owned Safari processes did not stop: ${active.map(item => item.pid).join(', ')}`);
    await delay(pollMilliseconds);
  }
}

export async function releaseCaptureResources({ stopSafari, stopServer, closeWorker, identities, processList }) {
  await stopSafari();
  await stopServer();
  await confirmOwnedProcessesStopped(identities, processList);
  await closeWorker();
}

export function captureReleaseRecord({ manifest, job, attempt, runId, cardId }) {
  if (!attempt || !job?.jobId || !job?.sourceId || manifest.ids.length !== 1 || manifest.ids[0] !== cardId
    || manifest.profile !== job.profile || manifest.motion !== job.motion || manifest.backend !== job.backend) {
    throw new Error('Capture release identity differs from its job.');
  }
  const frames = Object.values(manifest.nativeFrames);
  if (frames.length !== 276 || frames.some(record => record.id !== cardId)
    || new Set(frames.map(record => record.frame)).size !== 276
    || frames.some(record => !Number.isSafeInteger(record.frame) || record.frame < 0 || record.frame >= 276
      || ['sha256', 'iccSha256', 'stitchReportSha256'].some(key => !/^[a-f0-9]{64}$/.test(record[key] || '')))) {
    throw new Error('Capture release requires all 276 native checkpoints.');
  }
  const proofs = manifest.nativeProofs[cardId];
  const capture = manifest.captures.find(item => item.id === cardId && item.method === 'c');
  if (!capture || !proofs?.before?.path || !proofs?.after?.path
    || !/^[a-f0-9]{64}$/.test(proofs.before.sha256 || '') || !/^[a-f0-9]{64}$/.test(proofs.after.sha256 || '')
    || !capture.repeat?.checks?.length || capture.repeat.checks.some(check => !check.equal || !check.iccEqual)) {
    throw new Error('Capture release requires exact final native rest proofs.');
  }
  return { version: 1, status: 'capture-complete', attempt, runId, jobId: job.jobId, sourceId: job.sourceId, cardId,
    ownerId: manifest.ownerId, backend: manifest.backend, profile: manifest.profile, motion: manifest.motion, frameCount: 276,
    preflight: manifest.preflight, sourceHashesSha256: sourceHashesSha256(manifest.sourceHashes),
    nativeFramesSha256: nativeFramesSha256(manifest.nativeFrames),
    before: { path: proofs.before.path, sha256: proofs.before.sha256 }, after: { path: proofs.after.path, sha256: proofs.after.sha256 },
    captureWindows: manifest.captureWindows || [], safariReleased: true, completedAt: new Date().toISOString() };
}

export function saveCaptureRelease(path, record) {
  const pending = join(dirname(path), `.capture-complete-${randomUUID()}.pending.json`);
  const descriptor = openSync(pending, 'wx');
  try {
    writeFileSync(descriptor, JSON.stringify(record, null, 2) + '\n');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pending, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
