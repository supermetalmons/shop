import { lstat, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileSha256, inBatches, loadMetadataTemplates, md5, metadataBody, metadataObjects, readMetadataManifest, sha256,
} from './catalog.ts';

export async function validateMetadata(directory: string, options: { progress?: (count: number) => void } = {}) {
  await rm(join(directory, 'validation.json'), { force: true });
  const manifest = await readMetadataManifest(directory);
  const { templates } = await loadMetadataTemplates(join(directory, 'templates'));
  let objectCount = 0;
  let totalBytes = 0;
  await inBatches(metadataObjects(directory), 64, async object => {
    const path = join(directory, object.file);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error(`Metadata path is not a regular file: ${object.file}`);
    if (stat.size !== object.bytes) throw new Error(`Metadata size mismatch: ${object.file}`);
    const body = await readFile(path);
    if (body.length !== object.bytes || sha256(body) !== object.sha256 || md5(body) !== object.md5) {
      throw new Error(`Metadata checksum mismatch: ${object.file}`);
    }
    if (body.toString('utf8') !== metadataBody(object, templates)) throw new Error(`Metadata content mismatch: ${object.file}`);
    objectCount++;
    totalBytes += body.length;
    if (objectCount % 10_000 === 0) options.progress?.(objectCount);
  });
  let files = 0;
  for await (const entry of await opendir(directory)) {
    if (/^\d+\.json$/.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`Metadata path is not a regular file: ${entry.name}`);
      files++;
    }
  }
  if (objectCount !== manifest.objectCount || files !== objectCount || totalBytes !== manifest.totalBytes) {
    throw new Error('Metadata collection coverage validation failed');
  }
  const report = {
    version: 1, manifestSha256: await fileSha256(join(directory, 'manifest.json')),
    objectsSha256: manifest.objectsSha256, objectCount, totalBytes, templateSha256: manifest.templateSha256,
  };
  await writeFile(join(directory, 'validation.json.tmp'), `${JSON.stringify(report, null, 2)}\n`);
  await rename(join(directory, 'validation.json.tmp'), join(directory, 'validation.json'));
  options.progress?.(objectCount);
  return report;
}
