import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { createScriptSolanaConnection, resolveScriptSolanaRpcUrl, scriptSolanaRpcHost } from './shared/solanaRpcEnvironment.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const IMMUTABLE_LOADERS = new Set([
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
]);
const TARGETS = [
  {
    cluster: 'devnet',
    programId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  },
  {
    cluster: 'mainnet-beta',
    programId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  },
] as const;
const DEPENDENCIES = [
  { name: 'mpl_core', programId: MPL_CORE_PROGRAM_ADDRESS },
  { name: 'bubblegum', programId: BUBBLEGUM_PROGRAM_ADDRESS },
  { name: 'compression', programId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS },
  { name: 'mpl_noop', programId: MPL_NOOP_PROGRAM_ADDRESS },
  { name: 'spl_noop', programId: SPL_NOOP_PROGRAM_ADDRESS },
];

type RpcAccount = {
  owner: PublicKey;
  executable: boolean;
  data: Uint8Array;
};

export type ProgramAttestation = {
  name: string;
  programId: string;
  loader: string;
  programDataAddress?: string;
  deploymentSlot?: number;
  programReadSlot: number;
  programDataReadSlot?: number;
  bytes: number;
  sha256: string;
  file: string;
};

export type TwoConfigProgramAttestation = {
  schemaVersion: 1;
  capturedAt: string;
  source: 'read-only Solana RPC';
  targets: Array<{
    cluster: string;
    genesisHash: string;
    programs: ProgramAttestation[];
  }>;
};

