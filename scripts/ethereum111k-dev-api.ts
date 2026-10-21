import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import nacl from 'tweetnacl';
import { decodeReturn, encodeCall } from '../shared/ethereum/abi.ts';
import { ethereumSignerAddress } from '../shared/ethereum/crypto.ts';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_UNBOX_QUANTITY, requireEthereumAddress } from '../shared/ethereum/protocol.ts';
import { parseProceedsConfig } from '../onchain/ethereum/scripts/proceeds-config.mjs';

const root = resolve(import.meta.dirname, '..');
const deploymentFile = resolve(root, process.env.ETHEREUM_111K_LOCAL_DEPLOYMENT || 'onchain/ethereum/.local/deployment.json');
const deployment = JSON.parse(await readFile(deploymentFile, 'utf8')) as {
  protocolVersion?: number; chainId: number; rpcUrl: string; contractAddress: string; rendererAddress: string; deploymentBlock: number; quoteSigner: string;
};
if (deployment.protocolVersion !== 6) throw new Error('The local deployment does not support the current proceeds contract interface. Restart Anvil and run npm --prefix onchain/ethereum run deploy:local again.');
const rpcUrl = new URL(deployment.rpcUrl);
if (deployment.chainId !== 31337 || rpcUrl.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(rpcUrl.hostname) || rpcUrl.username || rpcUrl.password) {
  throw new Error('The local API accepts only an Anvil deployment on an HTTP loopback URL, chain ID 31337.');
}
const contractAddress = requireEthereumAddress(deployment.contractAddress);
const rendererAddress = requireEthereumAddress(deployment.rendererAddress);
const proceeds = parseProceedsConfig(deployment, contractAddress) as {
  mintRecipients: string[]; mintSharesBps: number[]; deliveryPaymentReceiver: string;
};
if (!Number.isSafeInteger(deployment.deploymentBlock) || deployment.deploymentBlock < 0) throw new Error('Invalid deployment block.');
const testKey = `0x${'0'.repeat(59)}a11ce`;
const signer = ethereumSignerAddress(testKey);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (!response.ok || body.error || body.result === undefined) throw new Error(`Local RPC ${method} failed.`);
  return body.result;
}

const [chainId, client, collectionCode, rendererCode, signerResult] = await Promise.all([
  rpc('eth_chainId'), rpc('web3_clientVersion'), rpc('eth_getCode', [contractAddress, 'latest']),
  rpc('eth_getCode', [rendererAddress, 'latest']),
  rpc('eth_call', [{ to: contractAddress, data: encodeCall('quoteSigner()', [], []) }, 'latest']),
]);
if (chainId !== '0x7a69' || typeof client !== 'string' || !client.toLowerCase().includes('anvil')) {
  throw new Error('Start the local Anvil chain before starting this API.');
}
if ([collectionCode, rendererCode].some((code) => typeof code !== 'string' || code.length < 4)) {
  throw new Error('The local deployment is missing. Run npm --prefix onchain/ethereum run deploy:local again.');
}
if (requireEthereumAddress(deployment.quoteSigner) !== signer || typeof signerResult !== 'string' ||
  decodeReturn(['address'], signerResult)[0] !== signer) throw new Error('Local API requires the public A11CE test signer used by deploy:local.');

const [unboxLimit, tokenInfos, tokenURIs, collectionStats] = await Promise.all([
  rpc('eth_call', [{ to: contractAddress, data: encodeCall('MAX_UNBOX_QUANTITY()', [], []) }, 'latest']),
  rpc('eth_call', [{ to: contractAddress, data: encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, ['uint256[]'], [[]]) }, 'latest']),
  rpc('eth_call', [{ to: contractAddress, data: encodeCall(ETHEREUM_FUNCTIONS.previewTokenURIs, ['uint8[]', 'uint256[]'], [[], []]) }, 'latest']),
  rpc('eth_call', [{ to: contractAddress, data: encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [`0x${'0'.repeat(40)}`]) }, 'latest']),
]);
if (typeof unboxLimit !== 'string' || decodeReturn(['uint256'], unboxLimit)[0] !== BigInt(ETHEREUM_MAX_UNBOX_QUANTITY) ||
  typeof tokenInfos !== 'string' || (decodeReturn(['(uint8,uint256,address)[]'], tokenInfos)[0] as unknown[]).length !== 0 ||
  typeof tokenURIs !== 'string' || (decodeReturn(['string[]'], tokenURIs)[0] as unknown[]).length !== 0 ||
  typeof collectionStats !== 'string' || decodeReturn(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
    collectionStats,
  )[9] !== 0n) {
  throw new Error('The local collection does not implement the current discount interface. Run npm --prefix onchain/ethereum run deploy:local again.');
}

async function proceedsRead(signature: string, types: string[], values: unknown[], resultType: string) {
  const result = await rpc('eth_call', [{ to: contractAddress, data: encodeCall(signature, types, values) }, 'latest']);
  if (typeof result !== 'string') throw new Error('Invalid local proceeds contract response.');
  return decodeReturn([resultType], result)[0];
}
const [recipientCount, deliveryReceiver, recipients, shares, ...accounting] = await Promise.all([
  proceedsRead('mintRecipientCount()', [], [], 'uint256'),
  proceedsRead('deliveryPaymentReceiver()', [], [], 'address'),
  Promise.all(proceeds.mintRecipients.map((_, index) => proceedsRead('mintRecipients(uint256)', ['uint256'], [index], 'address'))),
  Promise.all(proceeds.mintRecipients.map(address => proceedsRead('mintSharesBps(address)', ['address'], [address], 'uint256'))),
  ...['totalMintReceived()', 'totalMintReleased()', 'totalDeliveryReceived()', 'totalDeliveryReleased()', 'releasableDelivery()']
    .map(signature => proceedsRead(signature, [], [], 'uint256')),
  ...proceeds.mintRecipients.flatMap(address => ['mintReleased(address)', 'releasableMint(address)']
    .map(signature => proceedsRead(signature, ['address'], [address], 'uint256'))),
]);
parseProceedsConfig({ ...proceeds, deliveryPaymentReceiver: deliveryReceiver }, contractAddress);
if (recipientCount !== BigInt(proceeds.mintRecipients.length) ||
  !Array.isArray(recipients) || recipients.some((recipient, index) => recipient !== proceeds.mintRecipients[index]) ||
  !Array.isArray(shares) || shares.some((share, index) => share !== BigInt(proceeds.mintSharesBps[index])) ||
  accounting.some(value => typeof value !== 'bigint')) {
  throw new Error('The local collection does not match its proceeds configuration. Run npm --prefix onchain/ethereum run deploy:local again.');
}

