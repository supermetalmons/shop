import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  MI_NOTE_AUTH_CHALLENGE_PATH, MI_NOTE_AUTH_LOGOUT_PATH, MI_NOTE_AUTH_VERIFY_PATH, MI_NOTE_SESSION_HEADER,
  type MiNoteEthereumChallenge, type MiNoteEthereumSession,
} from '../../../../shared/miNoteAuth.ts';
import { cleanupExpiredMiNoteAuthState, handleMiNoteAuthRequest, MiNoteAuthError, verifyMiNoteSession } from '../src/miNoteAuth.ts';
import { d1Database } from './commerceD1Harness.ts';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ORIGIN = 'https://mons.shop';
const PREORDER = 'mi_note_cards_devnet';
const KEY = new Uint8Array(32).fill(17);
const ADDRESS = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(KEY, false).subarray(1)).subarray(12))}`;

function sign(message: string, key = KEY): string {
  const body = utf8ToBytes(message);
  const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
  const signature = secp256k1.sign(hash, key);
  return `0x${bytesToHex(signature.toCompactRawBytes())}${(signature.recovery + 27).toString(16)}`;
}

function request(path: string, data: unknown = {}, token?: string, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Origin: origin, 'X-Mons-CSRF': '1', 'CF-Connecting-IP': '127.0.0.1', 'Content-Type': 'application/json',
      ...(token ? { [MI_NOTE_SESSION_HEADER]: token } : {}),
    },
    body: JSON.stringify(data),
  });
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../ops-migrations/0007_mi_note_auth.sql', import.meta.url), 'utf8'));
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env = { OPS_DB: d1Database(database), STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter };
  const challenge = async (origin = ORIGIN) => {
    const response = await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_CHALLENGE_PATH, {
      preorderId: PREORDER, address: ADDRESS, chainId: 1,
    }, undefined, origin), env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW);
    assert.equal(response.status, 200);
    return response.json<MiNoteEthereumChallenge>();
  };
  const session = async (origin = ORIGIN) => {
    const proof = await challenge(origin);
    const response = await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_VERIFY_PATH, {
      challengeId: proof.challengeId, signature: sign(proof.message),
    }, undefined, origin), env, MI_NOTE_AUTH_VERIFY_PATH, NOW + 1000);
    assert.equal(response.status, 200);
    return response.json<MiNoteEthereumSession>();
  };
  return { database, env, challenge, session };
}

test('Ethereum proof requires no Solana session and is scoped to origin, preorder, and expiry', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    assert.equal(session.address, ADDRESS);
    assert.equal(session.preorderId, PREORDER);
    assert.equal(session.expiresAtMs, NOW + 1000 + 3_600_000);
    const authenticated = request('/preorders/prepare', {}, session.token);
    assert.equal((await verifyMiNoteSession(authenticated, f.env.OPS_DB, PREORDER, NOW + 2000)).address, ADDRESS);
    await assert.rejects(verifyMiNoteSession(authenticated, f.env.OPS_DB, 'mi_note_cards', NOW + 2000), MiNoteAuthError);
    await assert.rejects(verifyMiNoteSession(authenticated, f.env.OPS_DB, PREORDER, session.expiresAtMs), MiNoteAuthError);
    await assert.rejects(verifyMiNoteSession(request('/preorders/prepare', {}, session.token, 'https://www.mons.shop'), f.env.OPS_DB, PREORDER, NOW + 2000), MiNoteAuthError);
    const stored = f.database.prepare('SELECT secret_hash FROM mi_note_auth_sessions').get()!;
    assert.match(String(stored.secret_hash), /^[0-9a-f]{64}$/);
    assert.notEqual(stored.secret_hash, session.token.split('.').at(-1));
    assert.equal(f.database.prepare('SELECT consumed_at_ms FROM mi_note_auth_challenges').get()!.consumed_at_ms, NOW + 1000);
  } finally { f.database.close(); }
});

test('challenge signatures reject wrong signer, wrong message, expiry, malformed signatures, and replay', async () => {
  const f = fixture();
  try {
    const challenge = await f.challenge();
    assert.match(challenge.message, /Nonce: [0-9a-f]{32}/);
    assert.match(challenge.message, /urn:mons:preorder:mi_note_cards_devnet/);
    assert.equal(challenge.expiresAtMs, NOW + 300_000);
    const verify = (signature: string, now = NOW + 1000) => handleMiNoteAuthRequest(request(MI_NOTE_AUTH_VERIFY_PATH, {
      challengeId: challenge.challengeId, signature,
    }), f.env, MI_NOTE_AUTH_VERIFY_PATH, now);
    assert.equal((await verify(sign(challenge.message, new Uint8Array(32).fill(18)))).status, 401);
    assert.equal((await verify(sign(challenge.message + ' tampered'))).status, 401);
    assert.equal((await verify('0x' + '00'.repeat(65))).status, 401);
    assert.equal((await verify('0x1234')).status, 400);
    assert.equal((await verify(sign(challenge.message), challenge.expiresAtMs)).status, 409);
    const signature = sign(challenge.message);
    assert.equal((await verify(signature.slice(0, -2) + 'ff')).status, 401);
    const responses = await Promise.all([verify(signature), verify(signature)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM mi_note_auth_sessions').get()!.count, 1);
    assert.equal((await verify(signature)).status, 409);
  } finally { f.database.close(); }
});

test('verification accepts an ethers personal_sign fixture with both standard recovery encodings', async () => {
  for (const recovery of ['1c', '01']) {
    const f = fixture();
    try {
      const challengeId = '10000000-0000-4000-8000-000000000001';
      f.database.prepare('INSERT INTO mi_note_auth_challenges VALUES (?, ?, ?, ?, 1, ?, ?, NULL)')
        .run(challengeId, ADDRESS, PREORDER, ORIGIN, NOW, NOW + 300_000);
      const signature = `0x51f835401cacd658c15aabf4e9dddd90618fbc81666bcd768f62bcd6f802012b0b15f84a75ca61c92df9a01c2ef07833eb33d57c0422e587abee1c0cf221ea8d${recovery}`;
      const result = await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_VERIFY_PATH, { challengeId, signature }), f.env, MI_NOTE_AUTH_VERIFY_PATH, NOW + 1000);
      assert.equal(result.status, 200);
      assert.equal((await result.json<MiNoteEthereumSession>()).address, ADDRESS);
    } finally { f.database.close(); }
  }
});

test('logout revokes only the supplied session and invalid bearer tokens fail closed', async () => {
  const f = fixture();
  try {
    const first = await f.session();
    const second = await f.session();
    const mutated = first.token.slice(0, -1) + (first.token.endsWith('a') ? 'b' : 'a');
    await assert.rejects(verifyMiNoteSession(request('/preorders/prepare', {}, mutated), f.env.OPS_DB, PREORDER, NOW + 2000), MiNoteAuthError);
    assert.equal((await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_LOGOUT_PATH, {}, first.token), f.env, MI_NOTE_AUTH_LOGOUT_PATH, NOW + 2000)).status, 200);
    await assert.rejects(verifyMiNoteSession(request('/preorders/prepare', {}, first.token), f.env.OPS_DB, PREORDER, NOW + 2000), MiNoteAuthError);
    assert.equal((await verifyMiNoteSession(request('/preorders/prepare', {}, second.token), f.env.OPS_DB, PREORDER, NOW + 2000)).address, ADDRESS);
  } finally { f.database.close(); }
});

test('same-origin GET and local proxy origin resolution preserve full origin including ports', async () => {
  const f = fixture();
  try {
    const session = await f.session('http://localhost:5173');
    const read = new Request('https://api.mons.shop/preorders/availability', { headers: {
      Referer: 'http://localhost:5173/mi_note_cards_devnet', [MI_NOTE_SESSION_HEADER]: session.token,
    } });
    assert.equal((await verifyMiNoteSession(read, f.env.OPS_DB, PREORDER, NOW + 2000)).origin, 'http://localhost:5173');
    read.headers.set('Referer', 'http://localhost:3000/');
    await assert.rejects(verifyMiNoteSession(read, f.env.OPS_DB, PREORDER, NOW + 2000), MiNoteAuthError);
    const production = await f.session();
    assert.equal((await verifyMiNoteSession(new Request(`${ORIGIN}/api/preorders/availability`, {
      headers: { [MI_NOTE_SESSION_HEADER]: production.token },
    }), f.env.OPS_DB, PREORDER, NOW + 2000)).address, ADDRESS);
  } finally { f.database.close(); }
});

test('auth validates request shape, CSRF, allowed origins, methods, and rate limits', async () => {
  const f = fixture();
  try {
    const body = { preorderId: PREORDER, address: ADDRESS, chainId: 1 };
    for (const changed of [{ ...body, chainId: 0 }, { ...body, preorderId: 'wrong' }, { ...body, extra: true }]) {
      assert.equal((await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_CHALLENGE_PATH, changed), f.env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW)).status, 400);
    }
    assert.equal((await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_CHALLENGE_PATH, body, undefined, 'https://evil.example'), f.env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW)).status, 403);
    const csrf = request(MI_NOTE_AUTH_CHALLENGE_PATH, body);
    csrf.headers.delete('X-Mons-CSRF');
    assert.equal((await handleMiNoteAuthRequest(csrf, f.env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW)).status, 403);
    assert.equal((await handleMiNoteAuthRequest(new Request(`${ORIGIN}${MI_NOTE_AUTH_CHALLENGE_PATH}`), f.env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW)).status, 405);
    f.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await handleMiNoteAuthRequest(request(MI_NOTE_AUTH_CHALLENGE_PATH, body), f.env, MI_NOTE_AUTH_CHALLENGE_PATH, NOW);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM mi_note_auth_challenges').get()!.count, 0);
  } finally { f.database.close(); }
});

test('auth cleanup bounds expiry deletion and preserves active sessions', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    const insert = f.database.prepare(`INSERT INTO mi_note_auth_challenges VALUES (?, ?, ?, ?, 1, ?, ?, NULL)`);
    for (let index = 0; index < 502; index += 1) insert.run(crypto.randomUUID(), ADDRESS, PREORDER, ORIGIN, NOW - 300_000, NOW);
    assert.deepEqual(await cleanupExpiredMiNoteAuthState(f.env.OPS_DB, NOW + 1000), {
      sessionsDeleted: 0, challengesDeleted: 500, limitReached: true, hasMore: true,
    });
    assert.equal((await verifyMiNoteSession(request('/preorders/prepare', {}, session.token), f.env.OPS_DB, PREORDER, NOW + 2000)).address, ADDRESS);
    assert.deepEqual(await cleanupExpiredMiNoteAuthState(f.env.OPS_DB, session.expiresAtMs), {
      sessionsDeleted: 1, challengesDeleted: 3, limitReached: false, hasMore: false,
    });
  } finally { f.database.close(); }
});
