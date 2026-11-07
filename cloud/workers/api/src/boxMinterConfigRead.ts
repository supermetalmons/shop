import { PublicKey } from '@solana/web3.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodeBoxMinterConfigDataOptions,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import { isRecord } from './dataAccess.js';

const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;

export async function readBoxMinterConfig(options: Readonly<{
  rpc: (method: string, params: unknown) => Promise<unknown>;
  collectionMint: PublicKey;
  configPda: PublicKey;
  programId: PublicKey;
  parseAccount: (value: unknown, label: string) => { owner: PublicKey; data: Uint8Array };
  collectionPolicy: 'owner-only' | 'collection-v1';
  decodeOptions?: Pick<DecodeBoxMinterConfigDataOptions,
    'validateItemsPerBox' | 'normalizeDiscountMintsPerWallet'>;
  errors: {
    invalidResponse: () => Error;
    missingCollection: () => Error;
    missingConfig: () => Error;
    invalidCollection: (actualOwner: PublicKey) => Error;
    invalidConfigOwner: (actualOwner: PublicKey) => Error;
    invalidConfig: (error: BoxMinterConfigCodecError) => Error;
  };
}>): Promise<DecodedBoxMinterConfigData> {
  const result = await options.rpc('getMultipleAccounts', [
    [options.collectionMint.toBase58(), options.configPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw options.errors.invalidResponse();
  }
  if (!result.value[0]) throw options.errors.missingCollection();
  if (!result.value[1]) throw options.errors.missingConfig();
  const collection = options.parseAccount(result.value[0], 'COLLECTION_MINT');
  const config = options.parseAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID) || (
    options.collectionPolicy === 'collection-v1' &&
    (collection.data.length < MPL_CORE_COLLECTION_V1_MIN_BYTES ||
      collection.data[0] !== MPL_CORE_COLLECTION_V1_DISCRIMINATOR)
  )) {
    throw options.errors.invalidCollection(collection.owner);
  }
  if (!config.owner.equals(options.programId)) {
    throw options.errors.invalidConfigOwner(config.owner);
  }
  try {
    return decodeBoxMinterConfigData(config.data, {
      validateDiscriminator: true,
      decodeExtensions: true,
      ...options.decodeOptions,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) throw options.errors.invalidConfig(error);
    throw error;
  }
}
