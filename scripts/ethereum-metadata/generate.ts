import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethereumPlaceholderMetadata, type EthereumMetadataNetwork } from '../../shared/ethereum/placeholderMetadata.ts';
import { fileSha256, metadataCounts, metadataIdentities, metadataPrefix, metadataSources, sha256, type MetadataManifest, type MetadataObject } from './catalog.ts';

export async function generateMetadata(directory: string, network: EthereumMetadataNetwork, progress: (count: number) => void = () => {}): Promise<MetadataManifest> {
  await mkdir(directory, { recursive: true });
  const lock = await open(join(directory, '.generate.lock'), 'wx');
  const objectsPath = join(directory, 'objects.jsonl.tmp');
  let objects: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await rm(join(directory, 'validation.json'), { force: true });
    await rm(join(directory, 'manifest.json'), { force: true });
    objects = await open(objectsPath, 'w');
    let batch: Array<Promise<MetadataObject>> = [];
    let objectCount = 0;
    let totalBytes = 0;
    const flush = async () => {
      const rows = await Promise.all(batch);
      for (const row of rows) { objectCount++; totalBytes += row.bytes; }
      await objects!.write(rows.map(row => JSON.stringify(row) + '\n').join(''));
      batch = [];
      if (objectCount % 4096 === 0) progress(objectCount);
    };
    for (const identity of metadataIdentities()) {
      const body = JSON.stringify(ethereumPlaceholderMetadata(identity.kind, identity.displayId, network)) + '\n';
      batch.push((async () => {
        const path = join(directory, identity.file);
        let same = false;
        try { same = await readFile(path, 'utf8') === body; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!same) await writeFile(path, body);
        return { ...identity, sha256: sha256(body), bytes: Buffer.byteLength(body) };
      })());
      if (batch.length === 32) await flush();
    }
    if (batch.length) await flush();
    await objects.close();
    objects = undefined;
    await rename(objectsPath, join(directory, 'objects.jsonl'));
    const manifest: MetadataManifest = {
      version: 1, network, prefix: metadataPrefix(network), objectCount, totalBytes, counts: metadataCounts(),
      objectsFile: 'objects.jsonl', objectsSha256: await fileSha256(join(directory, 'objects.jsonl')), sourceSha256: await metadataSources(),
    };
    await writeFile(join(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
    progress(objectCount);
    return manifest;
  } finally {
    await objects?.close();
    await lock.close();
    await rm(join(directory, '.generate.lock'), { force: true });
  }
}
