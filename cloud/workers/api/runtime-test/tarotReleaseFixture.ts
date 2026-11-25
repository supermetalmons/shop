import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.ts';

type Rpc = <T>(method: string, params?: unknown[]) => Promise<T>;
type Deployment = { contractAddress: string; transactionHash: string; blockNumber: string; blockHash: string };
type Artifact = { bytecode: { object: string }; metadata: {
  sources: Record<string, { keccak256: string }>;
  settings: { compilationTarget: Record<string, string> } & Record<string, unknown>;
} };
type Transaction = { from: string; input: string; nonce: string; gasPrice: string; gas: string };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');

export async function writeTarotMainnetReleaseFixture(directory: string, project: string,
  collection: Deployment, renderer: Deployment, admin: string, quoteSigner: string, rpc: Rpc): Promise<void> {
  const [uri] = decodeReturn(['string'], await rpc<string>('eth_call', [{ to: collection.contractAddress,
    data: encodeCall('contractURI()', [], []) }, 'latest']));
  if (typeof uri !== 'string') throw new Error('Missing local collection metadata');
  const collectionMetadata = JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString());
  const current = await rpc<{ number: string }>('eth_getBlockByNumber', ['latest', false]);
  async function freeze(contractName: 'TarotCards' | 'DMXWebpRenderer', deployment: Deployment,
    rendererFiles?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const artifact = JSON.parse(await readFile(resolve(project, 'out', `${contractName}.sol`, `${contractName}.json`), 'utf8')) as Artifact;
    const sources = Object.fromEntries(await Promise.all(Object.keys(artifact.metadata.sources).map(async source =>
      [source, { content: await readFile(resolve(project, source), 'utf8') }] as const)));
    const { compilationTarget, ...settings } = artifact.metadata.settings;
    const input = { language: 'Solidity', sources, settings: { ...settings,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
    const transaction = await rpc<Transaction>('eth_getTransactionByHash', [deployment.transactionHash]);
    const gasPrice = BigInt(transaction.gasPrice).toString();
    const gasLimit = BigInt(transaction.gas).toString();
    const manifest = {
      network: 'mainnet', releaseVersion: 2, chainId: 1, contractName, deployer: transaction.from, admin,
      feeCeilingWei: '1000000000000000000', expectedCollectionImage: collectionMetadata.image,
      contractAddress: deployment.contractAddress, nonce: BigInt(transaction.nonce).toString(),
      constructorArgs: '0x' + transaction.input.slice(artifact.bytecode.object.length), creationCode: transaction.input,
      gasPrice, gasLimit, maximumFeeWei: (BigInt(gasPrice) * BigInt(gasLimit)).toString(),
      ...(rendererFiles ? { quoteSigner, renderer: renderer.contractAddress, rendererReleaseSha256: hash(rendererFiles) } : {}),
      artifactSha256: hash(artifact), standardInputSha256: hash(input),
    };
    return {
      'manifest.json': manifest,
      'deployment.json': { ...manifest, transactionHash: deployment.transactionHash,
        deploymentBlock: Number(deployment.blockNumber), deploymentBlockHash: deployment.blockHash,
        confirmations: Number(BigInt(current.number) - BigInt(deployment.blockNumber) + 1n), collectionMetadata },
      [`${contractName}.artifact.json`]: artifact,
      [`${contractName}.standard-input.json`]: input,
    };
  }
  async function write(directory: string, files: Record<string, unknown>): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all(Object.entries(files).map(([name, value]) =>
      writeFile(resolve(directory, name), json(value), { mode: 0o600 })));
  }
  const rendererFiles = await freeze('DMXWebpRenderer', renderer);
  await write(resolve(directory, 'renderer'), rendererFiles);
  await write(directory, await freeze('TarotCards', collection, rendererFiles));
}
