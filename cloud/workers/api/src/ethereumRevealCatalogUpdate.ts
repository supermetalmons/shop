import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { MAX_REVEAL_METADATA_BYTES, readPublishedRevealMetadata } from './ethereumRevealAttributes.js';
import { EthereumRevealCatalogReader } from './ethereumRevealCatalogReader.js';

const PAGE_SIZE = 8;
type Phase = EthereumRevealCatalogUpdateResult['phase'];
type UpdateRecord = {
  deploymentId: string; expectedRevision: number; phase: Phase; mappingCount: number; observationUntilMs: number;
};
type CatalogUpdateHost = {
  env: Env; storage: DurableObjectStorage;
};

export function parseCatalogUpdateRequest(value: unknown): EthereumRevealCatalogUpdateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical catalog request.');
  const request = value as EthereumRevealCatalogUpdateRequest;
  if (!['inspect', 'verify'].includes(request.action) ||
    Object.keys(request).some(key => !['action', 'deploymentId', 'batchId', 'expectedRevision', 'verificationAfterEggId'].includes(key)) ||
    typeof request.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.deploymentId) ||
    typeof request.batchId !== 'string' || !/^catalog-[a-f0-9]{32}$/.test(request.batchId) ||
    !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
    request.verificationAfterEggId !== undefined && (request.action !== 'verify' || !Number.isSafeInteger(request.verificationAfterEggId) ||
      request.verificationAfterEggId < 0 || request.verificationAfterEggId > 111_111)) {
    throw new Error('Historical catalog operations support inspection and verification only.');
  }
  return request;
}

export class EthereumRevealCatalogUpdate {
  private readonly reader: EthereumRevealCatalogReader;
  constructor(private readonly host: CatalogUpdateHost) {
    this.reader = new EthereumRevealCatalogReader(host.storage.sql);
  }

  private async current(scope: EthereumRevealDeployment): Promise<EthereumRevealDeployment> {
    const current = await readEthereumRevealDeployment(this.host.env.OPS_DB, scope);
    if (!current || current.deploymentId !== scope.deploymentId || current.retiredAtMs != null || current.metadataBaseUri !== scope.metadataBaseUri ||
      current.templateSha256 !== scope.templateSha256 || ![1, 11155111, 31337].includes(current.chainId)) {
      throw new Error('Catalog deployment identity is unavailable.');
    }
    return current;
  }

  private async record(request: EthereumRevealCatalogUpdateRequest): Promise<UpdateRecord | undefined> {
    const record = await this.host.storage.get<UpdateRecord>(`catalog-update:${request.batchId}`);
    if (record && (record.deploymentId !== request.deploymentId || record.expectedRevision !== request.expectedRevision)) {
      throw new Error('Catalog update scope or original revision does not match.');
    }
    return record;
  }

  private result(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment,
    record?: UpdateRecord, status = this.reader.status(request.batchId)): EthereumRevealCatalogUpdateResult {
    const phase = record?.phase ?? 'unstarted';
    return { deploymentId: deployment.deploymentId, batchId: request.batchId, phase, complete: phase === 'complete',
      catalogRevision: this.reader.effectiveCatalog()?.catalogRevision ?? deployment.catalogRevision ?? 0,
      total: status?.total ?? record?.mappingCount ?? 0, staged: status?.metadataStaged ?? 0,
      applied: status?.activatedAtMs ? status.total : 0, published: status?.published ?? 0, frozen: status?.frozen ?? 0,
      conflicts: status?.conflicts ?? 0, retrying: status?.retrying ?? 0,
      retryAfterMs: phase === 'observing' ? Math.max(0, Math.min(5_000, (record?.observationUntilMs ?? 0) - Date.now()))
        : phase === 'publishing' && status && status.published < status.frozen ? 1_000 : 0,
      ...(phase === 'complete' ? { refreshTransaction: { chainId: deployment.chainId, to: deployment.contractAddress,
        data: encodeCall('setBaseURI(string)', ['string'], [deployment.metadataBaseUri]), value: '0x0' as const } } : {}) };
  }

  async run(value: unknown, deployment: EthereumRevealDeployment): Promise<EthereumRevealCatalogUpdateResult> {
    const request = parseCatalogUpdateRequest(value);
    const record = await this.record(request);
    deployment = await this.current(deployment);
    if (request.action !== 'verify') return this.result(request, deployment, record);
    const status = this.reader.verify(request.batchId);
    if (!status.activatedAtMs || status.published !== status.frozen) throw new Error('Catalog replacement publication is incomplete.');
    const next = await this.verifyPublicationPage(deployment, request.batchId, request.verificationAfterEggId ?? 0);
    await this.current(deployment);
    return { ...this.result(request, deployment, record), nextVerificationEggId: next };
  }

  private async verifyPublicationPage(deployment: EthereumRevealDeployment, batchId: string, afterEggId: number): Promise<number | null> {
    const rows = this.reader.publicationPage(batchId, afterEggId, PAGE_SIZE);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 25_000, timeoutMessage: 'Catalog publication verification timed out.' });
    try {
      await Promise.all(rows.map(async row => {
        const url = ethereumTokenMetadataUri(deployment, row.tokenId);
        const object = await raceWithSignal(this.host.env.ETHEREUM_REVEAL_METADATA.get(new URL(url).pathname.slice(1)), timeout.signal);
        if (!object || object.size > MAX_REVEAL_METADATA_BYTES || object.httpMetadata?.contentType !== 'application/json; charset=utf-8' ||
          object.httpMetadata.cacheControl !== 'no-store' || object.httpMetadata.contentEncoding) throw new Error(`Invalid stored metadata.`);
        const bytes = await raceWithSignal(object.arrayBuffer(), timeout.signal);
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== row.metadataJson) throw new Error(`Stored metadata differs.`);
        const response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: timeout.signal });
        const publicBytes = await readPublishedRevealMetadata(response, timeout.signal);
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(publicBytes) !== row.metadataJson) throw new Error(`Public metadata differs.`);
      }));
    } finally { timeout.dispose(); }
    return rows.length === PAGE_SIZE ? rows[rows.length - 1].eggId : null;
  }
}
