import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import { environmentStorage, uploadWithConcurrency, type MetadataStorage } from '../ethereum-metadata/storage.ts';
import { DMX_METADATA_BASE_URI, DMX_METADATA_PREFIX, DMX_METADATA_ROOT, dmxMetadataBody,
  dmxMetadataConcurrency, dmxMetadataDirectory, dmxMetadataManifestSha256, loadDmxMetadataBody, loadDmxMetadataManifest,
  verifyDmxPublishedMetadata, type DmxMetadataManifest } from './metadata.ts';

type Options = { root?: string; storage?: MetadataStorage; fetcher?: typeof fetch; concurrency?: number };
type Publication = { manifest: DmxMetadataManifest; bodies: Map<string, Buffer> };

async function loadPublication(directory: string): Promise<Publication> {
  const manifest = await loadDmxMetadataManifest(directory);
  const bodies = new Map<string, Buffer>();
  await uploadWithConcurrency(manifest.objects, 8, async object => {
    bodies.set(object.file, await loadDmxMetadataBody(directory, object.file, manifest));
  });
  return { manifest, bodies };
}

async function checkStorage(storage: MetadataStorage, publication: Publication, allowMissing: boolean,
  concurrency: number): Promise<Set<string>> {
  if (storage.destination.bucket !== 'cdn-mons-shop') throw new Error('DMX metadata requires the cdn-mons-shop bucket');
  const present = new Set<string>();
  for await (const object of storage.list(DMX_METADATA_PREFIX)) {
    const file = object.key.slice(DMX_METADATA_PREFIX.length);
    if (object.key !== `${DMX_METADATA_PREFIX}${file}` || !publication.bodies.has(file) || present.has(file)) {
      throw new Error(`Unexpected DMX metadata object: ${object.key}`);
    }
    present.add(file);
  }
  if (!allowMissing && present.size !== publication.manifest.objectCount) throw new Error('DMX metadata publication is incomplete');
  await uploadWithConcurrency(present, concurrency, async file => {
    const body = await storage.get(`${DMX_METADATA_PREFIX}${file}`);
    if (!body.equals(publication.bodies.get(file)!)) throw new Error(`Existing DMX metadata differs: ${file}`);
  });
  return present;
}

async function writeReport(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, dmxMetadataBody(value), { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function publishDmxMetadata(directory: string, options: Options = {}) {
  const concurrency = dmxMetadataConcurrency(options.concurrency);
  const root = options.root ?? DMX_METADATA_ROOT;
  const target = await dmxMetadataDirectory(directory, root);
  const publication = await loadPublication(target);
  const manifestSha256 = dmxMetadataManifestSha256(publication.manifest);
  const operations = resolve(root, '.operations/dmx-metadata');
  const operationDirectory = join(operations, manifestSha256);
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
  if (await realpath(operationDirectory) !== operationDirectory) throw new Error('DMX publication journal must not use symbolic links');
  const storage = options.storage ?? environmentStorage(concurrency);
  try {
    return await withMetadataLock(join(operations, 'publication.lock'), async () => {
      const present = await checkStorage(storage, publication, true, concurrency);
      const header = { version: 1, ...storage.destination, prefix: DMX_METADATA_PREFIX, manifestSha256 };
      const journalPath = join(operationDirectory, 'publication.jsonl');
      const headerLine = JSON.stringify(header);
      try { await writeFile(journalPath, `${headerLine}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const content = await readFile(journalPath, 'utf8');
      const complete = content.slice(0, content.lastIndexOf('\n') + 1);
      const lines = complete.trimEnd().split('\n');
      if (lines[0] !== headerLine) throw new Error('DMX publication journal belongs to a different destination or manifest');
      const completed = new Set<string>();
      for (const line of lines.slice(1)) {
        const row = JSON.parse(line) as { file: string; sha256: string };
        if (publication.manifest.objects.find(object => object.file === row.file)?.sha256 !== row.sha256) {
          throw new Error('DMX publication journal checksum mismatch');
        }
        completed.add(row.file);
      }
      if (content !== complete) await truncate(journalPath, Buffer.byteLength(complete));
      const journal = await open(journalPath, 'a');
      let tail: Promise<unknown> = Promise.resolve();
      let uploaded = 0;
      let skipped = 0;
      try {
        await uploadWithConcurrency(publication.manifest.objects, concurrency, async object => {
          const key = `${DMX_METADATA_PREFIX}${object.file}`;
          const body = publication.bodies.get(object.file)!;
          if (present.has(object.file)) skipped++;
          else {
            try { await storage.put(key, body, null); uploaded++; }
            catch (error) {
              let accepted = false;
              try { accepted = (await storage.get(key)).equals(body); } catch {}
              if (!accepted) throw error;
              skipped++;
            }
          }
          if (!completed.has(object.file)) {
            tail = tail.then(() => journal.writeFile(`${JSON.stringify({ file: object.file, sha256: object.sha256 })}\n`));
            await tail;
          }
        });
        await tail;
        await journal.sync();
      } finally { await tail.catch(() => {}); await journal.close(); }
      await checkStorage(storage, publication, false, concurrency);
      const report = { version: 1, baseURI: DMX_METADATA_BASE_URI, bucket: storage.destination.bucket,
        manifestSha256, objectsSha256: publication.manifest.objectsSha256, objectCount: publication.manifest.objectCount,
        uploaded, skipped, complete: true, storageVerified: true, finishedAt: new Date().toISOString() };
      await writeReport(join(target, 'publication.json'), report);
      return report;
    });
  } finally { if (!options.storage) storage.close(); }
}

export async function verifyDmxMetadata(directory: string, options: Options = {}) {
  const concurrency = dmxMetadataConcurrency(options.concurrency);
  const target = await dmxMetadataDirectory(directory, options.root);
  const publication = await loadPublication(target);
  const storage = options.storage ?? environmentStorage(concurrency);
  try {
    await checkStorage(storage, publication, false, concurrency);
    const report = { ...await verifyDmxPublishedMetadata(publication.manifest, { ...options, concurrency }), storageVerified: true,
      bucket: storage.destination.bucket };
    await writeReport(join(target, 'verification.json'), report);
    return report;
  } finally { if (!options.storage) storage.close(); }
}
