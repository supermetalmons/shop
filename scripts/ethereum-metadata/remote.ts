import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  fileSha256, metadataCounts, metadataIdentities, metadataObjects, readMetadataManifest, sha256,
} from './catalog.ts';
import {
  environmentStorage, metadataMd5, metadataNetworks, metadataPrefix, metadataUploadConcurrency, uploadWithConcurrency,
  type MetadataNetwork, type MetadataNetworkSelection, type MetadataStorage, type RemoteObject, type UploadDestination,
} from './storage.ts';
import { withMetadataLock } from './lock.ts';
import { acquireMetadataPublicationLease, type MetadataPublicationLease, type MetadataWriteFence } from './publicationLease.ts';

export type { MetadataNetwork, MetadataNetworkSelection } from './storage.ts';
type Progress = (value: { phase: string; network: MetadataNetwork; completed: number; total: number }) => void;
type CommonOptions = { concurrency?: number; progress?: Progress; storage?: MetadataStorage; prefix?: string; publicationLease?: (baseUri: string) => Promise<MetadataPublicationLease> };
type ObjectDigest = { file: string; bytes: number; md5: string; sha256: string };
type SnapshotObject = ObjectDigest & { body: Buffer };
type PublishObject = ObjectDigest & ({ body: Buffer } | { readBody: () => Promise<Buffer> });
type SnapshotManifest = {
  network: MetadataNetwork; prefix: string; destination: UploadDestination;
  objectCount: number; totalBytes: number; archive: 'objects.jsonl.gz'; archiveSha256: string; createdAt: string;
} & ({ version: 1 } | { version: 2; publicationManifestSha256: string });
const COLLECTION_SIZE = Object.values(metadataCounts()).reduce((sum, count) => sum + count, 0);
const SAMPLE_IDS = ['1', '55556', '111111', '111112', '116666', '116667', '117171',
  '1000001', '1111111', '1111112', '1222222', '2000001', '2005555'];

async function writeReport(path: string, report: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

function expectedFiles(): Set<string> {
  return new Set(Array.from(metadataIdentities(), object => object.file));
}

function selectedIds(tokenIds?: string[]): Set<string> | undefined {
  if (!tokenIds) return undefined;
  const files = expectedFiles();
  if (!tokenIds.length || new Set(tokenIds).size !== tokenIds.length || tokenIds.some(id => !files.has(`${id}.json`))) {
    throw new Error('Requested metadata token IDs are outside the collection or duplicated');
  }
  return new Set(tokenIds);
}

export async function remoteInventory(storage: MetadataStorage, prefix: string,
  files: Set<string> = expectedFiles(), options: { allowMissing?: boolean; allowInvalidMetadata?: boolean } = {}): Promise<Map<string, RemoteObject>> {
  const found = new Map<string, RemoteObject>();
  const ranges: Array<{ startAfter?: string; endAt?: string } | undefined> = [];
  if (files.size <= 10_000) ranges.push(undefined);
  else {
    const keys = Array.from(files, file => prefix + file).sort();
    let startAfter: string | undefined;
    for (let offset = 0; offset < keys.length; offset += 10_000) {
      const endAt = keys[Math.min(offset + 10_000, keys.length) - 1];
      ranges.push({ startAfter, endAt });
      startAfter = endAt;
    }
    ranges.push({ startAfter });
  }
  await uploadWithConcurrency(ranges, Math.min(ranges.length, 16), async range => {
    let previous = range?.startAfter;
    for await (const object of storage.list(prefix, range)) {
      const file = object.key.slice(prefix.length);
      if (!object.key.startsWith(prefix) || (previous !== undefined && object.key <= previous) ||
        (range?.endAt !== undefined && object.key > range.endAt)) {
        throw new Error(`Unexpected remote metadata key or checksum: ${object.key}`);
      }
      previous = object.key;
      if (/^[a-z0-9][a-z0-9-]{0,63}\//.test(file)) continue;
      if (!files.has(file) || found.has(file) || !Number.isSafeInteger(object.bytes) || object.bytes < 0 ||
        typeof object.md5 !== 'string' || !options.allowInvalidMetadata &&
        (object.bytes < 1 || object.bytes > 128 * 1024 || !/^[a-f0-9]{32}$/.test(object.md5))) {
        throw new Error(`Unexpected remote metadata key or checksum: ${object.key}`);
      }
      found.set(file, object);
    }
  });
  if (!options.allowMissing && found.size !== files.size) throw new Error(`Remote metadata inventory is incomplete: ${found.size}/${files.size}`);
  return found;
}

async function withDestinationLock<T>(storage: MetadataStorage, network: MetadataNetwork, work: () => Promise<T>, prefix?: string): Promise<T> {
  const path = resolve('.cache/111k-metadata-locks', `${sha256(JSON.stringify({ ...storage.destination, network, prefix: metadataPrefix(network, prefix) }))}.lock`);
  return withMetadataLock(path, work);
}

async function readSnapshotManifest(directory: string, storage: MetadataStorage, network: MetadataNetwork,
  expectedCount = COLLECTION_SIZE, publicationManifestSha256?: string, prefix?: string): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 && manifest.version !== 2 ||
    manifest.version === 2 && !/^[a-f0-9]{64}$/.test(manifest.publicationManifestSha256) ||
    manifest.network !== network || manifest.prefix !== metadataPrefix(network, prefix) ||
    manifest.destination?.endpoint !== storage.destination.endpoint || manifest.destination.bucket !== storage.destination.bucket ||
    manifest.archive !== 'objects.jsonl.gz' || manifest.objectCount !== expectedCount || !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 1 || !/^[a-f0-9]{64}$/.test(manifest.archiveSha256)) {
    throw new Error('Snapshot does not match this destination and complete collection');
  }
  if (publicationManifestSha256 !== undefined &&
    (manifest.version !== 2 || manifest.publicationManifestSha256 !== publicationManifestSha256)) {
    throw new Error('Snapshot is not bound to this publication; choose a new snapshot directory');
  }
  if (await fileSha256(join(directory, manifest.archive)) !== manifest.archiveSha256) throw new Error('Snapshot archive checksum mismatch');
  return manifest;
}