export type TwoConfigGateResult = {
  schemaVersion: 1;
  status: 'passed';
  testTarget: 'two_config_existing_programs';
  completedAt: string;
  attestationSha256: string;
  harnessSha256: string;
  runnerSha256: string;
  targets: TwoConfigProgramAttestation['targets'];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_PATH = path.join(ROOT, 'onchain/programs/box_minter/tests/two_config_existing_programs.rs');

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function accountBytes(account: RpcAccount | null, label: string): Buffer {
  if (!account || !(account.data instanceof Uint8Array)) {
    throw new Error(`Missing or invalid account: ${label}`);
  }
  return Buffer.from(account.data);
}

async function captureTarget(target: typeof TARGETS[number], fixturesDir?: string, explicitUrl?: string) {
  const rpcUrl = resolveScriptSolanaRpcUrl({
    cluster: target.cluster, root: ROOT,
    explicitUrl: explicitUrl || (target.cluster === 'devnet'
      ? process.env.TWO_CONFIG_DEVNET_RPC_URL : process.env.TWO_CONFIG_MAINNET_RPC_URL),
  });
  const connection = createScriptSolanaConnection({ cluster: target.cluster, root: ROOT, explicitUrl: rpcUrl });
  if (fixturesDir) console.log(`${target.cluster} RPC host: ${scriptSolanaRpcHost(rpcUrl)}`);
  const programs = [{ name: 'box_minter', programId: target.programId }, ...DEPENDENCIES];
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== target.genesisHash) throw new Error(`RPC cluster mismatch: expected ${target.cluster}`);
  const programAccounts = await connection.getMultipleAccountsInfoAndContext(
    programs.map(({ programId }) => new PublicKey(programId)), { commitment: 'finalized' },
  );
  if (programAccounts.value.length !== programs.length) throw new Error('Incomplete program account response');
  const resolved = programs.map((program, index) => {
    const account = programAccounts.value[index];
    const data = accountBytes(account, program.programId);
    if (!account.executable) throw new Error(`Program is not executable: ${program.programId}`);
    if (account.owner.toBase58() === UPGRADEABLE_LOADER) {
      if (data.length !== 36 || data.readUInt32LE(0) !== 2) throw new Error(`Invalid upgradeable program: ${program.programId}`);
      return { ...program, account, programDataAddress: new PublicKey(data.subarray(4, 36)).toBase58() };
    }
    if (!IMMUTABLE_LOADERS.has(account.owner.toBase58())) throw new Error(`Unsupported loader for ${program.programId}`);
    return { ...program, account, programDataAddress: undefined };
  });
  const programDataAddresses = resolved.flatMap(({ programDataAddress }) => programDataAddress ? [programDataAddress] : []);
  const programDataAccounts = await connection.getMultipleAccountsInfoAndContext(
    programDataAddresses.map((address) => new PublicKey(address)),
    { commitment: 'finalized', minContextSlot: programAccounts.context.slot },
  );
  const byAddress = new Map(programDataAddresses.map((address, index) => [address, programDataAccounts.value[index]]));
  if (fixturesDir) mkdirSync(path.join(fixturesDir, target.cluster), { recursive: true });
  const attestations: ProgramAttestation[] = [];
  for (const program of resolved) {
    let bytes: Buffer;
    let deploymentSlot: number | undefined;
    if (program.programDataAddress) {
      const account = byAddress.get(program.programDataAddress);
      const data = accountBytes(account, program.programDataAddress);
      if (account.owner.toBase58() !== UPGRADEABLE_LOADER || account.executable || data.length < 49 || data.readUInt32LE(0) !== 3) {
        throw new Error(`Invalid ProgramData: ${program.programDataAddress}`);
      }
      deploymentSlot = Number(data.readBigUInt64LE(4));
      if (!Number.isSafeInteger(deploymentSlot)) throw new Error('Invalid deployment slot');
      bytes = data.subarray(45);
    } else {
      bytes = accountBytes(program.account, program.programId);
    }
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`Program is not ELF: ${program.programId}`);
    }
    const file = `${target.cluster}/${program.name}.so`;
    if (fixturesDir) writeFileSync(path.join(fixturesDir, file), bytes);
    attestations.push({
      name: program.name,
      programId: program.programId,
      loader: program.account.owner.toBase58(),
      ...(program.programDataAddress ? {
        programDataAddress: program.programDataAddress,
        deploymentSlot,
        programDataReadSlot: programDataAccounts.context.slot,
      } : {}),
      programReadSlot: programAccounts.context.slot,
      bytes: bytes.length,
      sha256: sha256(bytes),
      file,
    });
    if (fixturesDir) console.log(`${target.cluster} ${program.name}: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
  }
  return { cluster: target.cluster, genesisHash, programs: attestations };
}

function verifyCachedFixtures(fixturesDir: string): TwoConfigProgramAttestation {
  const attestation = JSON.parse(readFileSync(path.join(fixturesDir, 'attestation.json'), 'utf8')) as TwoConfigProgramAttestation;
  if (attestation.schemaVersion !== 1 || attestation.targets.length !== 2) throw new Error('Invalid attestation');
  for (const target of TARGETS) {
    const captured = attestation.targets.find(({ cluster }) => cluster === target.cluster);
    const expected = [{ name: 'box_minter', programId: target.programId }, ...DEPENDENCIES];
    if (!captured || captured.genesisHash !== target.genesisHash || captured.programs.length !== expected.length) throw new Error(`Missing or incorrect ${target.cluster} binaries`);
    for (const program of expected) {
      const record = captured.programs.find(({ name }) => name === program.name);
      const file = `${target.cluster}/${program.name}.so`;
      if (!record || record.programId !== program.programId || record.file !== file) throw new Error(`Wrong ${program.name} fixture`);
      const bytes = readFileSync(path.join(fixturesDir, file));
      if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`Changed binary: ${file}`);
    }
  }
  return attestation;
}

export async function verifyTwoConfigGateForDeployment(args: {
  cluster: 'devnet' | 'mainnet-beta';
  fixturesDir?: string;
  rpcUrl?: string;
}): Promise<{
  gate: TwoConfigGateResult;
  target: TwoConfigProgramAttestation['targets'][number];
}> {
  const fixturesDir = path.resolve(args.fixturesDir || path.join(ROOT, '.cache/two-config-programs'));
  const gate = JSON.parse(readFileSync(path.join(fixturesDir, 'gate-result.json'), 'utf8')) as TwoConfigGateResult;
  const attestation = verifyCachedFixtures(fixturesDir);
  if (
    gate.schemaVersion !== 1 || gate.status !== 'passed' || gate.testTarget !== 'two_config_existing_programs' ||
    !Number.isFinite(Date.parse(gate.completedAt)) ||
    gate.attestationSha256 !== sha256(readFileSync(path.join(fixturesDir, 'attestation.json'))) ||
    gate.harnessSha256 !== sha256(readFileSync(HARNESS_PATH)) ||
    gate.runnerSha256 !== sha256(readFileSync(fileURLToPath(import.meta.url))) ||
    JSON.stringify(gate.targets) !== JSON.stringify(attestation.targets)
  ) throw new Error('Missing or stale successful two-config test gate; rerun verify-two-config-programs');
  const target = TARGETS.find(({ cluster }) => cluster === args.cluster);
  if (!target) throw new Error(`Unsupported gate cluster: ${args.cluster}`);
  const current = await captureTarget(target, undefined, args.rpcUrl);
  const recorded = attestation.targets.find(({ cluster }) => cluster === args.cluster)!;
  for (const program of current.programs) {
    const expected = recorded.programs.find(({ name }) => name === program.name);
    if (!expected || ['programId', 'loader', 'programDataAddress', 'deploymentSlot', 'sha256', 'bytes'].some(
      (field) => program[field] !== expected[field],
    )) throw new Error(`Deployed ${args.cluster} ${program.name} changed since the local test gate`);
  }
  return { gate, target: current };
}

async function main() {
  const root = ROOT;
  let fixturesDir = path.join(root, '.cache/two-config-programs');
  let fetchOnly = false;
  let useCached = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--fixtures-dir' && args[index + 1]) fixturesDir = path.resolve(args[++index]);
    else if (args[index] === '--fetch-only') fetchOnly = true;
    else if (args[index] === '--use-cached') useCached = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  rmSync(path.join(fixturesDir, 'gate-result.json'), { force: true });
  if (!useCached) {
    const targets = [];
    for (const target of TARGETS) targets.push(await captureTarget(target, fixturesDir));
    const attestation: TwoConfigProgramAttestation = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      source: 'read-only Solana RPC',
      targets,
    };
    writeFileSync(path.join(fixturesDir, 'attestation.json'), `${JSON.stringify(attestation, null, 2)}\n`);
  }
  const attestation = verifyCachedFixtures(fixturesDir);
  console.log(`Verified binary attestation: ${path.join(fixturesDir, 'attestation.json')}`);
  if (fetchOnly) return;
  const attestationSha256 = sha256(readFileSync(path.join(fixturesDir, 'attestation.json')));
  const harnessSha256 = sha256(readFileSync(HARNESS_PATH));
  const runnerSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const result = spawnSync('cargo', [
    'test', '--manifest-path', path.join(root, 'onchain/Cargo.toml'), '--locked',
    '--features', 'sbf-tests', '--test', 'two_config_existing_programs', '--', '--nocapture',
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NO_DNA: '1', TWO_CONFIG_FIXTURES_DIR: fixturesDir },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local two-config gate failed (${result.status ?? result.signal})`);
  verifyCachedFixtures(fixturesDir);
  if (
    attestationSha256 !== sha256(readFileSync(path.join(fixturesDir, 'attestation.json'))) ||
    harnessSha256 !== sha256(readFileSync(HARNESS_PATH)) ||
    runnerSha256 !== sha256(readFileSync(fileURLToPath(import.meta.url)))
  ) throw new Error('Gate inputs changed during testing; rerun the local test gate');
  const gate: TwoConfigGateResult = {
    schemaVersion: 1,
    status: 'passed',
    testTarget: 'two_config_existing_programs',
    completedAt: new Date().toISOString(),
    attestationSha256,
    harnessSha256,
    runnerSha256,
    targets: attestation.targets,
  };
  const gatePath = path.join(fixturesDir, 'gate-result.json');
  writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
  console.log(`Both deployed-program test gates passed: ${gatePath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
