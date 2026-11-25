import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { dmxRedemptionReceiptTokenId, encodeDmxMintTo, encodeDmxMintToAuthorized, encodeDmxRedeem,
  type DMXRedemptionQuote } from '../../../../shared/ethereum/dmx.ts';
import { dmxMintDigest, dmxRedemptionDigest, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.ts';
import { TAROT_API_PATHS, encodeTarotClaimTo, tarotChainId, tarotCodeHashInput, tarotReceiptTokenId,
  type TarotConfirmResponse, type TarotPrepareResponse, type TarotStatus } from '../../../../shared/ethereum/tarot.ts';
import { bindMainnetCredentials, stageMainnetCredentials, type MainnetClaimLinks } from '../../../../scripts/tarot/mainnetClaims.ts';
import { handleTarotRequest, type TarotEnvironment } from '../src/tarot.ts';
import { d1Database } from '../test/commerceD1Harness.ts';

const root = resolve(import.meta.dirname, '../../../..');
const project = resolve(root, 'onchain/ethereum');
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== '--mainnet') throw new Error('Use tarot-e2e.ts [--mainnet].');
const testnet = args.length === 0;
const chainId = tarotChainId(testnet);
const build = spawnSync('forge', ['build', '--offline'], { cwd: project, stdio: 'inherit' });
if (build.status !== 0) throw new Error('Contract compilation failed');
const port = await new Promise<number>((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate local port')); return; }
    server.close(error => error ? reject(error) : done(address.port));
  });
});
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--hardfork', 'prague', '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilError = '';
anvil.stderr.on('data', data => { anvilError += String(data); });
anvil.on('error', error => { anvilError += error.message; });
const rpcUrl = `http://127.0.0.1:${port}`;
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message || `RPC ${method} failed`);
  return body.result;
}
type Receipt = { status: string; contractAddress: string | null; blockNumber: string; blockHash: string; transactionHash: string };
async function send(from: string, transaction: { data: string; to?: string; value?: string }): Promise<Receipt> {
  const gas = await rpc<string>('eth_estimateGas', [{ from, ...transaction }]);
  const hash = await rpc<string>('eth_sendTransaction', [{ from, ...transaction, gas }]);
  for (let i = 0; i < 100; i++) {
    const receipt = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) { assert.equal(receipt.status, '0x1'); return receipt; }
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Local transaction did not mine');
}