async function existingSnapshot(directory: string, storage: MetadataStorage, network: MetadataNetwork,
  publicationManifestSha256: string, expectedCount = COLLECTION_SIZE, prefix?: string): Promise<SnapshotManifest | undefined> {
  try { await readFile(join(directory, 'manifest.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readSnapshotManifest(directory, storage, network, expectedCount, publicationManifestSha256, prefix);
}

export async function snapshotMetadata(storage: MetadataStorage, network: MetadataNetwork, directory: string,
  inventory: Map<string, RemoteObject>, publicationManifestSha256: string,
  options: CommonOptions & { priorCacheRoot?: string } = {}): Promise<SnapshotManifest> {
  if (!/^[a-f0-9]{64}$/.test(publicationManifestSha256)) throw new Error('Invalid publication manifest checksum');
  const existing = await existingSnapshot(directory, storage, network, publicationManifestSha256, inventory.size);
  if (existing) return existing;
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, 'objects.jsonl.gz.partial');
  const archive = join(directory, 'objects.jsonl.gz');
  const gzip = createGzip({ level: 1 });
  const completion = pipeline(gzip, createWriteStream(temporary));
  let outputError: Error | undefined;
  void completion.catch(error => { outputError = error; });
  let tail: Promise<unknown> = Promise.resolve();
  let completed = 0;
  let totalBytes = 0;
  const caches = options.priorCacheRoot ? [join(options.priorCacheRoot, network), options.priorCacheRoot] : [];
  try {
    await uploadWithConcurrency(inventory.entries(), options.concurrency ?? 32, async ([file, object]) => {
      if (outputError) throw outputError;
      let body: Buffer | undefined;
      for (const cache of caches) {
        try {
          const path = join(cache, file);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.size !== object.bytes) continue;
          const candidate = await readFile(path);
          if (candidate.length === object.bytes && metadataMd5(candidate) === object.md5) {
            body = candidate;
            break;
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      body ??= await storage.get(object.key);
      if (outputError) throw outputError;
      if (body.length !== object.bytes || metadataMd5(body) !== object.md5) throw new Error(`Remote object changed while taking snapshot: ${object.key}`);
      const row = JSON.stringify({ file, bytes: body.length, md5: object.md5, sha256: sha256(body), body: body.toString('base64') });
      tail = tail.then(() => new Promise<void>((resolve, reject) => {
        if (outputError) reject(outputError);
        else gzip.write(`${row}\n`, error => error ? reject(error) : resolve());
      }));
      await tail;
      totalBytes += body.length;
      completed++;
      if (completed % 5000 === 0) options.progress?.({ phase: 'snapshot', network, completed, total: inventory.size });
    });
    gzip.end();
    await completion;
    await rename(temporary, archive);
    const manifest: SnapshotManifest = { version: 2, publicationManifestSha256, network,
      prefix: metadataPrefix(network, options.prefix), destination: storage.destination,
      objectCount: completed, totalBytes, archive: 'objects.jsonl.gz', archiveSha256: await fileSha256(archive), createdAt: new Date().toISOString() };
    await writeReport(join(directory, 'manifest.json'), manifest);
    options.progress?.({ phase: 'snapshot', network, completed, total: inventory.size });
    return manifest;
  } catch (error) {
    gzip.destroy(error instanceof Error ? error : new Error('Snapshot failed'));
    await completion.catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw outputError ?? error;
  }
}

export async function* snapshotObjects(directory: string, manifest: SnapshotManifest,
  files: Set<string> = expectedFiles()): AsyncGenerator<SnapshotObject> {
  const input = createReadStream(join(directory, manifest.archive));
  const gunzip = createGunzip();
  const completion = pipeline(input, gunzip);
  void completion.catch(() => {});
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  const seen = new Set<string>();
  let totalBytes = 0;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (!files.has(row.file) || seen.has(row.file) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 128 * 1024 ||
        !/^[a-f0-9]{32}$/.test(row.md5) || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.body !== 'string') {
        throw new Error('Snapshot contains an invalid or duplicate object');
      }
      const body = Buffer.from(row.body, 'base64');
      if (body.length !== row.bytes || metadataMd5(body) !== row.md5 || sha256(body) !== row.sha256) throw new Error(`Snapshot object checksum mismatch: ${row.file}`);
      seen.add(row.file);
      totalBytes += body.length;
      yield { file: row.file, bytes: row.bytes, md5: row.md5, sha256: row.sha256, body };
    }
    await completion;
    if (seen.size !== files.size || seen.size !== manifest.objectCount || totalBytes !== manifest.totalBytes) throw new Error('Snapshot is incomplete');
  } finally {
    lines.close();
    gunzip.destroy();
    input.destroy();
    await completion.catch(() => {});
  }
}

async function initializeJournal(path: string, header: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(header);
      await file.sync();
    } finally { await file.close(); }
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function publishObjects(args: {
  storage: MetadataStorage; network: MetadataNetwork; objects: AsyncIterable<PublishObject>; inventory: Map<string, RemoteObject>;
  journal: string; sourceHash: string; concurrency: number; total: number; progress?: Progress; restoreFiles?: ReadonlySet<string>; prefix?: string; beforePut?: () => Promise<void>; writeFence?: MetadataWriteFence; initializeOnly?: boolean;
}) {
  const header = { version: 1, ...args.storage.destination, network: args.network, ...(args.prefix ? { prefix: metadataPrefix(args.network, args.prefix) } : {}), sourceHash: args.sourceHash };
  await mkdir(resolve(args.journal, '..'), { recursive: true });
  const completedHashes = new Map<string, string>();
  try {
    const content = await readFile(args.journal, 'utf8');
    const complete = content.slice(0, content.lastIndexOf('\n') + 1);
    const lines = complete.trimEnd().split('\n');
    if (lines[0] !== JSON.stringify(header)) throw new Error('Upload journal belongs to a different destination or manifest');
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line);
      if (!/^[1-9]\d*\.json$/.test(row.file) || !/^[a-f0-9]{64}$/.test(row.sha256) ||
        completedHashes.has(row.file) && completedHashes.get(row.file) !== row.sha256) throw new Error('Upload journal contains an invalid completion record');
      completedHashes.set(row.file, row.sha256);
    }
    if (complete !== content) await truncate(args.journal, Buffer.byteLength(complete));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await initializeJournal(args.journal, `${JSON.stringify(header)}\n`);
  }
  const journal = await open(args.journal, 'a');
  let tail: Promise<unknown> = Promise.resolve();
  let uploaded = 0;
  let skipped = 0;
  try {
    await uploadWithConcurrency(args.objects, args.concurrency, async object => {
      if (!/^[1-9]\d*\.json$/.test(object.file) || object.bytes < 1 || object.bytes > 128 * 1024 ||
        args.restoreFiles && !args.restoreFiles.has(object.file)) throw new Error(`Invalid local object: ${object.file}`);
      const body = 'body' in object ? object.body : await object.readBody();
      if (body.length !== object.bytes || metadataMd5(body) !== object.md5 || sha256(body) !== object.sha256) {
        throw new Error(`Local object checksum mismatch: ${object.file}`);
      }
      const priorHash = completedHashes.get(object.file);
      if (priorHash && priorHash !== object.sha256) throw new Error(`Upload journal checksum mismatch: ${object.file}`);
      const current = args.inventory.get(object.file);
      if (!current && !args.initializeOnly && !args.restoreFiles?.has(object.file)) throw new Error(`Object is not in the verified destination inventory: ${object.file}`);
      if (args.initializeOnly && current && (current.bytes !== object.bytes || current.md5 !== object.md5)) {
        throw new Error(`Deployment prefix already contains different metadata: ${object.file}`);
      }
      if (!args.restoreFiles && current && current.bytes === object.bytes && current.md5 === object.md5) skipped++;
      else {
        await args.beforePut?.();
        await args.storage.put(metadataPrefix(args.network, args.prefix) + object.file, body, current ? `"${current.md5}"` : null, args.writeFence);
        uploaded++;
      }
      if (!priorHash) {
        tail = tail.then(() => journal.writeFile(`${JSON.stringify({ file: object.file, sha256: object.sha256 })}\n`));
        await tail;
      }
      const completed = uploaded + skipped;
      if (completed % 1000 === 0) {
        tail = tail.then(() => journal.sync());
        await tail;
        args.progress?.({ phase: 'upload', network: args.network, completed, total: args.total });
      }
    });
    await tail;
    await journal.sync();
    if (uploaded + skipped !== args.total) throw new Error('Upload object count does not match the requested collection');
    args.progress?.({ phase: 'upload', network: args.network, completed: uploaded + skipped, total: args.total });
    return { uploaded, skipped };
  } finally {
    await tail.catch(() => {});
    await journal.close();
  }
}

