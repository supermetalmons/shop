import { Connection, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

export function lamportsToSol(lamports = 0): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(3);
}

export function estimateDeliveryLamports(country: string, items: number): number {
  if (!items) return 0;
  const normalized = (country || '').trim().toLowerCase();
  const compact = normalized.replace(/[\s.]/g, '');
  const isUS =
    compact === 'us' ||
    compact === 'usa' ||
    compact === 'unitedstates' ||
    compact === 'unitedstatesofamerica' ||
    normalized.includes('united states');
  const base = isUS ? 0.15 : 0.32;
  const multiplier = Math.max(1, items * 0.35);
  return Math.round(base * multiplier * LAMPORTS_PER_SOL);
}

export async function sendPreparedTransaction(
  encodedTx: string,
  connection: Connection,
  signer: (tx: VersionedTransaction) => Promise<string>,
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(encodedTx, 'base64'));
  const signature = await signer(tx);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ ...latestBlockhash, signature }, 'confirmed');
  return signature;
}

export function encryptAddressPayload(
  plaintext: string,
  recipientPublicKey: string,
): { cipherText: string; hint: string } {
  const remoteKey = Buffer.from(recipientPublicKey, 'base64');
  if (remoteKey.length !== nacl.box.publicKeyLength) {
    throw new Error('Invalid address encryption public key');
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = new TextEncoder().encode(plaintext);
  const cipher = nacl.box(message, nonce, remoteKey, ephemeral.secretKey);
  const payload = [nonce, ephemeral.publicKey, cipher]
    .map((arr) => Buffer.from(arr).toString('base64'))
    .join('.');

  // Very small hint to display in UI without leaking full address
  const hint = plaintext.slice(0, 1) + '...' + plaintext.slice(-2);

  return { cipherText: payload, hint };
}

export function shortAddress(addr: string, chars = 4) {
  return addr.length <= chars * 2 ? addr : `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function buildSignInMessage(wallet: string): string {
  const domain = window?.location?.hostname || 'mons.shop';
  const ts = new Date().toISOString();
  return `Sign in to mons.shop as ${wallet}\nDomain: ${domain}\nTimestamp: ${ts}`;
}
