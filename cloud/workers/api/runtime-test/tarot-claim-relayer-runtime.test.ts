import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { TarotBackendClaim } from '../../../../shared/ethereum/tarot.ts';
import type { TarotClaimRejection, TarotClaimRejectionInput } from '../src/tarotClaimRejection.ts';
import type { TarotClaimInput } from '../src/tarotClaimRelayer.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const RECIPIENT = `0x${'22'.repeat(20)}`;
const input: TarotClaimInput = { chainId: 1, contractAddress: CONTRACT, tokenId: 1, recipient: RECIPIENT,
  requestId: '11111111-1111-4111-8111-111111111111', codeHash: '33'.repeat(32) };

async function fixture() {
  const source = `
    import { TarotClaimRelayerObject } from ${JSON.stringify(resolve('cloud/workers/api/src/tarotClaimRelayerObject.ts'))};
    export class RuntimeTarotClaimRelayer extends TarotClaimRelayerObject {
      async arm() {
        this.ctx.storage.sql.exec('UPDATE claim_attempts SET last_broadcast_at_ms=?,last_checked_at_ms=?', Date.now()-31000,Date.now()-16000);
        await this.ctx.storage.setAlarm(Date.now()+100);
      }
      async clearAlarm() { await this.ctx.storage.deleteAlarm(); }
      async alarm() {
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alarm_runs(id INTEGER PRIMARY KEY,count INTEGER NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO alarm_runs VALUES(1,1) ON CONFLICT(id) DO UPDATE SET count=count+1');
        await super.alarm();
      }
      async details() {
        return { alarmAt: await this.ctx.storage.getAlarm(),
          rows: this.ctx.storage.sql.exec('SELECT * FROM claim_attempts ORDER BY id').toArray(),
          account: this.ctx.storage.sql.exec('SELECT * FROM relayer_account').toArray()[0] ?? null,
          alarms: this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='alarm_runs'").toArray().length
            ? this.ctx.storage.sql.exec('SELECT count FROM alarm_runs').toArray()[0].count : 0 };
      }
    }
    export default { async fetch(request,env) {
      const body=await request.json();
      const target=env.TAROT_CLAIM_RELAYER.getByName(body.objectName ?? 'tarot-claims:1');
      try {
        if(body.action==='arm') { await target.arm();return Response.json({ok:true}); }
        if(body.action==='clearAlarm') { await target.clearAlarm();return Response.json({ok:true}); }
        if(body.action==='details') return Response.json(await target.details());
        if(body.action==='status') return Response.json(await target.status(body.input));
        if(body.action==='reject') return Response.json(await target.reject(body.input));
        return Response.json(await target.claim(body.input));
      } catch(error) { return Response.json({error:error.message},{status:400}); }
    } };
  `;
  const adapter = `
    const payer='0x4444444444444444444444444444444444444444';
    export function createTarotClaimChain() { return {
      relayerAddress:()=>payer, validate:async()=>{}, nonce:async()=>({latest:'0',pending:'0'}),
      async prepare(input,nonce) { return { rawTransaction:'0x0200'+Number(nonce).toString(16).padStart(2,'0'),
        transactionHash:'0x'+(Number(nonce)+1).toString(16).padStart(64,'0'),nonce,
        authorizationDeadline:Math.floor(Date.now()/1000)+600,maximumFeeWei:'1000',relayerAddress:payer }; },
      inspect:async attempt=>attempt.tokenId===2?'confirmed':'pending',
      async broadcast(attempt) { if(attempt.tokenId===1 && attempt.lastBroadcastAtMs===null) throw new Error('Lost broadcast response'); }
    }; }
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'],
    plugins: [{ name: 'fake-tarot-chain', setup(builder) {
      builder.onResolve({ filter: /^\.\/tarotClaimChain\.js$/ }, () => ({ path: 'tarot-claim-chain', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: adapter, loader: 'js' }));
    } }],
  });
  const name = 'tarot-relayer-runtime';
  const runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name, compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'tarot.mjs', modulesRoot: resolve('.'), modules: {
      'tarot.mjs': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
    env: { TAROT_CLAIM_RELAYER: { type: 'durable-object', worker: name, exportName: 'RuntimeTarotClaimRelayer' } },
    exports: { RuntimeTarotClaimRelayer: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const run = async <T>(action: string, value: typeof input | TarotClaimRejectionInput = input, objectName?: string): Promise<T> => {
    const response = await runtime.dispatchFetch('https://tarot.test/', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, input: value, objectName }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const evict = () => runtime.unsafeEvictDurableObject(name, 'RuntimeTarotClaimRelayer', { name: 'tarot-claims:1' });
  return { runtime, run, evict };
}

type Details = { alarmAt: number | null; alarms: number; account: { next_nonce: string };
  rows: Array<{ state: string; raw_transaction: string; transaction_hash: string; nonce: string; broadcast_accepted: number }> };

test('native Tarot relayer fences network objects and restores durable pending claims after eviction and a real alarm', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const denied = await f.runtime.dispatchFetch('https://tarot.test/', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, objectName: 'tarot-claims:11155111' }) });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /does not match/);

    const pending = await f.run<TarotBackendClaim>('claim');
    assert.equal(pending.state, 'pending');
    const before = await f.run<Details>('details');
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].broadcast_accepted, 0);
    assert.equal(before.account.next_nonce, '1');
    assert.ok(before.alarmAt);
    await f.evict();
    assert.deepEqual(await f.run<TarotBackendClaim>('status'), pending);
    assert.deepEqual(await f.run<TarotBackendClaim>('claim'), pending);
    await f.run('arm');
    let after = await f.run<Details>('details');
    const deadline = Date.now() + 5_000;
    while (!after.alarms && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      after = await f.run<Details>('details');
    }
    assert.ok(after.alarms >= 1, 'The scheduled native alarm must run.');
    assert.equal(after.rows[0].broadcast_accepted, 1);
    assert.equal(after.rows[0].raw_transaction, before.rows[0].raw_transaction);
    assert.equal(after.rows[0].transaction_hash, pending.transactionHash);
    assert.equal(after.account.next_nonce, '1');

    await f.run('clearAlarm');
    assert.equal((await f.run<Details>('details')).alarmAt, null);
    await f.evict();
    assert.deepEqual(await f.run<TarotBackendClaim>('status'), pending);
    assert.ok((await f.run<Details>('details')).alarmAt, 'Restoring pending status repairs a missing alarm.');

    const second = { ...input, tokenId: 2, requestId: '22222222-2222-4222-8222-222222222222' };
    assert.equal((await f.run<TarotBackendClaim>('claim', second)).state, 'pending');
    await f.evict();
    await f.run('arm');
    let result = await f.run<TarotBackendClaim>('status', second);
    const confirmationDeadline = Date.now() + 5_000;
    while (result.state !== 'confirmed' && Date.now() < confirmationDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      result = await f.run<TarotBackendClaim>('status', second);
    }
    assert.equal(result.state, 'confirmed');
    assert.equal((await f.run<Details>('details')).account.next_nonce, '2');
  } finally { await f.runtime.dispose(); }
});

test('native Tarot rejection is serialized durably and excludes late admission after eviction', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const failure = { code: 'unavailable' as const, message: 'ENS resolution is unavailable.' };
    const rejected = { rejection: failure };
    assert.deepEqual(await f.run<TarotClaimRejection>('reject', { ...input, failure }), rejected);
    await f.evict();
    assert.deepEqual(await f.run<TarotClaimRejection>('claim'), rejected);
    assert.deepEqual(await f.run<TarotClaimRejection>('reject', {
      ...input, failure: { code: 'invalid-argument', message: 'Changed failure.' },
    }), rejected);
    const before = await f.run<Details>('details');
    assert.equal(before.rows.length, 0);
    assert.equal(before.account, null);
    const retry = { ...input, requestId: '22222222-2222-4222-8222-222222222222' };
    const accepted = await f.run<TarotBackendClaim>('claim', retry);
    assert.equal(accepted.state, 'pending');
    assert.deepEqual(await f.run<TarotBackendClaim>('reject', { ...retry, failure }), accepted);
    assert.deepEqual(await f.run<TarotClaimRejection>('claim'), rejected);
    assert.equal((await f.run<Details>('details')).account.next_nonce, '1');
  } finally { await f.runtime.dispose(); }
});