try {
  let connected = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('eth_chainId'); connected = true; break; } catch {}
    await new Promise(done => setTimeout(done, 25));
  }
  if (!connected) throw new Error(`Anvil did not start: ${anvilError}`);
  const [admin, wallet, other] = await rpc<string[]>('eth_accounts');
  const key = `0x${'44'.repeat(32)}`;
  const rendererArtifact = JSON.parse(await readFile(resolve(project, 'out/DMXWebpRenderer.sol/DMXWebpRenderer.json'), 'utf8')) as { bytecode: { object: string } };
  const rendererDeployment = await send(admin, { data: rendererArtifact.bytecode.object });
  assert.ok(rendererDeployment.contractAddress);
  const artifact = JSON.parse(await readFile(resolve(project, 'out/TarotCards.sol/TarotCards.json'), 'utf8')) as { bytecode: { object: string } };
  const deployment = await send(admin, { data: `0x${artifact.bytecode.object.replace(/^0x/, '')}${encodeAbi(
    ['address', 'address', 'address'], [admin, ethereumSignerAddress(key), rendererDeployment.contractAddress]).slice(2)}` });
  assert.ok(deployment.contractAddress);
  const contractAddress = deployment.contractAddress.toLowerCase();
  const deploymentBlock = Number(deployment.blockNumber);
  await rpc('anvil_mine', ['0x2']);
  db.exec(await readFile(resolve(root, 'cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql'), 'utf8'));
  db.exec(await readFile(resolve(root, 'cloud/workers/api/ops-migrations/0017_dmx_sepolia_retirement.sql'), 'utf8'));
  const manifest: MainnetClaimLinks | null = testnet ? null : {
    version: 1, chainId: 1, collectionKey: 'dmx-mainnet-v1', contractAddress: null,
    batchId: '00000000-0000-4000-8000-000000000000', createdAtMs: Date.now(),
    links: Array.from({ length: 777 }, (_, index) => {
      const tokenId = index + 1;
      const code = `00000000-0000-4000-8000-${tokenId.toString(16).padStart(12, '0')}`;
      return { tokenId, code, url: `https://mons.shop/nfc?code=${code}&tokenId=${tokenId}` };
    }),
  };
  const codeFor = (tokenId: number) => manifest?.links[tokenId - 1].code ?? '11111111-1111-4111-8111-111111111111';
  if (testnet) {
    for (const tokenId of [1, 2, 777]) db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)')
      .run(chainId, contractAddress, tokenId, createHash('sha256').update(tarotCodeHashInput({ chainId,
        contractAddress, tokenId, code: codeFor(tokenId) })).digest('hex'), Date.now());
  } else {
    for (const migration of ['0015_dmx_mainnet_claim_staging.sql', '0016_dmx_mainnet_bound_claim_codes.sql']) {
      db.exec(await readFile(resolve(root, 'cloud/workers/api/ops-migrations', migration), 'utf8'));
    }
  }
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: TarotEnvironment = {
    OPS_DB: d1Database(db), ALCHEMY_MI_NOTE_API_KEY: 'local-test', ETHEREUM_111K_RPC_URL: '',
    TAROT_ACCESS_IP_RATE_LIMITER: limiter, TAROT_PREPARE_RATE_LIMITER: limiter, TAROT_CONFIRM_IP_RATE_LIMITER: limiter,
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: testnet ? contractAddress : '',
    ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: testnet ? String(deploymentBlock) : '0',
    ETHEREUM_TAROT_SEPOLIA_ENABLED: testnet ? 'true' : 'false', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: testnet ? key : '',
  };
  let apiRpcRequests = 0;
  async function api<T>(path: string, body: unknown, expectedStatus = 200): Promise<T> {
    const response = await handleTarotRequest(new Request(`https://api.mons.shop${path}`, { method: 'POST',
      headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      body: JSON.stringify(body) }), env, path, { fetch: (_input, init) => { apiRpcRequests++; return fetch(rpcUrl, init); } });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value as T;
  }
  const request = (tokenId: number) => ({ tokenId, testnet, code: codeFor(tokenId) });
  const status = (tokenId: number) => api<TarotStatus>(TAROT_API_PATHS.status, request(tokenId));
  const prepare = (tokenId: number, owner = wallet) => api<TarotPrepareResponse>(TAROT_API_PATHS.prepare, { ...request(tokenId), wallet: owner });
  const confirm = (tokenId: number, transactionHash: string, owner = wallet) => api<TarotConfirmResponse>(TAROT_API_PATHS.confirm,
    { ...request(tokenId), wallet: owner, transactionHash });
  const ownerOf = async (tokenId: number) => decodeReturn(['address'], await rpc<string>('eth_call', [
    { to: contractAddress, data: encodeCall('ownerOf(uint256)', ['uint256'], [tokenId]) }, 'latest',
  ]))[0];
  if (manifest) {
    await api(TAROT_API_PATHS.status, request(1), 503);
    await api(TAROT_API_PATHS.prepare, { ...request(1), wallet }, 503);
    const database = { query: (sql: string) => db.prepare(sql).all(), executeCommand: (sql: string) => db.exec(sql) };
    assert.equal(stageMainnetCredentials(manifest, database).status, 'staged');
    env.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS = contractAddress;
    env.ETHEREUM_TAROT_MAINNET_DEPLOYMENT_BLOCK = String(deploymentBlock);
    env.ETHEREUM_TAROT_MAINNET_ENABLED = 'true';
    env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET = key;
    await api(TAROT_API_PATHS.status, request(1), 503);
    await api(TAROT_API_PATHS.prepare, { ...request(1), wallet }, 503);
    assert.equal(apiRpcRequests, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dmx_mainnet_bound_claim_codes').get()?.count, 0);
    const bound = await bindMainnetCredentials(manifest, database,
      { contractAddress, deploymentBlock, transactionHash: deployment.transactionHash }, rpc);
    assert.equal(bound.status, 'bound');
    assert.equal(bound.credentialCount, 777);
    assert.equal(bound.contractAddress, contractAddress);
    assert.equal((await api<TarotStatus>(TAROT_API_PATHS.status, { tokenId: 1, code: codeFor(1) })).config.chainId, 1);
  }
  const initial = await status(1);
  assert.equal(initial.claimed, false);
  assert.equal(initial.config.chainId, chainId);
  assert.equal(initial.config.testnet, testnet);
  await api(TAROT_API_PATHS.prepare, { ...request(1), wallet, code: '22222222-2222-4222-8222-222222222222' }, 401);
  await api(TAROT_API_PATHS.prepare, { ...request(1), wallet, testnet: !testnet }, 503);
  const quote = await prepare(1);
  assert.equal(quote.transaction.value, '0x0');
  assert.equal(quote.transaction.chainId, chainId);
  await assert.rejects(send(other, quote.transaction), /revert/);
  await assert.rejects(send(wallet, { ...quote.transaction, value: '0x1' }), /revert/);
  const receipt = await send(wallet, quote.transaction);
  assert.equal(await ownerOf(1), wallet);
  assert.equal(await ownerOf(tarotReceiptTokenId(1)), wallet);
  assert.equal((await status(1)).claimed, false);
  const pending = await confirm(1, receipt.transactionHash);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.blockNumber, Number(receipt.blockNumber));
  assert.equal(pending.blockHash, receipt.blockHash);
  await api(TAROT_API_PATHS.prepare, { ...request(1), wallet }, 409);
  await rpc('anvil_mine', ['0x2']);
  const confirmed = await confirm(1, receipt.transactionHash);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.blockNumber, Number(receipt.blockNumber));
  assert.equal(confirmed.blockHash, receipt.blockHash);
  assert.equal((await status(1)).claimed, true);
  await assert.rejects(send(wallet, quote.transaction), /revert/);
  const [first, competitor] = await Promise.all([prepare(2), prepare(2, other)]);
  const raced = await send(wallet, first.transaction);
  await assert.rejects(send(other, competitor.transaction), /revert/);
  await rpc('anvil_mine', ['0x2']);
  assert.equal((await confirm(2, raced.transactionHash)).status, 'confirmed');
  assert.equal(await ownerOf(2), wallet);
  assert.equal(await ownerOf(tarotReceiptTokenId(2)), wallet);
  const boundary = await prepare(777, other);
  const boundaryReceipt = await send(other, boundary.transaction);
  await rpc('anvil_mine', ['0x2']);
  assert.equal((await confirm(777, boundaryReceipt.transactionHash, other)).status, 'confirmed');
  assert.equal(await ownerOf(777), other);
  assert.equal(await ownerOf(tarotReceiptTokenId(777)), other);
  await send(wallet, { to: contractAddress, data: encodeCall('transferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [wallet, other, 1]) });
  assert.equal((await status(1)).claimed, true);

  const read = async (signature: string, types: string[], values: unknown[], returns: string[]) =>
    decodeReturn(returns, await rpc<string>('eth_call', [{ to: contractAddress, data: encodeCall(signature, types, values) }, 'latest']));
  const call = (from: string, signature: string, types: string[], values: unknown[]) =>
    send(from, { to: contractAddress, data: encodeCall(signature, types, values) });
  const deadline = async () => Number((await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false])).timestamp) + 600;
  const domain = { chainId, contractAddress };
  const metadata = async (tokenId: number | bigint) => {
    const [uri] = await read('tokenURI(uint256)', ['uint256'], [tokenId], ['string']);
    assert.equal(typeof uri, 'string');
    assert.ok((uri as string).startsWith('data:application/json;base64,'));
    return JSON.parse(Buffer.from((uri as string).slice('data:application/json;base64,'.length), 'base64').toString()) as {
      image: string; attributes: { trait_type: string; value: string | number }[];
    };
  };
  assert.equal((await metadata(1)).image, 'https://wip.lil.org/tarot/bases/1.webp');
  assert.equal((await metadata(tarotReceiptTokenId(1))).image, 'https://wip.lil.org/tarot/receipts/1.webp');

  await send(admin, { to: contractAddress, data: encodeDmxMintTo(other, [3, 778]) });
  assert.equal(await ownerOf(3), other);
  assert.equal(await ownerOf(tarotReceiptTokenId(3)), other);
  assert.equal(await ownerOf(778), other);
  await assert.rejects(send(wallet, { to: contractAddress, data: encodeDmxMintTo(wallet, [779]) }), /revert/);
  const mintQuote = { authorizationId: '0x' + '1'.padStart(64, '0'), recipient: wallet, deadline: await deadline() };
  const mintSignature = signDigest(key, dmxMintDigest({ ...domain, ...mintQuote, cardIds: [4, 779] }));
  const mintTransaction = { to: contractAddress, data: encodeDmxMintToAuthorized([4, 779], mintQuote, mintSignature) };
  await send(other, mintTransaction);
  assert.equal(await ownerOf(4), wallet);
  assert.equal(await ownerOf(tarotReceiptTokenId(4)), wallet);
  assert.equal(await ownerOf(779), wallet);
  await assert.rejects(send(admin, mintTransaction), /revert/);
  const claimDeadline = await deadline();
  const claimSignature = signDigest(key, tarotClaimDigest({ ...domain, wallet, tokenId: 5, deadline: claimDeadline }));
  await send(admin, { to: contractAddress, data: encodeTarotClaimTo(wallet, 5, claimDeadline, claimSignature) });
  assert.equal(await ownerOf(5), wallet);
  assert.equal(await ownerOf(tarotReceiptTokenId(5)), wallet);

  await call(admin, 'registerRedemptionConfig(address,address,uint16)', ['address', 'address', 'uint16'], [admin, other, 2500]);
  const redemptionQuote: DMXRedemptionQuote = { orderId: 1, wallet, recipient: wallet, fee: 1001, deadline: await deadline(), configId: 1 };
  const redemptionSignature = signDigest(key, dmxRedemptionDigest({ ...domain, ...redemptionQuote, inputCardIds: [2, 779], outputCardIds: [780, 781] }));
  const redemptionTransaction = { to: contractAddress, value: '0x3e9', data: encodeDmxRedeem([2, 779], [780, 781], redemptionQuote, redemptionSignature) };
  await assert.rejects(send(wallet, redemptionTransaction), /revert/);
  await call(admin, 'setRedemptionsPaused(bool)', ['bool'], [false]);
  await assert.rejects(send(other, redemptionTransaction), /revert/);
  await assert.rejects(send(wallet, { ...redemptionTransaction, value: '0x3e8' }), /revert/);
  await assert.rejects(send(wallet, { ...redemptionTransaction, data: encodeDmxRedeem([2, 779], [780], redemptionQuote, redemptionSignature) }), /revert/);
  await send(wallet, redemptionTransaction);
  await assert.rejects(send(wallet, redemptionTransaction), /revert/);
  for (const id of [2, 779]) {
    await assert.rejects(ownerOf(id), /revert/);
    assert.equal((await read('redeemedByOrder(uint256)', ['uint256'], [id], ['uint256']))[0], 1n);
    assert.equal((await read('ownerOf(uint256)', ['uint256'], [dmxRedemptionReceiptTokenId(id)], ['address']))[0], wallet);
  }
  assert.equal(await ownerOf(tarotReceiptTokenId(2)), wallet);
  for (const id of [780, 781]) {
    assert.equal(await ownerOf(id), wallet);
    assert.equal((await read('generation(uint256)', ['uint256'], [id], ['uint256']))[0], 1n);
  }
  assert.deepEqual(await read('getRedemption(uint256)', ['uint256'], [1], ['address', 'address', 'uint256[]', 'uint256[]']),
    [wallet, wallet, [2n, 779n], [780n, 781n]]);
  assert.equal((await metadata(dmxRedemptionReceiptTokenId(2))).image, 'https://wip.lil.org/tarot/receipts/2.webp');
  assert.deepEqual(await read('releasableRedemption(uint256)', ['uint256'], [1], ['uint256', 'uint256']), [751n, 250n]);
  const balancesBefore = await Promise.all([admin, other].map(address => rpc<string>('eth_getBalance', [address, 'latest'])));
  await call(wallet, 'releaseRedemption(uint256[])', ['uint256[]'], [[1, 1]]);
  const balancesAfter = await Promise.all([admin, other].map(address => rpc<string>('eth_getBalance', [address, 'latest'])));
  assert.deepEqual(balancesAfter.map((balance, index) => BigInt(balance) - BigInt(balancesBefore[index])), [751n, 250n]);
  assert.deepEqual(await read('releasableRedemption(uint256)', ['uint256'], [1], ['uint256', 'uint256']), [0n, 0n]);

  for (const [orderId, inputs, outputs, recipient] of [
    [9_007_199_254_740_993n, [780], [], other], [(1n << 256n) - 1n, [781], [782], wallet],
  ] as const) {
    const quote = { orderId, wallet, recipient, fee: 0, deadline: await deadline(), configId: 0 };
    const signature = signDigest(key, dmxRedemptionDigest({ ...domain, ...quote, inputCardIds: inputs, outputCardIds: outputs }));
    await send(wallet, { to: contractAddress, data: encodeDmxRedeem(inputs, outputs, quote, signature) });
    assert.equal((await read('ownerOf(uint256)', ['uint256'], [dmxRedemptionReceiptTokenId(inputs[0])], ['address']))[0], recipient);
    const receiptMetadata = await metadata(dmxRedemptionReceiptTokenId(inputs[0]));
    assert.equal(receiptMetadata.attributes.find(attribute => attribute.trait_type === 'Redeemed By Order')?.value, String(orderId));
    if (outputs.length) {
      const cardMetadata = await metadata(outputs[0]);
      assert.equal(cardMetadata.attributes.find(attribute => attribute.trait_type === 'Created By Order')?.value, String(orderId));
    }
  }
  assert.equal((await read('generation(uint256)', ['uint256'], [782], ['uint256']))[0], 2n);
  await assert.rejects(send(admin, { to: contractAddress, data: encodeDmxMintTo(wallet, [780]) }), /revert/);

  const batchInputs = Array.from({ length: 50 }, (_, index) => 100 + index);
  const batchOutputs = Array.from({ length: 50 }, (_, index) => 999_950 + index);
  await send(admin, { to: contractAddress, data: encodeDmxMintTo(wallet, batchInputs) });
  const batchQuote = { orderId: 99, wallet, recipient: other, fee: 1, deadline: await deadline(), configId: 1 };
  const batchSignature = signDigest(key, dmxRedemptionDigest({ ...domain, ...batchQuote,
    inputCardIds: batchInputs, outputCardIds: batchOutputs }));
  const batchTransaction = { to: contractAddress, value: '0x1',
    data: encodeDmxRedeem(batchInputs, batchOutputs, batchQuote, batchSignature) };
  const maximumBatchGas = BigInt(await rpc<string>('eth_estimateGas', [{ from: wallet, ...batchTransaction }]));
  assert.ok(maximumBatchGas < 16_000_000n, 'Maximum redemption must fit below the EIP-7825 transaction gas cap');
  await send(wallet, batchTransaction);
  assert.equal(await ownerOf(999_999), other);
  assert.equal(await ownerOf(tarotReceiptTokenId(149)), wallet);
  assert.equal((await read('ownerOf(uint256)', ['uint256'], [dmxRedemptionReceiptTokenId(149)], ['address']))[0], other);
  assert.deepEqual(await read('getRedemption(uint256)', ['uint256'], [99], ['address', 'address', 'uint256[]', 'uint256[]']),
    [wallet, other, batchInputs.map(BigInt), batchOutputs.map(BigInt)]);
  await assert.rejects(ownerOf(100), /revert/);
  await assert.rejects(ownerOf(149), /revert/);

  const nextRenderer = await send(admin, { data: rendererArtifact.bytecode.object });
  assert.ok(nextRenderer.contractAddress);
  await call(admin, 'setRenderer(address)', ['address'], [nextRenderer.contractAddress]);
  assert.equal((await read('renderer()', [], [], ['address']))[0], nextRenderer.contractAddress.toLowerCase());
  assert.equal((await metadata(782)).image, 'https://wip.lil.org/tarot/bases/782.webp');
  await call(admin, 'setMintingPaused(bool)', ['bool'], [true]);
  await rpc('anvil_mine', ['0x2']);
  assert.equal((await status(1)).config.enabled, false);
  if (testnet) {
    env.ETHEREUM_TAROT_SEPOLIA_ENABLED = 'false';
    env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = '';
  } else {
    env.ETHEREUM_TAROT_MAINNET_ENABLED = 'false';
    env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET = '';
  }
  assert.equal((await status(1)).claimed, true);
  assert.equal((await confirm(1, receipt.transactionHash)).status, 'confirmed');
  const credentialTable = testnet ? 'tarot_claim_codes' : 'dmx_mainnet_bound_claim_codes';
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${credentialTable} WHERE revoked_at_ms IS NULL`).get()?.count, testnet ? 3 : 777);
  if (!testnet) {
    assert.equal(db.prepare('SELECT status FROM dmx_mainnet_claim_batches').get()?.status, 'bound');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dmx_mainnet_claim_codes WHERE revoked_at_ms IS NULL').get()?.count, 777);
  }
  console.log(`DMX ${testnet ? 'Sepolia' : 'mainnet'} E2E passed: initial claims, relayed and owner mints, signed multi-generation redemption, fee splitting, receipt provenance, renderer swaps, replay rejection and paused recovery. Maximum 50-input/50-output redemption gas estimate:`, maximumBatchGas.toString());
} finally {
  db.close();
  anvil.kill('SIGTERM');
}
