import nacl from 'tweetnacl';

function header(title) {
  console.log('');
  console.log(`== ${title} ==`);
}

function envLine(key, value) {
  console.log(`${key}=${value}`);
}

// Curve25519 keypair for encrypting delivery addresses (TweetNaCl box).
// Used by Frontend env: VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY=<base64 32-byte pubkey>
const addrEnc = nacl.box.keyPair();

header('Delivery address encryption (TweetNaCl box / Curve25519)');
console.log('Frontend (Vite) env:');
envLine('VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY', Buffer.from(addrEnc.publicKey).toString('base64'));
console.log('');
console.log('Secret for decryption (keep private; do NOT put this in Vite/AWS env):');
envLine('ADDRESS_ENCRYPTION_SECRET_BASE64', Buffer.from(addrEnc.secretKey).toString('base64'));
envLine('ADDRESS_ENCRYPTION_SECRET_JSON', `[${Array.from(addrEnc.secretKey)}]`);
