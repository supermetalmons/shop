import { opendir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethereumPlaceholderMetadata, type EthereumMetadataNetwork, type EthereumPlaceholderMetadata } from '../../shared/ethereum/placeholderMetadata.ts';
import { fileSha256, inBatches, metadataObjects, readMetadataManifest, sha256 } from './catalog.ts';

export async function validateMetadata(directory: string, network: EthereumMetadataNetwork, progress: (count: number) => void = () => {}) {
  const manifest = await readMetadataManifest(directory, network);
  const artworkHashes = new Map<number, string>();
  const geometries = new Set<string>();
  let objectCount = 0;
  let totalBytes = 0;
  let digitalReceiptMatches = 0;
  await inBatches(metadataObjects(directory), 32, async object => {
    const body = await readFile(join(directory, object.file));
    if (body.length !== object.bytes || sha256(body) !== object.sha256) throw new Error(`Metadata checksum mismatch: ${object.file}`);
    const expected = JSON.stringify(ethereumPlaceholderMetadata(object.kind, object.displayId, network)) + '\n';
    if (body.toString('utf8') !== expected) throw new Error(`Metadata content mismatch: ${object.file}`);
    if (object.kind === 1 || object.kind === 4) {
      const metadata: EthereumPlaceholderMetadata = JSON.parse(body.toString('utf8'));
      const svg = Buffer.from(metadata.image.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
      const artwork = object.kind === 1 ? svg.slice(svg.indexOf('>') + 1, -6) :
        svg.match(/<svg x="151" y="103" width="418" height="418" viewBox="0 0 720 720" overflow="hidden">(.*?)<\/svg>/)?.[1];
      if (!artwork || /<text\b/.test(artwork)) throw new Error(`Artwork geometry is missing or contains a number label: ${object.file}`);
      if (object.kind === 1) artworkHashes.set(object.displayId, sha256(artwork));
      else {
        const circle = artwork.match(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)" fill="#efb84c"\/>/);
        if (!circle) throw new Error(`Artwork center geometry missing: ${object.file}`);
        const key = circle.slice(1).join(':');
        if (geometries.has(key)) throw new Error(`Duplicate artwork geometry: ${object.file}`);
        geometries.add(key);
        if (object.displayId <= 111111) {
          if (artworkHashes.get(object.displayId) !== sha256(artwork)) throw new Error(`Artwork receipt does not preserve its flower: ${object.file}`);
          digitalReceiptMatches++;
        }
      }
    }
    objectCount++;
    totalBytes += body.length;
    if (objectCount % 4096 === 0) progress(objectCount);
  });
  let files = 0;
  for await (const entry of await opendir(directory)) {
    if (/^\d+\.json$/.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`Metadata path is not a regular file: ${entry.name}`);
      files++;
    }
  }
  if (objectCount !== manifest.objectCount || files !== objectCount || totalBytes !== manifest.totalBytes ||
    geometries.size !== 222222 || digitalReceiptMatches !== 111111) throw new Error('Metadata collection coverage or artwork geometry validation failed');
  const report = {
    version: 1, network, manifestSha256: await fileSha256(join(directory, 'manifest.json')),
    objectsSha256: manifest.objectsSha256, objectCount, totalBytes, artworkGeometryCount: geometries.size, digitalReceiptMatches,
  };
  await writeFile(join(directory, 'validation.json.tmp'), JSON.stringify(report, null, 2) + '\n');
  await rename(join(directory, 'validation.json.tmp'), join(directory, 'validation.json'));
  progress(objectCount);
  return report;
}
