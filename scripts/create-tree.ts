import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createAllocTreeIx,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  ValidDepthSizePair,
} from '@solana/spl-account-compression';
import { PROGRAM_ID as BUBBLEGUM_PROGRAM_ID, createCreateTreeInstruction } from '@metaplex-foundation/mpl-bubblegum';
import bs58 from 'bs58';

function getArg(flag: string, fallback = ''): string {
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
  const depth = parseInt(getArg('--depth', process.env.TREE_DEPTH || '14'), 10);
  const bufferSize = parseInt(getArg('--buffer', process.env.TREE_BUFFER_SIZE || '64'), 10);
  const canopy = parseInt(getArg('--canopy', process.env.TREE_CANOPY || '0'), 10);
  const cluster = getArg('--cluster', process.env.TREE_CLUSTER || 'devnet');
  const rpc = getArg('--rpc', process.env.TREE_RPC || clusterApiUrl(cluster as any));
  const keypairPath = getArg('--keypair', process.env.TREE_KEYPAIR || `${homedir()}/.config/solana/id.json`);

  const payer = loadKeypair(keypairPath);
  const tree = Keypair.generate();
  const connection = new Connection(rpc, { commitment: 'confirmed' });

  const balance = await connection.getBalance(payer.publicKey);
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.warn('⚠️  Low balance on payer; fund it before running.');
  }

  const depthSize: ValidDepthSizePair = { maxDepth: depth, maxBufferSize: bufferSize } as ValidDepthSizePair;
  const allocIx = await createAllocTreeIx(connection, tree.publicKey, payer.publicKey, depthSize, canopy);
  const [treeAuthorityPda] = PublicKey.findProgramAddressSync([tree.publicKey.toBuffer()], BUBBLEGUM_PROGRAM_ID);
  const createTreeIx = createCreateTreeInstruction(
    {
      treeAuthority: treeAuthorityPda,
      merkleTree: tree.publicKey,
      payer: payer.publicKey,
      treeCreator: payer.publicKey,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    },
    { maxDepth: depth, maxBufferSize: bufferSize, public: null },
  );

  // Allocate the Merkle tree account (system + compression program), then initialize Bubblegum TreeConfig (PDA).
  const tx = new Transaction().add(allocIx, createTreeIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.partialSign(tree);

  // Tree account is also a signer; include it so the transaction is fully signed.
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, tree], { commitment: 'confirmed' });

  console.log('✅ Tree created');
  console.log('  Signature:', sig);
  console.log('  Merkle tree address:', tree.publicKey.toBase58());
  console.log('  Bubblegum tree authority (TreeConfig PDA):', treeAuthorityPda.toBase58());
  console.log('  Tree delegate (payer) pubkey:', payer.publicKey.toBase58());
  console.log('');
  console.log('--- env for functions ---');
  console.log(`MERKLE_TREE=${tree.publicKey.toBase58()}`);
  console.log(`TREE_AUTHORITY_SECRET=${bs58.encode(payer.secretKey)}`);
  console.log('');
  console.log('⚠️  IMPORTANT: The payer keypair used here must be the SAME keypair');
  console.log('   used as update authority when creating the collection NFT.');
  console.log('   Run create-collection.ts with the same --keypair to ensure this.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
