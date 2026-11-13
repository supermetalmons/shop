import { PublicKey } from '@solana/web3.js';
import { BOX_MINTER_CONFIG_SEED, isConfiguredBoxMinterItemsPerBox } from '../../../../shared/boxMinterProtocol.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { resolveDropConfigRole } from '../../../../shared/dropConfigRoles.js';
import { resolveDropMaxFigureId } from '../../../../shared/dropFigureIds.js';
import type { ApiDropConfig } from './dropConfig.js';

type RuntimeErrorConstructor = new (code: 'failed-precondition', message: string, details?: unknown) => Error;
type RuntimeOptions = {
  error: RuntimeErrorConstructor;
  invalidConfigurationMessage: string;
};

export function configuredDropPublicKey(label: string, value: string | undefined, error: RuntimeErrorConstructor): PublicKey;
export function configuredDropPublicKey(label: string, value: string | undefined, error: RuntimeErrorConstructor, required: false): PublicKey | undefined;
export function configuredDropPublicKey(
  label: string,
  value: string | undefined,
  ErrorType: RuntimeErrorConstructor,
  required = true,
): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new ErrorType('failed-precondition', `${label} is not configured.`);
  }
  let key: PublicKey;
  try {
    key = new PublicKey(normalized);
  } catch {
    throw new ErrorType('failed-precondition', `${label} is invalid.`);
  }
  if (required && key.equals(PublicKey.default)) {
    throw new ErrorType('failed-precondition', `${label} is not configured.`);
  }
  return key;
}

function dropRuntimeValues(config: ApiDropConfig) {
  return {
    dropId: normalizeDropId(config.dropId),
    itemsPerBox: Number(config.itemsPerBox),
    maxSupply: Number(config.maxSupply),
    maxDudeId: resolveDropMaxFigureId(config),
  };
}

function validDropRuntimeValues(values: ReturnType<typeof dropRuntimeValues>): boolean {
  return isConfiguredBoxMinterItemsPerBox(values.itemsPerBox) &&
    Number.isInteger(values.maxSupply) && values.maxSupply >= 1 && values.maxSupply <= 0xffff_ffff &&
    Number.isSafeInteger(values.maxDudeId) && values.maxDudeId <= 0xffff;
}

function dropRuntimeIdentity(
  config: ApiDropConfig,
  ErrorType: RuntimeErrorConstructor,
  defaultConfigPdaAsMissing = false,
) {
  const boxMinterProgramId = configuredDropPublicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId, ErrorType);
  const configuredPda = configuredDropPublicKey(
    'BOX_MINTER_CONFIG_PDA', resolveDropConfigRole(config, 'operations').boxMinterConfigPda, ErrorType, false,
  );
  const boxMinterConfigPda = !configuredPda || (defaultConfigPdaAsMissing && configuredPda.equals(PublicKey.default))
    ? PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0]
    : configuredPda;
  return {
    config,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: configuredDropPublicKey('COLLECTION_MINT', config.collectionMint, ErrorType),
  };
}

export function buildDeliveryDropRuntime(
  config: ApiDropConfig,
  options: RuntimeOptions & { dropId?: string; defaultConfigPdaAsMissing?: boolean },
) {
  const values = dropRuntimeValues(config);
  if (options.dropId !== undefined) values.dropId = options.dropId;
  if (!validDropRuntimeValues(values)) {
    throw new options.error('failed-precondition', options.invalidConfigurationMessage, { dropId: values.dropId });
  }
  return { ...dropRuntimeIdentity(config, options.error, options.defaultConfigPdaAsMissing), ...values };
}

export function buildReceiptDropRuntime(config: ApiDropConfig, options: RuntimeOptions) {
  const values = dropRuntimeValues(config);
  const receiptMaxId = Number(config.receiptMaxId ?? values.maxSupply);
  const receiptsTreeMaxDepth = Number(config.receiptsTreeMaxDepth);
  const receiptsTreeCanopyDepth = Number(config.receiptsTreeCanopyDepth ?? 0);
  if (
    !validDropRuntimeValues(values) ||
    !Number.isInteger(receiptMaxId) || receiptMaxId < values.maxSupply || receiptMaxId > 0xffff_ffff ||
    !Number.isInteger(receiptsTreeCanopyDepth) || receiptsTreeCanopyDepth < 0 ||
    (Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeCanopyDepth >= receiptsTreeMaxDepth)
  ) {
    throw new options.error('failed-precondition', options.invalidConfigurationMessage, { dropId: values.dropId });
  }
  return {
    ...dropRuntimeIdentity(config, options.error),
    receiptsMerkleTree: configuredDropPublicKey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree, options.error),
    deliveryLookupTable: configuredDropPublicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, options.error, false),
    ...(Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeMaxDepth > 0 ? { receiptsTreeMaxDepth } : {}),
    receiptsTreeCanopyDepth,
    ...values,
    receiptMaxId,
  };
}
