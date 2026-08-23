import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

const PROGRAM_ID = new PublicKey('C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A');
const PROGRAM_DATA = new PublicKey('3rmLDxbb6AFQfAKjWMjvFF7axnXBJYBigATFdCSm9Mvv');
const CONFIG_PDA = new PublicKey('2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SOURCE_COMMIT = 'e16a8e63cdb97fc0a663e181b1e81cf86f3fd53f';
const OLD_URI_BASE = 'https://assets.mons.link/drops/poncho';
const NEW_URI_BASE = 'https://cdn.lil.org/nft/poncho_drifella';
const CONFIG_BYTES = 307;
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const SET_URI_BASE_DISCRIMINATOR = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);
const SEND_ATTEMPTS = 5;

type Options = {
  releaseDir: string;
  rollback: boolean;
  send: boolean;
  rpcUrl: string;
  rpcSource: string;
};

type DecodedConfig = {
  admin: string;
  treasury: string;
  coreCollection: string;
  priceLamports: string;
  discountPriceLamports: string;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  started: boolean;
  bump: number;
  discountMintsPerWallet: number;
  figureNamePrefix: string;
};

type LiveState = {
  configData: Buffer;
  config: DecodedConfig;
  programSlot: number;
  deployedHash: string;
  balanceLamports: number;
};

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function configuredHeliusRpc(): { rpcUrl: string; rpcSource: string } | undefined {
  const processApiKey = process.env.HELIUS_API_KEY?.trim();
  if (processApiKey) return {
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(processApiKey)}`,
    rpcSource: 'HELIUS_API_KEY (process environment)',
  };
  const envPath = path.join(repositoryRoot(), '.env.local');
  if (!existsSync(envPath)) return undefined;
  const contents = readFileSync(envPath, 'utf8');
  const match = contents.match(/^HELIUS_API_KEY\s*=\s*(.+?)\s*$/m);
  const fileApiKey = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (fileApiKey) return {
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(fileApiKey)}`,
    rpcSource: 'HELIUS_API_KEY (.env.local)',
  };
  return undefined;
}

function parseArgs(argv: string[]): Options {
  const configuredHelius = configuredHeliusRpc();
  let releaseDir = process.env.PONCHO_RELEASE_DIR?.trim()
    || path.join(repositoryRoot(), '.cache', 'poncho-drifella-migration-release');
  let rollback = false;
  let send = false;
  const rpcUrl = process.env.MAINNET_RPC_URL?.trim()
    || configuredHelius?.rpcUrl
    || 'https://api.mainnet-beta.solana.com';
  const rpcSource = process.env.MAINNET_RPC_URL?.trim()
    ? 'MAINNET_RPC_URL (process environment)'
    : configuredHelius?.rpcSource || 'Solana public mainnet RPC';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (/keypair|private|secret|signer|rpc-url/i.test(arg)) {
      throw new Error('Signing material and RPC URLs cannot be provided as command-line arguments');
    }
    if (arg === '--send') {
      send = true;
      continue;
    }
    if (arg === '--rollback') {
      rollback = true;
      continue;
    }
    if (arg === '--release-dir') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('--release-dir requires a path');
      releaseDir = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { releaseDir, rollback, send, rpcUrl, rpcSource };
}

function releaseIdentity(releaseDir: string): { elfBytes: number; elfSha256: string } {
  const binaryPath = path.join(releaseDir, 'box_minter.so');
  const manifestPath = path.join(releaseDir, 'hash-manifest.json');
  if (!existsSync(binaryPath) || !existsSync(manifestPath)) throw new Error('Verified release is incomplete');
  const binary = readFileSync(binaryPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const digest = sha256(binary);
  if (
    manifest.programId !== PROGRAM_ID.toBase58()
    || manifest.sourceCommit !== SOURCE_COMMIT
    || manifest.elfSha256 !== digest
    || manifest.identicalIndependentBuilds !== true
  ) {
    throw new Error('Verified release manifest mismatch');
  }
  return { elfBytes: binary.length, elfSha256: digest };
}

function sanitizedRpcUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function readString(data: Buffer, offset: number): { value: string; offset: number } {
  if (offset + 4 > data.length) throw new Error('Config string length exceeds account data');
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('Config string exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(data: Buffer): DecodedConfig {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config is ${data.length} bytes, expected ${CONFIG_BYTES}`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error('Config discriminator mismatch');
  let offset = 8;
  const readPubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const admin = readPubkey();
  const treasury = readPubkey();
  const coreCollection = readPubkey();
  const priceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountPriceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountMerkleRoot = data.subarray(offset, offset + 32).toString('hex');
  offset += 32;
  const maxSupply = data.readUInt32LE(offset);
  offset += 4;
  const maxPerTx = data[offset++];
  const itemsPerBox = data[offset++];
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const namePrefix = readString(data, offset);
  offset = namePrefix.offset;
  const symbol = readString(data, offset);
  offset = symbol.offset;
  const uriBase = readString(data, offset);
  offset = uriBase.offset;
  const started = data[offset++] === 1;
  const bump = data[offset++];
  const discountMintsPerWallet = data[offset++];
  const figureNamePrefix = readString(data, offset);
  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    started,
    bump,
    discountMintsPerWallet,
    figureNamePrefix: figureNamePrefix.value,
  };
}

function assertOnlyUriChanged(before: DecodedConfig, after: DecodedConfig, target: string): void {
  for (const key of Object.keys(before) as Array<keyof DecodedConfig>) {
    if (key !== 'uriBase') assert.equal(after[key], before[key], `Unexpected config change: ${key}`);
  }
  assert.equal(after.uriBase, target, 'URI base did not reach the approved target');
}

function instruction(target: string): TransactionInstruction {
  const value = Buffer.from(target, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  const result = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: ADMIN, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([SET_URI_BASE_DISCRIMINATOR, length, value]),
  });
  assert.deepEqual(result.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]), [
    [CONFIG_PDA.toBase58(), false, true],
    [ADMIN.toBase58(), true, false],
  ]);
  return result;
}