const rawConfig = JSON.parse(await readFile(resolve(root, 'cloud/workers/api/wrangler.jsonc'), 'utf8'));
const emptySecrets = Object.fromEntries((rawConfig.secrets?.required || []).map((name: string) => [name, '']));
const addressKeyPair = nacl.box.keyPair();
const addressPublicKey = Buffer.from(addressKeyPair.publicKey).toString('base64');
const config = {
  ...rawConfig,
  main: resolve(root, 'cloud/workers/api/src/index.ts'),
  vars: { ...rawConfig.vars, ...emptySecrets,
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contractAddress,
    ETHEREUM_111K_RENDERER_ADDRESS: rendererAddress, ETHEREUM_111K_DEPLOYMENT_BLOCK: String(deployment.deploymentBlock),
    ETHEREUM_111K_RPC_URL: rpcUrl.href, ETHEREUM_111K_SIGNER_SECRET: testKey,
    ADDRESS_DECRYPTION_SECRET: Buffer.from(addressKeyPair.secretKey).toString('base64'),
  },
  d1_databases: rawConfig.d1_databases.map((database: Record<string, unknown>) => ({
    ...database, remote: false, migrations_dir: resolve(root, 'cloud/workers/api', String(database.migrations_dir)),
  })),
};
delete config.$schema;
delete config.account_id;
delete config.routes;
delete config.secrets;
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
const runtimeRoot = await mkdtemp(join(tmpdir(), '111k-api-'));
const server = createTestHarness({ root: runtimeRoot, workers: [{ config }] });
let closed = false;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
async function close() {
  if (closed) return;
  closed = true;
  clearInterval(reconcileTimer);
  await server.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

try {
  const { url } = await server.listen();
  const worker = server.getWorker('mons-shop-api');
  for (const name of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(name);
  const env = await worker.getEnv();
  const existing = await env.COMMERCE_DB.prepare('SELECT COUNT(*) AS count FROM commerce_documents').first() as { count: number } | null;
  const authority = await env.COMMERCE_DB.prepare('SELECT authority_state FROM commerce_authority_control WHERE singleton = 1')
    .first() as { authority_state: string } | null;
  if (existing?.count !== 0 || authority?.authority_state !== 'paused') throw new Error('Local API initialization requires an empty, freshly migrated in-memory database.');
  const leaseToken = crypto.randomUUID();
  const statements = [
    env.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
      VALUES (1, ?, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`).bind(leaseToken),
    env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL`),
  ];
  for (const table of ['commerce_notification_outbox_control', 'commerce_stripe_checkout_state_control',
    'commerce_pack_status_outbox_control', 'commerce_delivery_recovery_control']) {
    statements.push(env.COMMERCE_DB.prepare(`UPDATE ${table} SET preparation_state = 'preparing', source_documents_revision = 0 WHERE singleton = 1`),
      env.COMMERCE_DB.prepare(`UPDATE ${table} SET preparation_state = 'ready', prepared_at_ms = 0 WHERE singleton = 1`),
      env.COMMERCE_DB.prepare(`UPDATE ${table} SET storage_mode = 'table' WHERE singleton = 1`));
  }
  statements.push(env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1 AND authority_state = 'paused'`),
  env.COMMERCE_DB.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1 AND lease_token = ?').bind(leaseToken));
  await env.COMMERCE_DB.batch(statements);
  await env.COMMERCE_DB.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
    paused_at_ms = NULL, chain_id = ?, contract_address = ?, updated_at_ms = ? WHERE singleton = 1`)
    .bind(deployment.chainId, contractAddress, Date.now()).run();
  const stats = await worker.fetch(`${url.origin}/ethereum/111k/stats`, { headers: { Origin: 'http://localhost:5173' } });
  if (!stats.ok) {
    throw new Error(`The local Worker could not read the deployed collection (HTTP ${stats.status}): ${await stats.text()}`);
  }
  let reconciling = false;
  reconcileTimer = setInterval(() => {
    if (reconciling || closed) return;
    reconciling = true;
    void worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() }).catch(() => {
      process.stderr.write('Local reconciliation failed; it will retry.\n');
    }).finally(() => { reconciling = false; });
  }, 10_000);
  console.log(`Local Ethereum API: ${url.origin}`);
  console.log(`Collection: ${contractAddress}`);
  console.log('Fresh in-memory databases only. All production API credentials are disabled.');
  console.log(`Frontend: VITE_MONS_API_ORIGIN=${url.origin} VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY=${addressPublicKey} npm run dev`);
  console.log('Open /111k_devnet. Import an Anvil test account into your wallet; do not use its key outside this local chain.');
  console.log('Restart the local chain and redeploy when restarting this API: address/order/code state resets on exit.');
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
} finally { await close(); }
