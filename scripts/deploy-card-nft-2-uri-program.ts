import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

const PROGRAM_ID = new PublicKey('7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
const PROGRAM_DATA = new PublicKey('EoFbiCxRabimw8NHUNcdtMuVTuxVcriZSFZys4GvkWMK');
const CONFIG_PDA = new PublicKey('5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm');
const AUTHORITY = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const LIVE_ELF_SHA256 = 'dfad30f7a415bedd7083afe1641b717503a7512395ba7d63ab275ece470afdb5';
const LIVE_ELF_BYTES = 482_520;
const OLD_URI_BASE = 'https://assets.mons.link/drops/cardnft2/json';
const NEW_URI_BASE = 'https://cdn.lil.org/nft/card_nft_2/json';
const CONFIG_BYTES = 376;
const BUFFER_HEADER_BYTES = 37;
const PROGRAM_DATA_HEADER_BYTES = 45;
const SAFETY_MARGIN_LAMPORTS = 50_000_000;
const WRITE_MAX_SIGN_ATTEMPTS = 10;
const VERIFIED_BUILD_IMAGE = 'solanafoundation/solana-verifiable-build@sha256:695f890e620db8c39afe5112e048599f8ee395a0cab5a2e572f30a72c6366cb4';
const SHARED_CONFIGS = [
  CONFIG_PDA,
  new PublicKey('9fd9YF6ZYMZw9ERwdnc798xoUFo584Tmqxc5bWu8j1Bi'),
  new PublicKey('FRJeVgAF9sjUgUJD6Da4eRCBSyfzxjoU4wjxStp8RGXG'),
  new PublicKey('3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi'),
];

type Options = {
  releaseDir: string;
  buffer?: string;
  send: boolean;
  rpcUrl: string;
  rpcSource: string;
};

type Release = {
  binaryPath: string;
  binary: Buffer;
  sha256: string;
  sourceCommit: string;
};

type Snapshot = {
  slot: number;
  authority: string;
  configData: Buffer;
  uriBase: string;
  balanceLamports: number;
  programData: Buffer;
  programDataLamports: number;
  sharedConfigData: Map<string, Buffer>;
};

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function configuredHeliusRpc(): { rpcUrl: string; rpcSource: string } | undefined {
  for (const name of ['HELIUS_API_KEY', 'VITE_HELIUS_API_KEY']) {
    const raw = process.env[name]?.trim();
    if (raw) {
      return {
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(raw)}`,
        rpcSource: `${name} (process environment)`,
      };
    }
  }
  const envPath = path.join(repositoryRoot(), '.env.local');
  if (!existsSync(envPath)) return undefined;
  const contents = readFileSync(envPath, 'utf8');
  for (const name of ['HELIUS_API_KEY', 'VITE_HELIUS_API_KEY']) {
    const match = contents.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
    const raw = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (raw) {
      return {
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(raw)}`,
        rpcSource: `${name} (.env.local)`,
      };
    }
  }
  return undefined;
}

function parseArgs(argv: string[]): Options {
  const configuredHelius = configuredHeliusRpc();
  const defaultReleaseDir = process.env.CARD_NFT_2_RELEASE_DIR?.trim()
    || path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-migration-release');
  let releaseDir = defaultReleaseDir;
  let buffer: string | undefined;
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
    if (arg === '--release-dir') {
      releaseDir = path.resolve(String(argv[++index] || '').trim());
      if (!releaseDir) throw new Error('--release-dir requires a path');
      continue;
    }
    if (arg === '--buffer') {
      buffer = String(argv[++index] || '').trim();
      if (!buffer) throw new Error('--buffer requires a public buffer address');
      new PublicKey(buffer);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { releaseDir, buffer, send, rpcUrl, rpcSource };
}

function sanitizedRpcUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function readRelease(releaseDir: string): Release {
  const binaryPath = path.join(releaseDir, 'box_minter.so');
  const manifestPath = path.join(releaseDir, 'hash-manifest.json');
  if (!existsSync(binaryPath) || !existsSync(manifestPath)) {
    throw new Error(`Verified release is incomplete: ${releaseDir}`);
  }
  const binary = readFileSync(binaryPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const digest = sha256(binary);
  if (manifest.programId !== PROGRAM_ID.toBase58()) throw new Error('Release program ID mismatch');
  if (!/^[0-9a-f]{40}$/.test(String(manifest.sourceCommit || ''))) {
    throw new Error('Release source commit is missing or malformed');
  }
  if (manifest.baseImage !== VERIFIED_BUILD_IMAGE) throw new Error('Release build image mismatch');
  if (manifest.elfSha256 !== digest) throw new Error('Release ELF hash mismatch');
  if (manifest.identicalIndependentBuilds !== true) throw new Error('Release lacks two identical independent builds');
  const builds = Array.isArray(manifest.builds) ? manifest.builds as Array<Record<string, unknown>> : [];
  if (builds.length !== 2 || builds.some((build) => build.elfSha256 !== digest)) {
    throw new Error('Independent build manifests do not match the release ELF');
  }
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot(),
    encoding: 'utf8',
  });
  if (gitHead.status !== 0 || gitHead.stdout.trim() !== manifest.sourceCommit) {
    throw new Error('Checked-out source commit does not match the verified release');
  }
  return { binaryPath, binary, sha256: digest, sourceCommit: String(manifest.sourceCommit) };
}

