import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
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
import bs58 from 'bs58';

function getArg(flag: string, fallback?: string) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, 'utf8').trim();
  try {
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (err) {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}

async function main() {
  const cluster = getArg('--cluster', process.env.SOLANA_CLUSTER || 'devnet');
  const rpc = getArg('--rpc', process.env.SOLANA_RPC_URL || clusterApiUrl(cluster as any));
  const keypairPath = getArg('--keypair', `${homedir()}/.config/solana/id.json`);
  const name = getArg('--name', process.env.COLLECTION_NAME || 'mons collection');
  const symbol = getArg('--symbol', process.env.COLLECTION_SYMBOL || 'MONS');
  const defaultMetadataBase = 'https://assets.mons.link/shop/drops/1';
  const metadataBase = (process.env.METADATA_BASE || defaultMetadataBase).replace(/\/$/, '');
  const uri = getArg('--uri', `${metadataBase}/collection.json`);
  const collectionSize = parseInt(getArg('--collection-size', process.env.COLLECTION_SIZE || '10000'), 10);

  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpc, { commitment: 'confirmed' });
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.warn('⚠️  Low balance on payer; fund it before running.');
  }

  const mint = Keypair.generate();
  const metadataPda = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  const masterEditionPda = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer(), Buffer.from('edition')],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  const bubblegumSigner = PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], BUBBLEGUM_PROGRAM_ID)[0];
  const bubblegumCollectionAuthorityRecordPda = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer(),
      Buffer.from('collection_authority'),
      bubblegumSigner.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  // Bubblegum's MintToCollectionV1 requires `collectionAuthority` to be a real signer.
  // We pre-build transactions in Cloud Functions, so we approve the same payer/update-authority keypair
  // as a delegated collection authority too (this creates the record PDA Bubblegum expects).
  const payerCollectionAuthorityRecordPda = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer(),
      Buffer.from('collection_authority'),
      payer.publicKey.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
  const ata = await getAssociatedTokenAddress(mint.publicKey, payer.publicKey);

  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  const tx = new Transaction().add(
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
            name,
            symbol,
            uri,
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
    createApproveCollectionAuthorityInstruction({
      collectionAuthorityRecord: bubblegumCollectionAuthorityRecordPda,
      newCollectionAuthority: bubblegumSigner,
      updateAuthority: payer.publicKey,
      payer: payer.publicKey,
      metadata: metadataPda,
      mint: mint.publicKey,
      systemProgram: SystemProgram.programId,
    }),
    createApproveCollectionAuthorityInstruction({
      collectionAuthorityRecord: payerCollectionAuthorityRecordPda,
      newCollectionAuthority: payer.publicKey,
      updateAuthority: payer.publicKey,
      payer: payer.publicKey,
      metadata: metadataPda,
      mint: mint.publicKey,
      systemProgram: SystemProgram.programId,
    }),
  );

  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(mint, payer);

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: 'confirmed' });

  console.log('✅ Collection NFT minted');
  console.log('  Signature:', sig);
  console.log('  Mint:', mint.publicKey.toBase58());
  console.log('  Metadata PDA:', metadataPda.toBase58());
  console.log('  Master edition PDA:', masterEditionPda.toBase58());
  console.log('  Update authority:', payer.publicKey.toBase58());
  console.log('  Bubblegum collection_cpi signer:', bubblegumSigner.toBase58());
  console.log('  Collection authority record (for bubblegum signer):', bubblegumCollectionAuthorityRecordPda.toBase58());
  console.log('  Collection authority record (for payer signer):', payerCollectionAuthorityRecordPda.toBase58());
  console.log('--- env for functions ---');
  console.log(`COLLECTION_MINT=${mint.publicKey.toBase58()}`);
  console.log(`COLLECTION_METADATA=${metadataPda.toBase58()}`);
  console.log(`COLLECTION_MASTER_EDITION=${masterEditionPda.toBase58()}`);
  console.log(`COLLECTION_UPDATE_AUTHORITY=${payer.publicKey.toBase58()}`);
  console.log(`COLLECTION_UPDATE_AUTHORITY_SECRET=${bs58.encode(payer.secretKey)}`);
  console.log('Note: COLLECTION_UPDATE_AUTHORITY_SECRET is sensitive; store it only in functions env/secrets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