function simulationAccountData(value: unknown): Buffer | null {
  if (!value || typeof value !== 'object' || !('data' in value)) return null;
  const data = (value as { data: unknown }).data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data) && typeof data[0] === 'string') return Buffer.from(data[0], 'base64');
  return null;
}

async function readLiveState(
  connection: Connection,
  release: { elfBytes: number; elfSha256: string },
): Promise<LiveState> {
  const [genesis, programAccount, configAccount, programDataAccount, balanceLamports] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(PROGRAM_ID, 'finalized'),
    connection.getAccountInfo(CONFIG_PDA, 'finalized'),
    connection.getAccountInfo(PROGRAM_DATA, 'finalized'),
    connection.getBalance(ADMIN, 'finalized'),
  ]);
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);
  if (!programAccount?.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)) throw new Error('Program mismatch');
  if (!new PublicKey(programAccount.data.subarray(4, 36)).equals(PROGRAM_DATA)) throw new Error('ProgramData mismatch');
  if (!programDataAccount?.owner.equals(UPGRADEABLE_LOADER) || programDataAccount.data[12] !== 1) {
    throw new Error('ProgramData state mismatch');
  }
  if (!new PublicKey(programDataAccount.data.subarray(13, 45)).equals(ADMIN)) throw new Error('Authority mismatch');
  if (programDataAccount.data.length < 45 + release.elfBytes) throw new Error('ProgramData is smaller than release');
  const deployedHash = sha256(Buffer.from(programDataAccount.data.subarray(45, 45 + release.elfBytes)));
  if (deployedHash !== release.elfSha256) throw new Error(`Deployed ELF hash mismatch: ${deployedHash}`);
  if (programDataAccount.data.subarray(45 + release.elfBytes).some((byte) => byte !== 0)) {
    throw new Error('ProgramData has unexpected trailing bytes');
  }
  if (!configAccount?.owner.equals(PROGRAM_ID)) throw new Error('Config owner mismatch');
  const configData = Buffer.from(configAccount.data);
  const config = decodeConfig(configData);
  if (config.admin !== ADMIN.toBase58()) throw new Error('Config admin mismatch');
  return {
    configData,
    config,
    programSlot: Number(programDataAccount.data.readBigUInt64LE(4)),
    deployedHash,
    balanceLamports,
  };
}