async function validatedManifest(directory: string) {
  const manifest = await readMetadataManifest(directory);
  const validation = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
  if (validation.manifestSha256 !== await fileSha256(join(directory, 'manifest.json')) ||
    validation.objectsSha256 !== manifest.objectsSha256 || validation.objectCount !== manifest.objectCount || validation.totalBytes !== manifest.totalBytes) {
    throw new Error('Run validate successfully before publishing this manifest');
  }
  return manifest;
}

async function* generatedObjects(directory: string, selected?: Set<string>): AsyncGenerator<PublishObject> {
  for await (const object of metadataObjects(directory)) {
    if (!selected || selected.has(object.tokenId)) yield { ...object, readBody: async () => {
      const path = join(directory, object.file);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size !== object.bytes) throw new Error(`Local object size mismatch: ${object.file}`);
      return readFile(path);
    } };
  }
}

export async function selectedInventory(storage: MetadataStorage, network: MetadataNetwork,
  selected: Set<string>, concurrency: number, prefix?: string): Promise<Map<string, RemoteObject>> {
  const inventory = new Map<string, RemoteObject>();
  selectedIds([...selected]);
  await uploadWithConcurrency(selected, concurrency, async tokenId => {
    const file = `${tokenId}.json`;
    const key = metadataPrefix(network, prefix) + file;
    const body = await storage.get(key);
    if (!body.length || body.length > 128 * 1024) throw new Error(`Invalid remote metadata size: ${key}`);
    inventory.set(file, { key, bytes: body.length, md5: metadataMd5(body) });
  });
  return inventory;
}

