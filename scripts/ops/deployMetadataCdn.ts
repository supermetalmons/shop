import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util';
import { parseConfigFileTextToJson } from 'typescript';
import { readBoundedResponseJson } from '../../cloud/workers/api/src/boundedResponse.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_PATH = 'cloud/workers/cdn/wrangler.jsonc';
const ZONE = { id: 'db7e403f4d03da508208cde9c8601447', name: 'mons.shop' };
const API = 'https://api.cloudflare.com/client/v4';
const execute = promisify(execFile);

type Target = {
  accountId: string; worker: string; hostname: string; zoneId: string; zoneName: string; bucket: string;
  compatibilityDate: string; compatibilityFlags: string[]; observability: Record<string, unknown>;
};
type Domain = { id: string; enabled: boolean; previewsEnabled: boolean };
type Payload = { bytes: Uint8Array; contentType: string; sha256: string; mainModule: string; modules: string[] };
type Report = {
  write: boolean; phase: 'prepared' | 'preflight' | 'uploading' | 'uploaded' | 'configuring-subdomain' | 'attaching-domain' | 'complete';
  preparedAt: string; updatedAt: string; target: Target; configSha256: string; payloadSha256: string;
  payloadBytes: number; mainModule: string; modules: string[]; output: string;
  deploymentId?: string; domainId?: string; domainAction?: 'attached' | 'reused'; workersDev?: boolean; previewUrls?: boolean; error?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseMetadataCdnDeployArgs(argv: string[]): { write: boolean; output: string } {
  let write = false;
  let output = '.cache/111k-offchain/cdn-deployment.json';
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--write') write = true;
    else if (flag === '--output' && argv[index + 1] && !argv[index + 1].startsWith('--')) output = argv[++index];
    else throw new Error('Usage: deploy:metadata-cdn -- [--write] [--output <report.json>]');
  }
  if (!output.endsWith('.json')) throw new Error('The deployment report must be a JSON file.');
  return { write, output };
}

export function metadataCdnTarget(value: unknown): Target {
  if (!record(value) || value.name !== 'mons-shop-cdn' || typeof value.account_id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.account_id) || value.main !== 'src/index.ts' ||
    value.workers_dev !== false || value.preview_urls !== false || !Array.isArray(value.routes) || value.routes.length !== 1 ||
    !record(value.routes[0]) || value.routes[0].pattern !== 'cdn.mons.shop' || value.routes[0].custom_domain !== true ||
    !Array.isArray(value.r2_buckets) || value.r2_buckets.length !== 1 || !record(value.r2_buckets[0]) ||
    value.r2_buckets[0].binding !== 'METADATA_BUCKET' || value.r2_buckets[0].bucket_name !== 'cdn-mons-shop' ||
    typeof value.compatibility_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date) ||
    !Array.isArray(value.compatibility_flags) || !value.compatibility_flags.every(flag => typeof flag === 'string') ||
    !record(value.observability)) throw new Error('The CDN configuration does not match the dedicated metadata deployment.');
  return {
    accountId: value.account_id, worker: value.name, hostname: value.routes[0].pattern, zoneId: ZONE.id, zoneName: ZONE.name,
    bucket: value.r2_buckets[0].bucket_name, compatibilityDate: value.compatibility_date,
    compatibilityFlags: value.compatibility_flags, observability: value.observability,
  };
}

