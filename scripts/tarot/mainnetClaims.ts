import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeReturn, encodeAbi, encodeCall } from '../../shared/ethereum/abi.ts';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol.ts';
import { tarotCodeHashInput } from '../../shared/ethereum/tarot.ts';
import { privateDirectory } from './claimLinks.ts';

const COLLECTION = 'dmx-mainnet-v1';
const COUNT = 777;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Row = Record<string, unknown>;
type Database = { query(sql: string): Row[]; executeCommand(sql: string): unknown };
type MainnetBinding = { contractAddress: string; deploymentBlock: number; transactionHash: string };
type MainnetRpc = (method: string, params?: unknown[]) => Promise<unknown>;
type RuntimeMatcher = (code: string) => boolean;
type TrustedBuild = { matchesRuntime: RuntimeMatcher; creationCode: string };
let trustedBuild: Promise<TrustedBuild> | undefined;
export type MainnetClaimLinks = {
  version: 1; chainId: 1; collectionKey: 'dmx-mainnet-v1'; contractAddress: null;
  batchId: string; createdAtMs: number; links: { tokenId: number; code: string; url: string }[];
};

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function url(tokenId: number, code: string): string {
  return `https://mons.shop/nfc?code=${code}&tokenId=${tokenId}`;
}

export function mainnetCredentials(manifest: MainnetClaimLinks): { tokenId: number; codeHash: string }[] {
  if (!manifest || manifest.version !== 1 || manifest.chainId !== 1 || manifest.collectionKey !== COLLECTION ||
    manifest.contractAddress !== null || typeof manifest.batchId !== 'string' || !UUID.test(manifest.batchId) ||
    !Number.isSafeInteger(manifest.createdAtMs) || manifest.createdAtMs < 0 ||
    !Array.isArray(manifest.links) || manifest.links.length !== COUNT) throw new Error('Invalid private mainnet claim manifest.');
  const seen = new Set<string>();
  return manifest.links.map((link, index) => {
    if (!link || link.tokenId !== index + 1 || typeof link.code !== 'string' || !UUID.test(link.code) ||
      seen.has(link.code) || link.url !== url(link.tokenId, link.code)) throw new Error('Invalid private mainnet claim link.');
    seen.add(link.code);
    return { tokenId: link.tokenId,
      codeHash: hash(`mons:dmx:mainnet-staging:v1:1:${manifest.batchId}:${link.tokenId}:${link.code}`) };
  });
}

export function mainnetCredentialFingerprint(manifest: MainnetClaimLinks): string {
  const credentials = mainnetCredentials(manifest);
  return hash('mons:dmx:mainnet-staging-set:v1\n' + JSON.stringify({ version: 1, chainId: 1,
    collectionKey: COLLECTION, batchId: manifest.batchId, createdAtMs: manifest.createdAtMs, credentials }));
}

export function mainnetClaimCsv(manifest: MainnetClaimLinks): string {
  mainnetCredentials(manifest);
  return manifest.links.map(link => `${link.url}\n`).join('');
}

function paths(directory: string, root: string) {
  privateDirectory(directory, root);
  const manifest = resolve(directory, 'claim-links.private.json');
  const csv = resolve(directory, 'claim-links.private.csv');
  for (const filename of [manifest, csv]) {
    const name = relative(resolve(root), filename);
    const options = { cwd: root, stdio: 'ignore' as const };
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', name], options);
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', name], options);
    if (ignored.status !== 0 || tracked.status !== 1) throw new Error('Mainnet claim files must be ignored and untracked.');
  }
  return { manifest, csv };
}

function exists(filename: string): boolean {
  return lstatSync(filename, { throwIfNoEntry: false }) !== undefined;
}

function readPrivate(filename: string): string {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Mainnet claim files must be regular private files with mode 0600.');
  }
  return readFileSync(filename, 'utf8');
}

