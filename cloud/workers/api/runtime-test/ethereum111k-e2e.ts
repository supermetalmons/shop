import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeEventLogs, decodeReturn, encodeAbi, encodeCall, type EthereumLog } from '../../../../shared/ethereum/abi.ts';
import { crateClaimDigest, deliveryDigest, ethereumReceiptIdsHash, ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { ethereumHexQuantity, ethereumReceiptTokenId, ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_API_PATHS, ETHEREUM_SESSION_HEADER, type EthereumAuthChallenge, type EthereumSession, type EthereumDeliveryPrepareResponse, type EthereumDeliveryConfirmResponse, type EthereumClaimPrepareResponse, type EthereumSaveAddressResponse, type EthereumShipmentsResponse, type EthereumTransactionConfirmResponse } from '../../../../shared/ethereum/api.ts';
import { encryptAddressCipherText, serializeAddressCipherPayload } from '../../../../shared/addressCipher.ts';
import { createCommerceD1Harness, d1Database } from '../test/commerceD1Harness.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';

type Receipt = { status: string; transactionHash: string; contractAddress: string | null; gasUsed: string; logs: EthereumLog[] };
const root = resolve(import.meta.dirname, '../../../..');
const project = resolve(root, 'onchain/ethereum');
const output = resolve(root, '.cache/111k-e2e');
const build = spawnSync('forge', ['build', '--offline'], { cwd: project, stdio: 'inherit' });
if (build.status !== 0) throw new Error('Contract compilation failed');

const port = await new Promise<number>((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a local port')); return; }
    server.close(error => error ? reject(error) : done(address.port));
  });
});
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'prague', '--enable-tx-gas-limit', '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
let anvilError = '';
anvil.stderr.on('data', data => { anvilError += String(data); });
anvil.on('error', error => { anvilError += error.message; });
const rpcUrl = `http://127.0.0.1:${port}`;
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message || `RPC ${method} failed`);
  return body.result;
}
async function send(from: string, data: string, to?: string, value = 0n): Promise<Receipt> {
  const transaction = { from, ...(to ? { to } : {}), data, value: ethereumHexQuantity(value) };
  const gas = await rpc<string>('eth_estimateGas', [transaction]);
  assert.ok(BigInt(gas) <= 16_777_216n, 'Transaction exceeds mainnet gas limit');
  const hash = await rpc<string>('eth_sendTransaction', [{ ...transaction, gas }]);
  return mined(hash);
}
async function mined(hash: string, status = '0x1'): Promise<Receipt> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) { assert.equal(receipt.status, status); return receipt; }
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Local transaction was not mined: ${hash}`);
}
async function call(to: string, signature: string, types: string[] = [], args: unknown[] = [], returns: string[] = []): Promise<unknown[]> {
  const data = await rpc<string>('eth_call', [{ to, data: encodeCall(signature, types, args) }, 'latest']);
  return decodeReturn(returns, data);
}
async function deploy(name: string, from: string, types: string[] = [], args: unknown[] = []): Promise<Receipt> {
  const artifact = JSON.parse(await readFile(resolve(project, `out/${name}.sol/${name}.json`), 'utf8')) as { bytecode: { object: string }; deployedBytecode: { object: string } };
  assert.ok(artifact.deployedBytecode.object.replace(/^0x/, '').length / 2 <= 24_576, 'Contract exceeds EIP-170 size');
  return send(from, `0x${artifact.bytecode.object.replace(/^0x/, '')}${encodeAbi(types, args).slice(2)}`);
}

try {
  for (let attempt = 0; ; attempt++) {
    try { await rpc('eth_chainId'); break; } catch {
      if (attempt >= 100 || anvil.exitCode !== null) throw new Error(`Local Anvil failed: ${anvilError}`);
      await new Promise(done => setTimeout(done, 50));
    }
  }
  const [admin, buyer, secondBuyer] = await rpc<string[]>('eth_accounts');
  const key = bytesToHex(secp256k1.utils.randomPrivateKey());
  const signer = ethereumSignerAddress(key);
  const rendererReceipt = await deploy('Mons111kRenderer', admin);
  const deployment = await deploy('Mons111k', admin, ['address', 'address', 'address', 'address'], [admin, signer, admin, rendererReceipt.contractAddress]);
  const contract = deployment.contractAddress!;
  const info = (id: number | bigint) => call(contract, ETHEREUM_FUNCTIONS.tokenInfo, ['uint256'], [id], ['uint8', 'uint256', 'address']);
  const transact = (wallet: string, signature: string, types: string[], args: unknown[], value = 0n) => send(wallet, encodeCall(signature, types, args), contract, value);
  const gas: Record<string, string> = { deploy: BigInt(deployment.gasUsed).toString(), renderer: BigInt(rendererReceipt.gasUsed).toString() };
  const deadline = async () => Number(BigInt((await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false])).timestamp)) + 600;
  let orderId = 0;
  async function authorizeDelivery(wallet: string, tokenIds: number[]) {
    const infos = await Promise.all(tokenIds.map(info));
    const receiptIds = infos.map(([kind, displayId]) => {
      assert.ok(kind === 1n || kind === 2n);
      return ethereumReceiptTokenId(kind === 1n ? 'artwork' : 'crate', Number(displayId));
    });
    const quote = { wallet, orderId: ++orderId, fee: '100000000000000', deadline: await deadline(),
      receiptIdsHash: ethereumReceiptIdsHash(receiptIds) };
    const signature = signDigest(key, deliveryDigest({ ...quote, chainId: 31337, contractAddress: contract, tokenIds }));
    const data = encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery, ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
      [tokenIds, [quote.orderId, wallet, quote.fee, quote.deadline, quote.receiptIdsHash], signature]);
    return { quote, data };
  }
  async function redeem(wallet: string, tokenIds: number[]) {
    const { quote, data } = await authorizeDelivery(wallet, tokenIds);
    const receipt = await send(wallet, data, contract, BigInt(quote.fee));
    const event = decodeEventLogs(receipt.logs, contract).find(event => event.name === 'DeliveryRedeemed');
    assert.ok(event?.name === 'DeliveryRedeemed');
    assert.equal(event.orderId, quote.orderId);
    assert.equal(event.wallet, wallet.toLowerCase());
    assert.deepEqual(event.tokenIds, tokenIds.map(String));
    return { receipt, event };
  }
  async function claim(wallet: string, receiptId: number, expected: number[]) {
    const claimId = `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const expires = await deadline();
    const signature = signDigest(key, crateClaimDigest({ chainId: 31337, contractAddress: contract, wallet, receiptId, claimId, deadline: expires }));
    const receipt = await transact(wallet, ETHEREUM_FUNCTIONS.claimCrateReceipt, ['uint256', 'bytes32', 'uint256', 'bytes'], [receiptId, claimId, expires, signature]);
    const event = decodeEventLogs(receipt.logs, contract).find(event => event.name === 'CrateReceiptClaimed');
    assert.ok(event?.name === 'CrateReceiptClaimed');
    assert.deepEqual(event.receiptIds, expected.map(id => String(1_000_000 + id)));
    for (const displayId of expected) assert.deepEqual(await info(1_000_000 + displayId), [4n, BigInt(displayId), wallet.toLowerCase()]);
    assert.equal((await info(receiptId))[0], 0n);
    await assert.rejects(transact(wallet, ETHEREUM_FUNCTIONS.claimCrateReceipt, ['uint256', 'bytes32', 'uint256', 'bytes'], [receiptId, claimId, expires, signature]));
    return receipt;
  }

  gas.mintWarehouse = BigInt((await transact(buyer, ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [1], 1100000000000000n)).gasUsed).toString();
  assert.deepEqual(await info(116667), [3n, 1n, buyer.toLowerCase()]);
  gas.unboxWarehouse = BigInt((await transact(buyer, ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [116667])).gasUsed).toString();
  for (let number = 1; number <= 11; number++) assert.deepEqual(await info(111111 + number), [2n, BigInt(number), buyer.toLowerCase()]);
  assert.equal((await info(116667))[0], 0n);
  await transact(buyer, ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1], 100000000000000n);
  const beforeIdentityCheck = await rpc<string>('evm_snapshot');
  const beforeFirstOpening = await rpc<string>('evm_snapshot');
  await transact(buyer, ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]);
  assert.deepEqual(await info(1), [1n, 1n, buyer.toLowerCase()]);
  const stale = await authorizeDelivery(buyer, [1]);
  await rpc('evm_revert', [beforeFirstOpening]);
  await transact(buyer, ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111113]);
  const canonicalInfo = await info(1);
  assert.deepEqual(canonicalInfo, [1n, 21n, buyer.toLowerCase()]);
  const supplyBefore = await call(contract, ETHEREUM_FUNCTIONS.stats, [], [], ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool']);
  const identityBlock = await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
  await rpc('evm_setNextBlockTimestamp', [Math.max(Number(BigInt(identityBlock.timestamp)) + 1, stale.quote.deadline - 600)]);
  await rpc('anvil_mine', [1]);
  const staleHash = await rpc<string>('eth_sendTransaction', [{ from: buyer, to: contract, data: stale.data,
    value: ethereumHexQuantity(stale.quote.fee), gas: '0x2dc6c0' }]);
  await mined(staleHash, '0x0');
  assert.deepEqual(await info(1), canonicalInfo);
  assert.deepEqual(await call(contract, ETHEREUM_FUNCTIONS.stats, [], [], ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool']), supplyBefore);
  assert.deepEqual(await call(contract, 'usedDeliveryOrders(uint256)', ['uint256'], [stale.quote.orderId], ['bool']), [false]);
  assert.equal((await info(1000001))[0], 0n);
  assert.equal((await info(1000021))[0], 0n);
  const refreshed = await redeem(buyer, [1]);
  assert.deepEqual(refreshed.event.receiptIds, ['1000021']);
  await rpc('evm_revert', [beforeIdentityCheck]);
  gas.unboxCrate = BigInt((await transact(buyer, ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111113])).gasUsed).toString();
  assert.deepEqual(await info(1), [1n, 21n, buyer.toLowerCase()]);
  await transact(buyer, ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]);
  assert.deepEqual(await info(21), [1n, 1n, buyer.toLowerCase()]);
  await transact(buyer, ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256'], [buyer, secondBuyer, 1]);
  assert.deepEqual(await info(1), [1n, 21n, secondBuyer.toLowerCase()]);
  gas.redeemArtwork = BigInt((await redeem(secondBuyer, [1])).receipt.gasUsed).toString();
  assert.equal((await info(1))[0], 0n);
  assert.deepEqual(await info(1000021), [4n, 21n, secondBuyer.toLowerCase()]);
  gas.redeemCrate = BigInt((await redeem(buyer, [111114])).receipt.gasUsed).toString();
  await transact(buyer, ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256'], [buyer, secondBuyer, 2000003]);
  gas.claimCrate = BigInt((await claim(secondBuyer, 2000003, Array.from({ length: 20 }, (_, index) => 41 + index))).gasUsed).toString();

  let remaining = Number((await call(contract, 'remainingCrates()', [], [], ['uint256']))[0]);
  while (remaining >= 11) {
    const quantity = Math.min(15, Math.floor(remaining / 11));
    await transact(buyer, ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [quantity], BigInt(quantity) * 1100000000000000n);
    remaining -= quantity * 11;
  }
  assert.equal(remaining, 10);
  await assert.rejects(transact(buyer, ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [1], 1100000000000000n));
  await transact(buyer, ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [remaining], BigInt(remaining) * 100000000000000n);
  await assert.rejects(transact(buyer, ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1], 100000000000000n));
  const snapshot = await rpc<string>('evm_snapshot');
  const special = await transact(buyer, ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [116666]);
  gas.unboxSpecialCrate = BigInt(special.gasUsed).toString();
  for (let index = 0; index < 31; index++) assert.deepEqual(await info(41 + index), [1n, BigInt(111081 + index), buyer.toLowerCase()]);
  assert.equal(decodeEventLogs(special.logs, contract).filter(event => event.name === 'Transfer' && event.from === '0x' + '0'.repeat(40)).length, 31);
  await rpc('evm_revert', [snapshot]);
  await redeem(buyer, [116666]);
  gas.claimSpecialCrate = BigInt((await claim(buyer, 2005555, Array.from({ length: 31 }, (_, index) => 111081 + index))).gasUsed).toString();
  assert.equal(Number((await call(contract, 'remainingCrates()', [], [], ['uint256']))[0]), 0);

  const commerce = createCommerceD1Harness();
  const ops = new DatabaseSync(':memory:');
  try {
    if (!commerce.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ethereum_delivery_quotes'").get()) {
      commerce.database.exec(await readFile(resolve(root, 'cloud/workers/api/commerce-migrations/0037_ethereum_111k.sql'), 'utf8'));
    }
    ops.exec(await readFile(resolve(root, 'cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql'), 'utf8'));
    const limiter = { limit: async () => ({ success: true }) };
    const environment = {
      OPS_DB: d1Database(ops), COMMERCE_DB: commerce.db, ALCHEMY_MI_NOTE_API_KEY: '',
      ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contract,
      ETHEREUM_111K_RENDERER_ADDRESS: rendererReceipt.contractAddress!,
      ETHEREUM_111K_DEPLOYMENT_BLOCK: '0', ETHEREUM_111K_RPC_URL: rpcUrl,
      ETHEREUM_111K_SIGNER_SECRET: key, STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter,
      STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
    } as EthereumEnvironment;
    async function api<T>(path: string, body?: unknown, session?: EthereumSession): Promise<T> {
      const request = new Request(`https://mons.shop${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.111',
          'Content-Type': 'application/json', 'X-Mons-CSRF': '1', ...(session ? { [ETHEREUM_SESSION_HEADER]: session.token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = await handleEthereumRequest(request, environment, path.split('?')[0]);
      const result = await response.json();
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
      return result as T;
    }
    const challenge = await api<EthereumAuthChallenge>(ETHEREUM_API_PATHS.authChallenge, { dropId: '111k_devnet', address: buyer, chainId: 31337 });
    const signature = await rpc<string>('personal_sign', [`0x${Buffer.from(challenge.message).toString('hex')}`, buyer]);
    const session = await api<EthereumSession>(ETHEREUM_API_PATHS.authVerify, { challengeId: challenge.challengeId, signature });
    assert.equal(session.address, buyer.toLowerCase());
    const encrypted = serializeAddressCipherPayload(encryptAddressCipherText('Local Test\n111 Example Street\nTest City\nUnited States', Buffer.from('OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=', 'base64')), bytes => Buffer.from(bytes).toString('base64'));
    const saved = await api<EthereumSaveAddressResponse>(ETHEREUM_API_PATHS.addresses, { encrypted, country: 'United States', countryCode: 'US', hint: 'Local test', email: '111k-test@example.test' }, session);
    let prepared = await api<EthereumDeliveryPrepareResponse>(ETHEREUM_API_PATHS.deliveryPrepare, { tokenIds: ['111115'], addressId: saved.address.id, requestId: crypto.randomUUID() }, session);
    const beforeDelivery = await rpc<string>('evm_snapshot');
    let redeemed = await send(buyer, prepared.transaction.data, prepared.transaction.to, BigInt(prepared.transaction.value));
    const pending = await api<EthereumDeliveryConfirmResponse>(ETHEREUM_API_PATHS.deliveryConfirm, { orderId: prepared.orderId, transactionHash: redeemed.transactionHash }, session);
    assert.equal(pending.status, 'pending');
    await rpc('anvil_mine', [2]);
    const confirmed = await api<EthereumDeliveryConfirmResponse>(ETHEREUM_API_PATHS.deliveryConfirm, { orderId: prepared.orderId, transactionHash: redeemed.transactionHash }, session);
    assert.equal(confirmed.status, 'confirmed');
    const orphanedOrderId = prepared.orderId;
    const orphanedClaim = commerce.database.prepare('SELECT code, claim_id FROM ethereum_crate_claims WHERE receipt_id = ?').get('2000004') as { code: string; claim_id: string };
    const orphanedAuthorization = await api<EthereumClaimPrepareResponse>(ETHEREUM_API_PATHS.claimPrepare, { receiptId: '2000004', code: orphanedClaim.code }, session);
    await rpc('evm_revert', [beforeDelivery]);
    assert.deepEqual(await info(111115), [2n, 4n, buyer.toLowerCase()]);
    prepared = await api<EthereumDeliveryPrepareResponse>(ETHEREUM_API_PATHS.deliveryPrepare, { tokenIds: ['111115'], addressId: saved.address.id, requestId: crypto.randomUUID() }, session);
    assert.notEqual(prepared.orderId, orphanedOrderId);
    redeemed = await send(buyer, prepared.transaction.data, prepared.transaction.to, BigInt(prepared.transaction.value));
    await rpc('anvil_mine', [2]);
    const replacement = await api<EthereumDeliveryConfirmResponse>(ETHEREUM_API_PATHS.deliveryConfirm, { orderId: prepared.orderId, transactionHash: redeemed.transactionHash }, session);
    assert.equal(replacement.status, 'confirmed');
    const currentClaim = commerce.database.prepare('SELECT code, claim_id, order_id FROM ethereum_crate_claims WHERE receipt_id = ?').get('2000004') as { code: string; claim_id: string; order_id: number };
    assert.equal(currentClaim.order_id, prepared.orderId);
    assert.notEqual(currentClaim.code, orphanedClaim.code);
    assert.notEqual(currentClaim.claim_id, orphanedClaim.claim_id);
    const shipments = await api<EthereumShipmentsResponse>(ETHEREUM_API_PATHS.shipments, undefined, session);
    assert.ok(shipments.orders.some(order => order.deliveryId === prepared.orderId));
    const row = commerce.database.prepare('SELECT code FROM ethereum_crate_claims WHERE receipt_id = ?').get('2000004') as { code: string };
    assert.ok(row.code);
    const claimPrepared = await api<EthereumClaimPrepareResponse>(ETHEREUM_API_PATHS.claimPrepare, { receiptId: '2000004', code: row.code }, session);
    assert.equal(claimPrepared.claimId, currentClaim.claim_id);
    const claimBlock = await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
    await rpc('evm_setNextBlockTimestamp', [Math.max(Number(BigInt(claimBlock.timestamp)) + 1, orphanedAuthorization.deadline - 600)]);
    await rpc('anvil_mine', [1]);
    const claimed = await send(buyer, orphanedAuthorization.transaction.data, orphanedAuthorization.transaction.to, BigInt(orphanedAuthorization.transaction.value));
    await rpc('anvil_mine', [2]);
    const claimResult = await api<{ status: string }>(ETHEREUM_API_PATHS.claimConfirm, { claimId: orphanedAuthorization.claimId, transactionHash: claimed.transactionHash }, session);
    assert.equal(claimResult.status, 'confirmed');
    for (let id = 61; id <= 80; id++) assert.deepEqual(await info(1000000 + id), [4n, BigInt(id), buyer.toLowerCase()]);
    const inventory = await api<{ items: Array<{ tokenId: string; owner: string }> }>(`${ETHEREUM_API_PATHS.inventory}?owner=${buyer}&expectedTokenIds=1000061,1000080`);
    assert.ok(inventory.items.some(item => item.tokenId === '1000061'));
    assert.ok(inventory.items.every(item => item.owner === buyer.toLowerCase()));
    gas.apiSignedDelivery = BigInt(redeemed.gasUsed).toString();
    gas.apiSignedClaim = BigInt(claimed.gasUsed).toString();
    const mixedIds = ['111116', '22', '2'];
    const mixedReceiptIds = ['2000005', '1000002', '1000022'];
    const mixedRequest = { tokenIds: mixedIds, addressId: saved.address.id, requestId: crypto.randomUUID() };
    const mixedPrepared = await api<EthereumDeliveryPrepareResponse>(ETHEREUM_API_PATHS.deliveryPrepare, mixedRequest, session);
    const repeatedMixed = await api<EthereumDeliveryPrepareResponse>(ETHEREUM_API_PATHS.deliveryPrepare, mixedRequest, session);
    assert.deepEqual(repeatedMixed, mixedPrepared);
    assert.equal(mixedPrepared.quote.receiptIdsHash, ethereumReceiptIdsHash(mixedReceiptIds));
    const mixed = await send(buyer, mixedPrepared.transaction.data, mixedPrepared.transaction.to, BigInt(mixedPrepared.transaction.value));
    const mixedEvents = decodeEventLogs(mixed.logs, contract);
    const mixedDelivery = mixedEvents.find(event => event.name === 'DeliveryRedeemed');
    assert.ok(mixedDelivery?.name === 'DeliveryRedeemed');
    assert.deepEqual(mixedDelivery.tokenIds, mixedIds);
    assert.deepEqual(mixedDelivery.receiptIds, mixedReceiptIds);
    const mixedTransfers = mixedEvents.filter(event => event.name === 'Transfer');
    assert.deepEqual(mixedTransfers.map(event => [event.from, event.to, event.tokenId]), [
      ...mixedIds.map(id => [buyer.toLowerCase(), '0x' + '0'.repeat(40), id]),
      ...mixedReceiptIds.map(id => ['0x' + '0'.repeat(40), buyer.toLowerCase(), id]),
    ]);
    assert.equal(mixedEvents.at(-1)?.name, 'DeliveryRedeemed');
    const includedMixed = await api<EthereumTransactionConfirmResponse>(ETHEREUM_API_PATHS.transactionsConfirm, { transactionHash: mixed.transactionHash });
    assert.equal(includedMixed.status, 'confirmed');
    assert.deepEqual(includedMixed.burnedTokenIds, mixedIds);
    assert.deepEqual(includedMixed.items.map(item => [item.tokenId, item.displayId]), [
      ['2000005', 5], ['1000002', 2], ['1000022', 22],
    ]);
    await rpc('anvil_mine', [2]);
    const mixedConfirmed = await api<EthereumDeliveryConfirmResponse>(ETHEREUM_API_PATHS.deliveryConfirm,
      { orderId: mixedPrepared.orderId, transactionHash: mixed.transactionHash }, session);
    assert.equal(mixedConfirmed.status, 'confirmed');
    const mixedShipments = await api<EthereumShipmentsResponse>(ETHEREUM_API_PATHS.shipments, undefined, session);
    const mixedOrder = mixedShipments.orders.find(order => order.deliveryId === mixedPrepared.orderId);
    assert.deepEqual(mixedOrder?.items, [{ kind: 'box', refId: 5 }, { kind: 'dude', refId: 2 }, { kind: 'dude', refId: 22 }]);
    gas.apiSignedMixedDelivery = BigInt(mixed.gasUsed).toString();
  } finally { commerce.database.close(); ops.close(); }

  await mkdir(output, { recursive: true });
  const previews = [{ kind: 1, id: 111111, name: 'artwork' }, { kind: 2, id: 5555, name: 'crate' }, { kind: 3, id: 505, name: 'warehouse' }, { kind: 4, id: 111111, name: 'artwork-receipt' }, { kind: 5, id: 5555, name: 'crate-receipt' }];
  for (const preview of previews) {
    const [uri] = await call(contract, ETHEREUM_FUNCTIONS.previewTokenURI, ['uint8', 'uint256'], [preview.kind, preview.id], ['string']);
    assert.ok(typeof uri === 'string' && uri.startsWith('data:application/json;base64,'));
    const metadata = JSON.parse(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString()) as { name: string; image: string };
    assert.ok(metadata.name.includes(String(preview.id)));
    assert.ok(metadata.image.startsWith('data:image/svg+xml;base64,'));
    const svg = Buffer.from(metadata.image.slice(metadata.image.indexOf(',') + 1), 'base64').toString();
    assert.match(svg, /<svg/);
    assert.doesNotMatch(svg, /<script|<image|https?:\/\/(?!www\.w3\.org)/);
    await writeFile(resolve(output, `${preview.name}.svg`), svg);
    await writeFile(resolve(output, `${preview.name}.json`), JSON.stringify(metadata, null, 2));
  }
  const report = { chainId: 31337, contract, renderer: rendererReceipt.contractAddress, gas, passed: ['warehouse mint/unpack', 'mixed direct supply', 'fixed item numbers across opening order', 'transfers preserve artwork identity', 'signed artwork delivery', 'signed crate delivery', 'transferred receipt claim', 'supply exhaustion', '31-artwork digital unpack', '31-artwork physical receipt claim', 'replay rejection', 'Ethereum API login and encrypted profile', 'API quote and real-chain redemption', 'three-confirmation fulfillment publication', 'API orphaned crate redelivery under a new order', 'stale artwork identity quote reverts before burning; fresh quote succeeds', 'API secret-code claim and real-chain receipts', 'mixed inventory ownership read', 'unsorted mixed API quotes preserve receipt identities and grouped burn/mint logs through fulfillment', 'all five onchain SVG types'] };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  anvil.kill('SIGTERM');
  await new Promise<void>(done => { if (anvil.exitCode !== null) done(); else { anvil.once('exit', () => done()); setTimeout(() => { anvil.kill('SIGKILL'); done(); }, 2000).unref(); } });
}
