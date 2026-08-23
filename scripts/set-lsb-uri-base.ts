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

const PROGRAM_ID = new PublicKey('22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep');
const PROGRAM_DATA = new PublicKey('2u35tdkjBJkT79tdT58XeNEw216B82BPVmMeD8WoEfa6');
const CONFIG_PDA = new PublicKey('iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const OLD_URI_BASE = 'https://assets.mons.link/drops/lsb';
const NEW_URI_BASE = 'https://cdn.lil.org/nft/little_swag_boxes';
const RELEASE_SHA256 = '17462bfc39cd338f6ade0c3859e2afedcfeaf82aa7d8581850f0f787a8dc1ace';
const OLD_CONFIG_SHA256 = '4cf3e76e8a5f1852f1876c857041ac8f3e35eeb7f1b96c398f2eb167d06d93db';
const RELEASE_BYTES = 493_728;
const CONFIG_BYTES = 289;
const DEPLOYMENT_SLOT = 437_179_964;
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const SET_URI_BASE_DISCRIMINATOR = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);

type Options = {
  rpcUrl: string;
  rpcSource: string;
  send: boolean;
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
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  started: boolean;
  bump: number;
};

type LiveState = {
  configData: Buffer;
  config: DecodedConfig;
  balanceLamports: number;
};

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function configuredHeliusRpc(): { rpcUrl: string; rpcSource: string } | undefined {
  const processApiKey = process.env.HELIUS_API_KEY?.trim();
  if (processApiKey) {
    return {
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(processApiKey)}`,
      rpcSource: 'HELIUS_API_KEY (process environment)',
    };
  }

  const envPath = path.join(repositoryRoot(), '.env.local');
  if (!existsSync(envPath)) return undefined;
  const contents = readFileSync(envPath, 'utf8');
  const match = contents.match(/^HELIUS_API_KEY\s*=\s*(.+?)\s*$/m);
  const fileApiKey = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (fileApiKey) {
    return {
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(fileApiKey)}`,
      rpcSource: 'HELIUS_API_KEY (.env.local)',
    };
  }
  return undefined;
}

function parseArgs(argv: string[]): Options {
  const configuredHelius = configuredHeliusRpc();
  let rpcUrl = process.env.MAINNET_RPC_URL?.trim()
    || configuredHelius?.rpcUrl
    || 'https://api.mainnet-beta.solana.com';
  let rpcSource = process.env.MAINNET_RPC_URL?.trim()
    ? 'MAINNET_RPC_URL (process environment)'
    : configuredHelius?.rpcSource || 'Solana public mainnet RPC';
  let send = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (/keypair|private|secret|signer/i.test(arg)) {
      throw new Error('Signing material cannot be provided as a command-line argument');
    }
    if (arg === '--send') {
      send = true;
      continue;
    }
    if (arg === '--rpc-url') {
      rpcUrl = String(argv[++index] || '').trim();
      if (!rpcUrl) throw new Error('--rpc-url requires a URL');
      rpcSource = '--rpc-url';
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { rpcUrl, rpcSource, send };
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
    if (offset + 32 > data.length) throw new Error('Config pubkey exceeds account data');
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
  const maxPerTx = data[offset];
  offset += 1;
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const namePrefix = readString(data, offset);
  offset = namePrefix.offset;
  const symbol = readString(data, offset);
  offset = symbol.offset;
  const uriBase = readString(data, offset);
  offset = uriBase.offset;
  if (offset + 2 > data.length) throw new Error('Config flags exceed account data');
  const started = data[offset] === 1;
  const bump = data[offset + 1];

  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    started,
    bump,
  };
}

function assertOnlyUriBaseChanged(before: DecodedConfig, after: DecodedConfig): void {
  for (const key of Object.keys(before) as Array<keyof DecodedConfig>) {
    if (key === 'uriBase') continue;
    assert.equal(after[key], before[key], `Unexpected config change: ${key}`);
  }
  assert.equal(after.uriBase, NEW_URI_BASE, 'URI base did not change to the approved target');
}

