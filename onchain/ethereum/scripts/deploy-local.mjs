import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rpcUrl = new URL(process.env.ETHEREUM_111K_LOCAL_RPC_URL || 'http://127.0.0.1:8545');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(rpcUrl.hostname) || rpcUrl.protocol !== 'http:' || rpcUrl.username || rpcUrl.password) {
  throw new Error('Local deployment accepts only an HTTP loopback RPC URL.');
}
let requestId = 0;
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Local RPC returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(`Local RPC ${method} failed: ${body.error.message}`);
  return body.result;
}

if (await rpc('eth_chainId') !== '0x7a69') throw new Error('Local deployment requires chain ID 31337.');
if (!String(await rpc('web3_clientVersion')).toLowerCase().includes('anvil')) throw new Error('Local deployment requires Anvil.');
const [deployer] = await rpc('eth_accounts');
const fixture = JSON.parse(await readFile(new URL('fixtures/eip712.json', root), 'utf8'));
const discounts = JSON.parse(await readFile(new URL('../../src/ethereum/discounts/111k.json', root), 'utf8'));
const discountRoot = process.env.ETHEREUM_111K_LOCAL_DISCOUNT_ROOT || discounts.root;
if (!/^0x[0-9a-fA-F]{64}$/.test(discountRoot)) throw new Error('Invalid discount Merkle root.');
const owner = process.env.ETHEREUM_111K_LOCAL_OWNER || deployer;
const signer = process.env.ETHEREUM_111K_LOCAL_QUOTE_SIGNER || fixture.signer;
const treasury = process.env.ETHEREUM_111K_LOCAL_TREASURY || deployer;
for (const address of [deployer, owner, signer, treasury]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new Error('Invalid local deployment address.');
}

const run = (executable, args) => execFileSync(executable, args, { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
run('forge', ['build', '--offline']);
const artifact = async name => JSON.parse(await readFile(new URL(`out/${name}.sol/${name}.json`, root), 'utf8'));
const send = creation => JSON.parse(run('cast', [
  'send', '--rpc-url', rpcUrl.href, '--unlocked', '--from', deployer, '--create', creation, '--json',
]));
const renderer = send((await artifact('NFT111KRenderer')).bytecode.object);
if (!renderer.contractAddress || Number(renderer.status) !== 1) throw new Error('Renderer deployment failed.');
const constructor = run('cast', [
  'abi-encode', 'constructor(address,address,address,address,bytes32)', owner, signer, treasury, renderer.contractAddress, discountRoot,
]);
const collection = send((await artifact('NFT111K')).bytecode.object + constructor.slice(2));
if (!collection.contractAddress || Number(collection.status) !== 1) throw new Error('Collection deployment failed.');

const result = {
  protocolVersion: 5,
  chainId: 31337, rpcUrl: rpcUrl.href, contractAddress: collection.contractAddress,
  rendererAddress: renderer.contractAddress, deploymentBlock: Number(collection.blockNumber),
  owner, quoteSigner: signer, treasury, discountRoot,
  rendererTransactionHash: renderer.transactionHash, collectionTransactionHash: collection.transactionHash,
};
const outputDirectory = new URL('.local/', root);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL('deployment.json', outputDirectory), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
