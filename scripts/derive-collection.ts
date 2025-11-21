import { PublicKey } from '@solana/web3.js';

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function pda(seeds: (Buffer | Uint8Array)[]): string {
  return PublicKey.findProgramAddressSync(seeds, TOKEN_METADATA_PROGRAM_ID)[0].toBase58();
}

function main() {
  const mintArg = process.argv.find((arg) => arg.startsWith('--mint='))?.split('=')[1] || process.argv[2];
  if (!mintArg) {
    console.error('Usage: npm run tree:derive-collection -- --mint <mintAddress>');
    process.exit(1);
  }
  const mint = new PublicKey(mintArg);
  const metadata = pda([Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()]);
  const masterEdition = pda([
    Buffer.from('metadata'),
    TOKEN_METADATA_PROGRAM_ID.toBuffer(),
    mint.toBuffer(),
    Buffer.from('edition'),
  ]);

  console.log('Collection mint:', mint.toBase58());
  console.log('Metadata PDA :', metadata);
  console.log('Master edition:', masterEdition);
  console.log('--- env for functions ---');
  console.log(`COLLECTION_MINT=${mint.toBase58()}`);
  console.log(`COLLECTION_METADATA=${metadata}`);
  console.log(`COLLECTION_MASTER_EDITION=${masterEdition}`);
}

main();
