import { Buffer } from 'buffer';
import { timingSafeEqual } from 'node:crypto';
import { Keypair, MessageV0, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertSignedTransaction, assertUnsignedTransaction } from './transaction.ts';

async function requestHasContent(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 1000); });
  try {
    for (let chunk = 0; chunk < 4; chunk++) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === 'timeout') return true;
      if (result.done) return false;
      if (result.value.length) return true;
    }
    return true;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createWorkerTransactionSigner(
  config: { messageBase64: string; authority: string; signerBinding: string; tokenHash: string; expiresAt: number },
  dependencies: { now?: () => number } = {},
) {
  const { authority, signerBinding, tokenHash, expiresAt } = config;
  if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 ||
    !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(signerBinding) || typeof config.messageBase64 !== 'string' ||
    !config.messageBase64.length || config.messageBase64.length > 1644) throw new Error('Invalid signer configuration.');
  const messageBytes = Buffer.from(config.messageBase64, 'base64');
  if (messageBytes.length > 1232 || messageBytes.toString('base64') !== config.messageBase64) throw new Error('Invalid embedded message encoding.');
  const message = MessageV0.deserialize(messageBytes);
  if (!Buffer.from(message.serialize()).equals(messageBytes)) throw new Error('Embedded message is not canonical.');
  assertUnsignedTransaction(new VersionedTransaction(message), authority);
  const expectedToken = Buffer.from(tokenHash, 'hex');
  const now = dependencies.now ?? Date.now;
  return {
    async fetch(request: Request, env: Record<string, string>): Promise<Response> {
      const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
      const url = new URL(request.url);
      if (url.pathname !== '/sign' || request.method !== 'POST') return respond({ error: 'not-found' }, 404);
      if (now() >= expiresAt) return respond({ error: 'expired' }, 410);
      if (expiresAt > now() + 15 * 60_000) return respond({ error: 'invalid-expiration' }, 409);
      const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
      if (!bearer) return respond({ error: 'unauthorized' }, 401);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
      if (!timingSafeEqual(Buffer.from(digest), expectedToken)) return respond({ error: 'unauthorized' }, 401);
      if (url.search || await requestHasContent(request)) return respond({ error: 'no-input-accepted' }, 400);
      let secret: Uint8Array | undefined;
      try {
        if (now() >= expiresAt || request.signal.aborted) return respond({ error: 'expired' }, 410);
        secret = bs58.decode(env[signerBinding].trim());
        const signer = Keypair.fromSecretKey(secret);
        if (signer.publicKey.toBase58() !== authority) throw new Error('Wrong signer.');
        const transaction = new VersionedTransaction(MessageV0.deserialize(messageBytes));
        transaction.sign([signer]);
        return respond({ signature: assertSignedTransaction(transaction, messageBytes, authority) });
      } catch {
        return respond({ error: 'signing-failed' }, 409);
      } finally {
        secret?.fill(0);
      }
    },
  };
}
