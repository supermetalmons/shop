import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import { encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_PATHS, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.ts';
import { initializeLocalEthereumReveal, localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';

export async function runEthereumRevealE2E(input: {
  root: string; rpcUrl: string; contractAddress: string; deploymentBlock: number; metadataBaseUri: string; buyer: string;
  rpc: <T>(method: string, params?: unknown[]) => Promise<T>;
}) {
  const production = JSON.parse(await readFile(resolve(input.root, 'cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const emptySecrets = Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, '']));
  const config = {
    ...production, ...localEthereumRevealBindings(), main: resolve(input.root, 'cloud/workers/api/src/index.ts'),
    vars: { ...production.vars, ...emptySecrets, ETHEREUM_111K_CHAIN_ID: '31337',
      ETHEREUM_111K_CONTRACT_ADDRESS: input.contractAddress, ETHEREUM_111K_RPC_URL: input.rpcUrl,
      ETHEREUM_111K_DEPLOYMENT_BLOCK: String(input.deploymentBlock), ETHEREUM_111K_METADATA_BASE_URI: input.metadataBaseUri },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({
      ...database, remote: false, migrations_dir: resolve(input.root, 'cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete config.$schema;
  delete config.account_id;
  delete config.routes;
  delete config.secrets;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const directory = await mkdtemp(join(tmpdir(), '111k-reveal-e2e-'));
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker<Env>('mons-shop-api');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    const env = await worker.getEnv();
    const deployment = await initializeLocalEthereumReveal(env, input);
    const scope = { chainId: 31337, contractAddress: input.contractAddress };
    async function request<T>(path: string, body: object): Promise<T> {
      const response = await worker.fetch(`https://api.mons.shop${path}`, {
        method: 'POST', headers: { Origin: 'https://vvv.so', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
        body: JSON.stringify({ ...scope, ...body }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://vvv.so');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      return value as T;
    }
    let unminted: EthereumRevealTokensResponse | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      unminted = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['1', '111111'] });
      if (unminted.unresolved.every(value => value.status === 'unminted')) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(unminted);
    assert.deepEqual(unminted.artworks, []);
    assert.deepEqual(unminted.unresolved, [{ tokenId: '1', status: 'unminted' }, { tokenId: '111111', status: 'unminted' }]);
    const snapshot = await input.rpc<string>('evm_snapshot');
    await input.rpc('evm_setAutomine', [false]);
    let transactionHash: string;
    try {
      const transaction = { from: input.buyer, to: input.contractAddress, value: '0x0',
        data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']) };
      const gas = await input.rpc<string>('eth_estimateGas', [transaction]);
      transactionHash = await input.rpc<string>('eth_sendTransaction', [{ ...transaction, gas }]);
      const pending = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash });
      assert.equal(pending.status, 'pending');
      assert.deepEqual(pending.artworks, []);
      assert.equal((await env.ETHEREUM_REVEAL_METADATA.list()).objects.length, 0);
      await input.rpc('anvil_mine', [1]);
    } finally { await input.rpc('evm_setAutomine', [true]); }
    let revealed: EthereumRevealTransactionResponse | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      revealed = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash });
      if (revealed.status === 'revealed') break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(revealed?.status, 'revealed');
    assert.equal(revealed.artworks.length, 20);
    assert.deepEqual(revealed.artworks.map(artwork => artwork.tokenId), Array.from({ length: 20 }, (_, index) => String(index + 1)));
    assert.equal(new Set(revealed.artworks.map(artwork => artwork.image)).size, 20);
    assert.ok(revealed.artworks.every(artwork => artwork.aspectRatio.width > 0 && artwork.aspectRatio.height > 0));
    const receipt = await input.rpc<{ blockNumber: string; blockHash: string }>('eth_getTransactionReceipt', [transactionHash]);
    assert.equal(await input.rpc<string>('eth_blockNumber'), receipt.blockNumber);
    assert.ok(revealed.artworks.every(artwork => artwork.observation.blockHash === receipt.blockHash));
    const key = `${new URL(input.metadataBaseUri).pathname.slice(1)}1.json`;
    let published: string | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const object = await env.ETHEREUM_REVEAL_METADATA.get(key);
      if (object) { published = await object.text(); break; }
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(published);
    assert.equal(JSON.parse(published).image, revealed.artworks[0].image);
    assert.deepEqual(JSON.parse(published).aspectRatio, revealed.artworks[0].aspectRatio);
    assert.equal(await input.rpc('evm_revert', [snapshot]), true);
    const afterReorg = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['1'] });
    assert.deepEqual(afterReorg.artworks, [revealed.artworks[0]]);
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get(key))!.text(), published);
    const mint = { from: input.buyer, to: input.contractAddress, value: '0x5af3107a4000',
      data: encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [1]) };
    await input.rpc('eth_sendTransaction', [{ ...mint, gas: await input.rpc<string>('eth_estimateGas', [mint]) }]);
    const unpack = { from: input.buyer, to: input.contractAddress, value: '0x0',
      data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [['111112', '111113']]) };
    const recoveryHash = await input.rpc<string>('eth_sendTransaction', [{ ...unpack, gas: await input.rpc<string>('eth_estimateGas', [unpack]) }]);
    let healed: EthereumRevealTokensResponse | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      healed = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['1', '21', '111111'] });
      if (healed.artworks.length === 2) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(healed?.artworks.length, 2);
    assert.deepEqual(healed.artworks[0], revealed.artworks[0]);
    assert.equal(healed.artworks[1].observation.transactionHash, recoveryHash);
    assert.deepEqual(healed.unresolved, [{ tokenId: '111111', status: 'unminted' }]);
    return { deploymentId: deployment.deploymentId, contractAddress: input.contractAddress, transactionHash, recoveryHash,
      pendingMediaHidden: true, firstConfirmationArtworkCount: revealed.artworks.length, metadataStorage: 'isolated-local-r2',
      immutableAfterReorg: true, tokenRecovery: true };
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}
