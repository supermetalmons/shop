import { PublicKey } from '@solana/web3.js';
import { BOX_MINTER_CONFIG_SEED } from '../../../../shared/boxMinterProtocol.js';

const DELIVER_DISCRIMINATOR = Buffer.from('fa83de39d3e5d193', 'hex');
const DELIVER_INSTRUCTION_BYTES = 21;

export function hasDeliverDiscriminator(data: Buffer): boolean {
  return data.subarray(0, DELIVER_DISCRIMINATOR.length).equals(DELIVER_DISCRIMINATOR);
}

export function encodeDeliverInstruction(
  deliveryId: number,
  feeLamports: bigint,
  deliveryBump: number,
): Buffer {
  const data = Buffer.alloc(DELIVER_INSTRUCTION_BYTES);
  DELIVER_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(deliveryId, 8);
  data.writeBigUInt64LE(feeLamports, 12);
  data.writeUInt8(deliveryBump, 20);
  return data;
}

export function decodeDeliverInstruction(data: Buffer): {
  deliveryId: number;
  feeLamports: bigint;
  deliveryBump: number;
} | null {
  if (data.length < DELIVER_INSTRUCTION_BYTES || !hasDeliverDiscriminator(data)) return null;
  return {
    deliveryId: data.readUInt32LE(8),
    feeLamports: data.readBigUInt64LE(12),
    deliveryBump: data.readUInt8(20),
  };
}

export function deriveDeliveryAddress(
  runtime: { boxMinterProgramId: PublicKey; boxMinterConfigPda: PublicKey },
  deliveryId: number,
): [PublicKey, number] {
  const singleton = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED)],
    runtime.boxMinterProgramId,
  )[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!runtime.boxMinterConfigPda.equals(singleton)) seeds.push(runtime.boxMinterConfigPda.toBuffer());
  const id = Buffer.alloc(4);
  id.writeUInt32LE(deliveryId, 0);
  seeds.push(id);
  return PublicKey.findProgramAddressSync(seeds, runtime.boxMinterProgramId);
}
