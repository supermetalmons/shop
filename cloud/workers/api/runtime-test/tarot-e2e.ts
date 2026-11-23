import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress } from '../../../../shared/ethereum/crypto.ts';
import { TAROT_API_PATHS, TAROT_CHAIN_ID, TAROT_METADATA_BASE_URI, tarotCodeHashInput,
  type TarotConfirmResponse, type TarotPrepareResponse, type TarotStatus } from '../../../../shared/ethereum/tarot.ts';
import { handleTarotRequest, type TarotEnvironment } from '../src/tarot.ts';
import { d1Database } from '../test/commerceD1Harness.ts';

const root = resolve(import.meta.dirname, '../../../..');
const project = resolve(root, 'onchain/ethereum');
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
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(TAROT_CHAIN_ID), '--hardfork', 'prague', '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilError = '';
anvil.stderr.on('data', data => { anvilError += String(data); });
anvil.on('error', error => { anvilError += error.message; });
const rpcUrl = `http://127.0.0.1:${port}`;
const db = new DatabaseSync(':memory:');
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
  const artifact = JSON.parse(await readFile(resolve(project, 'out/TarotCards.sol/TarotCards.json'), 'utf8')) as { bytecode: { object: string } };
  const deployment = await send(admin, { data: `0x${artifact.bytecode.object.replace(/^0x/, '')}${encodeAbi(
    ['address', 'address', 'string'], [admin, ethereumSignerAddress(key), TAROT_METADATA_BASE_URI]).slice(2)}` });
  assert.ok(deployment.contractAddress);
  const contractAddress = deployment.contractAddress.toLowerCase();
  await rpc('anvil_mine', ['0x2']);
  db.exec(await readFile(resolve(root, 'cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql'), 'utf8'));
  const code = '11111111-1111-4111-8111-111111111111';
  for (const tokenId of [1, 2, 777]) db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)')
    .run(TAROT_CHAIN_ID, contractAddress, tokenId, createHash('sha256').update(tarotCodeHashInput({ chainId: TAROT_CHAIN_ID,
      contractAddress, tokenId, code })).digest('hex'), Date.now());
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: TarotEnvironment = {
    OPS_DB: d1Database(db), ALCHEMY_MI_NOTE_API_KEY: 'local-test', ETHEREUM_111K_RPC_URL: '',
    TAROT_ACCESS_IP_RATE_LIMITER: limiter, TAROT_PREPARE_RATE_LIMITER: limiter, TAROT_CONFIRM_IP_RATE_LIMITER: limiter,
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: contractAddress, ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: String(Number(deployment.blockNumber)),
    ETHEREUM_TAROT_SEPOLIA_ENABLED: 'true', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: key,
  };
  async function api<T>(path: string, body: unknown, expectedStatus = 200): Promise<T> {
    const response = await handleTarotRequest(new Request(`https://api.mons.shop${path}`, { method: 'POST',
      headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      body: JSON.stringify(body) }), env, path, { fetch: (_input, init) => fetch(rpcUrl, init) });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value as T;
  }
  const request = (tokenId: number) => ({ tokenId, testnet: true, code });
  const status = (tokenId: number) => api<TarotStatus>(TAROT_API_PATHS.status, request(tokenId));
  const prepare = (tokenId: number, owner = wallet) => api<TarotPrepareResponse>(TAROT_API_PATHS.prepare, { ...request(tokenId), wallet: owner });
  const confirm = (tokenId: number, transactionHash: string, owner = wallet) => api<TarotConfirmResponse>(TAROT_API_PATHS.confirm,
    { ...request(tokenId), wallet: owner, transactionHash });
  const ownerOf = async (tokenId: number) => decodeReturn(['address'], await rpc<string>('eth_call', [
    { to: contractAddress, data: encodeCall('ownerOf(uint256)', ['uint256'], [tokenId]) }, 'latest',
  ]))[0];
  assert.equal((await status(1)).claimed, false);
  await api(TAROT_API_PATHS.prepare, { ...request(1), wallet, code: '22222222-2222-4222-8222-222222222222' }, 401);
  await api(TAROT_API_PATHS.prepare, { ...request(1), wallet, testnet: false }, 400);
  const quote = await prepare(1);
  assert.equal(quote.transaction.value, '0x0');
  await assert.rejects(send(other, quote.transaction), /revert/);
  await assert.rejects(send(wallet, { ...quote.transaction, value: '0x1' }), /revert/);
  const receipt = await send(wallet, quote.transaction);
  assert.equal(await ownerOf(1), wallet);
  assert.equal(await ownerOf(778), wallet);
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
  assert.equal(await ownerOf(779), wallet);
  const boundary = await prepare(777, other);
  const boundaryReceipt = await send(other, boundary.transaction);
  await rpc('anvil_mine', ['0x2']);
  assert.equal((await confirm(777, boundaryReceipt.transactionHash, other)).status, 'confirmed');
  assert.equal(await ownerOf(777), other);
  assert.equal(await ownerOf(1554), other);
  await send(wallet, { to: contractAddress, data: encodeCall('transferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [wallet, other, 1]) });
  assert.equal((await status(1)).claimed, true);
  env.ETHEREUM_TAROT_SEPOLIA_ENABLED = 'false';
  env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = '';
  assert.equal((await status(1)).claimed, true);
  assert.equal((await confirm(1, receipt.transactionHash)).status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tarot_claim_codes WHERE revoked_at_ms IS NULL').get()?.count, 3);
  console.log('Tarot E2E passed: secret validation, atomic paired mints, three-confirmation status, wallet binding, replay and race rejection, endpoint IDs, transfers, and paused recovery.');
} finally {
  db.close();
  anvil.kill('SIGTERM');
}
