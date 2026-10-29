import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { verifyRevealDeployment } from '../../cloud/workers/api/src/ethereumRevealChain.ts';
import { ethereumMetadataBaseUri } from '../../shared/ethereum/config.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION, ETHEREUM_REVEAL_DEPLOYMENT_ID, ETHEREUM_REVEAL_DEPLOYMENTS_SQL,
  parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol.ts';
import { createAsyncD1MaintenanceQuery } from '../shared/asyncD1MaintenanceQuery.ts';
import { acquireMetadataPublicationLease } from '../ethereum-metadata/publicationLease.ts';
import { verifyMetadata } from '../ethereum-metadata/remote.ts';
import { COMMERCE_D1_NOW_MS_SQL, sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';

const DEFAULT_TEMPLATE = new URL('../ethereum-metadata/templates/artwork.json', import.meta.url);
const RPC_ENV_FILES = [new URL('../../.env.local', import.meta.url), new URL('../../.env', import.meta.url)];

type Args = { command: 'status' | 'register' | 'activate' | 'pause'; write: boolean; deploymentId?: string; expectedRevision?: number; manifest?: string };

export function parseEthereumRevealControlArgs(argv: string[]): Args {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    write: { type: 'boolean', default: false }, manifest: { type: 'string' }, 'deployment-id': { type: 'string' }, 'expected-revision': { type: 'string' },
  } });
  const command = positionals[0] as Args['command'];
  if (positionals.length !== 1 || !['status', 'register', 'activate', 'pause'].includes(command)) {
    throw new Error('Usage: ethereumRevealControl.ts <status|register|activate|pause> [--manifest FILE] [--deployment-id ID --expected-revision N] [--write]');
  }
  const deploymentId = values['deployment-id'];
  const expectedRevision = values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']);
  if (deploymentId !== undefined && !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(deploymentId)) throw new Error('Invalid deployment ID.');
  if (command === 'status' && (values.write || values.manifest || expectedRevision !== undefined)) throw new Error('Status only accepts --deployment-id.');
  if (command === 'register' && (!values.manifest || deploymentId || expectedRevision !== undefined)) throw new Error('Register requires only --manifest and optional --write.');
  if ((command === 'activate' || command === 'pause') && (!deploymentId || values.manifest || !Number.isSafeInteger(expectedRevision) || expectedRevision! < 1)) {
    throw new Error('A transition requires --deployment-id and --expected-revision.');
  }
  return { command, write: values.write, deploymentId, expectedRevision, manifest: values.manifest };
}

type Registration = Omit<EthereumRevealDeployment, 'state' | 'revision' | 'createdAtMs' | 'updatedAtMs' | 'activatedAtMs' | 'provisionedAtMs' | 'lastError'>;

export async function ethereumRevealRegistrationRpcKey(env: Readonly<Record<string, string | undefined>> = process.env,
  files: readonly (string | URL)[] = RPC_ENV_FILES): Promise<string> {
  const supplied = env.ALCHEMY_MI_NOTE_API_KEY?.trim();
  if (supplied) return supplied;
  for (const file of files) {
    try {
      const key = parseEnv(await readFile(file, 'utf8')).ALCHEMY_MI_NOTE_API_KEY?.trim();
      if (key) return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read Ethereum RPC credentials.');
    }
  }
  throw new Error('Set ALCHEMY_MI_NOTE_API_KEY in the invoking environment, root .env.local, or root .env before registering a reveal deployment.');
}

async function verifyRegistrationDeployment(value: Registration): Promise<void> {
  await verifyRevealDeployment({ ALCHEMY_MI_NOTE_API_KEY: await ethereumRevealRegistrationRpcKey(), ETHEREUM_111K_RPC_URL: '' },
    value, AbortSignal.timeout(15_000));
}

