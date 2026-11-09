import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { borshString, canRead, u32LE, u8, uniquePubkeys } from './solanaInstructionData.ts';

const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

export const MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY = 2;

export type MplCoreRoyaltyCreator = {
  address: PublicKey;
  percentage: number;
};

export function parseCollectionRoyaltyCreators(
  collectionJson: unknown,
): MplCoreRoyaltyCreator[] {
  if (
    !collectionJson ||
    typeof collectionJson !== 'object' ||
    Array.isArray(collectionJson)
  ) {
    throw new Error('collection.json must be an object');
  }
  const json = collectionJson as Record<string, unknown>;
  if (
    !json.properties ||
    typeof json.properties !== 'object' ||
    Array.isArray(json.properties)
  ) {
    throw new Error('collection.json properties must be an object');
  }
  const properties = json.properties as Record<string, unknown>;
  if (!Array.isArray(properties.creators) || properties.creators.length === 0) {
    throw new Error('collection.json properties.creators must contain at least one creator');
  }

  const seen = new Set<string>();
  const creators = properties.creators.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`collection.json properties.creators[${index}] must be an object`);
    }
    const creator = value as Record<string, unknown>;
    const addressValue = typeof creator.address === 'string' ? creator.address.trim() : undefined;
    if (!addressValue) {
      throw new Error(`collection.json properties.creators[${index}].address must be a Solana address`);
    }
    let address: PublicKey;
    try {
      address = new PublicKey(addressValue);
    } catch {
      throw new Error(`collection.json properties.creators[${index}].address is not a valid Solana address`);
    }
    if (address.equals(PublicKey.default)) {
      throw new Error(`collection.json properties.creators[${index}].address must not be the default address`);
    }
    const normalizedAddress = address.toBase58();
    if (seen.has(normalizedAddress)) {
      throw new Error(`collection.json properties.creators contains duplicate address ${normalizedAddress}`);
    }
    seen.add(normalizedAddress);
    const percentage = creator.share;
    if (typeof percentage !== 'number' || !Number.isInteger(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error(`collection.json properties.creators[${index}].share must be a positive whole percentage`);
    }
    return { address, percentage };
  });
  const total = creators.reduce((sum, creator) => sum + creator.percentage, 0);
  if (total !== 100) {
    throw new Error(`collection.json properties.creators shares must total 100, got ${total}`);
  }
  return creators;
}

function u16LE(value: number): Buffer {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new Error(`Invalid u16: ${value}`);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n & 0xffff);
  return buf;
}

function borshOption(value: Buffer | null | undefined): Buffer {
  if (!value) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value]);
}

function encodeUmiArray(items: Buffer[]): Buffer {
  return Buffer.concat([u32LE(items.length), ...items]);
}

// MPL-Core plugin encoding helpers (Umi dataEnum + option layouts).
// We need BubblegumV2 + UpdateDelegate so Bubblegum can mint cNFT receipts into this collection
// while the deployer/admin wallet remains the root collection update authority for marketplace verification.
function mplCoreBasePluginAuthorityAddress(address: PublicKey): Buffer {
  // BasePluginAuthority::Address enum index = 3 (None=0, Owner=1, UpdateAuthority=2, Address=3)
  return Buffer.concat([u8(3), address.toBuffer()]);
}

function mplCorePluginBubblegumV2(): Buffer {
  // Plugin::BubblegumV2 enum index = 15 (see mpl-core PluginType order).
  return u8(15);
}

export function mplCorePluginUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Plugin::UpdateDelegate enum index = 4 (Royalties=0, FreezeDelegate=1, BurnDelegate=2, TransferDelegate=3, UpdateDelegate=4)
  // UpdateDelegate data: { additionalDelegates: Vec<Pubkey> }
  return Buffer.concat([u8(4), encodeUmiArray(additionalDelegates.map((k) => k.toBuffer()))]);
}

function mplCoreBaseRuleSetNone(): Buffer {
  // BaseRuleSet::None enum index = 0 (None=0, ProgramAllowList=1, ProgramDenyList=2).
  return u8(0);
}

function mplCoreCreator(address: PublicKey, percentage: number): Buffer {
  const pct = Number(percentage);
  if (!Number.isInteger(pct) || pct <= 0 || pct > 100) throw new Error(`Invalid creator percentage: ${percentage}`);
  return Buffer.concat([address.toBuffer(), u8(pct)]);
}

