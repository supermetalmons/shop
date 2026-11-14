import type { MintSelectionConfig } from '../../shared/deploymentCore.ts';
import type {
  BoxMinterConfigTombstone,
  DeploymentMediaMapConfig,
  DeploymentRegistryDrop,
  ReceiptPoolDeployment,
} from '../../shared/deploymentRegistry.ts';

export type MediaMapConfigSerialized = DeploymentMediaMapConfig;

export type FigureMediaConfigSerialized = MediaMapConfigSerialized;
export type BoxMediaConfigSerialized = MediaMapConfigSerialized;
export type MintSelectionConfigSerialized = MintSelectionConfig;

export type DeploymentDropConfigSerialized = DeploymentRegistryDrop;

export type DeploymentDropRegistry = {
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones: Record<string, BoxMinterConfigTombstone>;
  receiptPools: Record<string, ReceiptPoolDeployment>;
  sourceContent: string;
};