function writePrivateOnce(filename: string, contents: string): void {
  if (exists(filename)) {
    if (readPrivate(filename) !== contents) throw new Error('Existing private mainnet claim files conflict.');
    return;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(descriptor, contents); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    linkSync(temporary, filename);
  } finally { unlinkSync(temporary); }
  const parent = openSync(dirname(filename), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function readManifest(filename: string): MainnetClaimLinks {
  let manifest: MainnetClaimLinks;
  try { manifest = JSON.parse(readPrivate(filename)) as MainnetClaimLinks; }
  catch { throw new Error('Cannot read a valid private mainnet claim manifest.'); }
  mainnetCredentials(manifest);
  return manifest;
}

export function createMainnetClaimLinks(directory: string, root: string): MainnetClaimLinks {
  const files = paths(directory, root);
  let manifest: MainnetClaimLinks;
  if (exists(files.manifest)) manifest = readManifest(files.manifest);
  else {
    if (exists(files.csv)) throw new Error('Recover the original mainnet manifest before generating links.');
    const codes = new Set<string>();
    manifest = { version: 1, chainId: 1, collectionKey: COLLECTION, contractAddress: null,
      batchId: randomUUID(), createdAtMs: Date.now(), links: Array.from({ length: COUNT }, (_, index) => {
        let code = randomUUID();
        while (codes.has(code)) code = randomUUID();
        codes.add(code);
        return { tokenId: index + 1, code, url: url(index + 1, code) };
      }) };
    mainnetCredentials(manifest);
    writePrivateOnce(files.manifest, JSON.stringify(manifest, null, 2) + '\n');
  }
  writePrivateOnce(files.csv, mainnetClaimCsv(manifest));
  return loadMainnetClaimLinks(directory, root);
}

export function loadMainnetClaimLinks(directory: string, root: string): MainnetClaimLinks {
  const files = paths(directory, root);
  const manifest = readManifest(files.manifest);
  if (readPrivate(files.csv) !== mainnetClaimCsv(manifest)) throw new Error('Private mainnet CSV does not match its manifest.');
  return manifest;
}

function readBatch(manifest: MainnetClaimLinks, database: Database, bindingContract?: string): Row | undefined {
  const rows = database.query(`SELECT batch_id,chain_id,collection_key,status,contract_address,credential_count,
    credential_set_sha256,created_at_ms,verified_at_ms,bound_at_ms FROM dmx_mainnet_claim_batches WHERE collection_key='${COLLECTION}'`);
  if (rows.length > 1) throw new Error('Conflicting mainnet claim batches.');
  const row = rows[0];
  if (!row) return;
  const expected = { batch_id: manifest.batchId, chain_id: 1, collection_key: COLLECTION,
    credential_count: COUNT, credential_set_sha256: mainnetCredentialFingerprint(manifest), created_at_ms: manifest.createdAtMs };
  const bound = bindingContract !== undefined && row.status === 'bound';
  if (Object.entries(expected).some(([key, value]) => row[key] !== value) ||
    (bound ? row.contract_address !== bindingContract || !Number.isSafeInteger(row.bound_at_ms) ||
      Number(row.bound_at_ms) < Number(row.verified_at_ms) :
      !['preparing', 'staged'].includes(String(row.status)) || row.contract_address !== null || row.bound_at_ms !== null) ||
    (row.status === 'preparing' ? row.verified_at_ms !== null :
      !Number.isSafeInteger(row.verified_at_ms) || Number(row.verified_at_ms) < manifest.createdAtMs)) {
    throw new Error('Existing mainnet batch conflicts with this inactive private manifest.');
  }
  return row;
}

function readCredentials(manifest: MainnetClaimLinks, database: Database): Row[] {
  return database.query(`SELECT batch_id,token_id,code_hash,created_at_ms,revoked_at_ms FROM dmx_mainnet_claim_codes
    WHERE batch_id='${manifest.batchId}' ORDER BY token_id`);
}

function verifyRows(manifest: MainnetClaimLinks, rows: Row[], complete: boolean): void {
  const expected = new Map(mainnetCredentials(manifest).map(row => [row.tokenId, row.codeHash]));
  if (complete && rows.length !== COUNT) throw new Error('Mainnet credential provisioning is incomplete.');
  const seen = new Set<number>();
  for (const row of rows) {
    const tokenId = Number(row.token_id);
    if (!Number.isSafeInteger(row.token_id) || !expected.has(tokenId) || seen.has(tokenId) ||
      row.batch_id !== manifest.batchId || expected.get(tokenId) !== row.code_hash ||
      row.created_at_ms !== manifest.createdAtMs || row.revoked_at_ms !== null) {
      throw new Error('Existing mainnet credentials conflict with the private manifest.');
    }
    seen.add(tokenId);
  }
}

export function verifyMainnetCredentials(manifest: MainnetClaimLinks, database: Database) {
  mainnetCredentials(manifest);
  const batch = readBatch(manifest, database);
  if (!batch || batch.status !== 'staged') throw new Error('Mainnet batch has not completed staging.');
  verifyRows(manifest, readCredentials(manifest, database), true);
  return { batchId: manifest.batchId, chainId: 1, collectionKey: COLLECTION, credentialCount: COUNT,
    credentialSetSha256: mainnetCredentialFingerprint(manifest), status: 'staged' as const,
    contractAddress: null, verified: true };
}

export function stageMainnetCredentials(manifest: MainnetClaimLinks, database: Database) {
  const credentials = mainnetCredentials(manifest);
  const fingerprint = mainnetCredentialFingerprint(manifest);
  if (!readBatch(manifest, database)) {
    database.executeCommand(`INSERT INTO dmx_mainnet_claim_batches
      (batch_id,chain_id,collection_key,status,contract_address,credential_count,credential_set_sha256,created_at_ms,verified_at_ms,bound_at_ms)
      VALUES ('${manifest.batchId}',1,'${COLLECTION}','preparing',NULL,${COUNT},'${fingerprint}',${manifest.createdAtMs},NULL,NULL)
      ON CONFLICT(collection_key) DO NOTHING;`);
  }
  const batch = readBatch(manifest, database);
  if (!batch) throw new Error('Mainnet batch was not created.');
  if (batch.status === 'staged') return verifyMainnetCredentials(manifest, database);
  verifyRows(manifest, readCredentials(manifest, database), false);
  for (let offset = 0; offset < credentials.length; offset += 50) {
    const values = credentials.slice(offset, offset + 50).map(row => `(${row.tokenId},'${row.codeHash}')`).join(',');
    database.executeCommand(`WITH pending(token_id,code_hash) AS (VALUES ${values})
      INSERT INTO dmx_mainnet_claim_codes(batch_id,token_id,code_hash,created_at_ms,revoked_at_ms)
      SELECT '${manifest.batchId}',token_id,code_hash,${manifest.createdAtMs},NULL FROM pending
      WHERE EXISTS(SELECT 1 FROM dmx_mainnet_claim_batches WHERE batch_id='${manifest.batchId}'
        AND credential_set_sha256='${fingerprint}' AND status='preparing' AND contract_address IS NULL)
      ON CONFLICT(batch_id,token_id) DO UPDATE SET code_hash=CASE
        WHEN dmx_mainnet_claim_codes.code_hash=excluded.code_hash
          AND dmx_mainnet_claim_codes.created_at_ms=excluded.created_at_ms AND dmx_mainnet_claim_codes.revoked_at_ms IS NULL
        THEN dmx_mainnet_claim_codes.code_hash ELSE NULL END;`);
  }
  const current = readBatch(manifest, database);
  if (!current) throw new Error('Mainnet batch disappeared during provisioning.');
  verifyRows(manifest, readCredentials(manifest, database), true);
  if (current.status === 'preparing') {
    database.executeCommand(`UPDATE dmx_mainnet_claim_batches SET status='staged',verified_at_ms=${Date.now()}
      WHERE batch_id='${manifest.batchId}' AND status='preparing' AND contract_address IS NULL
        AND credential_set_sha256='${fingerprint}'
        AND (SELECT COUNT(*) FROM dmx_mainnet_claim_codes WHERE batch_id='${manifest.batchId}')=${COUNT};`);
  }
  return verifyMainnetCredentials(manifest, database);
}

export function mainnetBindingConfiguration(contract: unknown, block: unknown, transactionHash: unknown): MainnetBinding {
  const contractAddress = normalizeEthereumAddress(contract);
  if (!contractAddress || /^0x0{40}$/.test(contractAddress) ||
    !((typeof block === 'string' && /^[1-9][0-9]*$/.test(block)) || typeof block === 'number') ||
    !Number.isSafeInteger(Number(block)) || Number(block) < 1 ||
    typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
    throw new Error('Mainnet binding requires a nonzero --contract, positive --deployment-block, and --deployment-transaction hash.');
  }
  return { contractAddress, deploymentBlock: Number(block), transactionHash: transactionHash.toLowerCase() };
}

export function mainnetBindingRpc(environment: Record<string, string | undefined> = process.env): MainnetRpc {
  const url = new URL(environment.ETHEREUM_TAROT_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com');
  if (url.protocol !== 'https:') throw new Error('Mainnet binding requires an HTTPS RPC.');
  return async (method, params = []) => {
    if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
      'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)) {
      throw new Error('Mainnet binding permits read-only RPC methods.');
    }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const body = await response.json() as { error?: unknown; result?: unknown };
    if (!response.ok || !body || body.error || !Object.hasOwn(body, 'result')) throw new Error('Mainnet binding RPC failed.');
    return body.result;
  };
}

function rpcQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid mainnet RPC quantity.');
  return BigInt(value);
}

function rpcBlock(value: unknown): { number: bigint; hash: string } {
  const block = value as { number?: unknown; hash?: unknown } | null;
  if (!block || typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) {
    throw new Error('Invalid mainnet block.');
  }
  const number = rpcQuantity(block.number);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid mainnet block number.');
  return { number, hash: block.hash.toLowerCase() };
}

function trustedDmxBuild(): Promise<TrustedBuild> {
  return trustedBuild ??= (async () => {
    const project = fileURLToPath(new URL('../../onchain/ethereum/', import.meta.url));
    const build = mkdtempSync(resolve(tmpdir(), 'dmx-binding-build-'));
    try {
      execFileSync('forge', ['build', '--offline', 'src/TarotCards.sol', '--out', resolve(build, 'out'),
        '--cache-path', resolve(build, 'cache')], { cwd: project, stdio: 'pipe', timeout: 30_000 });
      const artifact = JSON.parse(readFileSync(resolve(build, 'out/TarotCards.sol/TarotCards.json'), 'utf8'));
      if (artifact.metadata?.settings?.compilationTarget?.['src/TarotCards.sol'] !== 'TarotCards' ||
        typeof artifact.deployedBytecode?.object !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(artifact.deployedBytecode.object) ||
        typeof artifact.bytecode?.object !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(artifact.bytecode.object)) {
        throw new Error('Trusted DMX build did not produce the expected contract.');
      }
      const { matchingRuntime }: { matchingRuntime: (expected: string, actual: string,
        references: Record<string, { start: number; length: number }[]>) => boolean } =
        await import(new URL('../../onchain/ethereum/scripts/pre111k-deployment.mjs', import.meta.url).href);
      const expected: string = artifact.deployedBytecode.object;
      const references: Record<string, { start: number; length: number }[]> = artifact.deployedBytecode.immutableReferences ?? {};
      return { creationCode: artifact.bytecode.object.toLowerCase(),
        matchesRuntime: (code: string) => matchingRuntime(expected, code, references) };
    } finally { rmSync(build, { recursive: true, force: true }); }
  })().catch(error => { trustedBuild = undefined; throw error; });
}

async function verifyCreation(binding: MainnetBinding, deployment: { number: bigint; hash: string },
  rpc: MainnetRpc, build: TrustedBuild): Promise<void> {
  const [transaction, receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [binding.transactionHash]), rpc('eth_getTransactionReceipt', [binding.transactionHash]),
  ]);
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const matchesHash = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected;
  if (!record(transaction) || !record(receipt) || transaction.to !== null || receipt.to !== null || receipt.status !== '0x1' ||
    !matchesHash(transaction.hash, binding.transactionHash) || !matchesHash(receipt.transactionHash, binding.transactionHash) ||
    !matchesHash(transaction.blockHash, deployment.hash) || !matchesHash(receipt.blockHash, deployment.hash) ||
    normalizeEthereumAddress(receipt.contractAddress) !== binding.contractAddress ||
    rpcQuantity(transaction.blockNumber) !== deployment.number || rpcQuantity(receipt.blockNumber) !== deployment.number ||
    rpcQuantity(transaction.chainId) !== 1n || rpcQuantity(transaction.value) !== 0n) {
    throw new Error('Mainnet deployment transaction does not match the contract and canonical block.');
  }
  const from = normalizeEthereumAddress(transaction.from);
  if (!from || /^0x0{40}$/.test(from) || normalizeEthereumAddress(receipt.from) !== from) {
    throw new Error('Mainnet deployment sender is inconsistent.');
  }
  if (typeof transaction.input !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.input)) {
    throw new Error('Mainnet deployment creation code is invalid.');
  }
  const input = transaction.input.toLowerCase();
  if (!input.startsWith(build.creationCode) || input.length !== build.creationCode.length + 3 * 64) {
    throw new Error('Mainnet deployment creation code does not match the trusted DMX build.');
  }
  const encoded = '0x' + input.slice(build.creationCode.length);
  const args = decodeReturn(['address', 'address', 'address'], encoded);
  if (args.some(value => typeof value !== 'string' || /^0x0{40}$/.test(value) || value === binding.contractAddress) ||
    encodeAbi(['address', 'address', 'address'], args) !== encoded) {
    throw new Error('Mainnet deployment constructor arguments are invalid.');
  }
}