function mplCorePluginRoyalties(args: { basisPoints: number; creators: { address: PublicKey; percentage: number }[] }): Buffer {
  const bps = Number(args.basisPoints);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(`Invalid royalties basisPoints: ${args.basisPoints}`);
  const creators = Array.isArray(args.creators) ? args.creators : [];
  const creatorAddresses = new Set<string>();
  let creatorPercentageTotal = 0;
  for (const creator of creators) {
    if (creator.address.equals(PublicKey.default)) {
      throw new Error('Royalty creator must not be the default address');
    }
    const address = creator.address.toBase58();
    if (creatorAddresses.has(address)) {
      throw new Error(`Duplicate royalty creator: ${address}`);
    }
    creatorAddresses.add(address);
    if (!Number.isInteger(creator.percentage) || creator.percentage <= 0) {
      throw new Error(`Invalid creator percentage: ${creator.percentage}`);
    }
    creatorPercentageTotal += creator.percentage;
  }
  if (creators.length === 0 || creatorPercentageTotal !== 100) {
    throw new Error(`Royalty creator percentages must total 100, got ${creatorPercentageTotal}`);
  }

  // BaseRoyalties = { basisPoints: u16, creators: Vec<Creator>, ruleSet: BaseRuleSet }
  const baseRoyalties = Buffer.concat([
    u16LE(bps),
    encodeUmiArray(creators.map((c) => mplCoreCreator(c.address, c.percentage))),
    mplCoreBaseRuleSetNone(),
  ]);

  // Plugin::Royalties enum index = 0. Payload = BaseRoyalties (no extra wrapper beyond tuple(1)).
  return Buffer.concat([u8(0), baseRoyalties]);
}

function mplCorePluginAuthorityPairRoyalties(args: {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  authority?: PublicKey | null;
}): Buffer {
  const authority = args.authority ? mplCoreBasePluginAuthorityAddress(args.authority) : null;
  return Buffer.concat([mplCorePluginRoyalties({ basisPoints: args.basisPoints, creators: args.creators }), borshOption(authority)]);
}

function mplCorePluginAuthorityPairBubblegumV2(): Buffer {
  // PluginAuthorityPair = { plugin: Plugin, authority: Option<BasePluginAuthority> }
  // BubblegumV2 authority is fixed to the Bubblegum program (mpl-core enforces this at creation time).
  // We omit the authority field (None) so mpl-core uses the default manager authority.
  return Buffer.concat([mplCorePluginBubblegumV2(), borshOption(null)]);
}

function mplCorePluginAuthorityPairUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Let the program config PDA mint/update collection assets while the deployer/admin key remains
  // marketplace-verifiable as the root collection update authority.
  // Bubblegum’s own checks will pass as long as the admin/cosigner collection_authority is in `additionalDelegates`.
  return Buffer.concat([mplCorePluginUpdateDelegate(additionalDelegates), borshOption(null)]);
}

/**
 * MPL-Core instruction: create_collection_v2 (discriminator = 21, mpl-core 1.7.0).
 *
 * Data layout (umi-serializers, which are Borsh-compatible here):
 * - u8 discriminator (21)
 * - string name
 * - string uri
 * - Option<Vec<PluginAuthorityPair>> plugins
 * - Option<Vec<BaseExternalPluginAdapterInitInfo>> externalPluginAdapters
 *
 * NOTE: BubblegumV2 plugin can ONLY be added at creation time (it is permanent and rejects addCollectionPlugin).
 * We include it here so Bubblegum v2 can mint receipt cNFTs into this MPL-Core collection.
 */
