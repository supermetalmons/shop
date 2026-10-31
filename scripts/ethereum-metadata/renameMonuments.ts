import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { createAsyncD1MaintenanceQuery } from '../shared/asyncD1MaintenanceQuery.ts';
import type { CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { withMetadataLock } from './lock.ts';
import { acquireMetadataPublicationLease, type MetadataPublicationLease } from './publicationLease.ts';
import {
  environmentStorage, metadataMd5, metadataPrefix, uploadWithConcurrency,
  type MetadataNamespaceStorage, type MetadataNetwork, type RemoteObject, type UploadDestination,
} from './storage.ts';

const ROOTS = ['111k/', '111k-sepolia/'];
const FIRST_LEGACY_TOKEN = 117_172;
const LAST_LEGACY_TOKEN = 117_201;
const MAX_BYTES = 128 * 1024;
const REGISTRY_SQL = 'SELECT * FROM ethereum_reveal_deployments WHERE chain_id IN (1, 11155111) ORDER BY metadata_base_uri';
const MIGRATION = 'monument-wording-v1';
type RegistryIdentity = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' |
  'metadataBaseUri' | 'deploymentBlock' | 'catalogVersion' | 'templateJson' | 'templateSha256'>;
type BodySnapshot = { body: string; bytes: number; md5: string; sha256: string };
type PlannedObject = { key: string; tokenId: number; before: BodySnapshot; after: BodySnapshot };
type Scope = { prefix: string; network: MetadataNetwork; deployment: RegistryIdentity | null;
  objectCount: number; keysSha256: string; objects: PlannedObject[] };
type MigrationPlan = { version: 1; migration: typeof MIGRATION; destination: UploadDestination; createdAt: string; scopes: Scope[] };
type Options = {
  storage?: MetadataNamespaceStorage;
  query?: CommerceAuthorityQuery;
  acquireLease?: (uri: string) => Promise<MetadataPublicationLease>;
  fetch?: typeof fetch;
  progress?: (value: object) => void;
};
type Dependencies = Required<Options>;
type CliArgs = { command: 'plan' | 'apply' | 'verify'; directory: string };

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const snapshot = (body: Buffer): BodySnapshot => ({ body: body.toString('utf8'), bytes: body.length, md5: metadataMd5(body), sha256: sha256(body) });
const canonicalBody = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function networkForPrefix(prefix: string): MetadataNetwork {
  const network = prefix.startsWith('111k-sepolia/') ? 'sepolia' : 'mainnet';
  if (metadataPrefix(network, prefix) !== prefix) throw new Error('Invalid migration prefix');
  return network;
}

function legacyToken(key: string, prefix: string): number {
  networkForPrefix(prefix);
  if (!key.startsWith(prefix) || !/^[1-9]\d*\.json$/.test(key.slice(prefix.length))) throw new Error(`Invalid metadata key: ${key}`);
  const tokenId = Number(key.slice(prefix.length, -5));
  if (!Number.isSafeInteger(tokenId) || tokenId < FIRST_LEGACY_TOKEN || tokenId > LAST_LEGACY_TOKEN) {
    throw new Error(`Metadata migration may only update legacy container tokens: ${key}`);
  }
  return tokenId;
}

export function renamedMonumentBody(key: string, prefix: string, body: Buffer): Buffer {
  const number = legacyToken(key, prefix) - FIRST_LEGACY_TOKEN + 1;
  if (body.length < 1 || body.length > MAX_BYTES || !Buffer.from(body.toString('utf8')).equals(body)) {
    throw new Error(`Invalid metadata body: ${key}`);
  }
  const value = JSON.parse(body.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.attributes)) {
    throw new Error(`Invalid container metadata: ${key}`);
  }
  const types = value.attributes.filter((attribute: unknown) => attribute && typeof attribute === 'object' &&
    'trait_type' in attribute && attribute.trait_type === 'type');
  if (types.length !== 1) throw new Error(`Expected exactly one container type trait: ${key}`);
  if (value.name === `Monument #${number}` && types[0].value === 'monument') {
    if (/reliquar/i.test(body.toString('utf8'))) throw new Error(`Unexpected legacy wording outside name/type: ${key}`);
    return body;
  }
  if (value.name !== `Reliquary #${number}` || types[0].value !== 'reliquary') {
    throw new Error(`Unexpected legacy container name or type: ${key}`);
  }
  value.name = `Monument #${number}`;
  types[0].value = 'monument';
  const result = canonicalBody(value);
  if (result.length > MAX_BYTES || /reliquar/i.test(result.toString('utf8'))) {
    throw new Error(`Unexpected legacy wording outside name/type: ${key}`);
  }
  return result;
}

