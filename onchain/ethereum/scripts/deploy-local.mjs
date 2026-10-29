import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseProceedsConfig } from './proceeds-config.mjs';

const root = new URL('../', import.meta.url);
const metadataBaseURI = process.env.ETHEREUM_111K_LOCAL_METADATA_BASE_URI || 'https://cdn.mons.shop/111k-sepolia/';
const metadataUrl = new URL(metadataBaseURI);
const hostedMetadata = metadataUrl.origin === 'https://cdn.mons.shop' &&
  /^\/111k(?:-sepolia)?\/(?:[a-z0-9][a-z0-9-]{0,63}\/)?$/.test(metadataUrl.pathname);
if (!hostedMetadata || metadataUrl.href !== metadataBaseURI || metadataUrl.username || metadataUrl.password ||
    metadataUrl.search || metadataUrl.hash || !metadataUrl.pathname.endsWith('/')) {
  throw new Error('Local metadata must use a canonical https://cdn.mons.shop/111k-sepolia/ or /111k/ collection prefix, optionally followed by a deployment ID.');
}
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
const proceeds = parseProceedsConfig(JSON.parse(await readFile(new URL('config/proceeds.json', root), 'utf8')));
const { mintRecipients, mintSharesBps, deliveryPaymentReceiver } = proceeds;
for (const address of [deployer, owner, signer]) {
  if (typeof address !== 'string') throw new Error('Invalid local deployment address.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new Error('Invalid local deployment address.');
}
const run = (executable, args) => execFileSync(executable, args, { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
const collectionNonce = BigInt(await rpc('eth_getTransactionCount', [deployer, 'pending']));
const predictedCollection = run('cast', ['compute-address', deployer, '--nonce', collectionNonce.toString()])
  .match(/^Computed Address: (0x[0-9a-fA-F]{40})$/)?.[1];
if (!predictedCollection) throw new Error('Unable to predict the collection address.');
parseProceedsConfig(proceeds, predictedCollection);
run('forge', ['build', '--offline']);
const artifact = async name => JSON.parse(await readFile(new URL(`out/${name}.sol/${name}.json`, root), 'utf8'));
const send = creation => JSON.parse(run('cast', [
  'send', '--rpc-url', rpcUrl.href, '--unlocked', '--from', deployer, '--create', creation, '--json',
]));
const constructor = run('cast', [
  'abi-encode', 'constructor(address,address,address,string,bytes32,address[],uint256[])',
  owner, signer, deliveryPaymentReceiver, metadataBaseURI, discountRoot,
  `[${mintRecipients.join(',')}]`, `[${mintSharesBps.join(',')}]`,
]);
const collection = send((await artifact('NFT111K')).bytecode.object + constructor.slice(2));
if (!collection.contractAddress || Number(collection.status) !== 1) throw new Error('Collection deployment failed.');
if (collection.contractAddress.toLowerCase() !== predictedCollection.toLowerCase()) throw new Error('Unexpected collection deployment address.');

const result = {
  protocolVersion: 8,
  chainId: 31337, rpcUrl: rpcUrl.href, contractAddress: collection.contractAddress,
  metadataBaseURI, deploymentBlock: Number(collection.blockNumber),
  owner, quoteSigner: signer, deliveryPaymentReceiver, mintRecipients, mintSharesBps, discountRoot,
  collectionTransactionHash: collection.transactionHash,
};
const outputDirectory = new URL('.local/', root);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL('deployment.json', outputDirectory), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
