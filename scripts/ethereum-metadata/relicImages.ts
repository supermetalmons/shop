import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cancelResponseBody, readBoundedResponseBytes } from '../../cloud/workers/api/src/boundedResponse.ts';
import { ETHEREUM_REVEAL_DEPLOYMENT_ID, ETHEREUM_REVEAL_DEPLOYMENTS_SQL,
  parseEthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { parseRelicImagePatch, parseRelicImagesScope, RELIC_IMAGE_TOKEN_IDS, relicImageSha256,
  type RelicImagePatch, type RelicImagesRequest, type RelicImagesResult, type RelicImagesScope } from '../../shared/ethereum/relicImages.ts';
import { createAsyncD1MaintenanceQuery } from '../shared/asyncD1MaintenanceQuery.ts';
import { sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { withMetadataLock } from './lock.ts';

const API = 'https://api.mons.shop/ethereum/111k';
const ORIGIN = 'https://mons.shop';
const MAX_JSON_BYTES = 128 * 1024;
type RelicImagesTransport = (request: RelicImagesRequest) => Promise<RelicImagesResult>;
type Dependencies = {
  query?: CommerceAuthorityQuery;
  transport?: RelicImagesTransport;
  fetch?: typeof fetch;
  now?: () => Date;
  onProgress?: (progress: { tokenId: string; status: 'updated' | 'unchanged'; completed: number; total: number }) => void;
};
type JournalBody = { version: 1; preparedAt: string; scope: RelicImagesScope; objects: RelicImagePatch[] };
export type RelicImagesJournal = JournalBody & { journalSha256: string };
export type RelicImagesVerification = {
  deploymentId: string; journalSha256: string; verifiedAt: string; complete: true;
  objectCount: number; storageVerified: number; cdnVerified: number; apiVerified: number;
  metadataBaseUri: string; expectedRevision: number;
};

function journalBody(value: RelicImagesJournal | JournalBody): JournalBody {
  return { version: value.version, preparedAt: value.preparedAt, scope: value.scope, objects: value.objects };
}

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function parseObjects(value: unknown): RelicImagePatch[] {
  if (!Array.isArray(value) || value.length !== RELIC_IMAGE_TOKEN_IDS.length) throw new Error('Relic inspection must contain all 18 objects.');
  const objects = value.map(parseRelicImagePatch).sort((left, right) => Number(left.tokenId) - Number(right.tokenId));
  if (objects.some((object, index) => object.tokenId !== RELIC_IMAGE_TOKEN_IDS[index])) throw new Error('Relic inspection contains unexpected or duplicate token IDs.');
  return objects;
}

export async function readRelicImagesJournal(directory: string): Promise<RelicImagesJournal> {
  const raw = await readFile(join(resolve(directory), 'journal.json'), 'utf8');
  if (Buffer.byteLength(raw) > 6 * 1024 * 1024) throw new Error('Relic image journal is too large.');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relic image journal.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'journalSha256,objects,preparedAt,scope,version' || row.version !== 1 ||
    typeof row.preparedAt !== 'string' || !Number.isFinite(Date.parse(row.preparedAt)) ||
    typeof row.journalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.journalSha256)) throw new Error('Invalid relic image journal.');
  const journal: RelicImagesJournal = { version: 1, preparedAt: row.preparedAt,
    scope: parseRelicImagesScope(row.scope), objects: parseObjects(row.objects), journalSha256: row.journalSha256 };
  if (relicImageSha256(JSON.stringify(journalBody(journal))) !== journal.journalSha256) throw new Error('Relic image journal checksum mismatch.');
  return journal;
}

async function withTransport<T>(dependencies: Dependencies, work: (transport: RelicImagesTransport) => Promise<T>): Promise<T> {
  if (dependencies.transport) return work(dependencies.transport);
  return withEthereumRevealMaintenance(async maintenance => {
    if (!maintenance.relicImages) throw new Error('The deployed reveal maintenance binding does not support relic images.');
    return work(request => maintenance.relicImages!(request));
  });
}