function registryIdentity(value: EthereumRevealDeployment): RegistryIdentity {
  return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
    metadataBaseUri: value.metadataBaseUri, deploymentBlock: value.deploymentBlock, catalogVersion: value.catalogVersion,
    templateJson: value.templateJson, templateSha256: value.templateSha256 };
}

async function discover(deps: Dependencies): Promise<Array<Pick<Scope, 'prefix' | 'network' | 'deployment'>>> {
  const registry = (await deps.query(REGISTRY_SQL)).map(row => registryIdentity(parseEthereumRevealDeployment(row)));
  const deployments = new Map(registry.map(row => [new URL(row.metadataBaseUri).pathname.slice(1), row]));
  if (deployments.size !== registry.length) throw new Error('Duplicate metadata prefix in reveal registry');
  const prefixes = new Set(ROOTS);
  for (const root of ROOTS) {
    for await (const prefix of deps.storage.prefixes(root)) {
      if (!prefix.startsWith(root) || prefix === root) throw new Error('Invalid discovered metadata prefix');
      networkForPrefix(prefix);
      prefixes.add(prefix);
    }
  }
  for (const prefix of deployments.keys()) { networkForPrefix(prefix); prefixes.add(prefix); }
  return [...prefixes].sort().map(prefix => ({ prefix, network: networkForPrefix(prefix), deployment: deployments.get(prefix) ?? null }));
}

async function inventory(storage: MetadataNamespaceStorage, prefix: string) {
  let objectCount = 0;
  let previous = '';
  const hash = createHash('sha256');
  const objects: RemoteObject[] = [];
  for await (const object of storage.list(prefix)) {
    const file = object.key.slice(prefix.length);
    if (!object.key.startsWith(prefix) || !/^[1-9]\d*\.json$/.test(file) || object.key <= previous) {
      throw new Error(`Unexpected metadata inventory key: ${object.key}`);
    }
    previous = object.key;
    hash.update(`${object.key}\n`);
    objectCount++;
    const tokenId = Number(file.slice(0, -5));
    if (tokenId >= FIRST_LEGACY_TOKEN && tokenId <= LAST_LEGACY_TOKEN) objects.push(object);
  }
  return { objectCount, keysSha256: hash.digest('hex'), objects };
}

function validatePlan(value: MigrationPlan, destination: UploadDestination): MigrationPlan {
  if (!value || value.version !== 1 || value.migration !== MIGRATION || !same(value.destination, destination) ||
    !Array.isArray(value.scopes) || !value.scopes.length || typeof value.createdAt !== 'string') throw new Error('Invalid migration plan or destination');
  const seen = new Set<string>();
  for (const scope of value.scopes) {
    if (seen.has(scope.prefix) || networkForPrefix(scope.prefix) !== scope.network || !Number.isSafeInteger(scope.objectCount) || scope.objectCount < 0 ||
      !/^[a-f0-9]{64}$/.test(scope.keysSha256) || !Array.isArray(scope.objects)) throw new Error('Invalid migration scope');
    seen.add(scope.prefix);
    const keys = new Set<string>();
    for (const object of scope.objects) {
      if (keys.has(object.key) || legacyToken(object.key, scope.prefix) !== object.tokenId) throw new Error('Invalid or duplicate migration object');
      keys.add(object.key);
      for (const body of [object.before, object.after]) {
        if (!body || typeof body.body !== 'string' || !same(snapshot(Buffer.from(body.body)), body)) throw new Error(`Invalid migration snapshot: ${object.key}`);
      }
      const expected = renamedMonumentBody(object.key, scope.prefix, Buffer.from(object.before.body));
      if (!expected.equals(Buffer.from(object.after.body))) throw new Error(`Migration changes more than container wording: ${object.key}`);
    }
  }
  if (!ROOTS.every(root => seen.has(root))) throw new Error('Migration plan must include both network roots');
  return value;
}

async function loadPlan(directory: string, destination: UploadDestination) {
  const body = await readFile(join(directory, 'plan.json'), 'utf8');
  return { plan: validatePlan(JSON.parse(body), destination), planSha256: sha256(body) };
}

async function checkScopes(plan: MigrationPlan, deps: Dependencies): Promise<void> {
  const current = await discover(deps);
  const expected = plan.scopes.map(({ prefix, network, deployment }) => ({ prefix, network, deployment }));
  if (!same(current, expected)) throw new Error('Metadata namespaces or immutable registry identities changed; create a new migration plan');
  for (const scope of plan.scopes) {
    const observed = await inventory(deps.storage, scope.prefix);
    if (observed.objectCount !== scope.objectCount || observed.keysSha256 !== scope.keysSha256 ||
      !same(observed.objects.map(object => object.key), scope.objects.map(object => object.key))) {
      throw new Error(`Metadata object coverage changed: ${scope.prefix}`);
    }
    deps.progress({ phase: 'inventory-verified', prefix: scope.prefix, objectCount: scope.objectCount });
  }
}

