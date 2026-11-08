export type EthereumRevealMaintenanceRequest = {
  deploymentId: string;
  expectedRevision: number;
};

export type EthereumRevealInspection = {
  deploymentId: string;
  chainId: number;
  contractAddress: string;
  metadataBaseUri: string;
  revision: number;
  storageEmpty: boolean;
  alarmCleared: boolean;
};

export type EthereumRevealPurgeResult = EthereumRevealInspection & {
  purged: true;
  storageEmpty: true;
  alarmCleared: true;
};

export type EthereumRevealRetirementRequest = EthereumRevealMaintenanceRequest & {
  replacementDeploymentId: string;
  expectedReplacementRevision: number;
};

export type EthereumRevealRetirementResult = Omit<EthereumRevealInspection, 'storageEmpty' | 'alarmCleared'> & {
  retiredAtMs: number;
  replacementDeploymentId: string;
  replacementRevision: number;
  quiesced: true;
};

export type EthereumRevealRetirementCancellation = {
  deploymentId: string;
  replacementDeploymentId: string;
  revision: number;
  cancelled: boolean;
  retired: boolean;
};

export type EthereumRevealReplacementRequest = EthereumRevealMaintenanceRequest & {
  frozenThroughMs?: number;
};

export type EthereumRevealReplacementInspection = Omit<EthereumRevealInspection, 'storageEmpty' | 'alarmCleared'> & {
  ready: true;
  frozenThroughMs: number;
  frozenArtworks: number;
  frozenMetadataSha256: string;
  frozenSamples: Array<{ tokenId: string; metadataSha256: string }>;
};