export async function inspectMetadataCdnPayload(bytes: Uint8Array, target: Target): Promise<Payload> {
  if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('Invalid CDN multipart payload size.');
  const buffer = Buffer.from(bytes);
  const lineEnd = buffer.indexOf('\r\n');
  const first = lineEnd >= 0 && lineEnd < 80 ? buffer.subarray(0, lineEnd).toString('ascii') : '';
  if (!/^--[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(first)) throw new Error('Wrangler did not produce a multipart upload payload.');
  const boundary = first.slice(2);
  const ending = buffer.subarray(-boundary.length - 8).toString('ascii');
  if (!ending.endsWith(`--${boundary}--`) && !ending.endsWith(`--${boundary}--\r\n`)) {
    throw new Error('The CDN multipart payload is incomplete.');
  }
  const contentType = `multipart/form-data; boundary=${boundary}`;
  let form: FormData;
  try { form = await new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new Error('The CDN multipart payload cannot be parsed.'); }
  const fields = [...form.keys()];
  if (new Set(fields).size !== fields.length || !form.has('metadata')) throw new Error('Invalid CDN multipart fields.');
  const raw = form.get('metadata')!;
  let metadata: unknown;
  try { metadata = JSON.parse(typeof raw === 'string' ? raw : await raw.text()); }
  catch { throw new Error('Invalid CDN upload metadata.'); }
  if (!record(metadata) || typeof metadata.main_module !== 'string' || !(form.get(metadata.main_module) instanceof Blob) ||
    metadata.compatibility_date !== target.compatibilityDate ||
    !isDeepStrictEqual(metadata.compatibility_flags, target.compatibilityFlags) ||
    !isDeepStrictEqual(metadata.observability, target.observability) ||
    !isDeepStrictEqual(metadata.bindings, [{ name: 'METADATA_BUCKET', type: 'r2_bucket', bucket_name: target.bucket }])) {
    throw new Error('The CDN upload metadata differs from the pinned Wrangler configuration.');
  }
  return { bytes, contentType, sha256: digest(bytes), mainModule: metadata.main_module,
    modules: fields.filter(field => field !== 'metadata') };
}

async function preparePayload(root: string): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'mons-metadata-cdn-'));
  const output = join(directory, 'worker.multipart');
  try {
    try {
      await execute(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run',
        '--config', join(root, CONFIG_PATH), '--env-file', join(root, 'cloud/workers/cdn/release.env'), '--outfile', output], {
        cwd: root, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      });
    } catch { throw new Error('Wrangler metadata CDN preparation failed.'); }
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function cloudflareToken(root: string): string {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) return process.env.CLOUDFLARE_API_TOKEN.trim();
  for (const filename of ['.env.local', '.env']) {
    const path = join(root, filename);
    if (!existsSync(path)) continue;
    let token: string;
    try { token = parseEnv(readFileSync(path, 'utf8')).CLOUDFLARE_API_TOKEN?.trim(); }
    catch { throw new Error('Unable to read Cloudflare API token configuration.'); }
    if (token) return token;
  }
  throw new Error('CLOUDFLARE_API_TOKEN is required for --write.');
}

