import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import bs58 from 'bs58';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createApproveCollectionAuthorityInstruction,
  createCreateMasterEditionV3Instruction,
  createCreateMetadataAccountV3Instruction,
} from '@metaplex-foundation/mpl-token-metadata';
import { PROGRAM_ID as BUBBLEGUM_PROGRAM_ID, createCreateTreeInstruction } from '@metaplex-foundation/mpl-bubblegum';
import {
  createAllocTreeIx,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
} from '@solana/spl-account-compression';
import type { ValidDepthSizePair } from '@solana/spl-account-compression';

/**
 * Minimal argv flag parser.
 * Supports: `--flag value` (no `--flag=value` parsing).
 */
function getArg(flag: string, fallback?: string) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function requireArg(flag: string, value?: string): string {
  const v = (value || '').trim();
  if (!v) {
    console.error(`Missing required arg: ${flag}`);
    process.exit(1);
  }
  return v;
}

function resolveHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function loadKeypair(keypairPath: string): Keypair {
  const raw = readFileSync(keypairPath, 'utf8').trim();
  try {
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function readBorshString(buf: Buffer, offset: number): { value: string; offset: number } {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: buf.subarray(start, end).toString('utf8'), offset: end };
}

function decodeBoxMinterConfig(data: Buffer) {
  // Anchor account discriminator is the first 8 bytes.
  let o = 8;
  const admin = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const merkleTree = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const collectionMint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const collectionMetadata = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const collectionMasterEdition = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const priceLamports = data.readBigUInt64LE(o);
  o += 8;
  const maxSupply = data.readUInt32LE(o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const minted = data.readUInt32LE(o);
  o += 4;
  const namePrefix = readBorshString(data, o);
  o = namePrefix.offset;
  const symbol = readBorshString(data, o);
  o = symbol.offset;
  const uriBase = readBorshString(data, o);
  o = uriBase.offset;
  const bump = data[o];

  return {
    admin,
    treasury,
    merkleTree,
    collectionMint,
    collectionMetadata,
    collectionMasterEdition,
    priceLamports,
    maxSupply,
    maxPerTx,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
  };
}

function boxMinterConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

function bubblegumTreeConfigPda(tree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function bubblegumCollectionSignerPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], BUBBLEGUM_PROGRAM_ID)[0];
}

