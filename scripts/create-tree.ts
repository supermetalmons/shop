import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createAllocTreeIx,
  createInitEmptyMerkleTreeIx,
  ValidDepthSizePair,
} from '@solana/spl-account-compression';
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
  const initIx = createInitEmptyMerkleTreeIx(tree.publicKey, payer.publicKey, depthSize);

  const tx = new Transaction().add(allocIx, initIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.partialSign(tree);

  // Tree account is also a signer; include it so the transaction is fully signed.
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, tree], { commitment: 'confirmed' });

  console.log('✅ Tree created');
  console.log('  Signature:', sig);
  console.log('  Merkle tree address:', tree.publicKey.toBase58());
  console.log('  Tree keypair (base58, keep only if you really need it):', bs58.encode(tree.secretKey));
  console.log('  Tree authority (payer) pubkey:', payer.publicKey.toBase58());
  console.log('--- env for functions ---');
  console.log(`MERKLE_TREE=${tree.publicKey.toBase58()}`);
  console.log(`TREE_AUTHORITY_SECRET=${bs58.encode(payer.secretKey)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
