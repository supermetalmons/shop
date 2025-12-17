import { readFileSync } from 'fs';
import { homedir } from 'os';
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
import { PROGRAM_ID as BUBBLEGUM_PROGRAM_ID } from '@metaplex-foundation/mpl-bubblegum';
import {
  createAllocTreeIx,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
} from '@solana/spl-account-compression';
import type { ValidDepthSizePair } from '@solana/spl-account-compression';
import { createCreateTreeInstruction } from '@metaplex-foundation/mpl-bubblegum';

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

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, 'utf8').trim();
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

async function main() {
  const cluster = (getArg('--cluster', process.env.SOLANA_CLUSTER || 'devnet') || 'devnet').toLowerCase();
  const rpc = getArg('--rpc', process.env.SOLANA_RPC_URL || clusterApiUrl(cluster as any));
  const keypairPath = getArg('--keypair', process.env.SOLANA_KEYPAIR || `${homedir()}/.config/solana/id.json`);

  const programIdStr = getArg('--program-id', process.env.BOX_MINTER_PROGRAM_ID || process.env.VITE_BOX_MINTER_PROGRAM_ID);
  const programId = new PublicKey(requireArg('--program-id', programIdStr));

  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpc!, { commitment: 'confirmed' });

  const treasuryStr = getArg('--treasury', process.env.BOX_MINTER_TREASURY || payer.publicKey.toBase58());
  const treasury = new PublicKey(treasuryStr!);
  const priceSol = Number(getArg('--price-sol', process.env.BOX_PRICE_SOL || '0.001'));
  const priceLamports = BigInt(Math.round(priceSol * LAMPORTS_PER_SOL));
  const maxSupply = Number(getArg('--max-supply', process.env.TOTAL_SUPPLY || '333'));
  const maxPerTx = Number(getArg('--max-per-tx', process.env.BOX_MAX_PER_TX || '15'));

  // Keep box metadata tiny to reduce compute when minting 30 in one go.
  const namePrefix = getArg('--name-prefix', process.env.BOX_NAME_PREFIX || 'b')!;
  const symbol = getArg('--symbol', process.env.BOX_SYMBOL || 'B')!;
  const uriBase = getArg('--uri-base', process.env.BOX_URI_BASE || 'b')!;

  const collectionName = getArg('--collection-name', process.env.COLLECTION_NAME || 'little swag figures')!;
  const collectionSymbol = getArg('--collection-symbol', process.env.COLLECTION_SYMBOL || 'LSF')!;
  const collectionSize = Number(getArg('--collection-size', process.env.COLLECTION_SIZE || String(maxSupply)));
  const collectionUri = getArg('--collection-uri', process.env.COLLECTION_URI || 'collection.json')!;

  const depth = Number(getArg('--tree-depth', process.env.TREE_DEPTH || '14'));
  const bufferSize = Number(getArg('--tree-buffer', process.env.TREE_BUFFER_SIZE || '64'));
  const canopy = Number(getArg('--tree-canopy', process.env.TREE_CANOPY || '0'));

  console.log('--- deploy box minter ---');
  console.log('cluster:', cluster);
  console.log('rpc    :', rpc);
  console.log('payer  :', payer.publicKey.toBase58());
  console.log('program:', programId.toBase58());

  // 1) Create collection NFT (1/1 master edition).
  console.log('\n[1/3] Creating collection NFT…');
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
            name: collectionName,
            symbol: collectionSymbol,
            uri: collectionUri,
            sellerFeeBasisPoints: 0,
            creators: [{ address: payer.publicKey, verified: true, share: 100 }],
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: { __kind: 'V1', size: collectionSize },
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

  // 2) Create Merkle tree for compressed mints.
  console.log('\n[2/3] Creating Merkle tree…');
  const tree = Keypair.generate();
  const depthSize: ValidDepthSizePair = { maxDepth: depth, maxBufferSize: bufferSize } as ValidDepthSizePair;
  const allocIx = await createAllocTreeIx(connection, tree.publicKey, payer.publicKey, depthSize, canopy);
  const [treeConfigPda] = PublicKey.findProgramAddressSync([tree.publicKey.toBuffer()], BUBBLEGUM_PROGRAM_ID);
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
    { maxDepth: depth, maxBufferSize: bufferSize, public: null },
  );
  const createTreeTx = new Transaction().add(allocIx, createTreeIx);
  createTreeTx.feePayer = payer.publicKey;
  createTreeTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  createTreeTx.partialSign(tree);
  const treeSig = await sendAndConfirmTransaction(connection, createTreeTx, [payer, tree], { commitment: 'confirmed' });
  console.log('✅ Tree created:', treeSig);
  console.log('  Merkle tree:', tree.publicKey.toBase58());
  console.log('  TreeConfig PDA:', treeConfigPda.toBase58());

  // 3) Initialize box minter config + approve collection authority + set tree delegate.
  console.log('\n[3/3] Initializing box minter + delegation…');
  const configPda = boxMinterConfigPda(programId);
  const bubblegumSigner = bubblegumCollectionSignerPda();
  const bubblegumSignerRecord = collectionAuthorityRecordPda(mint.publicKey, bubblegumSigner);
  const programAuthorityRecord = collectionAuthorityRecordPda(mint.publicKey, configPda);

  const initIx = buildInitializeIx({
    programId,
    admin: payer.publicKey,
    treasury,
    merkleTree: tree.publicKey,
    collectionMint: mint.publicKey,
    collectionMetadata: metadataPda,
    collectionMasterEdition: masterEditionPda,
    priceLamports,
    maxSupply,
    maxPerTx,
    namePrefix,
    symbol,
    uriBase,
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
    treeConfig: bubblegumTreeConfigPda(tree.publicKey),
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
  console.log(`VITE_BOX_MINTER_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`VITE_COLLECTION_MINT=${mint.publicKey.toBase58()}`);
  console.log(`VITE_MERKLE_TREE=${tree.publicKey.toBase58()}`);
  console.log('');
  console.log('NOTE: Keep using your Helius API key on the client (VITE_HELIUS_API_KEY).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