async function readPublicJson(url: string, fetcher: typeof fetch): Promise<{ body: string; value: Record<string, unknown> }> {
  const signal = AbortSignal.timeout(15_000);
  const response = await fetcher(url, { headers: { Origin: ORIGIN, Accept: 'application/json' }, cache: 'no-store', redirect: 'manual', signal });
  if (response.status !== 200 || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
    !['*', ORIGIN].includes(response.headers.get('access-control-allow-origin') ?? '') ||
    response.headers.get('cache-control') !== 'no-store' || response.headers.get('cf-cache-status') === 'HIT') {
    await cancelResponseBody(response);
    throw new Error(`Invalid public relic metadata response: ${url} (HTTP ${response.status}).`);
  }
  const bytes = await readBoundedResponseBytes(response, { maxBytes: MAX_JSON_BYTES, signal,
    createError: () => new Error(`Invalid public relic metadata body: ${url}.`) });
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid public relic JSON object: ${url}.`);
  return { body, value: value as Record<string, unknown> };
}

async function requirePublicScope(scope: RelicImagesScope, fetcher: typeof fetch): Promise<void> {
  const query = new URLSearchParams({ chainId: String(scope.chainId), contractAddress: scope.contractAddress });
  const url = `${API}/config${scope.chainId === 11155111 ? '' : `?${query}`}`;
  const { value } = await readPublicJson(url, fetcher);
  if (value.deploymentId !== scope.deploymentId || value.chainId !== scope.chainId || value.contractAddress !== scope.contractAddress ||
    value.metadataBaseUri !== scope.metadataBaseUri) throw new Error('The live public configuration does not match the frozen relic deployment.');
}

async function discoverScope(deploymentId: string, query: CommerceAuthorityQuery): Promise<RelicImagesScope> {
  if (!ETHEREUM_REVEAL_DEPLOYMENT_ID.test(deploymentId)) throw new Error('Invalid deployment ID.');
  const rows = await query(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id = ${sqlString(deploymentId)}`);
  if (rows.length !== 1) throw new Error('Relic image deployment is not registered.');
  const deployment = parseEthereumRevealDeployment(rows[0]);
  if (deployment.retiredAtMs != null || deployment.catalogUpdateId != null) throw new Error('Relic images require a current deployment without an active catalog update.');
  return parseRelicImagesScope({ deploymentId: deployment.deploymentId, chainId: deployment.chainId,
    contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri, expectedRevision: deployment.revision });
}

async function inspect(scope: RelicImagesScope, transport: RelicImagesTransport): Promise<RelicImagePatch[]> {
  const result = await transport({ scope, action: 'inspect' });
  if (result.action !== 'inspect') throw new Error('Invalid relic image inspection result.');
  return parseObjects(result.objects);
}

function requireExpectedObjects(journal: RelicImagesJournal, objects: RelicImagePatch[], complete: boolean): void {
  for (const [index, object] of objects.entries()) {
    const expected = journal.objects[index];
    const matchesTarget = object.beforeJson === expected.afterJson && object.beforeSha256 === expected.afterSha256;
    const matchesSource = object.beforeJson === expected.beforeJson && object.beforeSha256 === expected.beforeSha256 && object.etag === expected.etag;
    if (object.tokenId !== expected.tokenId || (!matchesTarget && (complete || !matchesSource))) {
      throw new Error(`Relic token ${object.tokenId} differs from the frozen ${complete ? 'target' : 'source and target'} metadata.`);
    }
  }
}

