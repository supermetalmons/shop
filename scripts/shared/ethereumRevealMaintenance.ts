import { fileURLToPath } from 'node:url';
import type { GetPlatformProxyOptions } from 'wrangler';
import type { EthereumRevealInspection, EthereumRevealMaintenanceRequest, EthereumRevealPurgeResult,
  EthereumRevealRetirementRequest, EthereumRevealRetirementResult, EthereumRevealRetirementCancellation, EthereumRevealReplacementRequest,
  EthereumRevealReplacementInspection } from '../../shared/ethereum/revealMaintenance.ts';

export type EthereumRevealMaintenanceTransport = {
  purgeRetired(request: EthereumRevealMaintenanceRequest): Promise<EthereumRevealPurgeResult>;
  inspectRetired(request: EthereumRevealMaintenanceRequest): Promise<EthereumRevealInspection>;
  retireForReplacement?(request: EthereumRevealRetirementRequest): Promise<EthereumRevealRetirementResult>;
  cancelRetirement?(request: EthereumRevealRetirementRequest): Promise<EthereumRevealRetirementCancellation>;
  inspectReplacement?(request: EthereumRevealReplacementRequest): Promise<EthereumRevealReplacementInspection>;
};
type Proxy = { env: { REVEAL_MAINTENANCE: EthereumRevealMaintenanceTransport }; dispose(): Promise<void> };
type ProxyFactory = (options: GetPlatformProxyOptions) => Promise<Proxy>;

async function defaultProxyFactory(options: GetPlatformProxyOptions): Promise<Proxy> {
  const { getPlatformProxy } = await import('wrangler');
  return getPlatformProxy<Proxy['env']>(options);
}

export async function withEthereumRevealMaintenance<T>(run: (transport: EthereumRevealMaintenanceTransport) => Promise<T>,
  createProxy: ProxyFactory = defaultProxyFactory): Promise<T> {
  let proxy: Proxy;
  try {
    proxy = await createProxy({ configPath: fileURLToPath(new URL('../ops/ethereum-reveal-maintenance.wrangler.jsonc', import.meta.url)),
      envFiles: [], persist: false, remoteBindings: true });
  } catch {
    throw new Error('Unable to connect to Ethereum reveal maintenance using existing Wrangler authentication.');
  }
  async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Ethereum reveal maintenance timed out; inspect before retrying.')), 60_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    const inspection = (value: EthereumRevealInspection): EthereumRevealInspection => ({ deploymentId: value.deploymentId,
      chainId: value.chainId, contractAddress: value.contractAddress, metadataBaseUri: value.metadataBaseUri,
      revision: value.revision, storageEmpty: value.storageEmpty, alarmCleared: value.alarmCleared });
    return await run({ async purgeRetired(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.purgeRetired(request));
      return { ...inspection(value), purged: value.purged } as EthereumRevealPurgeResult;
    }, async inspectRetired(request) {
      return inspection(await call(() => proxy.env.REVEAL_MAINTENANCE.inspectRetired(request)));
    }, async retireForReplacement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.retireForReplacement!(request));
      return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
        metadataBaseUri: value.metadataBaseUri, revision: value.revision, retiredAtMs: value.retiredAtMs,
        replacementDeploymentId: value.replacementDeploymentId, replacementRevision: value.replacementRevision, quiesced: value.quiesced };
    }, async cancelRetirement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.cancelRetirement!(request));
      return { deploymentId: value.deploymentId, replacementDeploymentId: value.replacementDeploymentId,
        revision: value.revision, cancelled: value.cancelled, retired: value.retired };
    }, async inspectReplacement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.inspectReplacement!(request));
      return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
        metadataBaseUri: value.metadataBaseUri, revision: value.revision, ready: value.ready, frozenThroughMs: value.frozenThroughMs,
        frozenArtworks: value.frozenArtworks, frozenMetadataSha256: value.frozenMetadataSha256,
        frozenSamples: Array.from({ length: value.frozenSamples.length }, (_, index) => ({ tokenId: value.frozenSamples[index].tokenId,
          metadataSha256: value.frozenSamples[index].metadataSha256 })) };
    } });
  } finally { await proxy.dispose(); }
}
