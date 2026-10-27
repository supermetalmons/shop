import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileSha256, loadMetadataTemplates, md5, metadataBody, metadataCounts, metadataIdentities, metadataSources, sha256,
  type MetadataManifest, type MetadataObject,
} from './catalog.ts';
import { withMetadataLock } from './lock.ts';

export async function generateMetadata(directory: string, options: { progress?: (count: number) => void } = {}): Promise<MetadataManifest> {
  const { templates, sources, hashes } = await loadMetadataTemplates();
  await mkdir(directory, { recursive: true });
  return withMetadataLock(join(directory, '.generate.lock'), async () => {
    let objects: Awaited<ReturnType<typeof open>> | undefined;
    let templateWrites: Array<Promise<void>> = [];
    let batch: Array<Promise<MetadataObject>> = [];
    try {
      try {
        await lstat(join(directory, 'manifest.json'));
        throw new Error('This directory already contains a completed metadata manifest. Use a new revision directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rm(join(directory, 'validation.json'), { force: true });
      await mkdir(join(directory, 'templates'), { recursive: true });
      templateWrites = Object.entries(sources).map(([kind, source]) => writeFile(join(directory, 'templates', `${kind}.json`), source));
      await Promise.all(templateWrites);
      objects = await open(join(directory, 'objects.jsonl.tmp'), 'w');
      let objectCount = 0;
      let totalBytes = 0;
      let lastProgress = 0;
      const flush = async () => {
        const results = await Promise.allSettled(batch);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        const rows = results.map(result => (result as PromiseFulfilledResult<MetadataObject>).value);
        for (const row of rows) { objectCount++; totalBytes += row.bytes; }
        await objects!.writeFile(rows.map(row => `${JSON.stringify(row)}\n`).join(''));
        batch = [];
        if (objectCount - lastProgress >= 10_000) {
          options.progress?.(objectCount);
          lastProgress = objectCount;
        }
      };
      for (const identity of metadataIdentities()) {
        const body = metadataBody(identity, templates);
        batch.push((async () => {
          await writeFile(join(directory, identity.file), body);
          return { ...identity, bytes: Buffer.byteLength(body), sha256: sha256(body), md5: md5(body) };
        })());
        if (batch.length === 64) await flush();
      }
      if (batch.length) await flush();
      await objects.sync();
      await objects.close();
      objects = undefined;
      await rename(join(directory, 'objects.jsonl.tmp'), join(directory, 'objects.jsonl'));
      const manifest: MetadataManifest = {
        version: 1, objectCount, totalBytes, counts: metadataCounts(), objectsFile: 'objects.jsonl',
        objectsSha256: await fileSha256(join(directory, 'objects.jsonl')), templateSha256: hashes, sourceSha256: await metadataSources(),
      };
      await writeFile(join(directory, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
      options.progress?.(objectCount);
      return manifest;
    } finally {
      await Promise.allSettled([...templateWrites, ...batch]);
      await objects?.close();
    }
  });
}
