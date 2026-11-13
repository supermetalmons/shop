import { isDeepStrictEqual } from 'node:util';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { DEPLOYMENT_DROPS } from '../../shared/deploymentRegistry.ts';
import {
  decodeMplCoreCollectionBase,
  decodeMplCoreCollectionRoyalties,
  decodeMplCoreCollectionUpdateDelegates,
  readMplCoreCollectionPluginRecords,
} from './mplCoreCollection.ts';
import type { PreparedPreorderCollectionConfig } from './preorderCollectionConfig.ts';

const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

export function validatePreorderCollectionAccount(args: {
  config: PreparedPreorderCollectionConfig;
  account: AccountInfo<Buffer> | null;
  collectionMint?: string;
  approvedCollectionDelegates?: readonly string[];
}): void {
  const { config, account } = args;
  if (!account || account.executable || !account.owner.equals(CORE_PROGRAM)) {
    throw new Error('Missing preorder collection or unexpected Core account owner');
  }
  const data = Buffer.from(account.data);
  const base = decodeMplCoreCollectionBase(data);
  if (!base.updateAuthority.equals(new PublicKey(config.authority))) {
    throw new Error('Preorder collection update authority mismatch');
  }
  if (base.name !== config.collectionMetadata.name || base.uri !== config.collectionMetadataUri) {
    throw new Error('Preorder collection name or metadata URI mismatch');
  }
  const plugins = readMplCoreCollectionPluginRecords(data);
  if (
    !plugins ||
    !isDeepStrictEqual(plugins.map((plugin) => plugin.pluginType).sort((a, b) => a - b), [0, 4, 15]) ||
    plugins.some((plugin) => data[plugin.offset] !== plugin.pluginType)
  ) {
    throw new Error('Preorder collection must have only Royalties, UpdateDelegate, and BubblegumV2 plugins with mutable metadata');
  }
  const royalties = decodeMplCoreCollectionRoyalties(data);
  if (
    !royalties || royalties.authorityKind !== 2 || royalties.ruleSetKind !== 0 ||
    royalties.basisPoints !== config.collectionMetadata.sellerFeeBasisPoints ||
    !isDeepStrictEqual(
      royalties.creators.map((creator) => ({ address: creator.address.toBase58(), share: creator.percentage })),
      config.collectionMetadata.creators,
    )
  ) throw new Error('Preorder collection royalties mismatch');
  const delegates = decodeMplCoreCollectionUpdateDelegates(data);
  const registered = DEPLOYMENT_DROPS[config.collectionId];
  const allowedDelegates = new Set([config.authority, ...(args.approvedCollectionDelegates ?? [])]);
  if (registered?.solanaCluster === config.solanaCluster && registered.collectionMint === args.collectionMint) {
    if (registered.boxMinterConfigPda) allowedDelegates.add(registered.boxMinterConfigPda);
    if (registered.operationsConfig) allowedDelegates.add(registered.operationsConfig.boxMinterConfigPda);
  }
  if (
    !delegates || delegates.authorityKind !== 2 || delegates.delegates.length !== allowedDelegates.size ||
    new Set(delegates.delegates.map(delegate => delegate.toBase58())).size !== allowedDelegates.size ||
    delegates.delegates.some(delegate => !allowedDelegates.has(delegate.toBase58()))
  ) throw new Error('Preorder collection UpdateDelegate must be controlled by UpdateAuthority and contain only the deployer and registered drop delegates');
}
