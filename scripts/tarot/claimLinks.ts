import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TAROT_CHAIN_ID, TAROT_MAX_CARDS, tarotCodeHashInput } from '../../shared/ethereum/tarot.ts';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol.ts';

type ClaimLink = { tokenId: number; code: string; url: string };
export type TarotClaimLinks = { version: 1; chainId: number; contractAddress: string; createdAtMs: number; links: ClaimLink[] };
type Credential = { tokenId: number; codeHash: string };
export const TAROT_CREDENTIAL_PIN_PATH = 'releases/tarot-sepolia-v1/credential-set.json';

export function tarotCredentials(manifest: TarotClaimLinks): Credential[] {
  if (manifest.version !== 1 || manifest.chainId !== TAROT_CHAIN_ID ||
    normalizeEthereumAddress(manifest.contractAddress) !== manifest.contractAddress ||
    !Number.isSafeInteger(manifest.createdAtMs) || manifest.createdAtMs < 0 ||
    !Array.isArray(manifest.links) || manifest.links.length !== TAROT_MAX_CARDS) throw new Error('Invalid private Tarot link manifest.');
  const unique = new Set<string>();
  return manifest.links.map((link, index) => {
    if (link.tokenId !== index + 1 || typeof link.code !== 'string' || link.code !== link.code.toLowerCase() ||
      unique.has(link.code) || link.url !== tarotLinkUrl(link.tokenId, link.code)) throw new Error('Invalid private Tarot claim link.');
    unique.add(link.code);
    return { tokenId: link.tokenId, codeHash: createHash('sha256').update(tarotCodeHashInput({
      chainId: manifest.chainId, contractAddress: manifest.contractAddress, tokenId: link.tokenId, code: link.code,
    })).digest('hex') };
  });
}

function tarotLinkUrl(tokenId: number, code: string): string {
  return `https://mons.shop/nfc?code=${code}&tokenId=${tokenId}&testnet=true`;
}

function privateDirectory(directory: string, root: string): void {
  const allowed = resolve(root, '.operations');
  const target = resolve(directory);
  const child = relative(allowed, target);
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Tarot secrets must be stored beneath .operations/.');
  mkdirSync(allowed, { recursive: true, mode: 0o700 });
  let current = allowed;
  if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== resolve(realpathSync(root), '.operations')) {
    throw new Error('Unsafe private operations directory.');
  }
  for (const part of child.split(sep)) {
    current = resolve(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Tarot secret directories must have mode 0700.');
  }
}

function readPrivateManifest(path: string): TarotClaimLinks {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Tarot link manifests must have mode 0600.');
  let manifest: TarotClaimLinks;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) as TarotClaimLinks; }
  catch { throw new Error('Invalid private Tarot link manifest.'); }
  tarotCredentials(manifest);
  return manifest;
}