export async function prepareRelicImages(directory: string, deploymentId: string, dependencies: Dependencies = {}): Promise<RelicImagesJournal> {
  const destination = resolve(directory);
  await mkdir(dirname(destination), { recursive: true });
  return withMetadataLock(`${destination}.lock`, async () => {
    if (await optionalFile(join(destination, 'journal.json')) !== null) {
      const existing = await readRelicImagesJournal(destination);
      if (existing.scope.deploymentId !== deploymentId) throw new Error('This relic image journal belongs to a different deployment.');
      await requirePublicScope(existing.scope, dependencies.fetch ?? fetch);
      await withTransport(dependencies, async transport => requireExpectedObjects(existing, await inspect(existing.scope, transport), false));
      return existing;
    }
    const scope = await discoverScope(deploymentId, dependencies.query ?? createAsyncD1MaintenanceQuery('ops'));
    await requirePublicScope(scope, dependencies.fetch ?? fetch);
    const objects = await withTransport(dependencies, transport => inspect(scope, transport));
    const body: JournalBody = { version: 1, preparedAt: (dependencies.now ?? (() => new Date()))().toISOString(), scope, objects };
    const journal = { ...body, journalSha256: relicImageSha256(JSON.stringify(body)) };
    const staging = `${destination}.staging-${randomUUID()}`;
    await mkdir(staging);
    try {
      await writeFile(join(staging, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
      await rename(staging, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return journal;
  });
}

export async function applyRelicImages(directory: string, dependencies: Dependencies = {}): Promise<{
  deploymentId: string; journalSha256: string; applied: true; complete: false; objectCount: number; updated: number; unchanged: number;
}> {
  const destination = resolve(directory);
  return withMetadataLock(`${destination}.lock`, async () => {
    const journal = await readRelicImagesJournal(destination);
    await requirePublicScope(journal.scope, dependencies.fetch ?? fetch);
    return withTransport(dependencies, async transport => {
      requireExpectedObjects(journal, await inspect(journal.scope, transport), false);
      const completed: Array<{ tokenId: string; status: 'updated' | 'unchanged' }> = [];
      await rm(join(destination, 'verification.json'), { force: true });
      for (const patch of journal.objects) {
        const result = await transport({ scope: journal.scope, action: 'apply', patch });
        if (result.action !== 'apply' || result.tokenId !== patch.tokenId || !['updated', 'unchanged'].includes(result.status)) {
          throw new Error(`Invalid relic image application result for token ${patch.tokenId}.`);
        }
        completed.push({ tokenId: result.tokenId, status: result.status });
        await writeJson(join(destination, 'progress.json'), { journalSha256: journal.journalSha256,
          updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(), complete: false, completed });
        dependencies.onProgress?.({ tokenId: result.tokenId, status: result.status, completed: completed.length, total: journal.objects.length });
      }
      requireExpectedObjects(journal, await inspect(journal.scope, transport), true);
      return { deploymentId: journal.scope.deploymentId, journalSha256: journal.journalSha256, applied: true, complete: false,
        objectCount: completed.length, updated: completed.filter(item => item.status === 'updated').length,
        unchanged: completed.filter(item => item.status === 'unchanged').length };
    });
  });
}

async function concurrent<T>(values: readonly T[], work: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length && failure === undefined) {
      const value = values[next++];
      try { await work(value); } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
}

export async function verifyRelicImages(directory: string, dependencies: Dependencies = {}): Promise<RelicImagesVerification> {
  const destination = resolve(directory);
  return withMetadataLock(`${destination}.lock`, async () => {
    const journal = await readRelicImagesJournal(destination);
    const fetcher = dependencies.fetch ?? fetch;
    await rm(join(destination, 'verification.json'), { force: true });
    await requirePublicScope(journal.scope, fetcher);
    await withTransport(dependencies, async transport => requireExpectedObjects(journal, await inspect(journal.scope, transport), true));
    await concurrent(journal.objects, async object => {
      const url = `${journal.scope.metadataBaseUri}${object.tokenId}.json`;
      const cdn = await readPublicJson(url, fetcher);
      if (cdn.body !== object.afterJson || relicImageSha256(cdn.body) !== object.afterSha256) throw new Error(`Public relic metadata differs for token ${object.tokenId}.`);
      const query = new URLSearchParams({ chainId: String(journal.scope.chainId), contractAddress: journal.scope.contractAddress,
        kind: 'relic', displayId: String(Number(object.tokenId) - 117171) });
      const api = await readPublicJson(`${API}/metadata?${query}`, fetcher);
      const expected: unknown = JSON.parse(object.afterJson);
      const metadata = { ...api.value };
      for (const key of ['deploymentId', 'dropId', 'chainId', 'contractAddress', 'catalogRevision']) delete metadata[key];
      if (!isDeepStrictEqual(metadata, expected)) throw new Error(`Relic metadata API differs for token ${object.tokenId}.`);
      if (api.value.deploymentId !== journal.scope.deploymentId || api.value.chainId !== journal.scope.chainId ||
        api.value.contractAddress !== journal.scope.contractAddress) throw new Error(`Relic metadata API identity differs for token ${object.tokenId}.`);
    });
    await withTransport(dependencies, async transport => requireExpectedObjects(journal, await inspect(journal.scope, transport), true));
    const report: RelicImagesVerification = { deploymentId: journal.scope.deploymentId, journalSha256: journal.journalSha256,
      verifiedAt: (dependencies.now ?? (() => new Date()))().toISOString(), complete: true, objectCount: journal.objects.length,
      storageVerified: journal.objects.length, cdnVerified: journal.objects.length, apiVerified: journal.objects.length,
      metadataBaseUri: journal.scope.metadataBaseUri, expectedRevision: journal.scope.expectedRevision };
    await writeJson(join(destination, 'verification.json'), report);
    return report;
  });
}
