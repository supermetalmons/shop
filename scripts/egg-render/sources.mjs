import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { prepareCatalogSources } from '../painting-canvas/render.mjs';

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function prepareEggSources(samples, sampleHashes) {
  const downloads = [];
  const pinned = [];
  for (const sample of samples) {
    const expected = sampleHashes[sample.id];
    if (!expected) {
      downloads.push(sample);
    } else if (!existsSync(sample.path) || await sha256(sample.path) !== expected) {
      const path = `${sample.path}.incoming-${randomUUID()}`;
      downloads.push({ ...sample, path });
      pinned.push({ sample, path, expected });
    }
  }
  if (!downloads.length) return;

  try {
    await prepareCatalogSources(downloads);
    for (const { sample, path, expected } of pinned) {
      if (await sha256(path) !== expected) {
        throw new Error(`Downloaded artwork differs from the saved egg ${sample.id} study (see samples.json).`);
      }
      await rename(path, sample.path);
    }
  } finally {
    for (const { path } of pinned) await rm(path, { force: true });
  }
}