async function verifyBindingTarget(binding: MainnetBinding, rpc: MainnetRpc, build: TrustedBuild) {
  if (rpcQuantity(await rpc('eth_chainId')) !== 1n) throw new Error('Mainnet binding requires Ethereum chain 1.');
  const deploymentTag = '0x' + binding.deploymentBlock.toString(16);
  const deployment = rpcBlock(await rpc('eth_getBlockByNumber', [deploymentTag, false]));
  const current = rpcBlock(await rpc('eth_getBlockByNumber', ['latest', false]));
  if (deployment.number !== BigInt(binding.deploymentBlock) || current.number < deployment.number + 2n) {
    throw new Error('Mainnet deployment requires three canonical confirmations.');
  }
  await verifyCreation(binding, deployment, rpc, build);
  const currentTag = '0x' + current.number.toString(16);
  const previous = await rpc('eth_getCode', [binding.contractAddress, '0x' + (deployment.number - 1n).toString(16)]);
  if (previous !== '0x') throw new Error('Mainnet contract already existed before the supplied deployment block.');
  const readCode = async (address: string, block: string) => {
    const code = await rpc('eth_getCode', [address, block]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('Mainnet binding requires deployed contract code.');
    return code.toLowerCase();
  };
  const deployedCode = await readCode(binding.contractAddress, deploymentTag);
  if (await readCode(binding.contractAddress, currentTag) !== deployedCode) throw new Error('Mainnet collection runtime changed.');
  if (!build.matchesRuntime(deployedCode)) throw new Error('Mainnet collection runtime does not match the trusted DMX build.');
  const call = async (signature: string, types: string[]) => {
    const result = await rpc('eth_call', [{ to: binding.contractAddress, data: encodeCall(signature, [], []) }, currentTag]);
    if (typeof result !== 'string') throw new Error('Invalid mainnet contract response.');
    return decodeReturn(types, result);
  };
  for (const [signature, type, expected] of [
    ['name()', 'string', 'divination machina x'], ['symbol()', 'string', 'DMX'],
    ['INITIAL_CARDS()', 'uint256', 777n], ['MAX_CARDS()', 'uint256', 999999n], ['RECEIPT_OFFSET()', 'uint256', 999999n],
  ] as const) {
    if ((await call(signature, [type]))[0] !== expected) throw new Error('Unexpected mainnet DMX identity: ' + signature);
  }
  const [fields, name, version, chainId, verifyingContract] = await call('eip712Domain()',
    ['bytes1', 'string', 'string', 'uint256', 'address', 'bytes32', 'uint256[]']);
  if (fields !== '0x0f' || name !== 'divination machina x' || version !== '1' || chainId !== 1n ||
    verifyingContract !== binding.contractAddress) throw new Error('Unexpected mainnet DMX signing domain.');
  const quoteSigner = normalizeEthereumAddress((await call('quoteSigner()', ['address']))[0]);
  const renderer = normalizeEthereumAddress((await call('renderer()', ['address']))[0]);
  if (!quoteSigner || /^0x0{40}$/.test(quoteSigner) || !renderer || /^0x0{40}$/.test(renderer) || renderer === binding.contractAddress) {
    throw new Error('Invalid mainnet DMX signer or renderer.');
  }
  await readCode(renderer, currentTag);
  for (const [tag, expected] of [[deploymentTag, deployment], [currentTag, current]] as const) {
    const canonical = rpcBlock(await rpc('eth_getBlockByNumber', [tag, false]));
    if (canonical.number !== expected.number || canonical.hash !== expected.hash) throw new Error('Mainnet binding block is no longer canonical.');
  }
  return { deploymentBlock: binding.deploymentBlock, deploymentBlockHash: deployment.hash,
    deploymentTransactionHash: binding.transactionHash,
    observedBlock: Number(current.number), observedBlockHash: current.hash, quoteSigner, renderer };
}

function readBoundCredentials(manifest: MainnetClaimLinks, database: Database): Row[] {
  return database.query(`SELECT batch_id,chain_id,contract_address,token_id,code_hash,created_at_ms,revoked_at_ms
    FROM dmx_mainnet_bound_claim_codes WHERE batch_id='${manifest.batchId}' ORDER BY token_id`);
}

function verifyBoundRows(manifest: MainnetClaimLinks, contractAddress: string, rows: Row[], complete: boolean): void {
  const expected = new Map(manifest.links.map(link => [link.tokenId, hash(tarotCodeHashInput({
    chainId: 1, contractAddress, tokenId: link.tokenId, code: link.code,
  }))]));
  if (complete && rows.length !== COUNT) throw new Error('Mainnet credential binding is incomplete.');
  const seen = new Set<number>();
  for (const row of rows) {
    const tokenId = Number(row.token_id);
    if (!Number.isSafeInteger(row.token_id) || !expected.has(tokenId) || seen.has(tokenId) || row.batch_id !== manifest.batchId ||
      row.chain_id !== 1 || row.contract_address !== contractAddress || row.code_hash !== expected.get(tokenId) ||
      row.created_at_ms !== manifest.createdAtMs || row.revoked_at_ms !== null) {
      throw new Error('Existing mainnet bound credentials conflict with this binding.');
    }
    seen.add(tokenId);
  }
}

export async function bindMainnetCredentials(manifest: MainnetClaimLinks, database: Database, requested: MainnetBinding,
  rpc: MainnetRpc = mainnetBindingRpc()) {
  const binding = mainnetBindingConfiguration(requested.contractAddress, requested.deploymentBlock, requested.transactionHash);
  mainnetCredentials(manifest);
  const batch = readBatch(manifest, database, binding.contractAddress);
  if (!batch || !['staged', 'bound'].includes(String(batch.status))) throw new Error('Mainnet batch has not completed staging.');
  verifyRows(manifest, readCredentials(manifest, database), true);
  verifyBoundRows(manifest, binding.contractAddress, readBoundCredentials(manifest, database), batch.status === 'bound');
  const build = await trustedDmxBuild();
  let deployment = await verifyBindingTarget(binding, rpc, build);
  const fingerprint = mainnetCredentialFingerprint(manifest);
  if (batch.status !== 'bound') {
    const credentials = manifest.links.map(link => ({ tokenId: link.tokenId, codeHash: hash(tarotCodeHashInput({
      chainId: 1, contractAddress: binding.contractAddress, tokenId: link.tokenId, code: link.code,
    })) }));
    for (let offset = 0; offset < credentials.length; offset += 50) {
      const values = credentials.slice(offset, offset + 50).map(row => `(${row.tokenId},'${row.codeHash}')`).join(',');
      database.executeCommand(`WITH pending(token_id,code_hash) AS (VALUES ${values})
        INSERT INTO dmx_mainnet_bound_claim_codes(batch_id,chain_id,contract_address,token_id,code_hash,created_at_ms,revoked_at_ms)
        SELECT '${manifest.batchId}',1,'${binding.contractAddress}',token_id,code_hash,${manifest.createdAtMs},NULL FROM pending
        WHERE EXISTS(SELECT 1 FROM dmx_mainnet_claim_batches WHERE batch_id='${manifest.batchId}'
          AND credential_set_sha256='${fingerprint}' AND status='staged' AND contract_address IS NULL
          AND verified_at_ms=${Number(batch.verified_at_ms)})
        ON CONFLICT(batch_id,token_id) DO UPDATE SET code_hash=CASE
          WHEN dmx_mainnet_bound_claim_codes.chain_id=excluded.chain_id
            AND dmx_mainnet_bound_claim_codes.contract_address=excluded.contract_address
            AND dmx_mainnet_bound_claim_codes.code_hash=excluded.code_hash
            AND dmx_mainnet_bound_claim_codes.created_at_ms=excluded.created_at_ms
            AND dmx_mainnet_bound_claim_codes.revoked_at_ms IS NULL
          THEN dmx_mainnet_bound_claim_codes.code_hash ELSE NULL END;`);
    }
    verifyRows(manifest, readCredentials(manifest, database), true);
    verifyBoundRows(manifest, binding.contractAddress, readBoundCredentials(manifest, database), true);
    deployment = await verifyBindingTarget(binding, rpc, build);
    database.executeCommand(`UPDATE dmx_mainnet_claim_batches SET status='bound',contract_address='${binding.contractAddress}',
      bound_at_ms=${Math.max(Date.now(), Number(batch.verified_at_ms))}
      WHERE batch_id='${manifest.batchId}' AND status='staged' AND contract_address IS NULL
        AND credential_set_sha256='${fingerprint}' AND verified_at_ms=${Number(batch.verified_at_ms)}
        AND (SELECT COUNT(*) FROM dmx_mainnet_claim_codes WHERE batch_id='${manifest.batchId}'
          AND revoked_at_ms IS NULL AND created_at_ms=${manifest.createdAtMs})=${COUNT}
        AND (SELECT COUNT(*) FROM dmx_mainnet_bound_claim_codes WHERE batch_id='${manifest.batchId}')=${COUNT}
        AND (SELECT COUNT(*) FROM dmx_mainnet_bound_claim_codes WHERE batch_id='${manifest.batchId}'
          AND chain_id=1 AND contract_address='${binding.contractAddress}' AND revoked_at_ms IS NULL
          AND created_at_ms=${manifest.createdAtMs})=${COUNT};`);
  }
  const bound = readBatch(manifest, database, binding.contractAddress);
  if (!bound || bound.status !== 'bound') throw new Error('Mainnet credential binding did not complete.');
  verifyRows(manifest, readCredentials(manifest, database), true);
  verifyBoundRows(manifest, binding.contractAddress, readBoundCredentials(manifest, database), true);
  return { batchId: manifest.batchId, chainId: 1, collectionKey: COLLECTION, credentialCount: COUNT,
    credentialSetSha256: fingerprint, status: 'bound' as const, contractAddress: binding.contractAddress, verified: true, ...deployment };
}
