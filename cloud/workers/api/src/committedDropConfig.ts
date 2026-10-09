import bs58 from 'bs58';
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.js';
import { boxMinterMetadataBaseMatchesDrop } from '../../../../shared/deploymentCore.js';
import type { DeploymentDropProjectionCore } from '../../../../shared/deploymentProjection.js';
import type { DropConfigRole } from '../../../../shared/dropConfigRoles.js';

export type CommittedDropConfig = Pick<DeploymentDropProjectionCore,
  'collectionMint' | 'itemsPerBox' | 'maxSupply' | 'discountMintsPerWallet' |
  'metadataBase' | 'metadataBaseAliases' | 'treasury' | 'paymentRouting' | 'operationsConfig'>;

function paymentRoutingMatches(decoded: DecodedBoxMinterConfigData, expected: CommittedDropConfig): boolean {
  const routing = decoded.paymentRouting;
  if (!routing) return false;
  if (!expected.paymentRouting) return routing.schema === 'legacy';
  if (routing.schema !== 'split-payments-v1') return false;
  if (
    bs58.encode(routing.deliveryPaymentReceiver) !== expected.paymentRouting.deliveryPaymentReceiver ||
    routing.mintProceeds.length !== expected.paymentRouting.mintProceeds.length
  ) return false;
  return expected.paymentRouting.mintProceeds.every((recipient, index) => {
    const actual = routing.mintProceeds[index];
    return Boolean(actual) && bs58.encode(actual.address) === recipient.address && actual.percentage === recipient.percentage;
  });
}

export function matchesCommittedDropConfig(
  decoded: DecodedBoxMinterConfigData,
  expected: CommittedDropConfig,
  role: DropConfigRole = 'mint',
): boolean {
  const operations = expected.operationsConfig;
  const itemsPerBox = operations && role === 'mint' ? 0 : expected.itemsPerBox;
  const maxSupply = operations && role === 'operations' ? operations.maxSupply : expected.maxSupply;
  return bs58.encode(decoded.coreCollection) === expected.collectionMint &&
    decoded.itemsPerBox === itemsPerBox &&
    decoded.maxSupply === maxSupply &&
    (!operations || role !== 'operations' || (!decoded.started && decoded.minted === 0)) &&
    decoded.discountMintsPerWallet === expected.discountMintsPerWallet &&
    boxMinterMetadataBaseMatchesDrop(decoded.uriBase, expected.metadataBase, expected.metadataBaseAliases) &&
    bs58.encode(decoded.treasury) === expected.treasury &&
    paymentRoutingMatches(decoded, expected);
}
