import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

const PROGRAM_ID = new PublicKey('22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep');
const PROGRAM_DATA = new PublicKey('2u35tdkjBJkT79tdT58XeNEw216B82BPVmMeD8WoEfa6');
const CONFIG_PDA = new PublicKey('iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc');
const AUTHORITY = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CURRENT_URI_BASE = 'https://assets.mons.link/drops/lsb';
const RELEASE_SHA256 = '17462bfc39cd338f6ade0c3859e2afedcfeaf82aa7d8581850f0f787a8dc1ace';
const RELEASE_BYTES = 493_728;
const CONFIG_BYTES = 289;
const MIN_BALANCE_LAMPORTS = 3_870_000_000;

type Options = {
  binaryPath: string;
  rpcUrl: string;
  dryRun: boolean;
};

type MainnetSnapshot = {
  slot: number;
  authority: string;
  configData: Buffer;
  uriBase: string;
  balanceLamports: number;
  programData: Buffer;
};

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function defaultBinaryPath(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.resolve(
    root,
    '../shop-lsb-uri-upgrade/.cache/lsb-release-acd71311c367f822da2ec432c0a8d65f8aab7c87/box_minter.so',
  );
}

function parseArgs(argv: string[]): Options {
  let binaryPath = defaultBinaryPath();
  let rpcUrl = process.env.MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('--binary requires a path');
      binaryPath = path.resolve(value);
      continue;
    }
    if (arg === '--rpc-url') {
      rpcUrl = String(argv[++index] || '').trim();
      if (!rpcUrl) throw new Error('--rpc-url requires a URL');
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { binaryPath, rpcUrl, dryRun };
}

function sanitizedRpcUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function decodeConfigUri(data: Buffer): string {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config size is ${data.length}, expected ${CONFIG_BYTES}`);
  let offset = 8 + 32 * 3 + 8 + 8 + 32 + 4 + 1 + 4;
  for (let index = 0; index < 2; index += 1) {
    const length = data.readUInt32LE(offset);
    offset += 4 + length;
  }
  const length = data.readUInt32LE(offset);
  offset += 4;
  if (offset + length > data.length) throw new Error('Config URI exceeds account data');
  return data.subarray(offset, offset + length).toString('utf8');
}

async function readMainnetSnapshot(connection: Connection): Promise<MainnetSnapshot> {
  const [genesis, programAccount, configAccount, balanceLamports] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(PROGRAM_ID, 'finalized'),
    connection.getAccountInfo(CONFIG_PDA, 'finalized'),
    connection.getBalance(AUTHORITY, 'finalized'),
  ]);

  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);
  if (!programAccount) throw new Error('Program account is missing');
  if (!programAccount.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('Program executable or owner mismatch');
  }
  if (programAccount.data.readUInt32LE(0) !== 2) throw new Error('Program account state mismatch');
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  if (!programDataAddress.equals(PROGRAM_DATA)) throw new Error('ProgramData address mismatch');
  if (!configAccount) throw new Error('Config account is missing');
  if (!configAccount.owner.equals(PROGRAM_ID)) throw new Error('Config owner mismatch');
  if (configAccount.data.length !== CONFIG_BYTES) throw new Error('Config size mismatch');
  const configAdmin = new PublicKey(configAccount.data.subarray(8, 40));
  if (!configAdmin.equals(AUTHORITY)) throw new Error('Config admin mismatch');

  const programDataAccount = await connection.getAccountInfo(PROGRAM_DATA, 'finalized');
  if (!programDataAccount || !programDataAccount.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('ProgramData owner mismatch');
  }
  if (programDataAccount.data.readUInt32LE(0) !== 3) throw new Error('ProgramData state mismatch');
  if (programDataAccount.data[12] !== 1) throw new Error('Program has no upgrade authority');
  const authority = new PublicKey(programDataAccount.data.subarray(13, 45)).toBase58();
  if (authority !== AUTHORITY.toBase58()) throw new Error(`Upgrade authority mismatch: ${authority}`);

  return {
    slot: Number(programDataAccount.data.readBigUInt64LE(4)),
    authority,
    configData: Buffer.from(configAccount.data),
    uriBase: decodeConfigUri(Buffer.from(configAccount.data)),
    balanceLamports,
    programData: Buffer.from(programDataAccount.data),
  };
}

function writeTempKeypair(keypair: Keypair): string {
  const filePath = path.join(tmpdir(), `mons-shop-lsb-upgrade-${process.pid}-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return filePath;
}

function verifyRelease(binaryPath: string): Buffer {
  if (!existsSync(binaryPath)) throw new Error(`Release ELF not found: ${binaryPath}`);
  const binary = readFileSync(binaryPath);
  if (binary.length !== RELEASE_BYTES) {
    throw new Error(`Release ELF is ${binary.length} bytes, expected ${RELEASE_BYTES}`);
  }
  const hash = sha256(binary);
  if (hash !== RELEASE_SHA256) throw new Error(`Release ELF hash mismatch: ${hash}`);
  return binary;
}