function decodeConfigUri(data: Buffer): string {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config size is ${data.length}, expected ${CONFIG_BYTES}`);
  let offset = 8 + 32 * 3 + 8 + 8 + 32 + 4 + 1 + 1 + 4;
  for (let index = 0; index < 2; index += 1) {
    const length = data.readUInt32LE(offset);
    offset += 4 + length;
  }
  const length = data.readUInt32LE(offset);
  offset += 4;
  if (offset + length > data.length) throw new Error('Config URI exceeds account data');
  return data.subarray(offset, offset + length).toString('utf8');
}

async function readSnapshot(connection: Connection): Promise<Snapshot> {
  const [genesis, programAccount, balanceLamports, programDataAccount, ...sharedConfigAccounts] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(PROGRAM_ID, 'finalized'),
    connection.getBalance(AUTHORITY, 'finalized'),
    connection.getAccountInfo(PROGRAM_DATA, 'finalized'),
    ...SHARED_CONFIGS.map((address) => connection.getAccountInfo(address, 'finalized')),
  ]);
  const configAccount = sharedConfigAccounts[0];
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);
  if (!programAccount?.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('Program executable or owner mismatch');
  }
  if (programAccount.data.readUInt32LE(0) !== 2) throw new Error('Program account state mismatch');
  if (!new PublicKey(programAccount.data.subarray(4, 36)).equals(PROGRAM_DATA)) {
    throw new Error('ProgramData address mismatch');
  }
  if (!programDataAccount?.owner.equals(UPGRADEABLE_LOADER)) throw new Error('ProgramData owner mismatch');
  if (programDataAccount.data.readUInt32LE(0) !== 3 || programDataAccount.data[12] !== 1) {
    throw new Error('ProgramData state mismatch');
  }
  const authority = new PublicKey(programDataAccount.data.subarray(13, 45)).toBase58();
  if (authority !== AUTHORITY.toBase58()) throw new Error(`Upgrade authority mismatch: ${authority}`);
  if (!configAccount?.owner.equals(PROGRAM_ID)) throw new Error('Config owner mismatch');
  if (configAccount.data.length !== CONFIG_BYTES) throw new Error('Config size mismatch');
  if (!new PublicKey(configAccount.data.subarray(8, 40)).equals(AUTHORITY)) throw new Error('Config admin mismatch');
  const sharedConfigData = new Map<string, Buffer>();
  for (let index = 0; index < SHARED_CONFIGS.length; index += 1) {
    const address = SHARED_CONFIGS[index];
    const account = sharedConfigAccounts[index];
    if (!account?.owner.equals(PROGRAM_ID)) throw new Error(`Shared config owner mismatch: ${address}`);
    if (!new PublicKey(account.data.subarray(8, 40)).equals(AUTHORITY)) {
      throw new Error(`Shared config admin mismatch: ${address}`);
    }
    sharedConfigData.set(address.toBase58(), Buffer.from(account.data));
  }
  return {
    slot: Number(programDataAccount.data.readBigUInt64LE(4)),
    authority,
    configData: Buffer.from(configAccount.data),
    uriBase: decodeConfigUri(Buffer.from(configAccount.data)),
    balanceLamports,
    programData: Buffer.from(programDataAccount.data),
    programDataLamports: programDataAccount.lamports,
    sharedConfigData,
  };
}

function assertSharedConfigsUnchanged(before: Snapshot, after: Snapshot): void {
  for (const address of SHARED_CONFIGS) {
    const key = address.toBase58();
    if (!before.sharedConfigData.get(key)?.equals(after.sharedConfigData.get(key)!)) {
      throw new Error(`Shared config changed during program deployment: ${key}`);
    }
  }
}

function deployedElfHash(programData: Buffer, elfBytes?: number): string {
  const payload = programData.subarray(PROGRAM_DATA_HEADER_BYTES);
  return sha256(elfBytes == null ? payload : payload.subarray(0, elfBytes));
}

function identifyDeployedElf(programData: Buffer, release: Release): { bytes: number; sha256: string } {
  const payload = programData.subarray(PROGRAM_DATA_HEADER_BYTES);
  if (payload.length >= release.binary.length
    && deployedElfHash(programData, release.binary.length) === release.sha256
    && !payload.subarray(release.binary.length).some((byte) => byte !== 0)) {
    return { bytes: release.binary.length, sha256: release.sha256 };
  }
  if (payload.length >= LIVE_ELF_BYTES
    && deployedElfHash(programData, LIVE_ELF_BYTES) === LIVE_ELF_SHA256
    && !payload.subarray(LIVE_ELF_BYTES).some((byte) => byte !== 0)) {
    return { bytes: LIVE_ELF_BYTES, sha256: LIVE_ELF_SHA256 };
  }
  throw new Error('Deployed ProgramData does not match the archived live ELF or verified release');
}

async function inspectBuffer(connection: Connection, address: PublicKey, release: Release): Promise<string> {
  const account = await connection.getAccountInfo(address, 'finalized');
  if (!account?.owner.equals(UPGRADEABLE_LOADER)) throw new Error(`Finalized buffer is missing: ${address}`);
  if (account.data.length < BUFFER_HEADER_BYTES + release.binary.length) throw new Error('Buffer is too small');
  if (account.data.readUInt32LE(0) !== 1 || account.data[4] !== 1) throw new Error('Buffer state mismatch');
  if (!new PublicKey(account.data.subarray(5, 37)).equals(AUTHORITY)) throw new Error('Buffer authority mismatch');
  const digest = sha256(Buffer.from(account.data.subarray(37, 37 + release.binary.length)));
  return digest;
}

function safeUnlink(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writePrivateFile(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function recordBuffer(address: PublicKey, release: Release): string {
  const outputDir = path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-upgrade');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(outputDir, 'last-buffer.json');
  writeFileSync(outputPath, `${JSON.stringify({
    buffer: address.toBase58(),
    elfSha256: release.sha256,
    sourceCommit: release.sourceCommit,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const release = readRelease(options.releaseDir);
  const connection = new Connection(options.rpcUrl, 'finalized');
  const before = await readSnapshot(connection);
  const currentElf = identifyDeployedElf(before.programData, release);
  if (currentElf.sha256 === LIVE_ELF_SHA256 && before.uriBase !== OLD_URI_BASE) {
    throw new Error(`Unexpected config URI before upgrade: ${before.uriBase}`);
  }
  if (currentElf.sha256 === release.sha256
    && before.uriBase !== OLD_URI_BASE
    && before.uriBase !== NEW_URI_BASE) {
    throw new Error(`Unexpected config URI after upgrade: ${before.uriBase}`);
  }
  const bufferAddress = options.buffer ? new PublicKey(options.buffer) : undefined;
  const resumeBufferHash = bufferAddress && currentElf.sha256 !== release.sha256
    ? await inspectBuffer(connection, bufferAddress, release)
    : undefined;
  const bufferBytes = BUFFER_HEADER_BYTES + release.binary.length;
  const programDataBytes = PROGRAM_DATA_HEADER_BYTES + release.binary.length;
  const [bufferRent, programDataRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(bufferBytes, 'finalized'),
    connection.getMinimumBalanceForRentExemption(programDataBytes, 'finalized'),
  ]);
  const resizeFunding = Math.max(0, programDataRent - before.programDataLamports);
  const alreadyDeployed = currentElf.sha256 === release.sha256;
  const requiredLamports = alreadyDeployed
    ? 0
    : (bufferAddress ? 0 : bufferRent) + resizeFunding + SAFETY_MARGIN_LAMPORTS;

  console.log('Card NFT 2 program-upgrade preflight passed.');
  console.log('mode                  :', options.send ? 'approved send' : 'read-only preflight');
  console.log('cluster               : mainnet-beta');
  console.log('rpc                   :', sanitizedRpcUrl(options.rpcUrl));
  console.log('rpc credential        :', options.rpcSource);
  console.log('program               :', PROGRAM_ID.toBase58());
  console.log('program data          :', PROGRAM_DATA.toBase58());
  console.log('current slot          :', before.slot);
  console.log('authority             :', before.authority);
  console.log('config bytes          :', before.configData.length);
  console.log('config URI            :', before.uriBase);
  console.log('ProgramData capacity  :', before.programData.length - PROGRAM_DATA_HEADER_BYTES);
  console.log('deployed ELF bytes    :', currentElf.bytes);
  console.log('deployed ELF SHA-256  :', currentElf.sha256);
  console.log('release ELF           :', release.binaryPath);
  console.log('release bytes         :', release.binary.length);
  console.log('release SHA-256       :', release.sha256);
  console.log('ELF byte delta        :', release.binary.length - currentElf.bytes);
  console.log('ProgramData extension :', Math.max(0, programDataBytes - before.programData.length));
  console.log('final transactions    :', alreadyDeployed ? 0 : before.programData.length < programDataBytes ? 2 : 1);
  console.log('buffer bytes          :', bufferBytes);
  console.log('buffer rent           :', bufferRent);
  console.log('ProgramData rent      :', programDataRent);
  console.log('ProgramData rent delta:', resizeFunding);
  console.log('safety margin         :', SAFETY_MARGIN_LAMPORTS);
  console.log('required balance      :', requiredLamports);
  console.log('authority balance     :', before.balanceLamports);
  if (bufferAddress) {
    console.log('resume buffer         :', bufferAddress.toBase58());
    console.log('resume buffer hash    :', resumeBufferHash || 'not needed; release already deployed');
    console.log('resume write required :', resumeBufferHash != null && resumeBufferHash !== release.sha256);
  }
  if (currentElf.sha256 === release.sha256) {
    console.log('The verified release is already deployed. Nothing to send.');
    return;
  }
  if (before.balanceLamports < requiredLamports) {
    throw new Error(`Authority needs at least ${requiredLamports - before.balanceLamports} additional lamports`);
  }
  if (!options.send) {
    console.log('Read-only preflight complete. Use --send only after explicit program-deploy approval.');
    return;
  }

  console.log('Enter the upgrade authority private key (input is hidden).');
  console.log('Accepted formats: base58 secret key or a JSON byte array.');
  let keyInput = await promptMaskedInput('upgrade authority private key: ');
  let authority: Keypair | undefined;
  let tempDir: string | undefined;
  let configPath: string | undefined;
  let bufferPath: string | undefined;
  try {
    authority = parsePrivateKeyInput(keyInput);
    keyInput = '';
    if (!authority.publicKey.equals(AUTHORITY)) {
      throw new Error(`Private key address is ${authority.publicKey.toBase58()}, expected ${AUTHORITY.toBase58()}`);
    }
    console.log('Private key address verified:', authority.publicKey.toBase58());
    const action = before.programData.length < programDataBytes
      ? 'ProgramData extension and program upgrade'
      : 'program upgrade';
    if (!(await promptYConfirmation(`Proceed with approved MAINNET ${action}? [y/N] `))) {
      console.log('Cancelled before deployment.');
      return;
    }

    tempDir = mkdtempSync(path.join(tmpdir(), 'mons-card-nft-2-upgrade-'));
    chmodSync(tempDir, 0o700);
    configPath = path.join(tempDir, 'solana-config.yml');
    writePrivateFile(configPath, [
      `json_rpc_url: ${JSON.stringify(options.rpcUrl)}`,
      'websocket_url: ""',
      'keypair_path: "-"',
      'address_labels:',
      'commitment: finalized',
      '',
    ].join('\n'));

    const runSolana = (args: string[], label: string) => {
      const result = spawnSync('solana', ['--config', configPath!, ...args], {
        input: `${JSON.stringify(Array.from(authority!.secretKey))}\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, NO_DNA: '1' },
      });
      if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
    };

    let finalizedBuffer = bufferAddress;
    let writeBuffer = resumeBufferHash !== release.sha256;
    if (!finalizedBuffer) {
      const buffer = Keypair.generate();
      finalizedBuffer = buffer.publicKey;
      bufferPath = path.join(tempDir, 'buffer.json');
      writePrivateFile(bufferPath, JSON.stringify(Array.from(buffer.secretKey)));
      buffer.secretKey.fill(0);
      console.log('Initialized buffer address:', finalizedBuffer.toBase58());
      const checkpointPath = recordBuffer(finalizedBuffer, release);
      console.log('Buffer checkpoint     :', checkpointPath);
      writeBuffer = true;
    }
    if (writeBuffer) {
      try {
        runSolana([
          'program', 'write-buffer', release.binaryPath,
          '--buffer', bufferPath || finalizedBuffer.toBase58(),
          '--commitment', 'finalized',
          '--use-rpc',
          '--max-sign-attempts', String(WRITE_MAX_SIGN_ATTEMPTS),
          '--output', 'json',
        ], 'solana program write-buffer');
      } finally {
        safeUnlink(bufferPath);
        bufferPath = undefined;
      }
    }
    const bufferHash = await inspectBuffer(connection, finalizedBuffer, release);
    if (bufferHash !== release.sha256) throw new Error(`Finalized buffer hash mismatch: ${bufferHash}`);
    console.log('Finalized buffer hash :', bufferHash);
    const extensionBytes = Math.max(0, programDataBytes - before.programData.length);
    if (extensionBytes > 0) {
      try {
        runSolana([
          'program', 'extend', PROGRAM_ID.toBase58(), String(extensionBytes),
          '--commitment', 'finalized',
          '--output', 'json',
        ], 'solana program extend');
      } catch (error) {
        const extensionCheck = await readSnapshot(connection);
        if (extensionCheck.programData.length < programDataBytes) throw error;
        console.log('ProgramData extension finalized despite the CLI confirmation error.');
      }
      const extended = await readSnapshot(connection);
      if (extended.programData.length < programDataBytes) throw new Error('ProgramData extension did not allocate enough bytes');
      if (extended.authority !== before.authority) throw new Error('Upgrade authority changed during ProgramData extension');
      assertSharedConfigsUnchanged(before, extended);
      const extendedElf = identifyDeployedElf(extended.programData, release);
      if (extendedElf.sha256 !== LIVE_ELF_SHA256) throw new Error('Executable changed during ProgramData extension');
      console.log('ProgramData capacity  :', extended.programData.length - PROGRAM_DATA_HEADER_BYTES);
      console.log('ProgramData extended  :', true);
    }
    runSolana([
      'program', 'deploy',
      '--program-id', PROGRAM_ID.toBase58(),
      '--buffer', finalizedBuffer.toBase58(),
      '--commitment', 'finalized',
      '--use-rpc',
      '--output', 'json',
    ], 'solana program deploy');
  } finally {
    keyInput = '';
    authority?.secretKey.fill(0);
    safeUnlink(bufferPath);
    safeUnlink(configPath);
    if (tempDir) {
      try {
        rmdirSync(tempDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Temporary directory remains: ${tempDir}`);
      }
    }
  }

  const after = await readSnapshot(connection);
  if (after.slot <= before.slot) throw new Error('ProgramData slot did not advance');
  if (after.authority !== before.authority) throw new Error('Upgrade authority changed');
  assertSharedConfigsUnchanged(before, after);
  const afterHash = deployedElfHash(after.programData, release.binary.length);
  if (afterHash !== release.sha256) throw new Error(`Deployed ELF hash mismatch: ${afterHash}`);
  if (after.programData.subarray(45 + release.binary.length).some((byte) => byte !== 0)) {
    throw new Error('ProgramData contains unexpected nonzero trailing bytes');
  }
  console.log('Program upgrade verified at finalized commitment.');
  console.log('new slot        :', after.slot);
  console.log('deployed SHA-256:', afterHash);
  console.log('authority       :', after.authority);
  console.log('all four configs unchanged:', true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
