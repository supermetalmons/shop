import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { loadOnchainState as loadAdminState } from '../src/adminIrlRedeemOnchain.ts';
import { buildRuntime as buildAdminRuntime } from '../src/adminIrlRedeemRuntime.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.ts';
import { API_DROPS, type ApiDropConfig } from '../src/dropConfig.ts';
import { irlClaimTestHooks } from '../src/irlClaim.ts';
import { receiptTransferTestHooks } from '../src/receiptTransfer.ts';

const ADMIN = new PublicKey(new Uint8Array(32).fill(1));
const COLLECTION = new PublicKey(new Uint8Array(32).fill(2));
const CONFIG = new PublicKey(new Uint8Array(32).fill(3));
const PROGRAM = new PublicKey(new Uint8Array(32).fill(4));
const TREASURY = new PublicKey(new Uint8Array(32).fill(5));
const OTHER = new PublicKey(new Uint8Array(32).fill(6));
const DROP: ApiDropConfig = {
  ...API_DROPS.card_nft_2,
  dropId: 'config_read_test',
  boxMinterProgramId: PROGRAM.toBase58(),
  boxMinterConfigPda: CONFIG.toBase58(),
  collectionMint: COLLECTION.toBase58(),
  treasury: TREASURY.toBase58(),
  receiptsMerkleTree: OTHER.toBase58(),
  itemsPerBox: 3,
  maxSupply: 100,
  receiptMaxId: 100,
  discountMintsPerWallet: 1,
  operationsConfig: undefined,
  paymentRouting: undefined,
};

function u32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

function borshString(value: string): Buffer {
  const data = Buffer.from(value);
  return Buffer.concat([u32(data.length), data]);
}

function configData(overrides: { treasury?: PublicKey; itemsPerBox?: number; discount?: number } = {}): Buffer {
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR), ADMIN.toBuffer(),
    (overrides.treasury ?? TREASURY).toBuffer(), COLLECTION.toBuffer(),
    Buffer.alloc(48), u32(DROP.maxSupply),
    Buffer.from([DROP.maxPerTx, overrides.itemsPerBox ?? DROP.itemsPerBox]), u32(0),
    borshString(DROP.namePrefix), borshString(DROP.symbol), borshString(DROP.metadataBase),
    Buffer.from([0, 1, overrides.discount ?? DROP.discountMintsPerWallet]),
    borshString(DROP.figureNamePrefix), Buffer.alloc(37),
  ]);
  return Buffer.concat([payload, Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length)]);
}

function account(data: Buffer, owner = PROGRAM.toBase58()) {
  return { owner, data: [data.toString('base64'), 'base64'] };
}

function collectionAccount(discriminator = 5, length = 49) {
  const data = Buffer.alloc(length);
  data[0] = discriminator;
  return account(data, MPL_CORE_PROGRAM_ADDRESS);
}

type ProviderContext = { apiKey: string; providerFetch: ProfileProviderFetch; signal: AbortSignal };

function context(result: unknown, requests: unknown[] = []): ProviderContext {
  return {
    apiKey: 'test-key',
    signal: new AbortController().signal,
    providerFetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown };
      requests.push({ method: request.method, params: request.params });
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  };
}

const adapters = [
  {
    name: 'delivery', errorName: 'DeliveryPrepareError', providerName: 'Delivery',
    load: (provider: ProviderContext, drop = DROP) =>
      deliveryPrepareTestHooks.loadOnchainState(provider, deliveryPrepareTestHooks.buildRuntime(drop)),
  },
  {
    name: 'receipt transfer', errorName: 'ReceiptTransferError', providerName: 'Receipt transfer',
    load: (provider: ProviderContext, drop = DROP) =>
      receiptTransferTestHooks.loadOnchainState(provider, receiptTransferTestHooks.buildRuntime(drop)),
  },
  {
    name: 'IRL claim', errorName: 'IrlClaimError', providerName: 'Claim',
    load: (provider: ProviderContext, drop = DROP) =>
      irlClaimTestHooks.loadOnchainState(provider, irlClaimTestHooks.buildRuntime(drop)),
  },
  {
    name: 'admin redeem', errorName: 'AdminIrlRedeemPrepareError', providerName: 'Admin IRL redeem',
    load: (provider: ProviderContext, drop = DROP) => loadAdminState(provider, buildAdminRuntime(drop)),
  },
] as const;