const IX_MPL_CORE_CREATE_COLLECTION_V2 = 21;
export function buildCreateMplCoreCollectionV2Ix(args: {
  collection: PublicKey;
  updateAuthority: PublicKey;
  updateDelegates: PublicKey[];
  payer: PublicKey;
  systemProgram: PublicKey;
  name: string;
  uri: string;
  royaltiesBps: number;
  royaltiesCreators?: MplCoreRoyaltyCreator[];
  royaltiesRecipient?: PublicKey;
  royaltiesAuthority?: PublicKey | null;
}): TransactionInstruction {
  const royaltiesAuthority =
    args.royaltiesAuthority === undefined
      ? args.payer
      : args.royaltiesAuthority;
  const royaltiesCreators =
    args.royaltiesCreators ||
    (args.royaltiesRecipient
      ? [{ address: args.royaltiesRecipient, percentage: 100 }]
      : []);
  if (royaltiesCreators.length === 0) {
    throw new Error('At least one royalties creator is required');
  }
  const pluginsOpt = borshOption(
    encodeUmiArray([
      mplCorePluginAuthorityPairRoyalties({
        basisPoints: args.royaltiesBps,
        creators: royaltiesCreators,
        authority: royaltiesAuthority,
      }),
      mplCorePluginAuthorityPairBubblegumV2(),
      mplCorePluginAuthorityPairUpdateDelegate(uniquePubkeys(args.updateDelegates)),
    ]),
  );
  const externalAdaptersOpt = borshOption(encodeUmiArray([]));

  const data = Buffer.concat([
    u8(IX_MPL_CORE_CREATE_COLLECTION_V2),
    borshString(args.name),
    borshString(args.uri),
    pluginsOpt,
    externalAdaptersOpt,
  ]);

  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: true, isWritable: true },
      { pubkey: args.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.systemProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// MPL-Core instructions used to keep collection-level royalties in sync.
const IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1 = 3;
export const IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1 = 7;

export function buildUpdateMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesBps: number;
  royaltiesCreators: MplCoreRoyaltyCreator[];
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: args.royaltiesCreators,
  });
  const data = Buffer.concat([u8(IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1), plugin]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildAddMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesBps: number;
  royaltiesCreators: MplCoreRoyaltyCreator[];
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: args.royaltiesCreators,
  });
  // initAuthority: Some(BasePluginAuthority::Address(authority))
  const initAuthority = borshOption(mplCoreBasePluginAuthorityAddress(args.authority));
  const data = Buffer.concat([u8(IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1), plugin, initAuthority]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function decodeMplCoreCollectionUpdateAuthority(data: Buffer): PublicKey {
  // mpl-core BaseCollectionV1 starts with `Key` enum (u8). CollectionV1 = 5.
  const key = data[0];
  if (key !== 5) {
    throw new Error(`Not an MPL-Core collection account (unexpected Key enum ${key})`);
  }
  // BaseCollectionV1::update_authority is the next 32 bytes.
  return new PublicKey(data.subarray(1, 1 + 32));
}

export function decodeMplCoreCollectionBase(data: Buffer): {
  updateAuthority: PublicKey;
  name: string;
  uri: string;
} {
  if (data[0] !== 5 || data.length < 33) {
    throw new Error('Not an MPL-Core CollectionV1 account');
  }
  let offset = 33;
  const readString = (label: string): string => {
    if (!canRead(data, offset, 4)) {
      throw new Error(`Truncated MPL-Core collection ${label}`);
    }
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (!canRead(data, offset, length)) {
      throw new Error(`Truncated MPL-Core collection ${label}`);
    }
    const value = data.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return value;
  };
  return {
    updateAuthority: new PublicKey(data.subarray(1, 33)),
    name: readString('name'),
    uri: readString('uri'),
  };
}

function skipBorshString(buf: Buffer, offset: number): number | null {
  if (!canRead(buf, offset, 4)) return null;
  const len = buf.readUInt32LE(offset);
  const end = offset + 4 + len;
  if (!canRead(buf, offset + 4, len)) return null;
  return end;
}

type MplCoreCollectionPluginRecord = {
  pluginType: number;
  authorityKind: number;
  authorityAddress?: PublicKey;
  offset: number;
};

export function readMplCoreCollectionPluginRecords(data: Buffer): MplCoreCollectionPluginRecord[] | null {
  let o = 0;
  if (!canRead(data, o, 1)) return null;
  const key = data[o];
  o += 1;
  if (key !== 5) return null; // Not a CollectionV1 account.

  // updateAuthority pubkey
  if (!canRead(data, o, 32)) return null;
  o += 32;
  // name + uri
  const afterName = skipBorshString(data, o);
  if (afterName == null) return null;
  o = afterName;
  const afterUri = skipBorshString(data, o);
  if (afterUri == null) return null;
  o = afterUri;
  // numMinted + currentSize
  if (!canRead(data, o, 8)) return null;
  o += 8;

  // No plugins section.
  if (o >= data.length) return null;

  // PluginHeaderV1 (key=3, pluginRegistryOffset=u64)
  if (!canRead(data, o, 9)) return null;
  const pluginHeaderKey = data[o];
  o += 1;
  if (pluginHeaderKey !== 3) return null;
  const pluginRegistryOffset = Number(data.readBigUInt64LE(o));
  if (!Number.isFinite(pluginRegistryOffset) || pluginRegistryOffset < 0 || pluginRegistryOffset >= data.length) return null;

  // PluginRegistryV1 (key=4)
  let r = pluginRegistryOffset;
  if (!canRead(data, r, 5)) return null;
  const regKey = data[r];
  r += 1;
  if (regKey !== 4) return null;
  const registryLen = data.readUInt32LE(r);
  r += 4;

  const records: MplCoreCollectionPluginRecord[] = [];
  for (let i = 0; i < registryLen; i++) {
    if (!canRead(data, r, 2)) return null;
    const pluginType = data[r];
    r += 1;

    const authorityKind = data[r];
    r += 1;
    let authorityAddress: PublicKey | undefined;
    if (authorityKind === 3) {
      if (!canRead(data, r, 32)) return null;
      authorityAddress = new PublicKey(data.subarray(r, r + 32));
      r += 32;
    } else if (authorityKind < 0 || authorityKind > 3) {
      return null;
    }

    if (!canRead(data, r, 8)) return null;
    const offset = Number(data.readBigUInt64LE(r));
    r += 8;
    if (!Number.isFinite(offset) || offset < 0 || offset >= data.length) return null;

    records.push({ pluginType, authorityKind, authorityAddress, offset });
  }

  return records;
}

export function decodeMplCoreCollectionRoyalties(data: Buffer): {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  ruleSetKind: number;
  authorityKind: number;
  authorityAddress?: PublicKey;
} | null {
  const records = readMplCoreCollectionPluginRecords(data);
  const royaltiesRecord = records?.find((record) => record.pluginType === 0);
  if (!royaltiesRecord) return null;

  let p = royaltiesRecord.offset;
  if (!canRead(data, p, 1)) return null;
  const pluginVariant = data[p];
  p += 1;
  // Plugin variant must match Royalties (0).
  if (pluginVariant !== 0) return null;

  if (!canRead(data, p, 6)) return null;
  const basisPoints = data.readUInt16LE(p);
  p += 2;
  const creatorsLen = data.readUInt32LE(p);
  p += 4;
  const creators: { address: PublicKey; percentage: number }[] = [];
  for (let i = 0; i < creatorsLen; i++) {
    if (!canRead(data, p, 33)) return null;
    const address = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const percentage = data[p];
    p += 1;
    creators.push({ address, percentage });
  }
  if (!canRead(data, p, 1)) return null;
  const ruleSetKind = data[p];

  return {
    basisPoints,
    creators,
    ruleSetKind,
    authorityKind: royaltiesRecord.authorityKind,
    authorityAddress: royaltiesRecord.authorityAddress,
  };
}

export function decodeMplCoreCollectionUpdateDelegates(data: Buffer): {
  delegates: PublicKey[];
  authorityKind: number;
  authorityAddress?: PublicKey;
} | null {
  const records = readMplCoreCollectionPluginRecords(data);
  const updateDelegateRecord = records?.find((record) => record.pluginType === 4);
  if (!updateDelegateRecord) return null;

  let p = updateDelegateRecord.offset;
  if (!canRead(data, p, 5)) return null;
  const pluginVariant = data[p];
  p += 1;
  // Plugin variant must match UpdateDelegate (4).
  if (pluginVariant !== 4) return null;

  const delegateLen = data.readUInt32LE(p);
  p += 4;
  const delegates: PublicKey[] = [];
  for (let i = 0; i < delegateLen; i++) {
    if (!canRead(data, p, 32)) return null;
    delegates.push(new PublicKey(data.subarray(p, p + 32)));
    p += 32;
  }

  return {
    delegates,
    authorityKind: updateDelegateRecord.authorityKind,
    authorityAddress: updateDelegateRecord.authorityAddress,
  };
}

export function assertMplCoreCollectionHasUpdateDelegates(args: {
  data: Buffer;
  collection: PublicKey | string;
  requiredDelegates: PublicKey[];
  configPath?: string;
}) {
  const collection = typeof args.collection === 'string' ? args.collection : args.collection.toBase58();
  const updateDelegate = decodeMplCoreCollectionUpdateDelegates(args.data);
  if (!updateDelegate) {
    throw new Error(`Missing/undecodable UpdateDelegate plugin on core collection: ${collection}`);
  }
  if (updateDelegate.authorityKind !== MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY) {
    const actualAuthority =
      updateDelegate.authorityKind === 3 && updateDelegate.authorityAddress
        ? `Address(${updateDelegate.authorityAddress.toBase58()})`
        : `kind=${updateDelegate.authorityKind}`;
    throw new Error(
      `Core collection UpdateDelegate plugin authority mismatch.\n` +
        `Collection: ${collection}\n` +
        `Expected authority: UpdateAuthority\n` +
        `Actual authority  : ${actualAuthority}\n` +
        `Fix: recreate the collection through ${args.configPath ?? 'scripts/newDrops/<dropId>.ts'}, or update the collection UpdateDelegate plugin authority to UpdateAuthority before pinning it.`,
    );
  }

  const missing = uniquePubkeys(args.requiredDelegates).filter(
    (required) => !updateDelegate.delegates.some((actual) => actual.equals(required)),
  );
  if (!missing.length) return updateDelegate;

  throw new Error(
    `Core collection UpdateDelegate missing required delegate(s).\n` +
      `Collection: ${collection}\n` +
      `Expected delegates: ${uniquePubkeys(args.requiredDelegates).map((delegate) => delegate.toBase58()).join(', ')}\n` +
      `Actual delegates  : ${updateDelegate.delegates.map((delegate) => delegate.toBase58()).join(', ') || '(none)'}\n` +
      `Missing delegates : ${missing.map((delegate) => delegate.toBase58()).join(', ')}`,
  );
}