function buildTransaction(blockhash: string, target: string, signer?: Keypair) {
  const message = new TransactionMessage({
    payerKey: ADMIN,
    recentBlockhash: blockhash,
    instructions: [instruction(target)],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  if (signer) transaction.sign([signer]);
  return { message, transaction };
}

async function simulate(
  connection: Connection,
  before: DecodedConfig,
  target: string,
  transaction: VersionedTransaction,
  sigVerify: boolean,
) {
  const result = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed',
    sigVerify,
    replaceRecentBlockhash: !sigVerify,
    accounts: { addresses: [CONFIG_PDA.toBase58()], encoding: 'base64' },
  });
  if (result.value.err) {
    throw new Error(`Setter simulation failed: ${JSON.stringify(result.value.err)}\n${result.value.logs?.join('\n') || ''}`);
  }
  const data = simulationAccountData(result.value.accounts?.[0]);
  if (!data || data.length !== CONFIG_BYTES) throw new Error('Simulation did not return the 307-byte config');
  assertOnlyUriChanged(before, decodeConfig(data), target);
  return result.value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const release = releaseIdentity(options.releaseDir);
  const connection = new Connection(options.rpcUrl, 'finalized');
  const before = await readLiveState(connection, release);
  const source = options.rollback ? NEW_URI_BASE : OLD_URI_BASE;
  const target = options.rollback ? OLD_URI_BASE : NEW_URI_BASE;
  console.log('Poncho Drifella URI setter preflight passed.');
  console.log('mode            :', options.send ? 'approved send' : 'read-only simulation');
  console.log('direction       :', options.rollback ? 'rollback' : 'forward');
  console.log('cluster         : mainnet-beta');
  console.log('rpc             :', sanitizedRpcUrl(options.rpcUrl));
  console.log('rpc credential  :', options.rpcSource);
  console.log('program         :', PROGRAM_ID.toBase58());
  console.log('program data    :', PROGRAM_DATA.toBase58());
  console.log('deployment slot :', before.programSlot);
  console.log('deployed SHA-256:', before.deployedHash);
  console.log('config          :', CONFIG_PDA.toBase58());
  console.log('config bytes    :', before.configData.length);
  console.log('config SHA-256  :', sha256(before.configData));
  console.log('current URI     :', before.config.uriBase);
  console.log('target URI      :', target);
  console.log('admin/fee payer :', ADMIN.toBase58());
  console.log('balance lamports:', before.balanceLamports);
  console.log('writable account:', CONFIG_PDA.toBase58());
  if (before.config.uriBase === target) {
    console.log('The config is already finalized at the requested URI base. Nothing to send.');
    return;
  }
  if (before.config.uriBase !== source) throw new Error(`Unexpected live URI base: ${before.config.uriBase}`);
  const previewBlockhash = await connection.getLatestBlockhash('confirmed');
  const preview = buildTransaction(previewBlockhash.blockhash, target);
  const previewSimulation = await simulate(connection, before.config, target, preview.transaction, false);
  const previewFee = (await connection.getFeeForMessage(preview.message, 'confirmed')).value;
  console.log('simulation error:', previewSimulation.err);
  console.log('compute units   :', previewSimulation.unitsConsumed);
  console.log('estimated fee   :', previewFee, 'lamports');
  if (!options.send) {
    console.log('Read-only simulation complete. Use --send only after explicit setter approval.');
    return;
  }

  console.log('Enter the config admin private key (input is hidden).');
  console.log('Accepted formats: base58 secret key or a JSON byte array.');
  let keyInput = await promptMaskedInput('config admin private key: ');
  let admin: Keypair | undefined;
  try {
    admin = parsePrivateKeyInput(keyInput);
    keyInput = '';
    if (!admin.publicKey.equals(ADMIN)) {
      throw new Error(`Private key address is ${admin.publicKey.toBase58()}, expected ${ADMIN.toBase58()}`);
    }
    console.log('Private key address verified:', admin.publicKey.toBase58());
    const signedPreview = buildTransaction(previewBlockhash.blockhash, target, admin);
    const signedSimulation = await simulate(connection, before.config, target, signedPreview.transaction, true);
    console.log('Signed simulation succeeded with', signedSimulation.unitsConsumed, 'compute units.');
    console.log('Transaction summary: set_uri_base only; config PDA is the only writable program account.');
    if (!(await promptYConfirmation('Send the approved MAINNET URI setter? [y/N] '))) {
      console.log('Cancelled before send.');
      return;
    }

    let confirmedSignature = '';
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      const recheck = await readLiveState(connection, release);
      if (recheck.config.uriBase === target) {
        assertOnlyUriChanged(before.config, recheck.config, target);
        break;
      }
      if (!recheck.configData.equals(before.configData)) throw new Error('Config changed after simulation; refusing send');
      const latest = await connection.getLatestBlockhash('confirmed');
      const prepared = buildTransaction(latest.blockhash, target, admin);
      const finalSimulation = await simulate(connection, before.config, target, prepared.transaction, true);
      console.log(`Attempt ${attempt} simulation:`, finalSimulation.unitsConsumed, 'compute units');
      const expectedSignature = bs58.encode(prepared.transaction.signatures[0]);
      const signature = await connection.sendRawTransaction(prepared.transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5,
      });
      if (signature !== expectedSignature) throw new Error('RPC returned an unexpected signature');
      console.log('Submitted signature:', signature);
      try {
        const confirmation = await connection.confirmTransaction({
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        }, 'finalized');
        if (confirmation.value.err) throw new Error(`Setter failed: ${JSON.stringify(confirmation.value.err)}`);
        confirmedSignature = signature;
        break;
      } catch (error) {
        const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (status?.err) throw new Error(`Setter failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'finalized') {
          confirmedSignature = signature;
          break;
        }
        if (attempt === SEND_ATTEMPTS) throw error;
        console.log(`Blockhash confirmation expired; retrying with a fresh blockhash (${SEND_ATTEMPTS - attempt} left).`);
      }
    }
    const after = await readLiveState(connection, release);
    assertOnlyUriChanged(before.config, after.config, target);
    console.log('URI setter verified at finalized commitment.');
    console.log('signature       :', confirmedSignature || 'confirmed during state reconciliation');
    console.log('config bytes    :', after.configData.length);
    console.log('config SHA-256  :', sha256(after.configData));
    console.log('final URI       :', after.config.uriBase);
    console.log('other fields same:', true);
  } finally {
    keyInput = '';
    admin?.secretKey.fill(0);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