async function saveReport(report: Report): Promise<void> {
  await mkdir(dirname(report.output), { recursive: true });
  const temporary = `${report.output}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, report.output);
}

function cloudflareClient(token: string, providerFetch: typeof fetch) {
  return async (path: string, method = 'GET', body?: BodyInit, contentType?: string): Promise<Record<string, unknown>> => {
    const signal = AbortSignal.timeout(30_000);
    const failure = () => new Error(`Cloudflare ${method} request was not confirmed; inspect the deployment report before retrying.`);
    let response: Response;
    try {
      response = await providerFetch(`${API}${path}`, { method, body, signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) } });
    } catch { throw failure(); }
    if (!response.ok) { await response.body?.cancel(); throw failure(); }
    const value = await readBoundedResponseJson(response, { maxBytes: 1024 * 1024, contentType: 'require-json', signal,
      createError: failure });
    if (!record(value) || value.success !== true || !('result' in value)) throw failure();
    return value;
  };
}

function checkedDomain(value: unknown, target: Target): Domain {
  if (!record(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
    value.hostname !== target.hostname || value.service !== target.worker || value.zone_id !== target.zoneId ||
    value.zone_name !== target.zoneName || !['', 'production', undefined].includes(value.environment as string | undefined) ||
    typeof value.enabled !== 'boolean' || typeof value.previews_enabled !== 'boolean') {
    throw new Error('The CDN hostname is attached to a different Worker or zone, or its ownership is unclear.');
  }
  return { id: value.id, enabled: value.enabled, previewsEnabled: value.previews_enabled };
}

export async function runDeployMetadataCdn(argv: string[], overrides: {
  root?: string; apiToken?: string; fetch?: typeof fetch; prepare?: (root: string) => Promise<Uint8Array>; now?: () => Date;
} = {}): Promise<Report> {
  const args = parseMetadataCdnDeployArgs(argv);
  const root = resolve(overrides.root ?? ROOT);
  const configPath = join(root, CONFIG_PATH);
  const source = await readFile(configPath, 'utf8');
  const config = parseConfigFileTextToJson(configPath, source);
  if (config.error) throw new Error('Unable to parse the metadata CDN Wrangler configuration.');
  const target = metadataCdnTarget(config.config);
  const payload = await inspectMetadataCdnPayload(await (overrides.prepare ?? preparePayload)(root), target);
  const output = resolve(root, args.output);
  if (output === configPath) throw new Error('The report cannot replace the CDN configuration.');
  const now = () => (overrides.now?.() ?? new Date()).toISOString();
  const report: Report = { write: args.write, phase: 'prepared', preparedAt: now(), updatedAt: now(), target,
    configSha256: digest(source), payloadSha256: payload.sha256, payloadBytes: payload.bytes.byteLength,
    mainModule: payload.mainModule, modules: payload.modules, output };
  const save = async (phase: Report['phase']) => { report.phase = phase; report.updatedAt = now(); await saveReport(report); };
  await save('prepared');
  if (!args.write) return report;
  try {
    const token = overrides.apiToken?.trim() || cloudflareToken(root);
    const api = cloudflareClient(token, overrides.fetch ?? fetch);
    const accountPath = `/accounts/${target.accountId}/workers`;
    const zone = (await api(`/zones/${target.zoneId}`)).result;
    if (!record(zone) || zone.id !== target.zoneId || zone.name !== target.zoneName || zone.status !== 'active' ||
      !record(zone.account) || zone.account.id !== target.accountId) throw new Error('The CDN zone does not belong to the configured account.');
    const readDomain = async () => {
      const response = await api(`${accountPath}/domains?${new URLSearchParams({ hostname: target.hostname })}`);
      if (!Array.isArray(response.result) || response.result.length > 1 ||
        (record(response.result_info) && Number(response.result_info.total_pages ?? 1) > 1)) {
        throw new Error('The CDN hostname lookup is ambiguous or incomplete.');
      }
      return response.result.length ? checkedDomain(response.result[0], target) : null;
    };
    await readDomain();
    await save('preflight');
    await save('uploading');
    const uploaded = (await api(`${accountPath}/scripts/${target.worker}`, 'PUT', Uint8Array.from(payload.bytes), payload.contentType)).result;
    if (!record(uploaded) || uploaded.id !== target.worker || typeof uploaded.deployment_id !== 'string' ||
      !/^[a-f0-9-]{32,64}$/.test(uploaded.deployment_id)) throw new Error('The uploaded CDN deployment identity was not confirmed.');
    report.deploymentId = uploaded.deployment_id;
    await save('uploaded');
    const subdomainPath = `${accountPath}/scripts/${target.worker}/subdomain`;
    const readSubdomain = async () => {
      const result = (await api(subdomainPath)).result;
      if (!record(result) || typeof result.enabled !== 'boolean' || typeof result.previews_enabled !== 'boolean') {
        throw new Error('The CDN workers.dev and preview URL settings were not confirmed.');
      }
      return { enabled: result.enabled, previewsEnabled: result.previews_enabled };
    };
    let subdomain = await readSubdomain();
    if (subdomain.enabled || subdomain.previewsEnabled) {
      await save('configuring-subdomain');
      await api(subdomainPath, 'POST', JSON.stringify({ enabled: false, previews_enabled: false }), 'application/json');
      subdomain = await readSubdomain();
    }
    if (subdomain.enabled || subdomain.previewsEnabled) throw new Error('The CDN workers.dev or preview URLs remain enabled.');
    report.workersDev = false;
    report.previewUrls = false;
    await save('uploaded');
    let domain = await readDomain();
    if (!domain?.enabled || domain.previewsEnabled) {
      await save('attaching-domain');
      checkedDomain((await api(`${accountPath}/domains`, 'PUT', JSON.stringify({ hostname: target.hostname,
        service: target.worker, zone_id: target.zoneId, enabled: true, previews_enabled: false }), 'application/json')).result, target);
      domain = await readDomain();
      report.domainAction = 'attached';
    } else report.domainAction = 'reused';
    if (!domain?.enabled || domain.previewsEnabled) throw new Error('The CDN custom domain was not confirmed.');
    report.domainId = domain.id;
    await save('complete');
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'The CDN deployment was not confirmed.';
    await save(report.phase);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await runDeployMetadataCdn(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'The metadata CDN deployment failed.'); process.exitCode = 1; }
}
