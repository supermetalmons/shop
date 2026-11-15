import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

type SignerDecodeFailure =
  | { kind: 'encoding'; cause: unknown }
  | { kind: 'length'; length: number }
  | { kind: 'key-validation'; cause: unknown };

export function decodeSolanaSigner(secret: string, invalid: (failure: SignerDecodeFailure) => unknown): Keypair {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret.trim());
  } catch (cause) {
    throw invalid({ kind: 'encoding', cause });
  }
  if (bytes.length !== 64) throw invalid({ kind: 'length', length: bytes.length });
  try {
    return Keypair.fromSecretKey(bytes);
  } catch (cause) {
    throw invalid({ kind: 'key-validation', cause });
  }
}