function encodeSetUriBase(): Buffer {
  const value = Buffer.from(NEW_URI_BASE, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([SET_URI_BASE_DISCRIMINATOR, length, value]);
}

function setterInstruction(): TransactionInstruction {
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: ADMIN, isSigner: true, isWritable: false },
    ],
    data: encodeSetUriBase(),
  });
  assert.deepEqual(
    instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    [
      [CONFIG_PDA.toBase58(), false, true],
      [ADMIN.toBase58(), true, false],
    ],
  );
  return instruction;
}

function simulationAccountData(value: unknown): Buffer | null {
  if (!value || typeof value !== 'object' || !('data' in value)) return null;
  const data = (value as { data: unknown }).data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data) && typeof data[0] === 'string') return Buffer.from(data[0], 'base64');
  return null;
}

async function readLiveState(connection: Connection): Promise<LiveState> {
  const [genesis, programAccount, configAccount, balanceLamports] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(PROGRAM_ID, 'finalized'),
    connection.getAccountInfo(CONFIG_PDA, 'finalized'),
    connection.getBalance(ADMIN, 'finalized'),
  ]);
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);
  if (!programAccount || !programAccount.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('Program executable or owner mismatch');
  }
  if (programAccount.data.readUInt32LE(0) !== 2) throw new Error('Program account state mismatch');
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  if (!programDataAddress.equals(PROGRAM_DATA)) throw new Error('ProgramData address mismatch');
  const programDataAccount = await connection.getAccountInfo(PROGRAM_DATA, 'finalized');
  if (!programDataAccount || !programDataAccount.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('ProgramData owner mismatch');
  }
  if (programDataAccount.data.length !== 45 + RELEASE_BYTES) throw new Error('ProgramData size mismatch');
  if (programDataAccount.data.readUInt32LE(0) !== 3) throw new Error('ProgramData state mismatch');
  if (Number(programDataAccount.data.readBigUInt64LE(4)) !== DEPLOYMENT_SLOT) throw new Error('Deployment slot mismatch');
  if (programDataAccount.data[12] !== 1) throw new Error('Program has no upgrade authority');
  const authority = new PublicKey(programDataAccount.data.subarray(13, 45));
  if (!authority.equals(ADMIN)) throw new Error('Upgrade authority mismatch');
  if (sha256(Buffer.from(programDataAccount.data.subarray(45))) !== RELEASE_SHA256) {
    throw new Error('Deployed ELF hash mismatch');
  }
  if (!configAccount || !configAccount.owner.equals(PROGRAM_ID)) throw new Error('Config owner mismatch');
  const configData = Buffer.from(configAccount.data);
  const config = decodeConfig(configData);
  if (config.admin !== ADMIN.toBase58()) throw new Error('Config admin mismatch');
  return { configData, config, balanceLamports };
}

function buildTransaction(blockhash: string, signer?: Keypair) {
  const message = new TransactionMessage({
    payerKey: ADMIN,
    recentBlockhash: blockhash,
    instructions: [setterInstruction()],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  if (signer) transaction.sign([signer]);
  return { message, transaction };
}

async function simulateSetter(
  connection: Connection,
  before: DecodedConfig,
  transaction: VersionedTransaction,
  sigVerify: boolean,
) {
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed',
    sigVerify,
    replaceRecentBlockhash: !sigVerify,
    accounts: { addresses: [CONFIG_PDA.toBase58()], encoding: 'base64' },
  });
  if (simulation.value.err) {
    throw new Error(
      `Setter simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n') || ''}`,
    );
  }
  const returnedData = simulationAccountData(simulation.value.accounts?.[0]);
  if (!returnedData) throw new Error('Setter simulation did not return the config account');
  if (returnedData.length !== CONFIG_BYTES) throw new Error('Setter simulation changed the config size');
  assertOnlyUriBaseChanged(before, decodeConfig(returnedData));
  return simulation.value;
}

