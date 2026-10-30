import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ethereumMetadataBaseUri } from '../../shared/ethereum/config.ts';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_CATALOG_VERSION, parseEthereumRevealDeployment, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition } from '../ops/ethereumRevealControl.ts';

export function localEthereumRevealBindings() {
  return {
    durable_objects: { bindings: [
      { name: 'ETHEREUM_REVEAL', class_name: 'EthereumRevealObject' },
      { name: 'ETHEREUM_REVEAL_VERIFIER', class_name: 'EthereumRevealVerifierObject' },
      { name: 'ETHEREUM_REVEAL_PUBLISHER', class_name: 'EthereumRevealPublisherObject' },
    ] },
    migrations: [
      { tag: 'local-ethereum-reveal-v1', new_sqlite_classes: ['EthereumRevealObject'] },
      { tag: 'local-ethereum-reveal-verifier-v1', new_sqlite_classes: ['EthereumRevealVerifierObject'] },
      { tag: 'local-ethereum-reveal-publisher-v1', new_sqlite_classes: ['EthereumRevealPublisherObject'] },
    ],
    r2_buckets: [{ binding: 'ETHEREUM_REVEAL_METADATA', bucket_name: 'local-ethereum-reveal-metadata', remote: false }],
  };
}

type LocalStatement = { bind(...values: unknown[]): LocalStatement; first<T>(): Promise<T | null> };
type LocalEnvironment = {
  ETHEREUM_111K_CHAIN_ID: string;
  ETHEREUM_111K_CONTRACT_ADDRESS: string;
  ETHEREUM_111K_RPC_URL: string;
  OPS_DB: { prepare(sql: string): LocalStatement };
  ETHEREUM_REVEAL: { getByName(name: string): { initialize(deployment: EthereumRevealDeployment): Promise<{ ready: boolean; seeded: number }> } };
};

export async function initializeLocalEthereumReveal(env: LocalEnvironment, input: {
  contractAddress: string; metadataBaseUri: string; deploymentBlock: number;
}): Promise<EthereumRevealDeployment> {
  const address = normalizeEthereumAddress(input.contractAddress);
  const rpc = new URL(env.ETHEREUM_111K_RPC_URL);
  if (env.ETHEREUM_111K_CHAIN_ID !== '31337' || !address || /^0x0{40}$/.test(address) ||
    normalizeEthereumAddress(env.ETHEREUM_111K_CONTRACT_ADDRESS) !== address || rpc.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) || rpc.username || rpc.password || rpc.search || rpc.hash ||
    !Number.isSafeInteger(input.deploymentBlock) || input.deploymentBlock < 0) {
    throw new Error('Local reveal initialization requires the configured Anvil contract on chain 31337 and an HTTP loopback RPC.');
  }
  const metadataBaseUri = ethereumMetadataBaseUri(input.metadataBaseUri, 31337);
  const templateJson = JSON.stringify(JSON.parse(await readFile(new URL('../ethereum-metadata/templates/artwork.json', import.meta.url), 'utf8')));
  const registration = { deploymentId: `local-${address.slice(2)}`, dropId: '111k_devnet', chainId: 31337,
    contractAddress: address, metadataBaseUri, deploymentBlock: input.deploymentBlock,
    catalogVersion: ETHEREUM_REVEAL_CATALOG_VERSION, templateJson,
    templateSha256: createHash('sha256').update(templateJson).digest('hex') };
  let deployment = await readEthereumRevealDeployment(env.OPS_DB, registration);
  if (!deployment) {
    const row = await env.OPS_DB.prepare(buildEthereumRevealRegistration(registration)).first<Record<string, unknown>>();
    if (!row) throw new Error('Local reveal registration failed.');
    deployment = parseEthereumRevealDeployment(row);
  }
  if (!Object.entries(registration).every(([key, value]) => deployment![key as keyof EthereumRevealDeployment] === value)) {
    throw new Error('The local reveal deployment does not match this Anvil collection.');
  }
  const object = env.ETHEREUM_REVEAL.getByName(`31337:${address}`);
  for (let attempt = 0; deployment.state === 'provisioning' && attempt < 32; attempt++) {
    await object.initialize(deployment);
    const current = await readEthereumRevealDeployment(env.OPS_DB, registration);
    if (!current) throw new Error('Local reveal registration disappeared.');
    deployment = current;
  }
  if (deployment.state === 'ready') {
    const row = await env.OPS_DB.prepare(buildEthereumRevealTransition('activate', deployment, deployment.revision)).first<Record<string, unknown>>();
    if (!row) throw new Error('Local reveal activation failed.');
    deployment = parseEthereumRevealDeployment(row);
  }
  if (deployment.state !== 'active' || deployment.provisionedAtMs === null) throw new Error('Local reveal inventory is not ready.');
  return deployment;
}