function collectionAuthorityRecordPda(collectionMint: PublicKey, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      collectionMint.toBuffer(),
      Buffer.from('collection_authority'),
      authority.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Anchor instruction discriminator: sha256("global:initialize")[0..8]
const IX_INITIALIZE = Buffer.from('afaf6d1f0d989bed', 'hex');

function buildInitializeIx(args: {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  merkleTree: PublicKey;
  collectionMint: PublicKey;
  collectionMetadata: PublicKey;
  collectionMasterEdition: PublicKey;
  priceLamports: bigint;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
}): TransactionInstruction {
  const configPda = boxMinterConfigPda(args.programId);
  const data = Buffer.concat([
    IX_INITIALIZE,
    u64LE(args.priceLamports),
    u32LE(args.maxSupply),
    Buffer.from([args.maxPerTx & 0xff]),
    borshString(args.namePrefix),
    borshString(args.symbol),
    borshString(args.uriBase),
  ]);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: false },
      { pubkey: args.merkleTree, isSigner: false, isWritable: false },
      { pubkey: args.collectionMint, isSigner: false, isWritable: false },
      { pubkey: args.collectionMetadata, isSigner: false, isWritable: false },
      { pubkey: args.collectionMasterEdition, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Bubblegum discriminator (from mpl-bubblegum 2.1.1): [253,118,66,37,190,49,154,102]
const IX_SET_TREE_DELEGATE = Buffer.from([253, 118, 66, 37, 190, 49, 154, 102]);

function buildSetTreeDelegateIx(args: {
  treeConfig: PublicKey;
  treeCreator: PublicKey;
  newTreeDelegate: PublicKey;
  merkleTree: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: args.treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.treeCreator, isSigner: true, isWritable: false },
      { pubkey: args.newTreeDelegate, isSigner: false, isWritable: false },
      { pubkey: args.merkleTree, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_SET_TREE_DELEGATE,
  });
}

function canRunSolanaCargo(): boolean {
  // Anchor uses the rustup toolchain directive `cargo +solana ...`.
  // If we have that toolchain, we can generate a v3 Cargo.lock that's compatible
  // with Solana's older Rust toolchain (1.72.x).
  const res = spawnSync('cargo', ['+solana', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
  return res.status === 0;
}

function readSolanaActiveReleaseBinDir(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const configPath = path.join(home, '.config', 'solana', 'install', 'config.yml');
  if (existsSync(configPath)) {
    const cfg = readFileSync(configPath, 'utf8');
    const match = cfg.match(/^\s*active_release_dir:\s*(.+)\s*$/m);
    if (match?.[1]) {
      return path.join(match[1].trim(), 'bin');
    }
  }
  // Default install location for both legacy solana-install and agave-install.
  return path.join(home, '.local', 'share', 'solana', 'install', 'active_release', 'bin');
}

function ensureAnchorCompatibleCargoLock(onchainDir: string) {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;

  const head = readFileSync(lockPath, 'utf8').slice(0, 4096);
  const match = head.match(/^\s*version\s*=\s*(\d+)\s*$/m);
  const version = match?.[1] ? Number(match[1]) : undefined;
  if (!version || Number.isNaN(version)) return false;

  // Solana/Anchor toolchains often bundle an older Cargo that can't parse lockfile v4
  // ("lock file version 4 requires -Znext-lockfile-bump"). If we detect that, move it
  // aside so `anchor build` can regenerate a compatible lockfile.
  if (version >= 4) {
    const backupPath = path.join(onchainDir, `Cargo.lock.v${version}.bak`);
    console.warn(
      `⚠️  Detected on-chain Cargo.lock version ${version} (incompatible with the Solana/Anchor toolchain cargo).\n` +
        `   Renaming it to ${backupPath} so Anchor can regenerate a compatible lockfile...`,
    );
    try {
      renameSync(lockPath, backupPath);
    } catch {
      const fallback = path.join(onchainDir, `Cargo.lock.bak.${Date.now()}`);
      renameSync(lockPath, fallback);
    }
    return true;
  }
  return false;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function readProgramId(onchainDir: string): string {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(/declare_id!\(\"([1-9A-HJ-NP-Za-km-z]{32,44})\"\)/);
  if (!match?.[1]) {
    throw new Error(`Could not find declare_id!(\"...\") in ${libPath}`);
  }
  return match[1];
}

function generateFreshProgramKeypair(programKeypairPath: string): { programId: string; backupPath?: string } {
  mkdirSync(path.dirname(programKeypairPath), { recursive: true });

  let backupPath: string | undefined;
  if (existsSync(programKeypairPath)) {
    // Keep a copy so you can still upgrade older deployments if needed.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = programKeypairPath.replace(/\.json$/i, `.${ts}.bak.json`);
    try {
      renameSync(programKeypairPath, backupPath);
    } catch {
      // Fallback: best-effort unique name.
      backupPath = programKeypairPath.replace(/\.json$/i, `.bak.${Date.now()}.json`);
      renameSync(programKeypairPath, backupPath);
    }
  }

  const kp = Keypair.generate();
  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600 });
  return { programId: kp.publicKey.toBase58(), backupPath };
}

function cargoLockHasPackage(onchainDir: string, name: string, version: string): boolean {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;
  const content = readFileSync(lockPath, 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${name}"\\s*\\nversion = "${version}"`, 'm');
  return re.test(content);
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const programKeypairArg = getArg('--program-keypair');
  const programKeypair = programKeypairArg
    ? path.resolve(resolveHome(programKeypairArg))
    : path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');

  // We intentionally do NOT read env vars for deployment config.
  // Keep this script deterministic: edit constants below to change metadata/supply/price.
  const cluster = (getArg('--cluster', 'devnet') || 'devnet').toLowerCase();
  const rpc = getArg('--rpc');
  const keypairPath = path.resolve(resolveHome(requireArg('--keypair', getArg('--keypair'))));
  const solanaUrl = rpc || cluster;
  const solanaBinDir = readSolanaActiveReleaseBinDir();
  const toolEnv = solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : undefined;

  console.log('--- deploy ALL (program + collection + tree + delegation) ---');
  console.log('cluster:', cluster);
  if (rpc) console.log('rpc    :', rpc);
  if (keypairPath) console.log('keypair:', keypairPath);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  const reuseProgramId = process.argv.includes('--reuse-program-id') || process.argv.includes('--reuse-program-keypair');
  let expectedProgramId: string | undefined;
  if (reuseProgramId) {
    if (!existsSync(programKeypair)) {
      throw new Error(
        `Missing program keypair: ${programKeypair}\n` +
          `Either create it first, or omit --reuse-program-id to auto-generate a fresh program id.\n` +
          `Generate it with:\n` +
          `  solana-keygen new --no-bip39-passphrase -o ${programKeypair}\n`,
      );
    }
    console.log('Reusing existing program keypair:', programKeypair);
  } else {
    const { programId, backupPath } = generateFreshProgramKeypair(programKeypair);
    expectedProgramId = programId;
    console.log('Generated fresh program id:', programId);
    console.log('Program keypair:', programKeypair);
    if (backupPath) console.log('Backed up previous program keypair to:', backupPath);
  }

  const hasSolanaCargo = canRunSolanaCargo();
  if (hasSolanaCargo) {
    console.log('solana cargo toolchain:', 'cargo +solana');
  } else {
    console.warn('⚠️  Missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if your Cargo.lock is too new.');
  }

  // 1) Build + deploy program via Anchor.
  run('anchor', ['keys', 'sync'], { cwd: onchainDir, env: toolEnv });
  if (expectedProgramId) {
    const synced = readProgramId(onchainDir);
    if (synced !== expectedProgramId) {
      throw new Error(
        `Program id sync mismatch.\n` +
          `Expected: ${expectedProgramId}\n` +
          `Synced  : ${synced}\n` +
          `\n` +
          `This usually means 'anchor keys sync' did not update the program source/Anchor.toml.\n` +
          `Try running it manually in ${onchainDir} and re-run this script.`,
      );
    }
  }

  // Ensure Cargo.lock is compatible with the Solana toolchain (cargo 1.72.x).
  const lockMoved = ensureAnchorCompatibleCargoLock(onchainDir);

  // Only (re)generate a lockfile if it's missing (fresh clone) or if we moved aside an incompatible v4 lockfile.
  // If a compatible Cargo.lock already exists, keep it as-is so dependency versions remain pinned.
  if (hasSolanaCargo && (lockMoved || !existsSync(path.join(onchainDir, 'Cargo.lock')))) {
    run('cargo', ['+solana', 'generate-lockfile'], { cwd: onchainDir });

    // Cargo can pick newer crates that exceed Solana's pinned Rust toolchain MSRV.
    // In particular, borsh 1.6.x requires rustc >= 1.77; pin borsh to 1.5.5 if needed.
    if (cargoLockHasPackage(onchainDir, 'borsh', '1.6.0')) {
      run('cargo', ['+solana', 'update', '-p', 'borsh@1.6.0', '--precise', '1.5.5'], { cwd: onchainDir });
    }
  }

  run('anchor', ['build', '--arch', 'sbf'], { cwd: onchainDir, env: toolEnv });
  if (!existsSync(programBinary)) {
    throw new Error(`Missing program binary after build: ${programBinary}`);
  }

  // Deploy program via Solana CLI (Agave). This avoids `anchor deploy` rebuilding with the wrong arch/tooling.
  const deployArgs = ['program', 'deploy', programBinary, '--program-id', programKeypair, '--url', solanaUrl];
  if (keypairPath) deployArgs.push('--keypair', keypairPath);
  run('solana', deployArgs, { cwd: onchainDir, env: toolEnv });

  const programId = readProgramId(onchainDir);
  console.log('\nProgram deployed:', programId);

  // 2) Deploy on-chain prerequisites + initialize config PDA.
  // ---------------------------------------------------------------------------
  // EDIT THESE CONSTANTS to control drop metadata. No ENV/CLI overrides.
  const DROP_METADATA_BASE = 'https://assets.mons.link/shop/drops/1';
  const BOX_MINTER_CONFIG = {
    // Payment + mint caps
    treasury: undefined, // defaults to payer
    priceSol: 0.001,
    maxSupply: 333,
    maxPerTx: 15,

    // Box metadata (stored on-chain)
    namePrefix: 'swag box',
    symbol: 'box',
    // Base URI for per-box JSON: `${uriBase}${index}.json`
    // (Your on-chain program can also accept a full *.json uri for a single shared metadata file.)
    uriBase: `${DROP_METADATA_BASE}/json/boxes/`,

    // Collection NFT metadata (1/1 master edition)
    collectionName: 'little swag figures',
    collectionSymbol: 'LSF',
    collectionUri: `${DROP_METADATA_BASE}/collection.json`,

    // Merkle tree params (compressed mints)
    treeDepth: 14,
    treeBufferSize: 64,
    treeCanopy: 0,
  };
  // ---------------------------------------------------------------------------

  const connection = new Connection(rpc || clusterApiUrl(cluster as any), { commitment: 'confirmed' });
  const payer = loadKeypair(keypairPath);
  const programPk = new PublicKey(programId);
  const configPda = boxMinterConfigPda(programPk);

  const existingCfg = await connection.getAccountInfo(configPda, { commitment: 'confirmed' });
  if (existingCfg) {
    const cfg = decodeBoxMinterConfig(existingCfg.data);
    console.log('\nConfig PDA already exists (skipping collection/tree/init):', configPda.toBase58());
    console.log(
      `Minted: ${cfg.minted}/${cfg.maxSupply} · price(lamports): ${cfg.priceLamports.toString()} · max/tx: ${cfg.maxPerTx}`,
    );
    if (!payer.publicKey.equals(cfg.admin)) {
      console.warn(`⚠️  Deployer keypair pubkey: ${payer.publicKey.toBase58()}`);
      console.warn(`    On-chain admin pubkey : ${cfg.admin.toBase58()}`);
      console.warn('    (That is fine for reading config, but secrets below won’t be printed.)');
    }
    console.log('');
    console.log('--- env for frontend ---');
    console.log(`VITE_SOLANA_CLUSTER=${cluster}`);
    console.log(`VITE_BOX_MINTER_PROGRAM_ID=${programPk.toBase58()}`);
    console.log(`VITE_COLLECTION_MINT=${cfg.collectionMint.toBase58()}`);
    console.log(`VITE_MERKLE_TREE=${cfg.merkleTree.toBase58()}`);
    console.log('');
    console.log('--- env for functions ---');
    console.log(`MERKLE_TREE=${cfg.merkleTree.toBase58()}`);
    console.log(`COLLECTION_MINT=${cfg.collectionMint.toBase58()}`);
    console.log(`COLLECTION_METADATA=${cfg.collectionMetadata.toBase58()}`);
    console.log(`COLLECTION_MASTER_EDITION=${cfg.collectionMasterEdition.toBase58()}`);
    console.log(`COLLECTION_UPDATE_AUTHORITY=${cfg.admin.toBase58()}`);
    if (payer.publicKey.equals(cfg.admin)) {
      console.log('# Sensitive: keep this secret offline/backed up securely.');
      console.log(`TREE_AUTHORITY_SECRET=${bs58.encode(payer.secretKey)}`);
    } else {
      console.log('# TREE_AUTHORITY_SECRET not printed because --keypair != on-chain admin.');
    }
    console.log('');
    return;
  }

  const treasury = new PublicKey(BOX_MINTER_CONFIG.treasury || payer.publicKey.toBase58());
  const priceLamports = BigInt(Math.round(Number(BOX_MINTER_CONFIG.priceSol) * LAMPORTS_PER_SOL));
  const maxSupply = Number(BOX_MINTER_CONFIG.maxSupply);
  const maxPerTx = Number(BOX_MINTER_CONFIG.maxPerTx);

  console.log('\n[2/4] Creating collection NFT…');
  const mint = Keypair.generate();
  const metadataPda = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  const masterEditionPda = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer(), Buffer.from('edition')],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  const ata = await getAssociatedTokenAddress(mint.publicKey, payer.publicKey);

  const createCollectionTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, payer.publicKey),
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, ata, payer.publicKey, 1),
    createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPda,
        mint: mint.publicKey,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        updateAuthority: payer.publicKey,
      },
      {
        createMetadataAccountArgsV3: {
          data: {
            name: BOX_MINTER_CONFIG.collectionName,
            symbol: BOX_MINTER_CONFIG.collectionSymbol,
            uri: BOX_MINTER_CONFIG.collectionUri,
            sellerFeeBasisPoints: 0,
            creators: [{ address: payer.publicKey, verified: true, share: 100 }],
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: { __kind: 'V1', size: maxSupply },
        },
      },
    ),
    createCreateMasterEditionV3Instruction(
      {
        edition: masterEditionPda,
        mint: mint.publicKey,
        updateAuthority: payer.publicKey,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        metadata: metadataPda,
      },
      { createMasterEditionArgs: { maxSupply: 0 } },
    ),
  );
  createCollectionTx.feePayer = payer.publicKey;
  createCollectionTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  createCollectionTx.sign(payer, mint);
  const collectionSig = await sendAndConfirmTransaction(connection, createCollectionTx, [payer, mint], { commitment: 'confirmed' });
  console.log('✅ Collection created:', collectionSig);
  console.log('  Collection mint:', mint.publicKey.toBase58());

  console.log('\n[3/4] Creating Merkle tree…');
  const tree = Keypair.generate();
  const depthSize: ValidDepthSizePair = {
    maxDepth: Number(BOX_MINTER_CONFIG.treeDepth),
    maxBufferSize: Number(BOX_MINTER_CONFIG.treeBufferSize),
  } as ValidDepthSizePair;
  const allocIx = await createAllocTreeIx(connection, tree.publicKey, payer.publicKey, depthSize, Number(BOX_MINTER_CONFIG.treeCanopy));
  const treeConfigPda = bubblegumTreeConfigPda(tree.publicKey);
  const createTreeIx = createCreateTreeInstruction(
    {
      treeAuthority: treeConfigPda,
      merkleTree: tree.publicKey,
      payer: payer.publicKey,
      treeCreator: payer.publicKey,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    },
    { maxDepth: depthSize.maxDepth, maxBufferSize: depthSize.maxBufferSize, public: null },
  );
  const createTreeTx = new Transaction().add(allocIx, createTreeIx);
  createTreeTx.feePayer = payer.publicKey;
  createTreeTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  createTreeTx.partialSign(tree);
  const treeSig = await sendAndConfirmTransaction(connection, createTreeTx, [payer, tree], { commitment: 'confirmed' });
  console.log('✅ Tree created:', treeSig);
  console.log('  Merkle tree:', tree.publicKey.toBase58());
  console.log('  TreeConfig PDA:', treeConfigPda.toBase58());

  console.log('\n[4/4] Initializing box minter + delegation…');
  const bubblegumSigner = bubblegumCollectionSignerPda();
  const bubblegumSignerRecord = collectionAuthorityRecordPda(mint.publicKey, bubblegumSigner);
  const programAuthorityRecord = collectionAuthorityRecordPda(mint.publicKey, configPda);

  const initIx = buildInitializeIx({
    programId: programPk,
    admin: payer.publicKey,
    treasury,
    merkleTree: tree.publicKey,
    collectionMint: mint.publicKey,
    collectionMetadata: metadataPda,
    collectionMasterEdition: masterEditionPda,
    priceLamports,
    maxSupply,
    maxPerTx,
    namePrefix: BOX_MINTER_CONFIG.namePrefix,
    symbol: BOX_MINTER_CONFIG.symbol,
    uriBase: BOX_MINTER_CONFIG.uriBase,
  });

  const approveBubblegumSignerIx = createApproveCollectionAuthorityInstruction({
    collectionAuthorityRecord: bubblegumSignerRecord,
    newCollectionAuthority: bubblegumSigner,
    updateAuthority: payer.publicKey,
    payer: payer.publicKey,
    metadata: metadataPda,
    mint: mint.publicKey,
    systemProgram: SystemProgram.programId,
  });

  const approveProgramAuthorityIx = createApproveCollectionAuthorityInstruction({
    collectionAuthorityRecord: programAuthorityRecord,
    newCollectionAuthority: configPda,
    updateAuthority: payer.publicKey,
    payer: payer.publicKey,
    metadata: metadataPda,
    mint: mint.publicKey,
    systemProgram: SystemProgram.programId,
  });

  const setDelegateIx = buildSetTreeDelegateIx({
    treeConfig: treeConfigPda,
    treeCreator: payer.publicKey,
    newTreeDelegate: configPda,
    merkleTree: tree.publicKey,
  });

  const setupTx = new Transaction().add(initIx, approveBubblegumSignerIx, approveProgramAuthorityIx, setDelegateIx);
  setupTx.feePayer = payer.publicKey;
  setupTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const setupSig = await sendAndConfirmTransaction(connection, setupTx, [payer], { commitment: 'confirmed' });
  console.log('✅ Box minter configured:', setupSig);
  console.log('  Config PDA:', configPda.toBase58());
  console.log('  Treasury:', treasury.toBase58());
  console.log('  Price (lamports):', priceLamports.toString());
  console.log('');

  console.log('--- env for frontend ---');
  console.log(`VITE_SOLANA_CLUSTER=${cluster}`);
  console.log(`VITE_BOX_MINTER_PROGRAM_ID=${programPk.toBase58()}`);
  console.log(`VITE_COLLECTION_MINT=${mint.publicKey.toBase58()}`);
  console.log(`VITE_MERKLE_TREE=${tree.publicKey.toBase58()}`);
  console.log('');
  console.log('--- env for functions ---');
  console.log(`MERKLE_TREE=${tree.publicKey.toBase58()}`);
  console.log(`COLLECTION_MINT=${mint.publicKey.toBase58()}`);
  console.log(`COLLECTION_METADATA=${metadataPda.toBase58()}`);
  console.log(`COLLECTION_MASTER_EDITION=${masterEditionPda.toBase58()}`);
  console.log(`COLLECTION_UPDATE_AUTHORITY=${payer.publicKey.toBase58()}`);
  console.log('# Sensitive: keep this secret offline/backed up securely.');
  console.log(`TREE_AUTHORITY_SECRET=${bs58.encode(payer.secretKey)}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