async function finalizedConfig(connection: Connection, before: DecodedConfig): Promise<Buffer> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const account = await connection.getAccountInfo(CONFIG_PDA, 'finalized');
    if (account && account.owner.equals(PROGRAM_ID) && account.data.length === CONFIG_BYTES) {
      const data = Buffer.from(account.data);
      const decoded = decodeConfig(data);
      if (decoded.uriBase === NEW_URI_BASE) {
        assertOnlyUriBaseChanged(before, decoded);
        return data;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('Finalized config did not reach the approved URI base');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connection = new Connection(options.rpcUrl, 'finalized');
  const before = await readLiveState(connection);

  console.log('Little Swag Boxes URI setter preflight passed.');
  console.log('mode            :', options.send ? 'approved send' : 'read-only simulation');
  console.log('cluster         : mainnet-beta');
  console.log('rpc             :', sanitizedRpcUrl(options.rpcUrl));
  console.log('rpc credential  :', options.rpcSource);
  console.log('program         :', PROGRAM_ID.toBase58());
  console.log('program data    :', PROGRAM_DATA.toBase58());
  console.log('deployment slot :', DEPLOYMENT_SLOT);
  console.log('deployed SHA-256:', RELEASE_SHA256);
  console.log('config          :', CONFIG_PDA.toBase58());
  console.log('config bytes    :', before.configData.length);
  console.log('config SHA-256  :', sha256(before.configData));
  console.log('current URI     :', before.config.uriBase);
  console.log('target URI      :', NEW_URI_BASE);
  console.log('admin/fee payer :', ADMIN.toBase58());
  console.log('balance lamports:', before.balanceLamports);
  console.log('writable account:', CONFIG_PDA.toBase58());

  if (before.config.uriBase === NEW_URI_BASE) {
    console.log('The URI base is already finalized at the approved target. Nothing to send.');
    return;
  }
  if (before.config.uriBase !== OLD_URI_BASE) throw new Error(`Unexpected live URI base: ${before.config.uriBase}`);
  if (sha256(before.configData) !== OLD_CONFIG_SHA256) throw new Error('Live config differs from the archived snapshot');

  const previewBlockhash = await connection.getLatestBlockhash('confirmed');
  const preview = buildTransaction(previewBlockhash.blockhash);
  const previewSimulation = await simulateSetter(connection, before.config, preview.transaction, false);
  const previewFee = (await connection.getFeeForMessage(preview.message, 'confirmed')).value;
  console.log('simulation error:', previewSimulation.err);
  console.log('compute units   :', previewSimulation.unitsConsumed);
  console.log('estimated fee   :', previewFee, 'lamports');

  if (!options.send) {
    console.log('Read-only simulation complete. Use --send only after explicit mainnet setter approval.');
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

    const signedPreview = buildTransaction(previewBlockhash.blockhash, admin);
    const signedSimulation = await simulateSetter(connection, before.config, signedPreview.transaction, true);
    console.log('Signed simulation succeeded with', signedSimulation.unitsConsumed, 'compute units.');
    console.log('Transaction summary: set_uri_base only; no SOL transfer; network fee only.');
    if (!(await promptYConfirmation('Send the approved MAINNET URI setter? [y/N] '))) {
      console.log('Cancelled before send.');
      return;
    }

    const recheck = await readLiveState(connection);
    if (!recheck.configData.equals(before.configData)) throw new Error('Live config changed after simulation; refusing send');
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const prepared = buildTransaction(latestBlockhash.blockhash, admin);
    const finalSimulation = await simulateSetter(connection, before.config, prepared.transaction, true);
    console.log('Final simulation succeeded with', finalSimulation.unitsConsumed, 'compute units.');
    const expectedSignature = bs58.encode(prepared.transaction.signatures[0]);
    console.log('Prepared signature:', expectedSignature);

    const signature = await connection.sendRawTransaction(prepared.transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
    if (signature !== expectedSignature) throw new Error('RPC returned an unexpected transaction signature');
    console.log('Submitted signature:', signature);
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'finalized');
    if (confirmation.value.err) throw new Error(`Setter transaction failed: ${JSON.stringify(confirmation.value.err)}`);

    const afterData = await finalizedConfig(connection, before.config);
    console.log('URI setter verified at finalized commitment.');
    console.log('signature       :', signature);
    console.log('config bytes    :', afterData.length);
    console.log('config SHA-256  :', sha256(afterData));
    console.log('final URI       :', decodeConfig(afterData).uriBase);
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
