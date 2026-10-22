import { isDeepStrictEqual } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAG_PREFIX = 'worker-tx-';
const RESTORE_TAG_PREFIX = 'worker-source-';
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CONFIG_FIELDS = ['compatibility_date', 'compatibility_flags', 'main_module', 'modules', 'placement', 'usage_model',
  'assets', 'exports', 'limits', 'observability', 'tail_consumers', 'logpush', 'cache_options', 'containers', 'package_dependencies'];

export const WORKER_SIGNER_RUNTIME = Object.freeze({
  compatibility_date: '2026-08-08',
  compatibility_flags: Object.freeze(['nodejs_compat', 'enable_request_signal']),
});

export type WorkerSnapshot = {
  deploymentId: string;
  versionId: string;
  latestVersionId: string;
  previewSuffix: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  secretNames: string[];
};

export type TemporaryWorkerVersion = {
  id: string;
  url: string;
  operationId: string;
};

export type SourceRestoration = {
  started: boolean;
  versionId?: string;
};

type RestorationOptions = {
  restoration?: SourceRestoration;
  onRestorationChange?: (state: SourceRestoration) => void;
};

type Envelope = { result?: unknown; result_info?: unknown; success?: unknown; errors?: unknown };
type Deployment = { id: string; versions: { version_id: string; percentage: number }[] };

class CloudflareRequestRejectedError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Cloudflare returned an invalid version or deployment identifier.');
  return value;
}

function tag(operationId: string): string {
  return `${TAG_PREFIX}${uuid(operationId)}`;
}

function validatePreviewSuffix(suffix: string, workerName: string): string {
  const parts = typeof suffix === 'string' ? suffix.split('.') : [];
  if (parts.length !== 4 || parts[0] !== workerName || !DNS_LABEL.test(parts[1]) || parts[2] !== 'workers' || parts[3] !== 'dev') {
    throw new Error('Cloudflare Version URL suffix is invalid.');
  }
  return suffix;
}

function sourcePreviewSuffix(value: unknown, versionId: string, workerName: string): string {
  if (!Array.isArray(value)) throw new Error('The production Worker does not have Version URLs enabled.');
  const suffixes = value.flatMap(candidate => {
    if (typeof candidate !== 'string') return [];
    try {
      const url = new URL(candidate);
      const prefix = `${uuid(versionId).slice(0, 8)}-`;
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
        !url.hostname.startsWith(prefix)) return [];
      return [validatePreviewSuffix(url.hostname.slice(prefix.length), workerName)];
    } catch { return []; }
  });
  if (suffixes.length !== 1) throw new Error('The production Worker does not have one valid Version URL.');
  return suffixes[0];
}

function previewUrl(versionId: string, snapshot: WorkerSnapshot, workerName: string): string {
  return `https://${uuid(versionId).slice(0, 8)}-${validatePreviewSuffix(snapshot.previewSuffix, workerName)}`;
}

function parseTemporary(value: unknown, operationId: string, snapshot: WorkerSnapshot, workerName: string): TemporaryWorkerVersion {
  if (!record(value) || !record(value.annotations) || value.annotations['workers/tag'] !== tag(operationId)) {
    throw new Error('Cloudflare temporary version does not match this operation.');
  }
  const id = uuid(value.id);
  const url = previewUrl(id, snapshot, workerName);
  return { id, url, operationId };
}

function deployment(value: unknown): Deployment {
  if (!record(value) || !Array.isArray(value.deployments) || !record(value.deployments[0])) {
    throw new Error('Cloudflare returned no current production deployment.');
  }
  const current = value.deployments[0];
  const id = uuid(current.id);
  if (!Array.isArray(current.versions) || !current.versions.length) throw new Error('Cloudflare deployment versions are missing.');
  const versions = current.versions.map((entry) => {
    if (!record(entry) || typeof entry.percentage !== 'number' || entry.percentage <= 0 || entry.percentage > 100) {
      throw new Error('Cloudflare deployment allocation is invalid.');
    }
    return { version_id: uuid(entry.version_id), percentage: entry.percentage };
  });
  if (versions.reduce((sum, entry) => sum + entry.percentage, 0) !== 100) throw new Error('Cloudflare deployment allocation is incomplete.');
  return { id, versions };
}

function sameDeployment(expected: WorkerSnapshot, current: Deployment): boolean {
  return current.id === expected.deploymentId && current.versions.length === 1 &&
    current.versions[0].version_id === expected.versionId && current.versions[0].percentage === 100;
}