type DomainFailure = Error & { code: string; details?: unknown };
type OnchainState = {
  coreCollection: PublicKey;
  admin?: PublicKey;
  treasury?: PublicKey;
  config?: DecodedBoxMinterConfigData;
};

for (const adapter of adapters) {
  const failure = (result: unknown, code: string, message: string, details?: unknown) =>
    assert.rejects(adapter.load(context(result)), (error: unknown) => {
      assert.ok(error instanceof Error);
      const domainError = error as DomainFailure;
      assert.deepEqual({
        name: domainError.name, code: domainError.code, message: domainError.message, details: domainError.details,
      }, { name: adapter.errorName, code, message, details });
      return true;
    });

  test(`${adapter.name} reads the same account pair and preserves its state projection`, async () => {
    const requests: unknown[] = [];
    const state: OnchainState = await adapter.load(context({ value: [collectionAccount(), account(configData())] }, requests));
    assert.deepEqual(requests, [{
      method: 'getMultipleAccounts',
      params: [[COLLECTION.toBase58(), CONFIG.toBase58()], { commitment: 'confirmed', encoding: 'base64' }],
    }]);
    assert.equal(state.coreCollection.toBase58(), COLLECTION.toBase58());
    assert.deepEqual(Object.keys(state).sort(), adapter.name === 'delivery'
      ? ['admin', 'coreCollection', 'treasury']
      : adapter.name === 'admin redeem' ? ['admin', 'coreCollection']
        : adapter.name === 'IRL claim' ? ['config', 'coreCollection'] : ['coreCollection']);
    if (state.admin) assert.equal(state.admin.toBase58(), ADMIN.toBase58());
    if (state.treasury) assert.equal(state.treasury.toBase58(), TREASURY.toBase58());
    if (state.config) assert.equal(state.config.itemsPerBox, DROP.itemsPerBox);
  });

  test(`${adapter.name} preserves missing-account, ownership, and decoding errors`, async () => {
    for (const result of [null, { value: [collectionAccount()] }]) {
      await failure(result, 'unavailable', `${adapter.providerName} provider returned an invalid account response.`);
    }
    const missing = adapter.name === 'IRL claim';
    await failure({ value: [null, account(configData())] }, 'failed-precondition',
      missing ? 'On-chain mint configuration is missing.'
        : adapter.name === 'receipt transfer' ? 'Configured receipt collection was not found on-chain.'
          : 'Configured collection was not found on-chain.',
      missing ? { dropId: DROP.dropId } : { collection: COLLECTION.toBase58(), dropId: DROP.dropId });
    await failure({ value: [collectionAccount(), null] }, 'failed-precondition',
      missing ? 'On-chain mint configuration is missing.' : 'Box minter config PDA not found.',
      missing ? { dropId: DROP.dropId } : { configPda: CONFIG.toBase58(), dropId: DROP.dropId });
    await failure({ value: [{ ...collectionAccount(), owner: OTHER.toBase58() }, account(configData())] },
      'failed-precondition', adapter.name === 'IRL claim' ? 'COLLECTION_MINT is not an MPL Core collection account.'
        : adapter.name === 'receipt transfer' ? 'Configured receipt collection is not an MPL Core collection.'
          : 'Configured collection is not an MPL Core collection.',
      adapter.name === 'receipt transfer' ? {
        collection: COLLECTION.toBase58(), expectedOwner: MPL_CORE_PROGRAM_ADDRESS,
        actualOwner: OTHER.toBase58(), dropId: DROP.dropId,
      } : undefined);
    await failure({ value: [collectionAccount(), account(configData(), OTHER.toBase58())] },
      'failed-precondition', adapter.name === 'IRL claim' ? 'BOX_MINTER_CONFIG_PDA has an unexpected owner.'
        : 'Box minter config PDA has an unexpected owner.',
      adapter.name === 'receipt transfer' || adapter.name === 'admin redeem' ? {
        configPda: CONFIG.toBase58(), expectedOwner: PROGRAM.toBase58(),
        actualOwner: OTHER.toBase58(), dropId: DROP.dropId,
      } : undefined);
    await failure({ value: [collectionAccount(), { ...account(configData()), data: ['', 'base58'] }] },
      'unavailable', `${adapter.providerName} provider returned invalid account data.`);
    await failure({ value: [collectionAccount(), account(Buffer.alloc(8))] },
      'failed-precondition', 'Invalid config account discriminator');
    await failure({ value: [collectionAccount(), account(configData({ itemsPerBox: 6 }))] },
      'failed-precondition', 'Invalid on-chain itemsPerBox: 6 (expected 0..5)', { itemsPerBox: 6 });
  });

  test(`${adapter.name} keeps validation precedence and collection-layout policy`, async () => {
    await failure({ value: [{}, null] }, 'failed-precondition', adapter.name === 'IRL claim'
      ? 'On-chain mint configuration is missing.' : 'Box minter config PDA not found.',
    adapter.name === 'IRL claim' ? { dropId: DROP.dropId } : { configPda: CONFIG.toBase58(), dropId: DROP.dropId });
    await failure({ value: [{ ...collectionAccount(), owner: OTHER.toBase58() }, {}] },
      'failed-precondition', 'BOX_MINTER_CONFIG_PDA is invalid.');
    for (const collection of [collectionAccount(4), collectionAccount(5, 48)]) {
      const result = { value: [collection, account(configData())] };
      if (adapter.name === 'delivery') {
        await failure(result, 'failed-precondition', 'Configured collection is not an MPL Core collection.');
      } else {
        assert.equal((await adapter.load(context(result))).coreCollection.toBase58(), COLLECTION.toBase58());
      }
    }
  });

  test(`${adapter.name} preserves committed-config policy and discount normalization`, async () => {
    const normalized: OnchainState = await adapter.load(context({ value: [collectionAccount(), account(configData({ discount: 0 }))] }));
    if (normalized.config) assert.equal(normalized.config.discountMintsPerWallet, 1);
    const mismatch = { value: [collectionAccount(), account(configData({ treasury: OTHER }))] };
    if (adapter.name === 'delivery' || adapter.name === 'IRL claim') {
      await assert.rejects(adapter.load(context(mismatch)), {
        name: adapter.errorName, code: 'failed-precondition',
        message: 'Committed drop configuration does not match the on-chain config.',
      });
    } else {
      assert.equal((await adapter.load(context(mismatch))).coreCollection.toBase58(), COLLECTION.toBase58());
    }
    const operationsDrop = {
      ...DROP, operationsConfig: { configId: 'operations', boxMinterConfigPda: CONFIG.toBase58(), maxSupply: DROP.maxSupply },
    };
    await adapter.load(context({ value: [collectionAccount(), account(configData())] }), operationsDrop);
    await assert.rejects(adapter.load(context(mismatch), operationsDrop), {
      name: adapter.errorName, code: 'failed-precondition',
      message: adapter.name === 'delivery' || adapter.name === 'IRL claim'
        ? 'Committed drop configuration does not match the on-chain config.'
        : 'Committed operations configuration does not match the on-chain config.',
    });
  });

  test(`${adapter.name} preserves the original cancellation reason`, async () => {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    await assert.rejects(adapter.load({
      apiKey: 'test-key', signal: controller.signal,
      providerFetch: async () => {
        controller.abort(reason);
        throw new Error('provider failed after cancellation');
      },
    }), (error: unknown) => error === reason);
  });
}