export async function uploadMetadata(directory: string, network: MetadataNetworkSelection, options: CommonOptions & {
  tokenIds?: string[]; snapshotDirectory?: string; priorCacheRoot?: string;
} = {}) {
  const concurrency = metadataUploadConcurrency(options.concurrency);
  const selected = selectedIds(options.tokenIds);
  const manifest = await validatedManifest(directory);
  const publicationManifestSha256 = await fileSha256(join(directory, 'manifest.json'));
  const storage = options.storage ?? environmentStorage(concurrency);
  const reports = [];
  if (options.prefix && network === 'all') throw new Error('A deployment prefix requires one network');
  try {
    for (const selectedNetwork of metadataNetworks(network)) {
      const prefix = metadataPrefix(selectedNetwork, options.prefix);
      const lease = options.publicationLease || !options.storage
        ? await (options.publicationLease ?? acquireMetadataPublicationLease)(`https://cdn.mons.shop/${prefix}`) : undefined;
      try { reports.push(await withDestinationLock(storage, selectedNetwork, async () => {
        options.progress?.({ phase: 'inventory', network: selectedNetwork, completed: 0, total: manifest.objectCount });
        if (options.prefix) {
          const inventory = await remoteInventory(storage, prefix, expectedFiles(), { allowMissing: true });
          const counts = await publishObjects({ storage, network: selectedNetwork, prefix, initializeOnly: true,
            beforePut: () => lease?.beforePut() ?? Promise.resolve(), writeFence: lease, objects: generatedObjects(directory, selected), inventory,
            journal: join(directory, 'uploads', `${selectedNetwork}-${sha256(prefix).slice(0, 12)}.jsonl`),
            sourceHash: manifest.objectsSha256, concurrency, total: selected?.size ?? manifest.objectCount, progress: options.progress });
          const report = { network: selectedNetwork, ...storage.destination, prefix, ...counts, initialized: true,
            objectsSha256: manifest.objectsSha256, complete: !selected, tokenIds: selected ? [...selected] : undefined, finishedAt: new Date().toISOString() };
          await writeReport(join(directory, `upload-${selectedNetwork}-${sha256(prefix).slice(0, 12)}.json`), report);
          return report;
        }
        const snapshotDirectory = join(options.snapshotDirectory ?? join(directory, 'snapshots'), selectedNetwork);
        let snapshot = await existingSnapshot(snapshotDirectory, storage, selectedNetwork, publicationManifestSha256, COLLECTION_SIZE, options.prefix);
        const inventory = selected && snapshot ? await selectedInventory(storage, selectedNetwork, selected, concurrency, options.prefix)
          : await remoteInventory(storage, metadataPrefix(selectedNetwork, options.prefix));
        snapshot ??= await snapshotMetadata(storage, selectedNetwork, snapshotDirectory, inventory, publicationManifestSha256,
          { ...options, concurrency, priorCacheRoot: options.priorCacheRoot ?? resolve('.cache/111k-metadata') });
        const counts = await publishObjects({ storage, network: selectedNetwork, prefix: options.prefix, beforePut: () => lease?.beforePut() ?? Promise.resolve(), writeFence: lease, objects: generatedObjects(directory, selected), inventory,
          journal: join(directory, 'uploads', `${selectedNetwork}.jsonl`), sourceHash: manifest.objectsSha256, concurrency,
          total: selected?.size ?? manifest.objectCount, progress: options.progress });
        const report = { network: selectedNetwork, ...storage.destination, prefix: metadataPrefix(selectedNetwork, options.prefix),
          objectsSha256: manifest.objectsSha256, snapshotDirectory: resolve(snapshotDirectory), snapshotSha256: snapshot.archiveSha256,
          ...counts, complete: !selected, tokenIds: selected ? [...selected] : undefined, finishedAt: new Date().toISOString() };
        await writeReport(join(directory, `upload-${selectedNetwork}${selected ? '-sample' : ''}.json`), report);
        return report;
      }, options.prefix)); } finally { await lease?.close(); }
    }
    return reports;
  } finally { if (!options.storage) storage.close(); }
}

