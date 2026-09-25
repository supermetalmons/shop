import type { Connection } from '@solana/web3.js';
import bs58 from 'bs58';

function unsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function base58Bytes(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  try { return bs58.decode(value).length === length; }
  catch { return false; }
}

export async function verifyArchivedPreorderAbsence(
  connection: Pick<Connection, 'getBlocks' | 'getBlockSignatures'>,
  args: { signature: string; blockhashContextSlot: number; lastValidBlockHeight: number; finalizedSlot: number },
): Promise<boolean> {
  if (
    !base58Bytes(args.signature, 64) || !unsignedInteger(args.blockhashContextSlot) ||
    !unsignedInteger(args.lastValidBlockHeight) || !unsignedInteger(args.finalizedSlot) ||
    args.finalizedSlot < args.blockhashContextSlot
  ) return false;

  const lastSlot = args.blockhashContextSlot + Math.min(4095, args.finalizedSlot - args.blockhashContextSlot);
  let previous: { slot: number; blockhash: string; height: number } | undefined;
  for (let start = args.blockhashContextSlot; start <= lastSlot;) {
    const end = start + Math.min(255, lastSlot - start);
    const slots = await connection.getBlocks(start, end, 'finalized');
    if (!Array.isArray(slots) || slots.length > end - start + 1 || slots.some((slot, index) => (
      !unsignedInteger(slot) || slot < start || slot > end || index > 0 && slot <= slots[index - 1]
    ))) return false;

    for (const slot of slots) {
      const block = await connection.getBlockSignatures(slot, 'finalized');
      if (
        !block || !('blockHeight' in block) || !unsignedInteger(block.blockHeight) ||
        !unsignedInteger(block.parentSlot) || block.parentSlot >= slot ||
        !base58Bytes(block.blockhash, 32) || !base58Bytes(block.previousBlockhash, 32) ||
        !Array.isArray(block.signatures) || block.signatures.some((signature) => !base58Bytes(signature, 64))
      ) return false;

      if (previous ? (
        block.parentSlot !== previous.slot || block.previousBlockhash !== previous.blockhash ||
        block.blockHeight !== previous.height + 1
      ) : block.parentSlot >= args.blockhashContextSlot) return false;
      if (block.signatures.includes(args.signature)) return false;
      if (block.blockHeight > args.lastValidBlockHeight) return true;
      previous = { slot, blockhash: block.blockhash, height: block.blockHeight };
    }

    if (end === lastSlot) break;
    start = end + 1;
  }
  return false;
}
