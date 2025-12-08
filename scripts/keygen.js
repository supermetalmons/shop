import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();
console.log('Public key:', kp.publicKey.toBase58());
console.log('Secret (base58, keep safe):', bs58.encode(kp.secretKey));
console.log('Secret as JSON array (compatible with solana-cli):', `[${Array.from(kp.secretKey)}]`);