async function publicChecks(directory: string, network: MetadataNetwork, ids: string[], concurrency: number, prefix?: string) {
  const checks: Array<{ tokenId: string; sha256: string; cacheControl: string | null; cors: string | null }> = [];
  await uploadWithConcurrency(ids, Math.min(concurrency, 8), async tokenId => {
    const url = `https://cdn.mons.shop/${metadataPrefix(network, prefix)}${tokenId}.json`;
    const response = await fetch(url, { headers: { Origin: 'https://mons.shop', Accept: 'application/json' },
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json') ||
      response.headers.get('cache-control') !== 'no-store' || response.headers.get('access-control-allow-origin') !== '*' ||
      response.headers.get('cf-cache-status') === 'HIT') throw new Error(`Public metadata HTTP verification failed: ${url}`);
    const body = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(join(directory, `${tokenId}.json`));
    if (!body.equals(expected)) throw new Error(`Public metadata content mismatch: ${url}`);
    checks.push({ tokenId, sha256: sha256(body), cacheControl: response.headers.get('cache-control'), cors: response.headers.get('access-control-allow-origin') });
  });
  return checks.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
}

export async function verifyMetadata(directory: string, network: MetadataNetworkSelection,
  options: CommonOptions & { tokenIds?: string[] } = {}) {
  const manifest = await validatedManifest(directory);
  const selected = selectedIds(options.tokenIds);
  const concurrency = metadataUploadConcurrency(options.concurrency);
  const storage = options.storage ?? environmentStorage(concurrency);
  const reports = [];
  if (options.prefix && network === 'all') throw new Error('A deployment prefix requires one network');
  try {
    for (const selectedNetwork of metadataNetworks(network)) {
      const inventory = selected ? await selectedInventory(storage, selectedNetwork, selected, concurrency, options.prefix)
        : await remoteInventory(storage, metadataPrefix(selectedNetwork, options.prefix));
      let verified = 0;
      let totalBytes = 0;
      for await (const object of metadataObjects(directory)) {
        if (selected && !selected.has(object.tokenId)) continue;
        const actual = inventory.get(object.file)!;
        if (actual.bytes !== object.bytes || actual.md5 !== object.md5) throw new Error(`Remote metadata checksum mismatch: ${actual.key}`);
        verified++;
        totalBytes += object.bytes;
      }
      if (verified !== (selected?.size ?? manifest.objectCount) || !selected && totalBytes !== manifest.totalBytes) {
        throw new Error('Verified metadata count or size mismatch');
      }
      const samples = await publicChecks(directory, selectedNetwork, selected ? [...selected] : SAMPLE_IDS, concurrency, options.prefix);
      const report = { network: selectedNetwork, ...storage.destination, prefix: metadataPrefix(selectedNetwork, options.prefix),
        objectsSha256: manifest.objectsSha256, objectCount: verified, totalBytes, complete: !selected, samples, verifiedAt: new Date().toISOString() };
      await writeReport(join(directory, `verification-${selectedNetwork}${selected ? '-sample' : ''}.json`), report);
      options.progress?.({ phase: 'verify', network: selectedNetwork, completed: verified, total: selected?.size ?? manifest.objectCount });
      reports.push(report);
    }
    return reports;
  } finally { if (!options.storage) storage.close(); }
}

export async function restoreMetadata(snapshotDirectory: string, network: MetadataNetworkSelection, options: CommonOptions = {}) {
  const concurrency = metadataUploadConcurrency(options.concurrency);
  const storage = options.storage ?? environmentStorage(concurrency);
  const reports = [];
  if (options.prefix && network === 'all') throw new Error('A deployment prefix requires one network');
  try {
    for (const selectedNetwork of metadataNetworks(network)) {
      const prefix = metadataPrefix(selectedNetwork, options.prefix);
      const lease = options.publicationLease || !options.storage
        ? await (options.publicationLease ?? acquireMetadataPublicationLease)(`https://cdn.mons.shop/${prefix}`) : undefined;
      try { reports.push(await withDestinationLock(storage, selectedNetwork, async () => {
        const directory = join(snapshotDirectory, selectedNetwork);
        const manifest = await readSnapshotManifest(directory, storage, selectedNetwork, COLLECTION_SIZE, undefined, options.prefix);
        const expected = new Map<string, ObjectDigest>();
        for await (const { body: _, ...object } of snapshotObjects(directory, manifest)) expected.set(object.file, object);
        const restoreFiles = new Set(expected.keys());
        const inventory = await remoteInventory(storage, metadataPrefix(selectedNetwork, options.prefix), restoreFiles,
          { allowMissing: true, allowInvalidMetadata: true });
        const counts = await publishObjects({ storage, network: selectedNetwork, prefix: options.prefix, beforePut: () => lease?.beforePut() ?? Promise.resolve(), writeFence: lease, inventory, objects: snapshotObjects(directory, manifest),
          journal: join(directory, 'restore-journal.jsonl'), sourceHash: manifest.archiveSha256, concurrency, total: manifest.objectCount,
          progress: options.progress, restoreFiles });
        const restored = await remoteInventory(storage, metadataPrefix(selectedNetwork, options.prefix), restoreFiles);
        for (const [file, object] of expected) {
          const actual = restored.get(file)!;
          if (actual.bytes !== object.bytes || actual.md5 !== object.md5) throw new Error(`Restored object checksum mismatch: ${actual.key}`);
        }
        const report = { network: selectedNetwork, ...storage.destination, ...counts, complete: true,
          snapshotSha256: manifest.archiveSha256, restoredAt: new Date().toISOString() };
        await writeReport(join(directory, 'restore.json'), report);
        return report;
      }, options.prefix)); } finally { await lease?.close(); }
    }
    return reports;
  } finally { if (!options.storage) storage.close(); }
}