function deployedElfHash(programData: Buffer, releaseBytes: number): string {
  if (programData.length < 45 + releaseBytes) {
    throw new Error(`ProgramData is ${programData.length} bytes, expected at least ${45 + releaseBytes}`);
  }
  return sha256(programData.subarray(45, 45 + releaseBytes));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const binary = verifyRelease(options.binaryPath);
  const connection = new Connection(options.rpcUrl, 'finalized');
  const before = await readMainnetSnapshot(connection);

  if (before.uriBase !== CURRENT_URI_BASE) {
    throw new Error(`Live config URI is ${before.uriBase}, expected ${CURRENT_URI_BASE}`);
  }
  if (before.balanceLamports < MIN_BALANCE_LAMPORTS) {
    throw new Error(`Authority balance is ${before.balanceLamports} lamports, expected at least ${MIN_BALANCE_LAMPORTS}`);
  }

  console.log('Little Swag Boxes program-upgrade preflight passed.');
  console.log('cluster         : mainnet-beta');
  console.log('rpc             :', sanitizedRpcUrl(options.rpcUrl));
  console.log('program         :', PROGRAM_ID.toBase58());
  console.log('program data    :', PROGRAM_DATA.toBase58());
  console.log('current slot    :', before.slot);
  console.log('authority       :', before.authority);
  console.log('config bytes    :', before.configData.length);
  console.log('config URI      :', before.uriBase);
  console.log('release ELF     :', options.binaryPath);
  console.log('release bytes   :', binary.length);
  console.log('release SHA-256 :', RELEASE_SHA256);
  console.log('balance lamports:', before.balanceLamports);

  if (options.dryRun) {
    console.log('Dry run complete; no private key was requested and nothing was deployed.');
    return;
  }

  console.log('Enter the upgrade authority private key (input is hidden).');
  console.log('Accepted formats: base58 secret key or a JSON byte array.');
  const authority = parsePrivateKeyInput(await promptMaskedInput('upgrade authority private key: '));
  const authorityAddress = authority.publicKey.toBase58();
  if (authorityAddress !== AUTHORITY.toBase58()) {
    authority.secretKey.fill(0);
    throw new Error(`Private key address is ${authorityAddress}, expected ${AUTHORITY.toBase58()}`);
  }

  console.log('Private key address verified:', authorityAddress);
  const confirmed = await promptYConfirmation('Proceed with MAINNET program upgrade? [y/N] ');
  if (!confirmed) {
    authority.secretKey.fill(0);
    console.log('Cancelled before deployment.');
    return;
  }

  let tempKeypairPath: string | undefined;
  const cleanup = () => {
    authority.secretKey.fill(0);
    if (!tempKeypairPath) return;
    try {
      unlinkSync(tempKeypairPath);
      tempKeypairPath = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to remove temporary keypair: ${tempKeypairPath}`);
      }
    }
  };
  const interrupt = (code: number) => {
    cleanup();
    process.exit(code);
  };
  process.once('exit', cleanup);
  process.once('SIGINT', () => interrupt(130));
  process.once('SIGTERM', () => interrupt(143));

  try {
    tempKeypairPath = writeTempKeypair(authority);
    const result = spawnSync(
      'solana',
      [
        'program',
        'deploy',
        options.binaryPath,
        '--program-id',
        PROGRAM_ID.toBase58(),
        '--upgrade-authority',
        tempKeypairPath,
        '--fee-payer',
        tempKeypairPath,
        '--url',
        options.rpcUrl,
        '--commitment',
        'finalized',
        '--use-rpc',
        '--output',
        'json',
      ],
      { stdio: 'inherit', env: { ...process.env, NO_DNA: '1' } },
    );
    if (result.status !== 0) throw new Error(`solana program deploy exited with status ${result.status}`);
  } finally {
    cleanup();
  }

  const after = await readMainnetSnapshot(connection);
  if (after.slot <= before.slot) throw new Error(`Deployment slot did not advance: ${after.slot}`);
  if (after.authority !== before.authority) throw new Error('Upgrade authority changed unexpectedly');
  if (!after.configData.equals(before.configData)) throw new Error('Config account changed during program deployment');
  const onchainHash = deployedElfHash(after.programData, binary.length);
  if (onchainHash !== RELEASE_SHA256) {
    throw new Error(`Deployed ELF hash is ${onchainHash}, expected ${RELEASE_SHA256}`);
  }

  console.log('Program upgrade verified at finalized commitment.');
  console.log('new slot        :', after.slot);
  console.log('deployed SHA-256:', onchainHash);
  console.log('authority       :', after.authority);
  console.log('config unchanged:', true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