async function loadRegistrationInput(path: string): Promise<{ deployment: Registration; publicationDirectory?: string }> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reveal registration manifest.');
  const row = input as Record<string, unknown>;
  const address = normalizeEthereumAddress(row.contractAddress);
  if (typeof row.deploymentId !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(row.deploymentId) ||
    typeof row.dropId !== 'string' || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(row.dropId) || !address || /^0x0{40}$/.test(address) ||
    (row.chainId !== 1 && row.chainId !== 11155111) || typeof row.metadataBaseUri !== 'string' ||
    !Number.isSafeInteger(row.deploymentBlock) || Number(row.deploymentBlock) < 0 ||
    row.catalogVersion !== undefined && row.catalogVersion !== ETHEREUM_REVEAL_CATALOG_VERSION) throw new Error('Invalid reveal registration identity.');
  const metadataBaseUri = ethereumMetadataBaseUri(row.metadataBaseUri, row.chainId);
  const prefix = row.chainId === 1 ? '111k' : '111k-sepolia';
  if (metadataBaseUri !== `https://cdn.mons.shop/${prefix}/${row.deploymentId}/` && metadataBaseUri !== `https://cdn.mons.shop/${prefix}/`) {
    throw new Error('The metadata prefix must use the deployment ID.');
  }
  if (row.publicationDirectory !== undefined && (typeof row.publicationDirectory !== 'string' || !row.publicationDirectory.trim())) {
    throw new Error('Invalid publicationDirectory.');
  }
  const publicationDirectory = typeof row.publicationDirectory === 'string' ? resolve(resolve(path, '..'), row.publicationDirectory) : undefined;
  const source = await readFile(typeof row.templateFile === 'string' ? resolve(resolve(path, '..'), row.templateFile) :
    publicationDirectory ? join(publicationDirectory, 'templates', 'artwork.json') : DEFAULT_TEMPLATE, 'utf8');
  const template = JSON.parse(source) as Record<string, unknown>;
  if (typeof template.name !== 'string' || !template.name || typeof template.description !== 'string' ||
    template.image !== 'https://wip.lil.org/111k/artwork_placeholder.png' || !Array.isArray(template.attributes) ||
    Object.keys(template).some(key => !['name', 'description', 'image', 'attributes'].includes(key)) ||
    template.attributes.some(attribute => !attribute || typeof attribute !== 'object' || typeof attribute.trait_type !== 'string' ||
      !['string', 'number'].includes(typeof attribute.value))) throw new Error('Registration requires an unrevealed artwork template.');
  const rendered = JSON.stringify(template).replaceAll('{{tokenId}}', '1').replaceAll('{{displayId}}', '1');
  if (/\{\{|\}\}/.test(rendered)) throw new Error('Unsupported metadata template substitution.');
  const templateJson = JSON.stringify(template);
  return { publicationDirectory, deployment: { deploymentId: row.deploymentId, dropId: row.dropId, chainId: row.chainId, contractAddress: address, metadataBaseUri,
    deploymentBlock: Number(row.deploymentBlock), catalogVersion: ETHEREUM_REVEAL_CATALOG_VERSION,
    templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') } };
}

export async function loadEthereumRevealRegistration(path: string): Promise<Registration> {
  return (await loadRegistrationInput(path)).deployment;
}

async function verifyRegistrationPublication(value: Registration, directory: string, verify: typeof verifyMetadata): Promise<void> {
  const template = JSON.stringify(JSON.parse(await readFile(join(directory, 'templates', 'artwork.json'), 'utf8')));
  if (template !== value.templateJson) throw new Error('Registration template does not match the publication snapshot.');
  const network = value.chainId === 1 ? 'mainnet' : 'sepolia';
  const prefix = new URL(value.metadataBaseUri).pathname.slice(1);
  await verify(directory, network, { prefix: prefix === (network === 'mainnet' ? '111k/' : '111k-sepolia/') ? undefined : prefix });
}

export function buildEthereumRevealRegistration(value: Registration, publicationLeaseId?: string): string {
  return `INSERT INTO ethereum_reveal_deployments (deployment_id, drop_id, chain_id, contract_address, metadata_base_uri,
    deployment_block, catalog_version, template_json, template_sha256, state, revision, created_at_ms, updated_at_ms,
    activated_at_ms, provisioned_at_ms, last_error)
    SELECT ${sqlString(value.deploymentId)}, ${sqlString(value.dropId)}, ${value.chainId}, ${sqlString(value.contractAddress)},
      ${sqlString(value.metadataBaseUri)}, ${value.deploymentBlock}, ${sqlString(value.catalogVersion)}, ${sqlString(value.templateJson)},
      ${sqlString(value.templateSha256)}, 'provisioning', 1, ${COMMERCE_D1_NOW_MS_SQL}, ${COMMERCE_D1_NOW_MS_SQL}, NULL, NULL, NULL
    ${publicationLeaseId ? `WHERE EXISTS (SELECT 1 FROM ethereum_metadata_publication_leases WHERE metadata_base_uri = ${sqlString(value.metadataBaseUri)}
      AND lease_id = ${sqlString(publicationLeaseId)} AND expires_at_ms = 0)` : ''} RETURNING *`;
}

export function buildEthereumRevealTransition(command: 'activate' | 'pause', current: EthereumRevealDeployment, revision: number): string {
  if (revision !== current.revision || command === 'activate' && !['ready', 'paused'].includes(current.state) ||
    command === 'pause' && current.state !== 'active' || command === 'activate' && current.provisionedAtMs === null) {
    throw new Error('Reveal deployment state or revision does not permit this transition.');
  }
  return `UPDATE ethereum_reveal_deployments SET state = '${command === 'activate' ? 'active' : 'paused'}', revision = revision + 1,
    updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL}${command === 'activate' ? `, activated_at_ms = COALESCE(activated_at_ms, ${COMMERCE_D1_NOW_MS_SQL})` : ''}
    WHERE deployment_id = ${sqlString(current.deploymentId)} AND revision = ${revision} AND state = ${sqlString(current.state)} RETURNING *`;
}

export async function runEthereumRevealControl(argv: string[], overrides: {
  query?: CommerceAuthorityQuery; verifyPublication?: typeof verifyMetadata; verifyDeployment?: (value: Registration) => Promise<void>;
} = {}) {
  const args = parseEthereumRevealControlArgs(argv);
  const query = overrides.query ?? createAsyncD1MaintenanceQuery('ops');
  if (args.command === 'status') return { deployments: (await query(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL}${args.deploymentId ? ` WHERE deployment_id = ${sqlString(args.deploymentId)}` : ''} ORDER BY created_at_ms, deployment_id`)).map(parseEthereumRevealDeployment) };
  if (args.command === 'register') {
    const { deployment: value, publicationDirectory } = await loadRegistrationInput(args.manifest!);
    const existing = await query(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id = ${sqlString(value.deploymentId)}`);
    if (existing.length) {
      const deployment = parseEthereumRevealDeployment(existing[0]);
      if (!Object.entries(value).every(([key, entry]) => deployment[key as keyof EthereumRevealDeployment] === entry)) throw new Error('Deployment ID is already registered with different immutable settings.');
      return { unchanged: true, deployment };
    }
    if (!publicationDirectory) throw new Error('New reveal registration requires publicationDirectory for the verified generated metadata.');
    const verify = overrides.verifyPublication ?? verifyMetadata;
    const verifyDeployment = overrides.verifyDeployment ?? verifyRegistrationDeployment;
    if (!args.write) {
      await verifyRegistrationPublication(value, publicationDirectory, verify);
      await verifyDeployment(value);
      return { dryRun: true, command: args.command, deployment: value, publicationDirectory, publicationVerified: true, deploymentVerified: true };
    }
    const lease = await acquireMetadataPublicationLease(value.metadataBaseUri, { query });
    try {
      await verifyRegistrationPublication(value, publicationDirectory, verify);
      await verifyDeployment(value);
      await lease.retireForRegistration();
      const rows = await query(buildEthereumRevealRegistration(value, lease.leaseId));
      if (rows.length !== 1) throw new Error('Reveal registration lost its publication lease; verify again before retrying.');
      return { deployment: parseEthereumRevealDeployment(rows[0]) };
    } finally { await lease.close(); }
  }
  const rows = await query(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id = ${sqlString(args.deploymentId!)}`);
  if (rows.length !== 1) throw new Error('Reveal deployment not found.');
  const current = parseEthereumRevealDeployment(rows[0]);
  const sql = buildEthereumRevealTransition(args.command, current, args.expectedRevision!);
  if (!args.write) return { dryRun: true, command: args.command, deployment: current, sql };
  const updated = await query(sql);
  if (updated.length !== 1) throw new Error('Reveal transition was not confirmed; inspect status before retrying.');
  return { deployment: parseEthereumRevealDeployment(updated[0]) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runEthereumRevealControl(process.argv.slice(2)), null, 2));
}