async function writeReport(directory: string, file: string, value: object) {
  await writeFile(join(directory, `${file}.tmp`), canonicalBody(value));
  await rename(join(directory, `${file}.tmp`), join(directory, file));
}

function summary(plan: MigrationPlan) {
  return { destination: plan.destination, prefixes: plan.scopes.length,
    objects: plan.scopes.reduce((sum, scope) => sum + scope.objects.length, 0),
    changes: plan.scopes.reduce((sum, scope) => sum + scope.objects.filter(object => object.before.sha256 !== object.after.sha256).length, 0),
    scopes: plan.scopes.map(scope => ({ prefix: scope.prefix, registered: !!scope.deployment,
      objects: scope.objects.length, changes: scope.objects.filter(object => object.before.sha256 !== object.after.sha256).length })) };
}

async function createPlan(directory: string, deps: Dependencies) {
  try { await stat(join(directory, 'plan.json')); throw new Error('Migration plan already exists; use a new directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const plan: MigrationPlan = { version: 1, migration: MIGRATION, destination: deps.storage.destination, createdAt: new Date().toISOString(), scopes: [] };
  for (const scope of await discover(deps)) {
    const observed = await inventory(deps.storage, scope.prefix);
    const objects: PlannedObject[] = [];
    await uploadWithConcurrency(observed.objects, 8, async object => {
      const before = await deps.storage.get(object.key);
      if (before.length !== object.bytes || metadataMd5(before) !== object.md5) throw new Error(`Metadata changed while planning: ${object.key}`);
      const after = renamedMonumentBody(object.key, scope.prefix, before);
      objects.push({ key: object.key, tokenId: legacyToken(object.key, scope.prefix), before: snapshot(before), after: snapshot(after) });
    });
    objects.sort((a, b) => a.key.localeCompare(b.key));
    plan.scopes.push({ ...scope, objectCount: observed.objectCount, keysSha256: observed.keysSha256, objects });
    deps.progress({ phase: 'planned', prefix: scope.prefix, objects: objects.length });
  }
  validatePlan(plan, deps.storage.destination);
  await writeFile(join(directory, 'plan.json'), canonicalBody(plan), { flag: 'wx' });
  return { command: 'plan', dryRun: true, planFile: join(directory, 'plan.json'), ...summary(plan) };
}

async function journal(directory: string, plan: MigrationPlan, planSha256: string) {
  const path = join(directory, 'journal.jsonl');
  const header = JSON.stringify({ version: 1, migration: MIGRATION, destination: plan.destination, planSha256 });
  const allowed = new Map(plan.scopes.flatMap(scope => scope.objects.map(object => [object.key, object.after.sha256] as const)));
  try { await writeFile(path, `${header}\n`, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const content = await readFile(path, 'utf8');
  const complete = content.slice(0, content.lastIndexOf('\n') + 1);
  const lines = complete.trimEnd().split('\n');
  if (lines[0] !== header) throw new Error('Migration journal belongs to another plan');
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line);
    if (!allowed.has(row.key) || allowed.get(row.key) !== row.sha256 || !['written', 'already-renamed'].includes(row.status)) {
      throw new Error('Invalid migration journal record');
    }
  }
  if (content !== complete) await truncate(path, Buffer.byteLength(complete));
  return open(path, 'a');
}

async function checkedBody(storage: MetadataNamespaceStorage, object: PlannedObject): Promise<Buffer> {
  const body = await storage.get(object.key);
  if (!body.equals(Buffer.from(object.before.body)) && !body.equals(Buffer.from(object.after.body))) {
    throw new Error(`Metadata changed outside the approved migration: ${object.key}`);
  }
  return body;
}

async function applyPlan(directory: string, deps: Dependencies) {
  const { plan, planSha256 } = await loadPlan(directory, deps.storage.destination);
  await checkScopes(plan, deps);
  for (const scope of plan.scopes) await uploadWithConcurrency(scope.objects, 8, object => checkedBody(deps.storage, object).then(() => {}));
  const log = await journal(directory, plan, planSha256);
  let written = 0;
  let skipped = 0;
  try {
    for (const scope of plan.scopes) {
      if (!scope.objects.length) continue;
      const changes = scope.objects.some(object => object.before.sha256 !== object.after.sha256);
      const lease = !scope.deployment && changes ? await deps.acquireLease(`https://cdn.mons.shop/${scope.prefix}`) : undefined;
      try {
        for (const object of scope.objects) {
          legacyToken(object.key, scope.prefix);
          const current = await checkedBody(deps.storage, object);
          const after = Buffer.from(object.after.body);
          let status = 'already-renamed';
          if (!current.equals(after)) {
            await lease?.beforePut();
            await deps.storage.put(object.key, after, `"${object.before.md5}"`, lease);
            if (!(await deps.storage.get(object.key)).equals(after)) throw new Error(`Migration readback mismatch: ${object.key}`);
            status = 'written'; written++;
          } else skipped++;
          await log.writeFile(`${JSON.stringify({ key: object.key, sha256: object.after.sha256, status, at: new Date().toISOString() })}\n`);
          await log.sync();
        }
        deps.progress({ phase: 'applied', prefix: scope.prefix, written, skipped });
      } finally { await lease?.close(); }
    }
  } finally { await log.close(); }
  await checkScopes(plan, deps);
  const report = { command: 'apply', planSha256, written, skipped, finishedAt: new Date().toISOString(), ...summary(plan) };
  await writeReport(directory, 'apply-report.json', report);
  return report;
}

async function verifyPlan(directory: string, deps: Dependencies) {
  const { plan, planSha256 } = await loadPlan(directory, deps.storage.destination);
  await checkScopes(plan, deps);
  const checks: Array<{ key: string; sha256: string; cacheControl: string; cors: string }> = [];
  for (const scope of plan.scopes) {
    await uploadWithConcurrency(scope.objects, 8, async object => {
      const expected = Buffer.from(object.after.body);
      if (!(await deps.storage.get(object.key)).equals(expected)) throw new Error(`Metadata migration is incomplete: ${object.key}`);
      const response = await deps.fetch(`https://cdn.mons.shop/${object.key}`, { headers: { Origin: 'https://mons.shop', Accept: 'application/json' },
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json') ||
        response.headers.get('cache-control') !== 'no-store' || response.headers.get('access-control-allow-origin') !== '*' ||
        response.headers.get('cf-cache-status') === 'HIT' || !Buffer.from(await response.arrayBuffer()).equals(expected)) {
        throw new Error(`Public metadata migration verification failed: ${object.key}`);
      }
      checks.push({ key: object.key, sha256: object.after.sha256, cacheControl: 'no-store', cors: '*' });
    });
    deps.progress({ phase: 'verified', prefix: scope.prefix, objects: scope.objects.length });
  }
  await checkScopes(plan, deps);
  checks.sort((a, b) => a.key.localeCompare(b.key));
  const report = { command: 'verify', complete: true, planSha256, verifiedAt: new Date().toISOString(), checks, ...summary(plan) };
  await writeReport(directory, 'verification.json', report);
  return report;
}

export function parseMonumentMigrationArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { directory: { type: 'string' }, write: { type: 'boolean', default: false } } });
  const command = positionals[0] as CliArgs['command'];
  if (positionals.length !== 1 || !['plan', 'apply', 'verify'].includes(command) || !values.directory?.trim() ||
    values.write !== (command === 'apply')) {
    throw new Error('Usage: renameMonuments.ts <plan|apply|verify> --directory PATH [--write required only for apply]');
  }
  return { command, directory: resolve(values.directory) };
}

export async function runMonumentMigration(argv: string[], options: Options = {}) {
  const args = parseMonumentMigrationArgs(argv);
  const storage = options.storage ?? environmentStorage(8);
  if (storage.destination.bucket !== 'cdn-mons-shop') throw new Error('Monument metadata migration requires cdn-mons-shop');
  const query = options.query ?? createAsyncD1MaintenanceQuery('ops');
  const deps: Dependencies = { storage, query, acquireLease: options.acquireLease ?? (uri => acquireMetadataPublicationLease(uri, { query })),
    fetch: options.fetch ?? fetch, progress: options.progress ?? (() => {}) };
  try {
    await mkdir(args.directory, { recursive: true });
    return await withMetadataLock(join(args.directory, 'operation.lock'), async () => args.command === 'plan'
      ? createPlan(args.directory, deps) : args.command === 'apply' ? applyPlan(args.directory, deps) : verifyPlan(args.directory, deps));
  } finally { if (!options.storage) storage.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMonumentMigration(process.argv.slice(2), { progress: value => process.stderr.write(`${JSON.stringify(value)}\n`) })
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => { process.stderr.write(`Monument migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
}
