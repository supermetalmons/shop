import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { ethereumSignerAddress, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.ts';
import { TAROT_API_PATHS, TAROT_CHAIN_ID, tarotCodeHashInput, type TarotConfirmResponse, type TarotPrepareResponse } from '../../../../shared/ethereum/tarot.ts';
import { tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.ts';

test('Tarot credentials, signatures and repeated claimed-link checks work in the native Worker runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tarot-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const main = join(directory, 'worker.ts');
  const contractAddress = `0x${'11'.repeat(20)}`;
  const wallet = `0x${'22'.repeat(20)}`;
  const key = `0x${'44'.repeat(32)}`;
  const code = '11111111-1111-4111-8111-111111111111';
  const signer = ethereumSignerAddress(key);
  await writeFile(main, `
import { handleTarotRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/tarot.ts'))};
import { encodeAbi, encodeCall } from ${JSON.stringify(resolve('shared/ethereum/abi.ts'))};
import { TAROT_CLAIMED_TOPIC } from ${JSON.stringify(resolve('shared/ethereum/tarotCrypto.ts'))};
export default {
  fetch(request, env) {
    const claimed = request.headers.get('X-Test-Claimed') === 'true';
    const claimInput = request.headers.get('X-Test-Claim-Input');
    return handleTarotRequest(request, env, new URL(request.url).pathname, {
      fetch: async (_input, init) => {
        const respond = ({id, method, params}) => {
          let result;
          if (method === 'eth_chainId') result = '0xaa36a7';
          else if (method === 'eth_blockNumber') result = '0x64';
          else if (method === 'eth_getBlockByNumber') result = {number:params[0]==='latest'?'0x64':params[0], hash:'0x'+'ab'.repeat(32), timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
          else if (method === 'eth_getTransactionByHash') result = {hash:params[0],blockNumber:'0x62',blockHash:'0x'+'ab'.repeat(32),
            from:${JSON.stringify(wallet)},to:${JSON.stringify(contractAddress)},chainId:'0xaa36a7',value:'0x0',input:claimInput};
          else if (method === 'eth_getTransactionReceipt') {
            const log = topics => ({address:${JSON.stringify(contractAddress)},topics,data:'0x',removed:false,
              transactionHash:params[0],blockNumber:'0x62',blockHash:'0x'+'ab'.repeat(32)});
            result = claimInput ? {transactionHash:params[0],blockNumber:'0x62',blockHash:'0x'+'ab'.repeat(32),
              from:${JSON.stringify(wallet)},to:${JSON.stringify(contractAddress)},status:'0x1',logs:[
                log([TAROT_CLAIMED_TOPIC,encodeAbi(['address'],[${JSON.stringify(wallet)}]),encodeAbi(['uint256'],[1]),encodeAbi(['uint256'],[778])]),
                ...[1,778].map(id=>log(['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                  encodeAbi(['uint256'],[0]),encodeAbi(['address'],[${JSON.stringify(wallet)}]),encodeAbi(['uint256'],[id])]))]} : null;
          }
          else if (method === 'eth_call') {
            if (params[1]?.blockHash !== '0x'+'ab'.repeat(32) || params[1]?.requireCanonical !== true) throw new Error('Expected canonical block hash');
            const getters = {'MAX_CARDS()':777, 'RECEIPT_OFFSET()':777, 'MAX_AUTHORIZATION_LIFETIME()':600};
            const getter = Object.entries(getters).find(([name]) => encodeCall(name, [], []) === params[0].data);
            result = getter ? encodeAbi(['uint256'], [getter[1]]) : params[0].data === encodeCall('quoteSigner()',[],[])
              ? encodeAbi(['address'], [${JSON.stringify(signer)}]) : encodeAbi(['uint256'], [claimed ? 1 : 0]);
          } else throw new Error('Unexpected RPC request');
          return {jsonrpc:'2.0', id, result};
        };
        const payload = JSON.parse(init.body);
        return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
      },
    });
  },
};
`);
  const server = createTestHarness({ root: directory, workers: [{ config: {
    name: 'tarot-runtime', main, compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags,
    ratelimits: production.ratelimits.filter((binding: { name: string }) => binding.name.startsWith('TAROT_')),
    d1_databases: [{ binding: 'OPS_DB', database_name: 'tarot-runtime-ops', database_id: '00000000-0000-4000-8000-000000000001',
      migrations_dir: resolve('cloud/workers/api/ops-migrations') }],
    vars: { ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: contractAddress, ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: '1',
      ETHEREUM_TAROT_SEPOLIA_ENABLED: 'true', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: key,
      ETHEREUM_111K_RPC_URL: '', ALCHEMY_MI_NOTE_API_KEY: 'test-key' },
  } }] });
  t.after(() => server.close());
  await server.listen();
  const worker = server.getWorker<Env>('tarot-runtime');
  await worker.applyD1Migrations('OPS_DB');
  const env = await worker.getEnv();
  const codeHash = createHash('sha256').update(tarotCodeHashInput({ chainId: TAROT_CHAIN_ID, contractAddress, tokenId: 1, code })).digest('hex');
  await env.OPS_DB.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)').bind(TAROT_CHAIN_ID, contractAddress, 1, codeHash, Date.now()).run();
  const call = (path: string, body: unknown, claimed = false, headers: Record<string, string> = {}) => worker.fetch(`https://api.mons.shop${path}`, {
    method: 'POST', headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json',
      'X-Mons-CSRF': '1', 'X-Test-Claimed': String(claimed), ...headers }, body: JSON.stringify(body),
  });
  const credentials = { tokenId: 1, testnet: true, code };
  const status = await call(TAROT_API_PATHS.status, credentials);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('Cache-Control'), 'no-store');
  assert.equal((await status.json() as { claimed: boolean }).claimed, false);
  const prepare = await call(TAROT_API_PATHS.prepare, { ...credentials, wallet });
  assert.equal(prepare.status, 200);
  const quote = await prepare.json() as TarotPrepareResponse;
  assert.equal(recoverEthereumAddress(tarotClaimDigest({ chainId: TAROT_CHAIN_ID, contractAddress, wallet, tokenId: 1, deadline: quote.deadline }), quote.signature), signer);
  const confirmationRequest = { ...credentials, wallet, transactionHash: `0x${'a'.repeat(64)}` };
  const unavailable = await (await call(TAROT_API_PATHS.confirm, confirmationRequest)).json() as TarotConfirmResponse;
  assert.equal(unavailable.status, 'pending');
  assert.equal(unavailable.blockNumber, null);
  assert.equal(unavailable.blockHash, null);
  const confirmed = await (await call(TAROT_API_PATHS.confirm, confirmationRequest, false,
    { 'X-Test-Claim-Input': quote.transaction.data })).json() as TarotConfirmResponse;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.blockNumber, 98);
  assert.equal(confirmed.blockHash, `0x${'ab'.repeat(32)}`);
  assert.equal((await call(TAROT_API_PATHS.status, credentials, true)).status, 200);
  assert.equal((await call(TAROT_API_PATHS.prepare, { ...credentials, wallet }, true)).status, 409);
  for (const tokenId of [1, 2]) {
    const denied = await call(TAROT_API_PATHS.status, { ...credentials, tokenId, code: '22222222-2222-4222-8222-222222222222' }, true);
    assert.equal(denied.status, 401);
    assert.ok(!JSON.stringify(await denied.json()).includes(code));
  }
  await env.OPS_DB.prepare('UPDATE tarot_claim_codes SET revoked_at_ms = created_at_ms').run();
  assert.equal((await call(TAROT_API_PATHS.status, credentials, true)).status, 401);
});
