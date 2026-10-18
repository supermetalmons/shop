import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { encodeAbi, encodeCall, type EthereumLog } from '../shared/ethereum/abi.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumReceiptIdsHash, ethereumTokenIdsHash } from '../shared/ethereum/crypto.ts';
import { ETHEREUM_FUNCTIONS } from '../shared/ethereum/protocol.ts';
import { readEthereumSubmittedTransaction, recoverEthereumTransaction } from '../src/ethereum/recovery.ts';
import type { EthereumPendingTransaction, EthereumSubmission } from '../src/ethereum/state.ts';
import type { EIP1193Provider } from '../src/wallet/injectedEthereumProviders.ts';

const owner = '0x1111111111111111111111111111111111111111';
const relayer = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const recipient = '0x4444444444444444444444444444444444444444';
const config = resolveEthereum111kConfig({ chainId: 31337, contractAddress: contract });
const hash = `0x${'ab'.repeat(32)}`;
const originalHash = `0x${'cd'.repeat(32)}`;
const blockHash = `0x${'ef'.repeat(32)}`;
const claimId = `0x${'12'.repeat(32)}`;
const topic = (signature: string) => `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;

function event(signature: string, indexedTypes: string[], indexed: unknown[], types: string[], values: unknown[]): EthereumLog {
  return { address: contract, topics: [topic(signature), ...indexedTypes.map((type, index) => encodeAbi([type], [indexed[index]]))], data: encodeAbi(types, values) };
}

function submission(action: EthereumSubmission['action'], data: string, value = '0x0'): EthereumSubmission {
  return { scope: 'test', action, submittedAt: 1_000, nonce: '0x0', intent: { to: contract, data, value } };
}

function mint(quantity = 1, value = '0x5') {
  return submission('mint', encodeCall(ETHEREUM_FUNCTIONS.mintCrates, ['uint256'], [quantity]), value);
}

function mintEvent(quantity = 1, paid = 5) {
  return event('CratesPurchased(address,uint256,uint256,uint256)', ['address'], [owner], ['uint256', 'uint256', 'uint256'], [111112, quantity, paid]);
}

function known(pending: EthereumSubmission = mint()): EthereumPendingTransaction {
  return { ...pending, hash: originalHash, transactionSender: relayer, nonce: '0x7', transactionCallHash: originalCallHash };
}

function fixture(logs: EthereumLog[] = [mintEvent()]) {
  const transactions = new Map<string, Record<string, unknown>>([[hash, {
    hash, from: relayer, to: owner, input: '0x12345678', value: '0x0', nonce: '0x7', chainId: '0x7a69',
  }]]);
  const state = {
    code: '0x6000', canonicalHash: blockHash,
    receipt: { transactionHash: hash, status: '0x1', blockNumber: '0x65', blockHash, logs } as Record<string, unknown> | null,
  };
  const calls: string[] = [];
  const provider: EIP1193Provider = { request: async ({ method, params }) => {
    calls.push(method);
    if (method === 'eth_getTransactionByHash') return transactions.get((params as string[])[0]) ?? null;
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getTransactionReceipt') return state.receipt;
    if (method === 'eth_getBlockByNumber') return { hash: state.canonicalHash };
    throw new Error(`Unexpected ${method}`);
  } };
  return { state, calls, transactions, provider,
    recover: (pending: EthereumSubmission | EthereumPendingTransaction = known(), assertCurrent = () => {}) =>
      recoverEthereumTransaction({ provider, config, owner, pending, transactionHash: hash, assertCurrent }),
  };
}

const originalCallHash = (await readEthereumSubmittedTransaction(fixture().provider, hash, config.chainId, owner, mint().intent!))!.transactionCallHash;

test('contract-wallet recovery binds every supported action to its emitted collection event', async t => {
  const receiptIds = ['2000001', '1000001'];
  const receiptHash = ethereumReceiptIdsHash(receiptIds);
  const cases: Array<{ name: string; pending: EthereumSubmission; log: EthereumLog }> = [
    { name: 'crate mint', pending: mint(), log: mintEvent() },
    { name: 'warehouse mint', pending: submission('mint', encodeCall(ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [2]), '0x16'),
      log: event('WarehousesPurchased(address,uint256,uint256,uint256)', ['address'], [owner], ['uint256', 'uint256', 'uint256'], [116667, 2, 22]) },
    { name: 'crate opening', pending: submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112])),
      log: event('CrateUnboxed(uint256,address,uint256,uint256)', ['uint256', 'address'], [111112, owner], ['uint256', 'uint256'], [1, 20]) },
    { name: 'batch crate opening', pending: submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[116666, 111112]])),
      log: event('CratesUnboxed(address,bytes32,uint256,uint256)', ['address', 'bytes32'], [owner, ethereumTokenIdsHash([116666, 111112])], ['uint256', 'uint256'], [1, 51]) },
    { name: 'warehouse opening', pending: submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [116667])),
      log: event('WarehouseUnboxed(uint256,address,uint256,uint256)', ['uint256', 'address'], [116667, owner], ['uint256', 'uint256'], [111112, 11]) },
    { name: 'delivery', pending: { ...submission('delivery', encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery,
      ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], [[111112, 1], [42, owner, 5, 2000, receiptHash], '0x11']), '0x5'), orderId: 42 },
      log: event('DeliveryRedeemed(uint256,address,uint256,uint256[],uint256[])', ['uint256', 'address'], [42, owner],
        ['uint256', 'uint256[]', 'uint256[]'], [5, [111112, 1], receiptIds]) },
    { name: 'crate receipt claim', pending: { ...submission('claim', encodeCall(ETHEREUM_FUNCTIONS.claimCrateReceipt,
      ['uint256', 'bytes32', 'uint256', 'bytes'], [2000001, claimId, 2000, '0x11'])), claimId },
      log: event('CrateReceiptClaimed(bytes32,address,uint256,uint256[])', ['bytes32', 'address', 'uint256'], [claimId, owner, 2000001],
        ['uint256[]'], [Array.from({ length: 20 }, (_, index) => 1000001 + index)]) },
    { name: 'receipt transfer', pending: submission('transfer', encodeCall(ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256'], [owner, recipient, 2000001])),
      log: event('Transfer(address,address,uint256)', ['address', 'address', 'uint256'], [owner, recipient, 2000001], [], []) },
  ];
  for (const { name, pending, log } of cases) await t.test(name, async () => {
    const f = fixture([log]);
    const request = pending.action === 'mint' || pending.action === 'transfer' ? known(pending) : pending;
    f.state.receipt!.blockNumber = '0x1';
    const recovered = await f.recover(request);
    assert.equal(recovered.hash, hash);
    assert.equal(recovered.action, pending.action);
    assert.equal(recovered.nonce, '0x7');
    assert.equal(recovered.transactionSender, relayer);
    assert.equal(recovered.transactionCallHash, originalCallHash);
    if (['unbox', 'delivery', 'claim'].includes(pending.action)) {
      const recorded = known(pending);
      const original = f.transactions.get(hash)!;
      for (const changed of [{ from: recipient }, { nonce: '0x8' }, { from: recipient, nonce: '0x8' }]) {
        f.transactions.set(hash, { ...original, ...changed });
        const rebundled = await f.recover(recorded);
        assert.equal(rebundled.hash, hash);
        assert.equal(rebundled.transactionSender, changed.from ?? relayer);
        assert.equal(rebundled.nonce, changed.nonce ?? '0x7');
      }
      assert.equal((await f.recover({ ...pending, hash: originalHash })).hash, hash);
      f.state.receipt!.logs = [{ ...log, topics: log.topics.map((value, index) => index === 2 ? encodeAbi(['address'], [recipient]) : value) }];
      await assert.rejects(f.recover(recorded), /does not contain/);
      f.state.receipt!.logs = [log];
      f.state.receipt!.status = '0x0';
      await assert.rejects(f.recover(recorded), /did not succeed/);
      f.state.receipt!.status = '0x1';
      f.state.canonicalHash = originalHash;
      await assert.rejects(f.recover(recorded), /canonical chain/);
      f.state.canonicalHash = blockHash;
    }
    f.state.receipt!.logs = [{ ...log, address: recipient }];
    await assert.rejects(f.recover(request), /does not contain/);
  });
});

test('a partial batch cannot recover a contract-wallet unbox submission or replacement', async () => {
  const ids = [111113, 111112];
  const pending = submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [ids]));
  const individual = ids.map((id, index) => event('CrateUnboxed(uint256,address,uint256,uint256)',
    ['uint256', 'address'], [id, owner], ['uint256', 'uint256'], [index * 20 + 1, 20]));
  const summary = event('CratesUnboxed(address,bytes32,uint256,uint256)', ['address', 'bytes32'],
    [owner, ethereumTokenIdsHash(ids)], ['uint256', 'uint256'], [1, 40]);
  const f = fixture(individual);
  for (const request of [pending, known(pending)]) {
    f.state.receipt!.logs = individual;
    await assert.rejects(f.recover(request), /does not contain/);
    f.state.receipt!.logs = [...individual, summary];
    assert.equal((await f.recover(request)).hash, hash);
    f.state.receipt!.logs = [summary, summary];
    await assert.rejects(f.recover(request), /does not contain/);
  }
});

test('EOA batch replacement preserves the exact ordered calldata and recognizes a wallet cancellation', async () => {
  const intent = submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[111113, 111112]]));
  const pending: EthereumPendingTransaction = { ...intent, hash: originalHash, nonce: '0x7' };
  const f = fixture();
  const candidate = { ...f.transactions.get(hash)!, from: owner, to: contract, input: intent.intent!.data };
  f.transactions.set(hash, candidate);
  assert.equal((await f.recover(pending)).action, 'unbox');
  f.transactions.set(hash, { ...candidate, input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[111112, 111113]]) });
  await assert.rejects(f.recover(pending), /changes the original/);
  f.transactions.set(hash, { ...candidate, to: owner, input: '0x', value: '0x0' });
  const cancelled = await f.recover(pending);
  assert.equal(cancelled.action, 'cancel');
  assert.equal(cancelled.actionBeforeCancellation, 'unbox');
  assert.equal(cancelled.intent?.data, intent.intent?.data);
});

test('wrapped recovery rejects unrelated wallet, amount, quantity, operation and ambiguous events', async () => {
  const f = fixture();
  await assert.rejects(f.recover(known(mint(2))), /does not contain/);
  await assert.rejects(f.recover(known(mint(1, '0x6'))), /does not contain/);
  await assert.rejects(f.recover(submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]))), /does not contain/);
  f.state.receipt!.logs = [{ ...mintEvent(), topics: [mintEvent().topics[0], encodeAbi(['address'], [recipient])] }];
  await assert.rejects(f.recover(), /does not contain/);
  f.state.receipt!.logs = [mintEvent(), mintEvent()];
  await assert.rejects(f.recover(), /does not contain/);
  f.state.receipt!.logs = [{ ...mintEvent(), removed: true }];
  await assert.rejects(f.recover(), /does not contain/);
});

test('delivery recovery binds order, original token order, fee and expected receipt identities', async () => {
  const makePending = (ids: number[], receipts: number[], fee = 5, orderId = 42) => ({ ...submission('delivery',
    encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery, ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
      [ids, [orderId, owner, fee, 2000, ethereumReceiptIdsHash(receipts)], '0x11']), `0x${fee.toString(16)}`), orderId });
  const f = fixture([event('DeliveryRedeemed(uint256,address,uint256,uint256[],uint256[])', ['uint256', 'address'], [42, owner],
    ['uint256', 'uint256[]', 'uint256[]'], [5, [111112, 1], [2000001, 1000001]])]);
  for (const pending of [makePending([1, 111112], [2000001, 1000001]), makePending([111112, 1], [2000001, 1000021]),
    makePending([111112, 1], [2000001, 1000001], 6), makePending([111112, 1], [2000001, 1000001], 5, 43)]) {
    await assert.rejects(f.recover(pending), /does not contain/);
  }
});

test('wrapped recovery requires deployed wallet code, a successful canonical inclusion and a current account', async () => {
  const f = fixture();
  f.state.code = '0x';
  await assert.rejects(f.recover(), /original Ethereum transaction sender/);
  f.state.code = '0x6000';
  f.state.receipt!.status = '0x0';
  await assert.rejects(f.recover(), /did not succeed/);
  f.state.receipt!.status = '0x1';
  f.state.canonicalHash = originalHash;
  await assert.rejects(f.recover(), /canonical chain/);
  f.state.canonicalHash = blockHash;
  f.state.receipt = null;
  await assert.rejects(f.recover(), /Wait until.*mined/);
  await assert.rejects(f.recover(known(), () => { throw new Error('account changed'); }), /account changed/);
});

test('an older matching mint cannot recover a lost hash even above a stale saved checkpoint', async () => {
  const f = fixture();
  const pending = { ...mint(), submittedAt: 100_000, submittedAfterBlock: '0x64' };
  f.state.receipt!.blockNumber = '0x65';
  await assert.rejects(f.recover(pending), /Cannot safely recover this contract-wallet mint or transfer without its original transaction hash/);
});

test('a repeated matching transfer cannot recover a contract-wallet submission without its original hash', async () => {
  const pending = submission('transfer', encodeCall(ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256'], [owner, recipient, 2000001]));
  const f = fixture([event('Transfer(address,address,uint256)', ['address', 'address', 'uint256'], [owner, recipient, 2000001], [], [])]);
  await assert.rejects(f.recover(pending), /Cannot safely recover this contract-wallet mint or transfer without its original transaction hash/);
});

test('known wrapped replacements accept canonical inclusion below former checkpoints and legacy records without one', async () => {
  const f = fixture();
  for (const blockNumber of ['0x63', '0x64']) {
    f.state.receipt!.blockNumber = blockNumber;
    const checkpointed = { ...known(), submittedAfterBlock: '0x64' };
    assert.equal((await f.recover(checkpointed)).hash, hash);
    assert.equal((await f.recover(known())).hash, hash);
  }
});

test('a receipt alone cannot bypass transaction sender and nonce validation', async () => {
  const f = fixture();
  f.transactions.delete(hash);
  const pending = submission('unbox', encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]));
  await assert.rejects(f.recover({ ...pending, nonce: '0x8' }), /not visible yet/);
  assert.equal(f.calls.includes('eth_getTransactionReceipt'), false);
});

test('known wrapped replacements retain the original sender and nonce proof even if its transaction was dropped', async () => {
  const f = fixture();
  const pending = known();
  assert.equal((await f.recover(pending)).hash, hash);
  await assert.rejects(f.recover({ ...pending, nonce: '0x6' }), /does not replace/);
  await assert.rejects(f.recover({ ...pending, transactionSender: recipient }), /does not replace/);
  const { transactionSender: _sender, ...uncached } = pending;
  await assert.rejects(f.recover(uncached), /original transaction is no longer available/);
  f.transactions.set(originalHash, { ...f.transactions.get(hash), hash: originalHash });
  assert.equal((await f.recover(uncached)).hash, hash);
  f.transactions.set(hash, { ...f.transactions.get(hash), from: recipient });
  await assert.rejects(f.recover(uncached), /does not replace/);
});

test('a matching mint event cannot replace a known wrapped call with a different destination, calldata or value', async () => {
  for (const changed of [{ to: recipient }, { input: '0x5678' }, { value: '0x1' }]) {
    const f = fixture();
    f.transactions.set(hash, { ...f.transactions.get(hash), ...changed });
    await assert.rejects(f.recover(known()), /The replacement changes the original contract-wallet transaction/);
  }
});

test('repeatable wrapped replacements require the original call commitment or an available original transaction', async () => {
  const f = fixture();
  const { transactionCallHash: _call, ...legacy } = known();
  await assert.rejects(f.recover(legacy), /original transaction is no longer available|original.*call/i);
  f.transactions.set(originalHash, { ...f.transactions.get(hash), hash: originalHash });
  assert.equal((await f.recover(legacy)).hash, hash);
});

test('EOA reservation and replacement nonce guards cannot fall back to events even with delegated code', async () => {
  const f = fixture();
  f.transactions.set(hash, { ...f.transactions.get(hash), from: owner, to: contract, input: mint().intent!.data, value: '0x5' });
  assert.equal((await f.recover({ ...mint(), nonce: '0x6' })).nonce, '0x7');
  assert.equal(f.calls.includes('eth_getCode'), false);
  await assert.rejects(f.recover({ ...mint(), nonce: '0x8' }), /request nonce/);
  assert.equal((await f.recover({ ...mint(), hash: originalHash, nonce: '0x7' })).hash, hash);
  await assert.rejects(f.recover({ ...mint(), hash: originalHash, nonce: '0x6' }), /does not replace/);
  await assert.rejects(f.recover({ ...mint(), hash: originalHash, nonce: '0x7', transactionSender: relayer }), /original Ethereum transaction sender/);
});

test('submission capture caches the real outer nonce for wrapped wallets without weakening direct intent validation', async () => {
  const f = fixture();
  assert.deepEqual(await readEthereumSubmittedTransaction(f.provider, hash, config.chainId, owner, mint().intent!),
    { nonce: '0x7', transactionSender: relayer, transactionCallHash: originalCallHash });
  f.state.code = '0x';
  await assert.rejects(readEthereumSubmittedTransaction(f.provider, hash, config.chainId, owner, mint().intent!), /wallet or network/);
  f.transactions.set(hash, { ...f.transactions.get(hash), from: owner, to: contract, input: mint().intent!.data, value: '0x5' });
  const direct = await readEthereumSubmittedTransaction(f.provider, hash, config.chainId, owner, mint().intent!);
  assert.equal(direct?.nonce, '0x7');
  assert.equal(direct?.transactionSender, owner);
  assert.match(direct!.transactionCallHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(direct?.transactionCallHash, originalCallHash);
  await assert.rejects(readEthereumSubmittedTransaction(f.provider, hash, config.chainId, owner, mint(2).intent!), /changes the saved/);
});