function assertSameDeployment(expected: WorkerSnapshot, current: Deployment): void {
  if (!sameDeployment(expected, current)) {
    throw new Error('The production Worker deployment changed during the transaction operation.');
  }
}

function assertSupportedSource(value: Record<string, unknown>): void {
  const sourceTag = record(value.annotations) ? value.annotations['workers/tag'] : undefined;
  if ((typeof sourceTag === 'string' && sourceTag.startsWith(TAG_PREFIX)) || value.main_module === 'worker-transaction-signer.js') {
    throw new Error('A temporary transaction signer cannot be used as a Worker source. Recover its original operation first.');
  }
  const migrations = value.migrations;
  const migrationTag = value.migration_tag;
  const containers = value.containers;
  const exports = value.exports;
  const bindings = value.bindings;
  const reconciliation = value.exports_reconciliation;
  if ((migrations !== undefined && (!record(migrations) || Object.keys(migrations).length > 0)) ||
    (migrationTag !== undefined && (typeof migrationTag !== 'string' || migrationTag.length > 0)) ||
    (containers !== undefined && (!Array.isArray(containers) || containers.length > 0)) ||
    (reconciliation !== undefined && (!record(reconciliation) || ['deleted', 'renamed', 'transferred', 'transfer_pending'].some(field =>
      reconciliation[field] !== undefined && (!Array.isArray(reconciliation[field]) || reconciliation[field].length > 0)))) ||
    (bindings !== undefined && (!Array.isArray(bindings) || bindings.some(binding => !record(binding) || binding.type === 'durable_object_namespace'))) ||
    (exports !== undefined && (!record(exports) || Object.values(exports).some(entry => !record(entry) ||
      !['worker', 'workflow'].includes(String(entry.type)) || (entry.state !== undefined && entry.state !== 'created') ||
      ['renamed_to', 'transferred_to', 'transfer_from', 'storage', 'container'].some(field => Object.hasOwn(entry, field)))))) {
    throw new Error('Durable Object lifecycle sources are unsupported for temporary Worker transactions.');
  }
}

