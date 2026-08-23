import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A');
const PROGRAM_DATA = new PublicKey('3rmLDxbb6AFQfAKjWMjvFF7axnXBJYBigATFdCSm9Mvv');
const CONFIG_PDA = new PublicKey('2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const COLLECTION = new PublicKey('JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const OLD_URI_BASE = 'https://assets.mons.link/drops/poncho';
const RELEASE_SHA256 = '705a938ea341c07b2469bda68f6b229bc68976202c335a17fa697b46469292fc';
const RELEASE_BYTES = 576_496;
const CONFIG_BYTES = 307;
const START_OPEN_BOX = Buffer.from('c6646bb41bf3288f', 'hex');

type DasAsset = {
  id?: string;
  burnt?: boolean;
  content?: { json_uri?: string };
  ownership?: { owner?: string };
};

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function configuredHeliusRpc(): { rpcUrl: string; rpcSource: string } {
  const processApiKey = process.env.HELIUS_API_KEY?.trim();
  if (processApiKey) return {
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(processApiKey)}`,
    rpcSource: 'HELIUS_API_KEY (process environment)',
  };
  const envPath = path.join(repositoryRoot(), '.env.local');
  if (existsSync(envPath)) {
    const contents = readFileSync(envPath, 'utf8');
    const match = contents.match(/^HELIUS_API_KEY\s*=\s*(.+?)\s*$/m);
    const fileApiKey = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (fileApiKey) return {
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(fileApiKey)}`,
      rpcSource: 'HELIUS_API_KEY (.env.local)',
    };
  }
  throw new Error('HELIUS_API_KEY is required');
}

function readString(data: Buffer, offset: number): { value: string; offset: number } {
  if (offset + 4 > data.length) throw new Error('String length exceeds account data');
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('String exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(data: Buffer): { itemsPerBox: number; uriBase: string } {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config is ${data.length} bytes, expected ${CONFIG_BYTES}`);
  let offset = 8 + 32 * 3 + 8 + 8 + 32 + 4 + 1;
  const itemsPerBox = data[offset++];
  offset += 4;
  for (let index = 0; index < 2; index += 1) offset = readString(data, offset).offset;
  return { itemsPerBox, uriBase: readString(data, offset).value };
}

function parseCoreAsset(data: Buffer): { owner: PublicKey; uri: string } {
  if (data[0] !== 1) throw new Error('Core asset discriminator mismatch');
  let offset = 1;
  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const updateAuthorityKind = data[offset++];
  if (updateAuthorityKind !== 0) offset += 32;
  offset = readString(data, offset).offset;
  return { owner, uri: readString(data, offset).value };
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result as T;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('This client is read-only and accepts no arguments');
  const { rpcUrl, rpcSource } = configuredHeliusRpc();
  const connection = new Connection(rpcUrl, 'finalized');
  const [genesis, program, programData, configAccount] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(PROGRAM_ID, 'finalized'),
    connection.getAccountInfo(PROGRAM_DATA, 'finalized'),
    connection.getAccountInfo(CONFIG_PDA, 'finalized'),
  ]);
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);
  if (!program?.executable || !program.owner.equals(UPGRADEABLE_LOADER)) throw new Error('Program account mismatch');
  if (!new PublicKey(program.data.subarray(4, 36)).equals(PROGRAM_DATA)) throw new Error('ProgramData address mismatch');
  if (!programData?.owner.equals(UPGRADEABLE_LOADER)) throw new Error('ProgramData account mismatch');
  if (programData.data.length < 45 + RELEASE_BYTES) throw new Error('ProgramData allocation is too small');
  const deployedHash = createHash('sha256').update(programData.data.subarray(45, 45 + RELEASE_BYTES)).digest('hex');
  if (deployedHash !== RELEASE_SHA256) throw new Error(`Unexpected deployed ELF hash: ${deployedHash}`);
  if (programData.data.subarray(45 + RELEASE_BYTES).some((byte) => byte !== 0)) {
    throw new Error('ProgramData contains unexpected trailing bytes');
  }
  if (!configAccount?.owner.equals(PROGRAM_ID)) throw new Error('Config account mismatch');
  const config = decodeConfig(Buffer.from(configAccount.data));
  if (config.uriBase !== OLD_URI_BASE) throw new Error(`Expected legacy config URI, found ${config.uriBase}`);

  const assets = await rpc<{ items?: DasAsset[] }>(rpcUrl, 'searchAssets', {
    grouping: ['collection', COLLECTION.toBase58()],
    page: 1,
    limit: 1000,
    options: { showUnverifiedCollections: true },
  });
  const candidates = (assets.items || []).filter((asset) =>
    !asset.burnt
    && asset.id
    && asset.ownership?.owner
    && asset.content?.json_uri?.startsWith(`${OLD_URI_BASE}/json/boxes/`));
  const failures: Array<{ asset: string; error: unknown }> = [];
  for (const candidate of candidates) {
    const assetAddress = new PublicKey(candidate.id!);
    const owner = new PublicKey(candidate.ownership!.owner!);
    const [pending] = PublicKey.findProgramAddressSync([Buffer.from('open'), assetAddress.toBuffer()], PROGRAM_ID);
    const figures = Array.from({ length: config.itemsPerBox }, (_, index) => PublicKey.findProgramAddressSync(
      [Buffer.from('pdude'), pending.toBuffer(), Buffer.from([index])],
      PROGRAM_ID,
    )[0]);
    const accounts = await connection.getMultipleAccountsInfo([assetAddress, owner, pending, ...figures], 'finalized');
    const [assetAccount, ownerAccount, pendingAccount, ...figureAccounts] = accounts;
    if (!assetAccount?.owner.equals(MPL_CORE) || !ownerAccount?.owner.equals(SystemProgram.programId)) continue;
    if (ownerAccount.data.length !== 0 || ownerAccount.lamports < 10_000_000 || pendingAccount || figureAccounts.some(Boolean)) continue;
    const core = parseCoreAsset(Buffer.from(assetAccount.data));
    if (!core.owner.equals(owner) || core.uri !== candidate.content!.json_uri) continue;
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: assetAddress, isSigner: false, isWritable: true },
        { pubkey: ADMIN, isSigner: false, isWritable: false },
        { pubkey: COLLECTION, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        ...figures.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: START_OPEN_BOX,
    });
    const { blockhash } = await connection.getLatestBlockhash('finalized');
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
    }).compileToV0Message();
    const simulation = await connection.simulateTransaction(new VersionedTransaction(message), {
      commitment: 'processed',
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    if (simulation.value.err) {
      failures.push({ asset: assetAddress.toBase58(), error: simulation.value.err });
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      mode: 'read-only mainnet simulation',
      rpcCredential: rpcSource,
      programId: PROGRAM_ID.toBase58(),
      programDataSlot: Number(programData.data.readBigUInt64LE(4)),
      deployedSha256: deployedHash,
      configUri: config.uriBase,
      asset: assetAddress.toBase58(),
      owner: owner.toBase58(),
      assetUri: core.uri,
      pending: pending.toBase58(),
      figures: figures.map((figure) => figure.toBase58()),
      unitsConsumed: simulation.value.unitsConsumed,
      committed: false,
    }, null, 2)}\n`);
    return;
  }
  throw new Error(`No old-root unopened box simulated successfully: ${JSON.stringify(failures.slice(0, 5))}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
