import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { encodeAbi, encodeCall, decodeReturn } from '../../../shared/ethereum/abi.ts';
import {
  signDigest, ethereumSignerAddress, ethereumReceiptIdsHash, deliveryDigest, crateClaimDigest,
} from '../../../shared/ethereum/crypto.ts';

export const RECEIPT_WALLET_SOURCE = `pragma solidity 0.8.30;

contract ReceiptWallet {
    function run(address target, bytes[] calldata calls, uint256[] calldata values) external payable {
        require(calls.length == values.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory result) = target.call{value: values[i]}(calls[i]);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
`;

const hex = value => `0x${BigInt(value).toString(16)}`;
const address = value => `0x${BigInt(value).toString(16).padStart(40, '0')}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const range = (start, length) => Array.from({ length }, (_, index) => start + index);
const bytecode = artifact => {
  const code = artifact.bytecode.object.replace(/^0x/, '');
  assert.ok(code.length > 0 && code.length % 2 === 0 && /^[0-9a-f]+$/i.test(code), 'Invalid creation bytecode');
  return `0x${code}`;
};

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function measureReceiptGas({ variants, walletArtifact, environment }) {
  assert.deepEqual(variants.map(variant => variant.name), ['reference', 'candidate']);
  assert.deepEqual(variants[0].artifact.abi, variants[1].artifact.abi, 'Receipt variants have different ABIs');
  for (const variant of variants) bytecode(variant.artifact);
  const walletCreation = bytecode(walletArtifact);
  let requestId = 0;

  async function rpc(method, params = []) {
    if (startupError) throw startupError;
    if (closed) throw new Error(`Anvil stopped: ${stderr}`);
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (!response.ok || body.error || body.result === undefined) {
      throw Object.assign(new Error(`${method}: ${body.error?.message ?? response.status}`), { rpcError: body.error });
    }
    return body.result;
  }

  async function receipt(transactionHash, expectedStatus) {
    for (let attempt = 0; attempt < 100; ++attempt) {
      const value = await rpc('eth_getTransactionReceipt', [transactionHash]);
      if (value) {
        assert.equal(value.status, expectedStatus, `Unexpected receipt status: ${transactionHash}`);
        return value;
      }
      await delay(10);
    }
    throw new Error(`Receipt timeout: ${transactionHash}`);
  }

  async function rawSend(from, data, to, value = 0n, status = '0x1') {
    const transaction = { from, data, gas: hex(16_000_000), gasPrice: hex(2_000_000_000), value: hex(value), ...(to ? { to } : {}) };
    return receipt(await rpc('eth_sendTransaction', [transaction]), status);
  }

  const signerKey = `0x${'a11ce'.padStart(64, '0')}`;
  const signer = ethereumSignerAddress(signerKey);
  const cratePrice = 100_000_000_000_000n;
  const warehousePrice = 1_100_000_000_000_000n;
  const monumentPrice = 8_800_000_000_000_000n;
  const discountPrice = 50_000_000_000_000n;
  const metadata = 'https://cdn.mons.shop/111k-sepolia/optimizer-study/';
  const transferTopic = `0x${bytesToHex(keccak_256(new TextEncoder().encode('Transfer(address,address,uint256)')))}`;
  let admin, buyer, other, helper, collection, discountRoot, context;

  async function call(signature, types = [], args = [], returns = ['uint256']) {
    return decodeReturn(returns, await rpc('eth_call', [{ to: collection, data: encodeCall(signature, types, args) }, 'latest']));
  }

  async function transact(label, signature, types, args, value = 0n, from = buyer, to = collection, status = '0x1') {
    const data = encodeCall(signature, types, args);
    await rpc('evm_setNextBlockTimestamp', [++context.time]);
    const result = await rawSend(from, data, to, value, status);
    const logs = result.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data }));
    for (const log of result.logs) {
      if (log.address.toLowerCase() === collection.toLowerCase() && log.topics[0] === transferTopic) {
        context.touched.add(BigInt(log.topics[3]).toString());
      }
    }
    const input = { from, to, data, value: value.toString(), timestamp: context.time, status: result.status };
    context.trace.push({ ...input, logs });
    if (label) {
      const gasUsed = Number(BigInt(result.gasUsed));
      assert.ok(Number.isSafeInteger(gasUsed) && gasUsed > 0, 'Invalid receipt gas');
      context.records.push({ name: `${context.name}/${label}`, gasUsed, ...input });
    }
    return result;
  }

  const mint = (quantity, label = null, from = buyer) =>
    transact(label, 'mintCrates(uint256)', ['uint256'], [quantity], cratePrice * BigInt(quantity), from);
  const warehouse = (quantity, label = null) =>
    transact(label, 'mintWarehouses(uint256)', ['uint256'], [quantity], warehousePrice * BigInt(quantity));
  const monument = (quantity, label = null) =>
    transact(label, 'mintMonuments(uint256)', ['uint256'], [quantity], monumentPrice * BigInt(quantity));
  const free = (kind, quantity, label) => transact(label, 'mintFree(uint8,uint256)', ['uint8', 'uint256'], [kind, quantity]);
  const open = (id, label = null) => transact(label, 'unboxCrate(uint256)', ['uint256'], [id]);

  async function walletCall(label, signatures, types, args, values) {
    return transact(label, 'run(address,bytes[],uint256[])', ['address', 'bytes[]', 'uint256[]'],
      [collection, signatures.map((signature, index) => encodeCall(signature, types[index], args[index])), values],
      values.reduce((total, value) => total + value, 0n), buyer, helper);
  }

  async function bonusSetup() {
    for (let index = 0; index < 33; ++index) await warehouse(15);
    await warehouse(10);
    await transact(null, 'unboxWarehouse(uint256)', ['uint256'], [117171]);
  }

  async function deliver(ids, label = null, orderId = 1n) {
    const receiptIds = [];
    for (const id of ids) {
      const [kind, displayId] = await call('getTokenInfo(uint256)', ['uint256'], [id], ['uint8', 'uint256', 'address']);
      receiptIds.push((kind === 1n ? 1_000_000n : kind === 2n ? 2_000_000n : 3_000_000n) + displayId);
    }
    const deadline = context.time + 300;
    const receiptIdsHash = ethereumReceiptIdsHash(receiptIds);
    const signature = signDigest(signerKey, deliveryDigest({
      chainId: 31337, contractAddress: collection, wallet: buyer, tokenIds: ids, orderId,
      fee: cratePrice, deadline, receiptIdsHash,
    }));
    await transact(label, 'redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)',
      ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
      [ids, [orderId, buyer, cratePrice, deadline, receiptIdsHash], signature], cratePrice);
    return receiptIds;
  }

  async function claim(id, label) {
    const [receiptId] = await deliver([id]);
    const claimId = `0x${'5a'.repeat(32)}`;
    const deadline = context.time + 300;
    const signature = signDigest(signerKey, crateClaimDigest({
      chainId: 31337, contractAddress: collection, wallet: buyer, receiptId, claimId, deadline,
    }));
    await transact(label, 'claimCrateReceipt(uint256,bytes32,uint256,bytes)',
      ['uint256', 'bytes32', 'uint256', 'bytes'], [receiptId, claimId, deadline, signature]);
  }

  const cases = [];
  for (const quantity of [1, 2, 5, 10, 15]) {
    cases.push({ name: `mint-crates-${quantity}`, run: async () => {
      await mint(quantity, 'first');
      await mint(quantity, 'repeat');
      await warehouse(1);
      await mint(quantity, 'after-warehouse');
    } });
  }
  for (const quantity of [1, 5, 15]) {
    cases.push({ name: `mint-warehouses-${quantity}`, run: async () => {
      await warehouse(quantity, 'first');
      await warehouse(quantity, 'repeat');
      await mint(1);
      await warehouse(quantity, 'after-crate');
    } });
    cases.push({ name: `mint-monuments-${quantity}`, run: async () => {
      await monument(quantity, 'first');
      await monument(Math.min(18 - quantity, quantity), 'repeat');
    } });
  }
  for (const quantity of [1, 10]) {
    cases.push({ name: `discount-${quantity}`, run: () => transact('claim', 'mintCratesDiscounted(uint256,bytes32[])',
      ['uint256', 'bytes32[]'], [quantity, []], discountPrice * BigInt(quantity)) });
  }
  for (const [kind, name] of [[2, 'crate'], [3, 'warehouse'], [6, 'monument']]) {
    for (const quantity of [1, 15]) {
      cases.push({ name: `free-${name}-${quantity}`, run: async () => {
        await free(kind, quantity, 'first');
        await free(kind, kind === 6 ? Math.min(quantity, 18 - quantity) : quantity, 'repeat');
      } });
    }
  }
  cases.push({ name: 'unbox-ordinary', run: async () => {
    await mint(2);
    await open(111112, 'first20');
    await open(111113, 'repeat20');
  } });
  cases.push({ name: 'unbox-batch15', run: async () => {
    await mint(15);
    await transact('batch300', 'unboxCrates(uint256[])', ['uint256[]'], [range(111112, 15)]);
  } });
  cases.push({ name: 'unbox-warehouse', run: async () => {
    await warehouse(1);
    await transact('unbox11', 'unboxWarehouse(uint256)', ['uint256'], [116667]);
  } });
  cases.push({ name: 'unbox-monument', run: async () => {
    await monument(1);
    await transact('unbox111', 'unboxMonument(uint256)', ['uint256'], [117172]);
  } });
  cases.push({ name: 'unbox-bonus31', run: async () => {
    await bonusSetup();
    await open(116666, 'unbox31');
  } });
  cases.push({ name: 'unbox-bonus-batch15', run: async () => {
    await bonusSetup();
    await transact(null, 'unboxWarehouse(uint256)', ['uint256'], [117170]);
    await transact('batch311', 'unboxCrates(uint256[])', ['uint256[]'], [range(116652, 15)]);
  } });
  for (const descending of [false, true]) {
    cases.push({ name: `delivery50-art-${descending ? 'descending' : 'ascending'}`, run: async () => {
      await mint(3);
      for (let id = 111112; id < 111115; ++id) await open(id);
      const ids = range(1, 50);
      await deliver(descending ? ids.reverse() : ids, 'delivery50');
    } });
  }
  cases.push({ name: 'delivery50-crates', run: async () => {
    for (let index = 0; index < 3; ++index) await mint(15);
    await mint(5);
    await deliver(range(111112, 50), 'delivery50');
  } });
  cases.push({ name: 'delivery50-mixed', run: async () => {
    await mint(15);
    await mint(11);
    await open(111112);
    await open(111113);
    await deliver([...range(1, 26), ...range(111114, 24)], 'delivery50');
  } });
  cases.push({ name: 'delivery-monument', run: async () => {
    await monument(1);
    await deliver([117172], 'delivery1');
  } });
  cases.push({ name: 'claim20', run: async () => {
    await mint(1);
    await claim(111112, 'claim20');
  } });
  cases.push({ name: 'claim31', run: async () => {
    await bonusSetup();
    await claim(116666, 'claim31');
  } });
  cases.push({ name: 'approvals-transfers', run: async () => {
    await mint(3);
    await transact('approve-first', 'approve(address,uint256)', ['address', 'uint256'], [other, 111112]);
    await transact('approved-transfer', 'transferFrom(address,address,uint256)', ['address', 'address', 'uint256'],
      [buyer, other, 111112], 0n, other);
    await transact('approval-for-all-first', 'setApprovalForAll(address,bool)', ['address', 'bool'], [other, true]);
    await transact('operator-safe-transfer', 'safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'],
      [buyer, other, 111113], 0n, other);
    await transact('approval-for-all-revoke', 'setApprovalForAll(address,bool)', ['address', 'bool'], [other, false]);
    await transact('owner-safe-transfer', 'safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'],
      [buyer, other, 111114]);
  } });
  cases.push({ name: 'admin', run: async () => {
    const priceTypes = ['uint256', 'uint256', 'uint256', 'uint256'];
    await transact('prices', 'setPrices(uint256,uint256,uint256,uint256)', priceTypes,
      [2n * cratePrice, 2n * warehousePrice, discountPrice, 2n * monumentPrice], 0n, admin);
    await transact('prices-zero', 'setPrices(uint256,uint256,uint256,uint256)', priceTypes, [0, 0, 0, 0], 0n, admin);
    for (const [label, signature, value] of [
      ['pause-sale', 'setSaleActive(bool)', false], ['resume-sale', 'setSaleActive(bool)', true],
      ['pause-redemptions', 'setRedemptionsPaused(bool)', true], ['resume-redemptions', 'setRedemptionsPaused(bool)', false],
    ]) await transact(label, signature, ['bool'], [value], 0n, admin);
    await transact('discount-disable', 'setDiscountConfig(bytes32,uint256)', ['bytes32', 'uint256'],
      [`0x${'0'.repeat(64)}`, 10], 0n, admin);
    await transact('discount-enable', 'setDiscountConfig(bytes32,uint256)', ['bytes32', 'uint256'], [discountRoot, 10], 0n, admin);
    const wallets = Array.from({ length: 32 }, (_, index) => address(0xd000 + index));
    for (const [label, crates, warehouses, monuments] of [['first', 100, 1, 1], ['update', 120, 2, 2], ['revoke', 0, 0, 0]]) {
      await transact(`free-config32-${label}`, 'setFreeMintAllowances(address[],uint16,uint16,uint16)',
        ['address[]', 'uint16', 'uint16', 'uint16'], [wallets, crates, warehouses, monuments], 0n, admin);
    }
    for (const length of [100, 256, 1024]) {
      await transact(`base-uri-${length}`, 'setBaseURI(string)', ['string'], [`https://${'a'.repeat(length - 9)}/`], 0n, admin);
    }
    await transact('base-uri-short', 'setBaseURI(string)', ['string'], [metadata], 0n, admin);
    await transact('quote-signer', 'setQuoteSigner(address)', ['address'], [other], 0n, admin);
    await transact('delivery-receiver', 'setDeliveryPaymentReceiver(address)', ['address'], [address(0xfee2)], 0n, admin);
    await transact('transfer-ownership', 'transferOwnership(address)', ['address'], [other], 0n, admin);
    await transact('accept-ownership', 'acceptOwnership()', [], [], 0n, other);
  } });
  cases.push({ name: 'payouts', run: async () => {
    await mint(1);
    await transact('mint-release-first', 'releaseAllMint()', [], [], 0n, other);
    await mint(1);
    await transact('mint-release-repeat', 'releaseAllMint()', [], [], 0n, other);
    await deliver([111112]);
    await transact('delivery-release-first', 'releaseDelivery()', [], [], 0n, other);
    await deliver([111113], null, 2n);
    await transact('delivery-release-repeat', 'releaseDelivery()', [], [], 0n, other);
  } });
  cases.push({ name: 'wallet-warm-mints', run: async () => {
    await walletCall('mint-two', ['mintCrates(uint256)', 'mintCrates(uint256)'],
      [['uint256'], ['uint256']], [[1], [1]], [cratePrice, cratePrice]);
    await walletCall('free-two', ['mintFree(uint8,uint256)', 'mintFree(uint8,uint256)'],
      [['uint8', 'uint256'], ['uint8', 'uint256']], [[2, 1], [2, 1]], [0n, 0n]);
  } });
  cases.push({ name: 'wallet-unbox-batch15', run: async () => {
    await walletCall(null, ['mintCrates(uint256)'], [['uint256']], [[15]], [15n * cratePrice]);
    await walletCall('batch300', ['unboxCrates(uint256[])'], [['uint256[]']], [[range(111112, 15)]], [0n]);
  } });
  cases.push({ name: 'admin-canonical', run: async () => {
    const prefix = 'https://cdn.mons.shop/111k-sepolia/';
    for (const length of [40, 100, 256, 1024]) {
      await transact(`base-uri-${length}`, 'setBaseURI(string)', ['string'],
        [`${prefix}${'a'.repeat(length - prefix.length - 1)}/`], 0n, admin);
    }
  } });
  cases.push({ name: 'invalid-uris', run: async () => {
    const invalid = [
      ['empty', ''], ['missing-slash', 'https://a'], ['non-http', 'ftp://example.test/'], ['empty-host', 'https:///a/'],
      ['query', 'https://a/?/'], ['fragment', 'https://a/#/'], ['at-sign', 'https://a/@/'], ['backslash', 'https://a/\\/'],
      ['space', 'https://a/ /'], ['control', 'https://a/\u0001/'], ['nonascii', 'https://a/é/'],
      ['long-query', `https://a/${'x'.repeat(1024)}?/`],
    ];
    for (const [label, uri] of invalid) {
      const data = encodeCall('setBaseURI(string)', ['string'], [uri]);
      let reason;
      try { await rpc('eth_call', [{ from: admin, to: collection, data }, 'latest']); }
      catch (error) { reason = error.rpcError?.data; }
      assert.equal(reason, encodeCall('InvalidBaseURI()', [], []), `${label}: revert selector`);
      await transact(label, 'setBaseURI(string)', ['string'], [uri], 0n, admin, collection, '0x0');
    }
  } });
  assert.equal(cases.length, 39, 'Receipt scenario coverage changed');
  assert.equal(new Set(cases.map(value => value.name)).size, cases.length, 'Duplicate receipt scenario');

  async function state() {
    const result = {};
    for (const name of [
      'allocatedCrates', 'warehousesMinted', 'monumentsMinted', 'totalSupply', 'totalMintReceived', 'totalMintReleased',
      'totalDeliveryReceived', 'totalDeliveryReleased', 'cratePrice', 'warehousePrice', 'discountCratePrice', 'monumentPrice',
    ]) result[name] = (await call(`${name}()`))[0].toString();
    result.balance = await rpc('eth_getBalance', [collection, 'latest']);
    result.wallets = [];
    for (const wallet of [buyer, other, helper]) {
      result.wallets.push({
        wallet, balance: (await call('balanceOf(address)', ['address'], [wallet]))[0].toString(),
        discountUsed: (await call('discountUsed(address)', ['address'], [wallet]))[0].toString(),
        free: (await call('freeMintAllowances(address)', ['address'], [wallet], Array(6).fill('uint16'))).map(String),
      });
    }
    for (const name of ['owner', 'quoteSigner', 'deliveryPaymentReceiver']) result[name] = (await call(`${name}()`, [], [], ['address']))[0];
    for (const name of ['saleActive', 'redemptionsPaused']) result[name] = (await call(`${name}()`, [], [], ['bool']))[0];
    result.baseURI = (await call('baseURI()', [], [], ['string']))[0];
    const ids = [...context.touched].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const ownership = [];
    for (let offset = 0; offset < ids.length; offset += 150) {
      ownership.push(...(await call('getTokenInfos(uint256[])', ['uint256[]'], [ids.slice(offset, offset + 150)], ['(uint8,uint256,address)[]']))[0]);
    }
    result.ownership = ownership.map(row => row.map(String));
    assert.ok(BigInt(result.allocatedCrates) <= 5555n);
    assert.ok(BigInt(result.monumentsMinted) <= 18n);
    return result;
  }

  const result = {
    method: 'Actual Prague transaction receipts with a fixed 16M gas limit and 2 gwei gas price, without estimates. '
      + 'Identical addresses, calldata, timestamps, signatures and application state across variants. '
      + 'Each scenario resets to its starting snapshot; complete input/event traces and final state match. '
      + 'Sender ETH balances are excluded because gas costs intentionally differ.',
    repetitions: 2, caseCount: 39, operationCount: 106,
    walletRuntimeSha256: hash(walletArtifact.deployedBytecode.object),
    gas: {}, statuses: {}, variants: [],
  };
  const port = await unusedPort();
  const anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'prague', '--silent',
  ], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  let stderr = '';
  let closed = false;
  const stopped = new Promise(resolve => anvil.once('close', () => { closed = true; resolve(); }));
  anvil.on('error', error => { startupError = error; });
  anvil.stderr.on('data', chunk => { stderr += String(chunk); });
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; ; ++attempt) {
      try { [admin, buyer, other] = await rpc('eth_accounts'); break; }
      catch (error) {
        if (attempt >= 100 || startupError || closed) throw error;
        await delay(25);
      }
    }
    assert.ok(admin && buyer && other, 'Anvil did not provide the benchmark accounts');
    discountRoot = `0x${bytesToHex(keccak_256(keccak_256(hexToBytes(encodeAbi(['address'], [buyer]).slice(2)))))}`;
    let emptySnapshot = await rpc('evm_snapshot');
    const expected = new Map();
    for (const variant of variants) {
      const measuredVariant = { name: variant.name, repetitions: [] };
      result.variants.push(measuredVariant);
      for (let repetition = 0; repetition < 2; ++repetition) {
        assert.equal(await rpc('evm_revert', [emptySnapshot]), true);
        emptySnapshot = await rpc('evm_snapshot');
        await rpc('evm_setNextBlockTimestamp', [2_000_000_000]);
        helper = (await rawSend(admin, walletCreation)).contractAddress;
        await rpc('evm_setNextBlockTimestamp', [2_000_000_001]);
        const args = encodeAbi(
          ['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]', '(address,uint16,uint16,uint16)[]'],
          [admin, signer, address(0xfee), metadata, discountRoot, [address(0xa0001), address(0xa0002)], [6000, 4000],
            [[buyer, 5555, 505, 18], [helper, 5555, 505, 18]]],
        );
        const deployment = await rawSend(admin, bytecode(variant.artifact) + args.slice(2));
        collection = deployment.contractAddress;
        assert.ok(collection && helper, 'Missing deployment address');
        if (result.collection) {
          assert.equal(collection, result.collection);
          assert.equal(helper, result.helper);
        } else {
          result.collection = collection;
          result.helper = helper;
        }
        context = { name: 'setup', time: 2_000_000_001, records: [], trace: [], touched: new Set() };
        await transact(null, 'setSaleActive(bool)', ['bool'], [true], 0n, admin);
        await transact(null, 'setDiscountConfig(bytes32,uint256)', ['bytes32', 'uint256'], [discountRoot, 10], 0n, admin);
        let configuredSnapshot = await rpc('evm_snapshot');
        const measured = { repetition, deploymentGasUsed: Number(BigInt(deployment.gasUsed)), cases: [] };
        measuredVariant.repetitions.push(measured);
        for (const [index, scenario] of cases.entries()) {
          assert.equal(await rpc('evm_revert', [configuredSnapshot]), true);
          configuredSnapshot = await rpc('evm_snapshot');
          context = { name: scenario.name, time: 2_000_001_000 + index * 1000, records: [], trace: [], touched: new Set() };
          await scenario.run();
          const finalState = await state();
          const witnessed = { trace: context.trace, state: finalState };
          if (!expected.has(scenario.name)) expected.set(scenario.name, witnessed);
          else assert.deepEqual(witnessed, expected.get(scenario.name), `${variant.name}/${repetition}/${scenario.name}: input/event/state mismatch`);
          measured.cases.push({
            name: scenario.name, transactions: context.trace.length, traceSha256: hash(JSON.stringify(context.trace)),
            stateSha256: hash(JSON.stringify(finalState)), records: context.records,
          });
        }
        const records = measured.cases.flatMap(scenario => scenario.records);
        assert.equal(records.length, result.operationCount, 'Receipt operation coverage changed');
        assert.equal(new Set(records.map(record => record.name)).size, records.length, 'Duplicate receipt operation');
        assert.equal(records.filter(record => record.status === '0x0').length, 12, 'Expected-revert coverage changed');
        if (repetition === 1) {
          assert.equal(measured.deploymentGasUsed, measuredVariant.repetitions[0].deploymentGasUsed, 'Deployment repeat mismatch');
          assert.deepEqual(measured.cases, measuredVariant.repetitions[0].cases, `${variant.name}: receipt repeat mismatch`);
        }
        process.stderr.write(`Measured ${variant.name} receipts, repeat ${repetition + 1}: ${records.length} operations\n`);
      }
      const records = measuredVariant.repetitions[0].cases.flatMap(scenario => scenario.records);
      const statuses = Object.fromEntries(records.map(record => [record.name, record.status]));
      if (variant.name === 'reference') result.statuses = statuses;
      else assert.deepEqual(statuses, result.statuses, 'Receipt outcomes changed');
      result.gas[variant.name] = Object.fromEntries(records.map(record => [record.name, record.gasUsed]));
    }
    assert.deepEqual(Object.keys(result.gas.candidate), Object.keys(result.gas.reference), 'Receipt case coverage changed');
    return result;
  } finally {
    if (!closed) {
      if (anvil.pid) anvil.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (!closed && anvil.pid) anvil.kill('SIGKILL'); }, 5000);
      try { await stopped; }
      finally { clearTimeout(killTimer); }
    }
  }
}