function sourceConfiguration(value: unknown): Record<string, unknown> {
  if (!record(value) || typeof value.main_module !== 'string' || !Array.isArray(value.modules) || !value.modules.length ||
    !value.modules.every(module => record(module) && typeof module.name === 'string' && typeof module.content_type === 'string' &&
      typeof module.content_base64 === 'string') || !Array.isArray(value.bindings)) {
    throw new Error('Cloudflare source version code or bindings are missing.');
  }
  assertSupportedSource(value);
  return Object.fromEntries(CONFIG_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function sortedBindings(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(binding => record(binding) && typeof binding.name === 'string' && typeof binding.type === 'string')) {
    throw new Error('Cloudflare source version bindings are invalid.');
  }
  return [...value].sort((a, b) => a.name.localeCompare(b.name));
}

export function createWorkerVersionClient(args: {
  token: string;
  target: { accountId: string; workerName: string };
  signerBinding?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const token = args.token.trim();
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  const { accountId, workerName } = args.target;
  if (!/^[0-9a-f]{32}$/i.test(accountId) || !DNS_LABEL.test(workerName)) throw new Error('Cloudflare Worker target is invalid.');
  const signerBinding = args.signerBinding ?? 'COSIGNER_SECRET';
  if (!BINDING_NAME.test(signerBinding)) throw new Error('Worker signing secret binding name is invalid.');
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const versionsPath = `/workers/workers/${encodeURIComponent(workerName)}/versions`;
  const deploymentsPath = `/workers/scripts/${encodeURIComponent(workerName)}/deployments`;
  const providerFetch = args.fetch ?? fetch;
  const timeoutMs = args.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Cloudflare timeout must be a positive integer.');

  async function request(path: string, init: RequestInit = {}, allowMissing = false): Promise<Envelope | null> {
    let response: Response;
    let payload: Envelope;
    try {
      response = await providerFetch(`${apiBase}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error();
      payload = JSON.parse(body);
    } catch {
      throw new Error('Cloudflare version request failed or returned an unreadable response.');
    }
    if (!response.ok || !record(payload) || payload.success !== true) {
      const codes = Array.isArray(payload?.errors)
        ? payload.errors.flatMap(error => record(error) && Number.isSafeInteger(error.code) ? [error.code] : []) : [];
      const message = `Cloudflare version request failed with HTTP ${response.status}${codes.length ? ` (codes ${codes.join(', ')})` : ''}.`;
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && record(payload) && payload.success === false) {
        throw new CloudflareRequestRejectedError(message);
      }
      throw new Error(message);
    }
    return payload;
  }

  async function readDeployment(): Promise<Deployment> {
    return deployment((await request(deploymentsPath))!.result);
  }

  async function assertUnchanged(snapshot: WorkerSnapshot): Promise<void> {
    validatePreviewSuffix(snapshot.previewSuffix, workerName);
    assertSameDeployment(snapshot, await readDeployment());
  }

  async function latestVersionId(): Promise<string> {
    const latest = (await request(`${versionsPath}/latest`))!.result;
    if (!record(latest)) throw new Error('Cloudflare latest version metadata is invalid.');
    return uuid(latest.id);
  }

  async function assertLatestUnchanged(snapshot: WorkerSnapshot): Promise<void> {
    const latest = (await request(`${versionsPath}/latest`))!.result;
    if (!record(latest)) throw new Error('Cloudflare latest version metadata is invalid.');
    if (uuid(latest.id) !== uuid(snapshot.latestVersionId)) {
      throw new Error('The latest Worker version changed before upload. Retry with a fresh snapshot; no version was uploaded.');
    }
    assertSupportedSource(latest);
  }

  async function assertActiveSource(snapshot: WorkerSnapshot): Promise<void> {
    const active = (await request(`${versionsPath}/${uuid(snapshot.versionId)}`))!.result;
    if (!record(active) || active.id !== snapshot.versionId) throw new Error('Cloudflare production version identity is invalid.');
    assertSupportedSource(active);
  }

  async function findRestoration(restoreTag: string): Promise<string> {
    const found: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = (await request(`${versionsPath}?page=${page}&per_page=100`))!;
      if (!Array.isArray(result.result) || !record(result.result_info) || result.result_info.page !== page ||
        !Number.isSafeInteger(result.result_info.total_count)) throw new Error('Cloudflare version inventory is invalid.');
      for (const entry of result.result) {
        if (record(entry) && record(entry.annotations) && entry.annotations['workers/tag'] === restoreTag) {
          found.push(uuid(entry.id));
        }
      }
      if (found.length > 1) throw new Error('Multiple source restoration versions match this operation; preserve its pending record for inspection.');
      if (page * 100 >= Number(result.result_info.total_count)) {
        if (!found.length) throw new Error('Source restoration upload is unresolved; preserve its pending record and retry reconciliation.');
        return found[0];
      }
    }
    throw new Error('Cloudflare version inventory exceeded the source restoration recovery limit.');
  }

  async function restoreSourceLatest(options: { snapshot: WorkerSnapshot; operationId: string } & RestorationOptions): Promise<{ id: string; sourceVersionId: string } | null> {
    const { snapshot, operationId } = options;
    const restoreTag = `${RESTORE_TAG_PREFIX}${uuid(operationId)}`;
    let restoration = options.restoration;
    let restoredId: string | undefined;
    let temporaryId: string | undefined;
    if (restoration?.started) {
      restoredId = restoration.versionId ? uuid(restoration.versionId) : await findRestoration(restoreTag);
    } else {
      const latest = (await request(`${versionsPath}/latest`))!.result;
      if (!record(latest)) throw new Error('Cloudflare latest version metadata is invalid.');
      const latestId = uuid(latest.id);
      if (latest.annotations === undefined) return null;
      if (!record(latest.annotations)) throw new Error('Cloudflare latest version metadata is invalid.');
      if (latest.annotations['workers/tag'] === restoreTag) restoredId = latestId;
      else if (latest.annotations['workers/tag'] === tag(operationId)) temporaryId = latestId;
      else return null;
    }
    const sourceVersionId = uuid(snapshot.latestVersionId);
    const source = (await request(`${versionsPath}/${sourceVersionId}?include=modules`))!.result;
    if (!record(source) || source.id !== sourceVersionId) throw new Error('Cloudflare source version identity is invalid.');
    const configuration = sourceConfiguration(source);
    const bindings = sortedBindings(source.bindings);
    if (!restoredId) {
      if (!options.onRestorationChange) throw new Error('Source restoration requires a durable upload marker before creating a version.');
      const body = JSON.stringify({ ...configuration,
        bindings: bindings.map(binding => ({ name: binding.name, type: 'inherit', version_id: sourceVersionId })),
        annotations: { 'workers/tag': restoreTag, 'workers/message': 'Exact pre-operation latest source copy for temporary transaction signer cleanup; production routing unchanged.' },
      });
      if (await latestVersionId() !== temporaryId) return null;
      restoration = { started: true };
      options.onRestorationChange(restoration);
      let response: Envelope | null;
      try {
        response = await request(`${versionsPath}?deploy=false`, { method: 'POST', body });
      } catch (error) {
        if (error instanceof CloudflareRequestRejectedError) options.onRestorationChange({ started: false });
        throw error;
      }
      const result = response!.result;
      if (!record(result) || !record(result.annotations) || result.annotations['workers/tag'] !== restoreTag) {
        throw new Error('Cloudflare source restoration returned unexpected metadata.');
      }
      restoredId = uuid(result.id);
    }
    if (restoredId === snapshot.versionId || restoredId === sourceVersionId || restoredId === temporaryId) {
      throw new Error('Cloudflare source restoration returned an existing source or temporary version.');
    }
    if (options.onRestorationChange && restoration?.versionId !== restoredId) {
      options.onRestorationChange({ started: true, versionId: restoredId });
    }
    const restored = (await request(`${versionsPath}/${restoredId}?include=modules`))!.result;
    if (!record(restored) || restored.id !== restoredId || !record(restored.annotations) || restored.annotations['workers/tag'] !== restoreTag ||
      !isDeepStrictEqual(configuration, sourceConfiguration(restored)) ||
      !isDeepStrictEqual(bindings, sortedBindings(restored.bindings)) || !isDeepStrictEqual(source.env, restored.env)) {
      throw new Error('Restored Worker code or resource bindings differ from the production source.');
    }
    return { id: restoredId, sourceVersionId };
  }

  return {
    async snapshot(): Promise<WorkerSnapshot> {
      const active = await readDeployment();
      if (active.versions.length !== 1) throw new Error('The transaction operation requires one Worker version receiving all production traffic.');
      const versionId = active.versions[0].version_id;
      const version = (await request(`${versionsPath}/${versionId}`))!.result;
      if (!record(version)) throw new Error('Cloudflare production version configuration is invalid.');
      assertSupportedSource(version);
      const compatibilityFlags = version.compatibility_flags === undefined ? [] : version.compatibility_flags;
      if (version.id !== versionId || typeof version.compatibility_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(version.compatibility_date) || !Array.isArray(compatibilityFlags) ||
        !compatibilityFlags.every(flag => typeof flag === 'string') || !Array.isArray(version.bindings)) {
        throw new Error('Cloudflare production version configuration is invalid.');
      }
      const previewSuffix = sourcePreviewSuffix(version.urls, versionId, workerName);
      const secretNames = version.bindings.filter(binding => record(binding) && binding.type === 'secret_text').map(binding => {
        if (!record(binding) || typeof binding.name !== 'string' || !BINDING_NAME.test(binding.name)) {
          throw new Error('Cloudflare production secret binding name is invalid.');
        }
        return binding.name;
      }).sort();
      if (new Set(secretNames).size !== secretNames.length || !secretNames.includes(signerBinding)) {
        throw new Error('Cloudflare production signing secret binding is missing or duplicated.');
      }
      const latest = (await request(`${versionsPath}/latest`))!.result;
      if (!record(latest)) throw new Error('Cloudflare latest version metadata is invalid.');
      assertSupportedSource(latest);
      const result = {
        deploymentId: active.id, versionId, latestVersionId: uuid(latest.id), previewSuffix, compatibilityDate: version.compatibility_date,
        compatibilityFlags: [...compatibilityFlags] as string[], secretNames,
      };
      await assertUnchanged(result);
      await assertLatestUnchanged(result);
      return result;
    },
    assertUnchanged,
    restoreSourceLatest,
    async upload(options: { snapshot: WorkerSnapshot; bundle: string; operationId: string; onUploadChange: (started: boolean) => void }): Promise<TemporaryWorkerVersion> {
      const { snapshot, bundle, operationId } = options;
      if (!bundle || Buffer.byteLength(bundle) > 8 * 1024 * 1024) throw new Error('Temporary signer bundle is empty or too large.');
      await assertUnchanged(snapshot);
      await assertActiveSource(snapshot);
      await assertLatestUnchanged(snapshot);
      const body = JSON.stringify({
        main_module: 'worker-transaction-signer.js',
        modules: [{ name: 'worker-transaction-signer.js', content_type: 'application/javascript+module', content_base64: Buffer.from(bundle).toString('base64') }],
        ...WORKER_SIGNER_RUNTIME,
        bindings: snapshot.secretNames.map(name => ({ name, type: 'inherit', version_id: snapshot.versionId })),
        annotations: { 'workers/tag': tag(operationId), 'workers/message': 'Temporary pinned transaction signer; do not deploy.' },
      });
      options.onUploadChange(true);
      let result: Envelope | null;
      try {
        result = await request(`${versionsPath}?deploy=false`, { method: 'POST', body });
      } catch (error) {
        if (error instanceof CloudflareRequestRejectedError) options.onUploadChange(false);
        throw error;
      }
      const uploaded = parseTemporary(result!.result, operationId, snapshot, workerName);
      if (uploaded.id === snapshot.versionId) throw new Error('Cloudflare unexpectedly returned the production version for the temporary signer.');
      return uploaded;
    },
    async findOperation(options: { operationId: string; snapshot: WorkerSnapshot }): Promise<TemporaryWorkerVersion[]> {
      const { operationId, snapshot } = options;
      validatePreviewSuffix(snapshot.previewSuffix, workerName);
      const expectedTag = tag(operationId);
      const found: TemporaryWorkerVersion[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = (await request(`${versionsPath}?page=${page}&per_page=100`))!;
        if (!Array.isArray(result.result) || !record(result.result_info) || result.result_info.page !== page ||
          !Number.isSafeInteger(result.result_info.total_count)) throw new Error('Cloudflare version inventory is invalid.');
        for (const entry of result.result) {
          if (record(entry) && record(entry.annotations) && entry.annotations['workers/tag'] === expectedTag) {
            found.push(parseTemporary(entry, operationId, snapshot, workerName));
          }
        }
        if (page * 100 >= Number(result.result_info.total_count)) return found;
      }
      throw new Error('Cloudflare version inventory exceeded the recovery limit; inspect the saved operation tag before retrying.');
    },
    async remove(options: { snapshot: WorkerSnapshot; version: TemporaryWorkerVersion } & RestorationOptions): Promise<void> {
      const { snapshot, version } = options;
      uuid(version.id);
      if (version.id === snapshot.versionId) throw new Error('Refusing to delete the production source version.');
      const current = await readDeployment();
      if (current.versions.some(entry => entry.version_id === version.id)) throw new Error('Refusing to delete a deployed Worker version.');
      const existing = await request(`${versionsPath}/${version.id}`, {}, true);
      if (!existing && !options.restoration?.started) return;
      if (existing) parseTemporary(existing.result, version.operationId, snapshot, workerName);
      await restoreSourceLatest({ snapshot, operationId: version.operationId,
        restoration: options.restoration, onRestorationChange: options.onRestorationChange });
      if (existing) await request(`${versionsPath}/${version.id}`, { method: 'DELETE' });
    },
    async verifyRemoved(options: { snapshot: WorkerSnapshot; version: TemporaryWorkerVersion }): Promise<{
      absent: true; previewStatus: number; productionUnchanged: boolean; restoredVersion?: string;
    }> {
      const { snapshot, version } = options;
      const expectedUrl = previewUrl(version.id, snapshot, workerName);
      if (version.url !== expectedUrl || version.id === snapshot.versionId) throw new Error('Temporary version cleanup identity is invalid.');
      if (await request(`${versionsPath}/${version.id}`, {}, true)) throw new Error('Temporary Worker version still exists after cleanup.');
      let response: Response;
      let deletedVersionEdgeError = false;
      try {
        response = await providerFetch(`${expectedUrl}/sign`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 500 && response.headers.get('content-type')?.startsWith('text/html') && response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 32_768) throw new Error('Preview error response exceeded its limit.');
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const body = Buffer.concat(chunks).toString('utf8');
          deletedVersionEdgeError = /<span\s+class=["']cf-error-code["'][^>]*>\s*1101\s*<\/span>/.test(body) && body.includes('Worker threw exception');
        } else {
          await response.body?.cancel();
        }
      } catch {
        throw new Error('Could not verify temporary Version URL removal.');
      }
      if (response.status !== 404 && response.status !== 410 && !deletedVersionEdgeError) {
        throw new Error(`Temporary Version URL removal is not yet confirmed (HTTP ${response.status}).`);
      }
      const productionUnchanged = sameDeployment(snapshot, await readDeployment());
      const latest = (await request(`${versionsPath}/latest`))!.result;
      const restoredVersion = record(latest) && record(latest.annotations) &&
        latest.annotations['workers/tag'] === `${RESTORE_TAG_PREFIX}${uuid(version.operationId)}` ? uuid(latest.id) : undefined;
      return { absent: true, previewStatus: response.status, productionUnchanged, ...(restoredVersion ? { restoredVersion } : {}) };
    },
  };
}