export function createTarotClaimLinks(directory: string, contract: string, root: string): TarotClaimLinks {
  const contractAddress = normalizeEthereumAddress(contract);
  if (!contractAddress || /^0x0{40}$/.test(contractAddress)) throw new Error('A nonzero Tarot deployment address is required.');
  privateDirectory(directory, root);
  const filename = resolve(directory, 'claim-links.private.json');
  if (existsSync(filename)) {
    const manifest = readPrivateManifest(filename);
    if (manifest.contractAddress !== contractAddress) throw new Error('Existing Tarot links belong to another deployment.');
    return manifest;
  }
  const manifest: TarotClaimLinks = { version: 1, chainId: TAROT_CHAIN_ID, contractAddress, createdAtMs: Date.now(),
    links: Array.from({ length: TAROT_MAX_CARDS }, (_, index) => {
      const code = randomUUID();
      return { tokenId: index + 1, code, url: tarotLinkUrl(index + 1, code) };
    }) };
  tarotCredentials(manifest);
  const descriptor = openSync(filename, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(manifest, null, 2) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const parent = openSync(dirname(filename), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return manifest;
}

export function loadTarotClaimLinks(directory: string, root: string): TarotClaimLinks {
  privateDirectory(directory, root);
  return readPrivateManifest(resolve(directory, 'claim-links.private.json'));
}

export function tarotCredentialSql(manifest: TarotClaimLinks): string {
  const rows = tarotCredentials(manifest);
  return rows.map(({ tokenId, codeHash }) => `INSERT INTO tarot_claim_codes(chain_id,contract_address,token_id,code_hash,created_at_ms,revoked_at_ms) VALUES (${TAROT_CHAIN_ID},'${manifest.contractAddress}',${tokenId},'${codeHash}',${manifest.createdAtMs},NULL) ON CONFLICT(chain_id,contract_address,token_id) DO UPDATE SET code_hash=CASE WHEN tarot_claim_codes.code_hash=excluded.code_hash AND tarot_claim_codes.revoked_at_ms IS NULL THEN tarot_claim_codes.code_hash ELSE NULL END;`).join('\n');
}

export function verifyTarotCredentials(manifest: TarotClaimLinks, rows: Record<string, unknown>[], complete: boolean): void {
  const expected = new Map(tarotCredentials(manifest).map(row => [row.tokenId, row.codeHash]));
  const seen = new Set<number>();
  if (complete && rows.length !== TAROT_MAX_CARDS) throw new Error('Tarot credential provisioning is incomplete.');
  for (const row of rows) {
    const tokenId = Number(row.token_id);
    if (seen.has(tokenId) || row.chain_id !== TAROT_CHAIN_ID || row.contract_address !== manifest.contractAddress ||
      expected.get(tokenId) !== row.code_hash || row.created_at_ms !== manifest.createdAtMs || row.revoked_at_ms !== null) {
      throw new Error('Existing Tarot credentials conflict with the private manifest.');
    }
    seen.add(tokenId);
  }
}

export function tarotCredentialPin(manifest: TarotClaimLinks) {
  const credentials = tarotCredentials(manifest);
  const scope = { version: 1, chainId: manifest.chainId, contractAddress: manifest.contractAddress, credentialCount: credentials.length };
  const credentialSetSha256 = createHash('sha256').update('mons:tarot:credential-set:v1\n')
    .update(JSON.stringify({ ...scope, credentials })).digest('hex');
  return { ...scope, credentialSetSha256 };
}

export function assertTarotCredentialPin(manifest: TarotClaimLinks, pin: unknown): void {
  const expected = tarotCredentialPin(manifest);
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
    Object.entries(expected).some(([key, value]) => (pin as Record<string, unknown>)[key] !== value) ||
    !('verifiedAt' in pin) || typeof pin.verifiedAt !== 'string' || !Number.isFinite(Date.parse(pin.verifiedAt))) {
    throw new Error('Private Tarot manifest does not match the verified credential set.');
  }
}

export function assertExistingTarotCredentialPin(manifest: TarotClaimLinks, root: string): void {
  const filename = resolve(root, TAROT_CREDENTIAL_PIN_PATH);
  if (existsSync(filename)) assertTarotCredentialPin(manifest, JSON.parse(readFileSync(filename, 'utf8')));
}

export function recordVerifiedTarotCredentials(manifest: TarotClaimLinks, rows: Record<string, unknown>[], root: string): void {
  verifyTarotCredentials(manifest, rows, true);
  const filename = resolve(root, TAROT_CREDENTIAL_PIN_PATH);
  if (existsSync(filename)) {
    assertExistingTarotCredentialPin(manifest, root);
    return;
  }
  const pin = { ...tarotCredentialPin(manifest), verifiedAt: new Date().toISOString() };
  mkdirSync(dirname(filename), { recursive: true });
  const descriptor = openSync(filename, 'wx', 0o644);
  try { writeFileSync(descriptor, JSON.stringify(pin, null, 2) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const parent = openSync(dirname(filename), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
