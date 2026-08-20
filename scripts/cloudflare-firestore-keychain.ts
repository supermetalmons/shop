import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const firestoreKeychainService = 'mons-shop.cloudflare.firestore';
export const firestoreReaderServiceAccountEmail = 'mons-shop-cloudflare-reader@mons-shop.iam.gserviceaccount.com';
export const firestoreWriterServiceAccountEmail = 'mons-shop-cloudflare-writer@mons-shop.iam.gserviceaccount.com';

const helperPath = fileURLToPath(new URL('./macos-keychain-secret.swift', import.meta.url));

function runKeychain(command: 'get' | 'put' | 'delete', account: string, input?: string): string {
  if (process.platform !== 'darwin') throw new Error('Cloudflare Firestore Keychain credentials require macOS.');
  const result = spawnSync('swift', [resolve(helperPath), command, firestoreKeychainService, account], {
    encoding: 'utf8',
    input,
    maxBuffer: 128 * 1024,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cloudflare Firestore Keychain ${command} failed for ${account}.`);
  }
  return String(result.stdout || '');
}

export function readCloudflareFirestoreKeychainCredential(account: string): string {
  const value = runKeychain('get', account).trim();
  if (!value) throw new Error(`Cloudflare Firestore Keychain credential is empty for ${account}.`);
  return value;
}

export function writeCloudflareFirestoreKeychainCredential(account: string, value: string): void {
  if (!value.trim()) throw new Error(`Refusing to store an empty Keychain credential for ${account}.`);
  runKeychain('put', account, value);
}

export function deleteCloudflareFirestoreKeychainCredential(account: string): void {
  runKeychain('delete', account);
}
