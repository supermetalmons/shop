import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { createTestHarness } from 'wrangler';
import {
  MI_NOTE_AUTH_CHALLENGE_PATH, MI_NOTE_AUTH_LOGOUT_PATH, MI_NOTE_AUTH_VERIFY_PATH, MI_NOTE_SESSION_HEADER,
  type MiNoteEthereumChallenge, type MiNoteEthereumSession,
} from '../../../../shared/miNoteAuth.ts';

test('Mi Note verification signs, consumes, scopes, and revokes proofs in workerd', { timeout: 60_000 }, async () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  config.main = resolve('cloud/workers/api/src/index.ts');
  config.d1_databases = config.d1_databases.map((database: Record<string, unknown>) => ({
    ...database, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
  }));
  delete config.routes;
  delete config.$schema;
  delete config.secrets;
  const server = createTestHarness({ root: resolve('.'), workers: [{ config }] });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('OPS_DB');
    const key = new Uint8Array(32).fill(17);
    const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12))}`;
    const headers = { Origin: 'https://mons.shop', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.2' };
    const post = (path: string, body: unknown, token?: string) => worker.fetch(`https://mons.shop${path}`, {
      method: 'POST', headers: { ...headers, ...(token ? { [MI_NOTE_SESSION_HEADER]: token } : {}) }, body: JSON.stringify(body),
    });
    const challengeResponse = await post(MI_NOTE_AUTH_CHALLENGE_PATH, { preorderId: 'mi_note_cards_devnet', address, chainId: 1 });
    assert.equal(challengeResponse.status, 200);
    assert.equal(challengeResponse.headers.get('Cache-Control'), 'no-store');
    const challenge = await challengeResponse.json() as MiNoteEthereumChallenge;
    const message = utf8ToBytes(challenge.message);
    const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
    const signed = secp256k1.sign(digest, key);
    const proof = { challengeId: challenge.challengeId, signature: `0x${bytesToHex(signed.toCompactRawBytes())}${(signed.recovery + 27).toString(16)}` };
    const results = await Promise.all([post(MI_NOTE_AUTH_VERIFY_PATH, proof), post(MI_NOTE_AUTH_VERIFY_PATH, proof)]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    const session = await results.find((response) => response.ok)!.json() as MiNoteEthereumSession;
    assert.equal(session.address, address);
    const env = await worker.getEnv();
    assert.equal((await env.OPS_DB.prepare('SELECT COUNT(*) AS count FROM mi_note_auth_sessions').first<{ count: number }>())?.count, 1);
    const mismatched = await worker.fetch('https://mons.shop/mi-note-cards?preorderId=mi_note_cards', {
      headers: { ...headers, [MI_NOTE_SESSION_HEADER]: session.token },
    });
    assert.equal(mismatched.status, 401);
    const preflight = await worker.fetch('https://mons.shop/preorders/availability', { method: 'OPTIONS', headers });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers') || '', /X-Mi-Note-Session/);
    assert.equal((await post(MI_NOTE_AUTH_LOGOUT_PATH, {}, session.token)).status, 200);
    assert.equal((await env.OPS_DB.prepare('SELECT COUNT(*) AS count FROM mi_note_auth_sessions').first<{ count: number }>())?.count, 0);
  } finally { await server.close(); }
});
