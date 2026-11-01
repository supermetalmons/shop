import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { encodeAbi, encodeCall, decodeReturn } from '../../../shared/ethereum/abi.ts';
import { signDigest, ethereumSignerAddress } from '../../../shared/ethereum/crypto.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const prototypePath = 'onchain/ethereum/benchmarks/reference/registered-prototype.sol';
const signedPath = 'onchain/ethereum/benchmarks/reference/signed-address.sol';
const scriptPath = 'onchain/ethereum/scripts/benchmark-registered-delivery.mjs';
const reportPath = 'onchain/ethereum/benchmarks/registered-delivery-reproduction.json';
if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/benchmark-registered-delivery.mjs [output.json]');
const outputPath = resolve(process.argv[2] || join(repositoryRoot, reportPath));
assert.ok(outputPath === join(repositoryRoot, reportPath) || !outputPath.startsWith(`${repositoryRoot}/`),
  'Custom report outputs must be outside the repository to protect the existing implementation');
const read = path => readFileSync(path, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const referenceCommit = 'd37e03bc17db5fb6b08463f6a61c84c6a7335c2c';
const historical = path => git(['show', `${referenceCommit}:${path}`]);
const protectedPaths = [prototypePath, signedPath, scriptPath, 'onchain/ethereum/src/NFT111K.sol',
  'onchain/ethereum/package-lock.json', 'package-lock.json', 'shared/ethereum/abi.ts', 'shared/ethereum/crypto.ts',
  'onchain/ethereum/benchmarks/registered-delivery.json', 'onchain/ethereum/benchmarks/delivery-routing.json'];
function implementationSnapshot() {
  return Object.fromEntries(protectedPaths.map(path => [path, hash(readFileSync(join(repositoryRoot, path)))]));
}
const before = implementationSnapshot();
const sources = {
  legacy: historical('onchain/ethereum/src/NFT111K.sol'),
  signed: read(join(repositoryRoot, signedPath)),
  registered: read(join(repositoryRoot, prototypePath)),
};
assert.equal(hash(sources.signed), '584193b2e5ba87983b35c694c2bd8cc51c972b9ae553e454d217a916e871d436');
assert.equal(hash(sources.registered), 'c423cc59f57b700516f8f302e8f546949dacf44605e76babf17d547e913d1b43');
assert.equal(historical('onchain/ethereum/package-lock.json'), read(join(packageRoot, 'package-lock.json')),
  'Dependency lock differs from the pinned original HEAD');
assert.deepEqual(Object.keys(process.env).filter(name => /^(FOUNDRY_|DAPP_)/.test(name)), [], 'Remove FOUNDRY_/DAPP_ overrides');
const settings = { solc: '0.8.30', optimizer: true, optimizerRuns: 500, viaIR: false, evm: 'prague', bytecodeHash: 'none' };
const temporaryRoot = mkdtempSync(join(tmpdir(), '111k-registered-delivery-'));
const hex = value => `0x${BigInt(value).toString(16)}`;
const address = value => `0x${BigInt(value).toString(16).padStart(40, '0')}`;
const zero = address(0);
const primary = address(0xbeef);
const secondary = address(0xfeed);
const fee = 100_000_000_000_000n;
const signerKey = `0x${'a11ce'.padStart(64, '0')}`;
const signer = ethereumSignerAddress(signerKey);
const digest = value => `0x${bytesToHex(keccak_256(typeof value === 'string' ? hexToBytes(value.slice(2)) : value))}`;
const textHash = text => digest(new TextEncoder().encode(text));
const range = (start, count) => Array.from({ length: count }, (_, index) => start + index);
const bytes = value => value.replace(/^0x/, '').length / 2;
const code = value => value.startsWith('0x') ? value : `0x${value}`;
const receiverSource = `pragma solidity 0.8.30;
contract RejectingReceiver { receive() external payable { revert(); } }
contract BurningReceiver { receive() external payable { assembly { invalid() } } }
`;

function build(name, source, contract = 'NFT111K') {
  const directory = join(temporaryRoot, name);
  mkdirSync(join(directory, 'src'), { recursive: true });
  writeFileSync(join(directory, 'src', `${contract}.sol`), source);
  symlinkSync(join(packageRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'foundry.toml'), `[profile.default]\nsrc = "src"\nout = "out"\ncache_path = "cache"\nlibs = ["node_modules"]\nsolc_version = "0.8.30"\noptimizer = true\noptimizer_runs = 500\nvia_ir = false\nevm_version = "prague"\nbytecode_hash = "none"\n`);
  execFileSync('forge', ['build', '--offline'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const artifact = JSON.parse(read(join(directory, 'out', `${contract}.sol`, `${contract}.json`)));
  return { artifact, directory };
}

function authorization(variant, collection, wallet, ids, orderId, deadline, route) {
  const receipts = ids.map(id => id >= 111112 ? 2_000_000 + id - 111111 : 1_000_000 + id);
  const receiptHash = digest(encodeAbi(['uint256[]'], [receipts]));
  const routingTypes = variant === 'legacy' ? [] : variant === 'signed' ? ['address', 'address', 'uint256'] : ['uint256'];
  const routingFields = variant === 'legacy' ? '' : variant === 'signed' ? ',address receiver1,address receiver2,uint256 amount2' : ',uint256 configId';
  const routingValues = variant === 'legacy' ? [] : variant === 'signed' ? [route.first, route.second, fee * BigInt(route.bps) / 10_000n] : [route.id];
  const structHash = digest(encodeAbi(
    ['bytes32', 'address', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', ...routingTypes],
    [textHash(`Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline${routingFields})`),
      wallet, digest(encodeAbi(['uint256[]'], [ids])), receiptHash, orderId, fee, deadline, ...routingValues],
  ));
  const domain = digest(encodeAbi(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [textHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), textHash('111K'), textHash('2'), 31337, collection]));
  const signature = signDigest(signerKey, digest(`0x1901${domain.slice(2)}${structHash.slice(2)}`));
  const tuple = `(uint256,address,uint256,uint256,bytes32${routingTypes.length ? `,${routingTypes.join(',')}` : ''})`;
  return { receipts, data: encodeCall(`redeemForDelivery(uint256[],${tuple},bytes)`, ['uint256[]', tuple, 'bytes'],
    [ids, [orderId, wallet, fee, deadline, receiptHash, ...routingValues], signature]) };
}

const scenarios = [];
for (const kind of ['crate', 'mixed50']) {
  for (const split of [false, true]) {
    for (const state of ['fresh', 'pending', 'after-withdrawal']) {
      scenarios.push({ name: `${kind}-${split ? 'split' : 'single'}-${state}`, category: 'redeem', kind, split, state });
    }
  }
}
for (const split of [false, true]) {
  for (const state of ['first', 'repeat', 'empty']) scenarios.push({ name: `withdrawal-${split ? 'split' : 'single'}-${state}`, category: 'withdrawal', split, state });
}
scenarios.push({ name: 'failure-single-rejecting', category: 'failure', split: false, mode: 'rejecting' });
scenarios.push({ name: 'failure-split-one-rejecting', category: 'failure', split: true, mode: 'rejecting' });
scenarios.push({ name: 'failure-split-both-burning', category: 'failure', split: true, mode: 'burning' });
for (const routeCount of [4, 16, 32]) {
  for (const activity of ['all-first', 'all-repeat', 'half-first', 'idle']) {
    scenarios.push({ name: `routes-${routeCount}-${activity}`, category: 'scale', routeCount, activity });
  }
}
for (const mode of ['rejecting', 'burning']) scenarios.push({ name: `routes-32-all-split-${mode}`, category: 'bound', routeCount: 32, mode });
for (const shared of [false, true]) {
  for (const activity of ['all-first', 'all-repeat']) scenarios.push({ name: `routes-4-split-${shared ? 'shared' : 'distinct'}-${activity}`,
    category: 'scale', routeCount: 4, activity, shared, allSplit: true, diverseShares: true });
}
for (const activity of ['all-first', 'all-repeat']) scenarios.push({ name: `routes-32-all-split-${activity}`,
  category: 'scale', routeCount: 32, activity, allSplit: true });
assert.equal(scenarios.length, 41);
const applicable = (variant, scenario) => variant === 'legacy' ? !scenario.split && ['redeem', 'withdrawal', 'failure'].includes(scenario.category)
  : variant === 'signed' ? scenario.category !== 'bound' : true;

async function measure(variants, receivers) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'prague', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', closed = false, startupError, requestId = 0;
  anvil.on('error', error => { startupError = error; });
  anvil.stderr.on('data', data => { stderr += String(data); });
  const stopped = new Promise(resolve => anvil.once('close', () => { closed = true; resolve(); }));
  async function rpc(method, params = []) {
    if (startupError || closed) throw startupError ?? new Error(`Anvil stopped: ${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json();
    if (!response.ok || body.error || body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error ?? response.status)}`);
    return body.result;
  }
  let admin, buyer, caller, collection, context, variant;
  async function send(data, value = 0n, from = buyer, to = collection, options = {}) {
    const { status = '0x1', group = 'setup', gasLimit = 16_000_000 } = options;
    await rpc('evm_setNextBlockTimestamp', [++context.time]);
    const transaction = await rpc('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, value: hex(value), gas: hex(gasLimit), gasPrice: hex(2_000_000_000) }]);
    let receipt;
    for (let attempt = 0; attempt < 100; ++attempt) {
      receipt = await rpc('eth_getTransactionReceipt', [transaction]);
      if (receipt) break;
      await delay(10);
    }
    assert.ok(receipt, 'Missing mined receipt');
    assert.equal(receipt.status, status, `${variant}/${context.name}: unexpected transaction outcome`);
    context.trace.push({ from, to, data, value: value.toString(), timestamp: context.time, group, gasLimit, status,
      gasUsed: Number(BigInt(receipt.gasUsed)), logs: receipt.logs.map(({ address, topics, data }) => ({ address, topics, data })) });
    return receipt;
  }
  const transact = (signature, types = [], args = [], value = 0n, from = buyer, options = {}) =>
    send(encodeCall(signature, types, args), value, from, collection, options);
  async function call(signature, types = [], args = [], returns = ['uint256']) {
    return decodeReturn(returns, await rpc('eth_call', [{ to: collection, data: encodeCall(signature, types, args) }, 'latest']));
  }
  async function route(first, second = zero, bps = 0, failures = {}) {
    const configured = { id: context.routes.length + 1, first, second, bps, failures, total: 0n, released1: 0n, released2: 0n };
    context.routes.push(configured);
    for (const [recipient, mode] of Object.entries(failures)) {
      await rpc('anvil_setCode', [recipient, code(receivers[mode].deployedBytecode.object)]);
    }
    if (variant === 'registered') {
      await transact('registerDeliveryConfig(address,address,uint16)', ['address', 'address', 'uint16'], [first, second, bps], 0n, admin,
        { group: 'registration' });
      assert.equal((await call('deliveryConfigCount()'))[0], BigInt(configured.id));
    } else if (variant === 'legacy' && first !== primary) {
      await transact('setDeliveryPaymentReceiver(address)', ['address'], [first], 0n, admin);
    }
    return configured;
  }
  async function mint(quantity) {
    for (let remaining = quantity; remaining > 0;) {
      const batch = Math.min(remaining, 15);
      await transact('mintCrates(uint256)', ['uint256'], [batch], fee * BigInt(batch));
      remaining -= batch;
    }
  }
  async function deliver(ids, orderId, configured, group = 'setup') {
    const quote = authorization(variant, collection, buyer, ids, orderId, context.time + 300, configured);
    await send(quote.data, fee, buyer, collection, { group });
    configured.total += fee;
    assert.equal((await call('usedDeliveryOrders(uint256)', ['uint256'], [orderId], ['bool']))[0], true);
    const infos = (await call('getTokenInfos(uint256[])', ['uint256[]'], [quote.receipts], ['(uint8,uint256,address)[]']))[0];
    assert.equal(infos.length, quote.receipts.length);
    for (const info of infos) assert.equal(info[2], buyer);
  }
  function entitlements(configured) {
    const second = configured.total * BigInt(configured.bps) / 10_000n;
    return [configured.total - second, second];
  }
  async function payout(configuredRoutes, group = 'setup', includeEmpty = true) {
    if (variant === 'registered') {
      await transact('releaseDelivery()', [], [], 0n, caller, { group });
      for (const configured of context.routes) {
        const [first, second] = entitlements(configured);
        if (!configured.failures[configured.first]) configured.released1 = first;
        if (!configured.failures[configured.second]) configured.released2 = second;
      }
      return;
    }
    const recipients = [...new Set(configuredRoutes.flatMap(configured => [configured.first, configured.second]).filter(value => value !== zero))];
    for (const recipient of recipients) {
      const allocations = context.routes.flatMap(configured => {
        const values = entitlements(configured);
        return [configured.first, configured.second].flatMap((address, index) => address === recipient
          ? [{ configured, key: index === 0 ? 'released1' : 'released2', entitlement: values[index] }] : []);
      });
      const due = allocations.reduce((sum, { configured, key, entitlement }) => sum + entitlement - configured[key], 0n);
      if (!includeEmpty && due === 0n) continue;
      const failure = due > 0n && allocations.find(({ configured }) => configured.failures[recipient])?.configured.failures[recipient];
      const options = { group, status: failure ? '0x0' : '0x1', gasLimit: failure === 'burning' ? 300_000 : 16_000_000 };
      if (variant === 'legacy') await transact('releaseDelivery()', [], [], 0n, caller, options);
      else await transact('releaseDelivery(address)', ['address'], [recipient], 0n, caller, options);
      if (!failure) for (const { configured, key, entitlement } of allocations) configured[key] = entitlement;
    }
  }
  async function verifyState() {
    let total = 0n, released = 0n;
    const receivers = new Map();
    for (const configured of context.routes) {
      const [first, second] = entitlements(configured);
      total += configured.total;
      released += configured.released1 + configured.released2;
      if (variant === 'registered') {
        const values = await call('deliveryConfigs(uint256)', ['uint256'], [configured.id], ['address', 'address', 'uint16', 'uint256', 'uint256', 'uint256']);
        assert.deepEqual(values, [configured.first, configured.second, BigInt(configured.bps), configured.total, configured.released1, configured.released2]);
      }
      for (const [index, recipient] of [configured.first, configured.second].entries()) {
        if (recipient === zero) continue;
        const accumulated = receivers.get(recipient) ?? { released: 0n, pending: 0n };
        const paid = index === 0 ? configured.released1 : configured.released2;
        accumulated.released += paid;
        accumulated.pending += (index === 0 ? first : second) - paid;
        receivers.set(recipient, accumulated);
      }
    }
    for (const [recipient, expected] of receivers) {
      assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), expected.released);
      if (variant === 'signed') assert.equal((await call('releasableDelivery(address)', ['address'], [recipient]))[0], expected.pending);
    }
    if (variant !== 'registered') {
      assert.equal((await call('totalDeliveryReceived()'))[0], total);
      assert.equal((await call('totalDeliveryReleased()'))[0], released);
    }
    const mintReceived = (await call('totalMintReceived()'))[0];
    assert.equal((await call('totalMintReleased()'))[0], 0n);
    assert.equal(BigInt(await rpc('eth_getBalance', [collection, 'latest'])), mintReceived + total - released);
    return { totalReceived: total.toString(), totalReleased: released.toString(), unpaid: (total - released).toString() };
  }
  async function runScenario(scenario) {
    if (scenario.category === 'redeem') {
      const configured = await route(primary, scenario.split ? secondary : zero, scenario.split ? 2500 : 0);
      const mixed = scenario.kind === 'mixed50';
      await mint(mixed ? 28 : 2);
      let ids;
      if (mixed) {
        await transact('unboxCrate(uint256)', ['uint256'], [111112]);
        await transact('unboxCrate(uint256)', ['uint256'], [111113]);
        ids = [...range(1, 25), ...range(111114, 25)];
      } else ids = [111112];
      if (scenario.state !== 'fresh') {
        await deliver([mixed ? 111139 : 111113], 2, configured);
        if (scenario.state === 'after-withdrawal') await payout([configured]);
      }
      await deliver(ids, 1, configured, 'redeem');
    } else if (scenario.category === 'withdrawal') {
      const configured = await route(primary, scenario.split ? secondary : zero, scenario.split ? 2500 : 0);
      if (scenario.state !== 'empty') {
        await mint(2);
        await deliver([111112], 1, configured);
        if (scenario.state === 'repeat') {
          await payout([configured]);
          await deliver([111113], 2, configured);
        }
      }
      await payout([configured], 'withdrawal');
    } else if (scenario.category === 'failure') {
      const failures = scenario.split ? { [secondary]: scenario.mode, ...(scenario.mode === 'burning' ? { [primary]: scenario.mode } : {}) }
        : { [primary]: scenario.mode };
      const configured = await route(primary, scenario.split ? secondary : zero, scenario.split ? 2500 : 0, failures);
      await mint(2);
      await deliver([111112], 1, configured);
      await payout([configured], 'withdrawal-first');
      context.intermediateState = await verifyState();
      await deliver([111113], 2, configured);
      await payout([configured], 'withdrawal-after-new-revenue');
    } else {
      const bound = scenario.category === 'bound';
      const active = bound || scenario.activity.startsWith('all') ? scenario.routeCount : scenario.activity === 'half-first' ? scenario.routeCount / 2 : 0;
      const repeat = scenario.activity === 'all-repeat';
      for (let index = 0; index < scenario.routeCount; ++index) {
        const first = scenario.shared ? primary : address(0xc00001 + index * 2);
        const split = bound || scenario.allSplit || index % 2 === 1;
        const second = split ? scenario.shared ? secondary : address(0xc00002 + index * 2) : zero;
        const bps = split ? scenario.diverseShares ? [1000, 2500, 5000, 7500][index] : 2500 : 0;
        await route(first, second, bps, bound ? { [first]: scenario.mode, [second]: scenario.mode } : {});
      }
      if (active) {
        await mint(active * (repeat ? 2 : 1));
        for (let index = 0; index < active; ++index) await deliver([111112 + index], index + 1, context.routes[index]);
        if (repeat) {
          await payout(context.routes.slice(0, active), 'setup', false);
          for (let index = 0; index < active; ++index) await deliver([111112 + active + index], active + index + 1, context.routes[index]);
        }
      }
      await payout(context.routes.slice(0, active), 'withdrawal', false);
      context.activeRoutes = active;
      context.payableReceivers = new Set(context.routes.slice(0, active).flatMap(configured => [configured.first, configured.second]).filter(value => value !== zero)).size;
      context.routePayoutAttempts = context.routes.slice(0, active).reduce((sum, configured) => sum + (configured.second === zero ? 1 : 2), 0);
      if (bound) {
        const measured = context.trace.filter(record => record.group === 'withdrawal');
        assert.equal(measured.length, 1);
        assert.ok(measured[0].gasUsed < 10_000_000, 'Maximum failed batch exceeds the explicit 10M gas bound');
      }
    }
    return verifyState();
  }
  const result = { repetitions: 2, variants: {}, measuredReceiptCount: 0, registrationReceiptCount: 0 };
  try {
    for (let attempt = 0; ; ++attempt) {
      try { [admin, buyer, caller] = await rpc('eth_accounts'); break; }
      catch (error) { if (attempt >= 100 || startupError || closed) throw error; await delay(25); }
    }
    let empty = await rpc('evm_snapshot');
    for (const value of variants) {
      variant = value.name;
      const repetitions = [];
      for (let repetition = 0; repetition < 2; ++repetition) {
        assert.equal(await rpc('evm_revert', [empty]), true);
        empty = await rpc('evm_snapshot');
        context = { name: 'deploy', time: 2_000_000_000, trace: [], routes: [] };
        const types = ['address', 'address', ...(variant === 'legacy' ? ['address'] : []), 'string', 'bytes32', 'address[]', 'uint256[]', '(address,uint16,uint16,uint16)[]'];
        const args = [admin, signer, ...(variant === 'legacy' ? [primary] : []), 'https://cdn.mons.shop/111k-sepolia/registered-study/',
          `0x${'0'.repeat(64)}`, [address(0xa001), address(0xa002)], [6000, 4000], []];
        const deployed = await send(code(value.artifact.bytecode.object) + encodeAbi(types, args).slice(2), 0n, admin, null);
        collection = deployed.contractAddress;
        if (result.collection) assert.equal(collection, result.collection);
        result.collection = collection;
        await transact('setSaleActive(bool)', ['bool'], [true], 0n, admin);
        const saleActivationGas = context.trace.at(-1).gasUsed;
        let initial = await rpc('evm_snapshot');
        const rows = [];
        for (const [index, scenario] of scenarios.entries()) {
          if (!applicable(variant, scenario)) continue;
          assert.equal(await rpc('evm_revert', [initial]), true);
          initial = await rpc('evm_snapshot');
          context = { name: scenario.name, time: 2_000_001_000 + index * 1000, trace: [], routes: [] };
          const state = await runScenario(scenario);
          const registrations = context.trace.filter(record => record.group === 'registration');
          const measured = context.trace.filter(record => !['setup', 'registration'].includes(record.group));
          const groups = Object.fromEntries([...new Set(measured.map(record => record.group))].map(group => {
            const records = measured.filter(record => record.group === group);
            return [group, { transactions: records.length, gasUsed: records.reduce((sum, record) => sum + record.gasUsed, 0),
              receipts: records.map(({ gasUsed, status, gasLimit, data }) => ({ gasUsed, status, gasLimit, calldataBytes: bytes(data) })) }];
          }));
          const expectedMeasured = scenario.category === 'scale' && scenario.activity === 'idle' && variant === 'signed' ? 0 : 1;
          assert.ok(measured.length >= expectedMeasured, 'Missing measurements');
          result.measuredReceiptCount += measured.length;
          result.registrationReceiptCount += registrations.length;
          rows.push({ ...scenario, groups,
            measuredTransactions: measured.length, measuredGas: measured.reduce((sum, record) => sum + record.gasUsed, 0),
            registeredRoutes: context.routes.length,
            registration: { transactions: registrations.length, gasUsed: registrations.reduce((sum, record) => sum + record.gasUsed, 0),
              perConfig: registrations.map(record => record.gasUsed) },
            setupGas: context.trace.filter(record => record.group === 'setup').reduce((sum, record) => sum + record.gasUsed, 0),
            ...(context.activeRoutes !== undefined ? { activeRoutes: context.activeRoutes, payableReceivers: context.payableReceivers, routePayoutAttempts: context.routePayoutAttempts } : {}),
            ...(context.intermediateState ? { intermediateState: context.intermediateState } : {}),
            ...(scenario.category === 'scale' && scenario.activity === 'idle' && variant === 'signed'
              ? { note: 'No payable receivers: caller submits no transaction. Individual empty-call cost is measured separately.' } : {}),
            finalState: state, traceSha256: hash(JSON.stringify(context.trace)) });
        }
        const measured = { deploymentGas: Number(BigInt(deployed.gasUsed)), saleActivationGas, rows };
        if (repetition) assert.deepEqual(measured, repetitions[0], `${variant}: repeated measurements differ`);
        repetitions.push(measured);
        process.stderr.write(`Measured ${variant}, repeat ${repetition + 1}: ${rows.length} scenarios\n`);
      }
      result.variants[variant] = { identicalRepeats: true, ...repetitions[0] };
    }
    return result;
  } finally {
    if (!closed) {
      anvil.kill('SIGTERM');
      const timer = setTimeout(() => { if (!closed) anvil.kill('SIGKILL'); }, 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
  }
}

function comparisons(receipts) {
  const lookup = Object.fromEntries(Object.entries(receipts.variants).map(([variant, data]) => [variant, Object.fromEntries(data.rows.map(row => [row.name, row]))]));
  const delta = (before, after) => ({ delta: after - before, percent: before ? (after - before) * 100 / before : null });
  const rows = scenarios.map(scenario => {
    const values = Object.fromEntries(['legacy', 'signed', 'registered'].map(variant => [variant, lookup[variant][scenario.name]?.measuredGas ?? null]));
    return { name: scenario.name, ...values,
      registeredVsSigned: values.signed === null ? null : delta(values.signed, values.registered),
      registeredVsLegacy: values.legacy === null ? null : delta(values.legacy, values.registered) };
  });
  const amortization = [];
  for (const variant of ['legacy', 'signed', 'registered']) {
    for (const split of [false, true]) {
      if (variant === 'legacy' && split) continue;
      const mode = split ? 'split' : 'single';
      for (const kind of ['crate', 'mixed50']) {
        const fresh = lookup[variant][`${kind}-${mode}-fresh`];
        const pending = lookup[variant][`${kind}-${mode}-pending`];
        const after = lookup[variant][`${kind}-${mode}-after-withdrawal`];
        const firstPayout = lookup[variant][`withdrawal-${mode}-first`].measuredGas;
        const repeatPayout = lookup[variant][`withdrawal-${mode}-repeat`].measuredGas;
        for (const redemptions of [1, 10, 100]) {
          const firstCycle = fresh.registration.gasUsed + fresh.measuredGas + (redemptions - 1) * pending.measuredGas + firstPayout;
          const subsequentCycle = after.measuredGas + (redemptions - 1) * pending.measuredGas + repeatPayout;
          amortization.push({ variant, kind, mode, redemptionsPerPayout: redemptions,
            firstCycle: { registrationGas: fresh.registration.gasUsed, redemptionGas: fresh.measuredGas + (redemptions - 1) * pending.measuredGas,
              payoutGas: firstPayout, totalGas: firstCycle, gasPerRedemption: firstCycle / redemptions },
            subsequentCycle: { registrationGas: 0, redemptionGas: after.measuredGas + (redemptions - 1) * pending.measuredGas,
              payoutGas: repeatPayout, totalGas: subsequentCycle, gasPerRedemption: subsequentCycle / redemptions } });
        }
      }
    }
  }
  return { rows, amortization: { derived: true,
    method: 'Projections, not 10/100-redemption executions. First cycle = one registration + fresh redemption + (N-1) pending-redemption samples + first full payout. '
      + 'Subsequent cycle = after-withdrawal redemption + (N-1) pending-redemption samples + repeat full payout. '
      + 'Signed-address split payouts sum two actual transactions; registered routes use one no-argument call. '
      + 'Collection deployment and NFT mint/unbox setup are excluded and reported separately. Signature bytes, token storage and calldata changes can alter exact future totals.',
    rows: amortization } };
}

try {
  const variants = Object.entries(sources).map(([name, source]) => ({ name, ...build(name, source) }));
  assert.ok(variants[0].artifact.abi.some(entry => entry.name === 'deliveryPaymentReceiver'), 'Pinned reference is not the original global-receiver implementation');
  const helperBuild = build('receivers', receiverSource, 'RejectingReceiver');
  const receivers = { rejecting: helperBuild.artifact,
    burning: JSON.parse(read(join(helperBuild.directory, 'out/RejectingReceiver.sol/BurningReceiver.json'))) };
  const artifacts = Object.fromEntries(variants.map(({ name, artifact }) => {
    const runtimeBytes = bytes(artifact.deployedBytecode.object);
    const creationBytes = bytes(artifact.bytecode.object);
    const maximumConstructorArgumentBytes = name === 'legacy' ? 6656 : 6624;
    assert.ok(runtimeBytes <= 24576, `${name}: runtime ${runtimeBytes} exceeds EIP-170; experiment is not deployable`);
    assert.ok(creationBytes + maximumConstructorArgumentBytes <= 49152, `${name}: maximum initcode exceeds EIP-3860`);
    return [name, { runtimeBytes, headroomBytes: 24576 - runtimeBytes, creationBytes, maximumConstructorArgumentBytes,
      creationSha256: hash(artifact.bytecode.object), runtimeSha256: hash(artifact.deployedBytecode.object) }];
  }));
  const receipts = await measure(variants, receivers);
  assert.equal(read(join(repositoryRoot, signedPath)), sources.signed, 'Current implementation changed during the experiment');
  assert.equal(read(join(repositoryRoot, prototypePath)), sources.registered, 'Prototype changed during measurements');
  const after = implementationSnapshot();
  assert.deepEqual(after, before, 'Protected benchmark sources or historical reports changed during reproduction');
  const report = { schemaVersion: 1, referenceCommit, settings,
    variants: { legacy: 'Original global receiver pinned to the HEAD at experiment creation; split payments unsupported.', signed: 'Archived signed-address implementation preceding registered configurations.',
      registered: 'Archived immutable registered-percentage-route prototype before constructor initialization; owner registers routes; cumulative revenue; no aggregate writes; no-argument batch payouts.' },
    method: 'Two identical actual local Anvil Prague receipt runs for every supported scenario. EIP-170 remains enforced. Fixed fee is divisible by four so per-payment and cumulative 25% splits match exactly. '
      + 'Signed-address split payout costs sum both transactions. Legacy split values are null, never compared as equivalent. '
      + 'Failure contract fixtures use anvil_setCode outside measurements; individually unbounded signed-address gas-burning withdrawals use an explicit 300,000 transaction gas cap. '
      + 'Normal and registered-batch calls have a 16M transaction limit; registered callbacks retain their 100k contract cap. Registration and deployment are reported separately.',
    provenance: { sourceSha256: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hash(source)])),
      protectedFilesBefore: before, protectedFilesAfter: after, protectedFilesUnchanged: true,
      scriptSha256: hash(read(fileURLToPath(import.meta.url))), receiverFixtureSha256: hash(receiverSource),
      packageLockSha256: hash(read(join(packageRoot, 'package-lock.json'))), rootPackageLockSha256: hash(read(join(repositoryRoot, 'package-lock.json'))),
      abiHelperSha256: hash(read(join(repositoryRoot, 'shared/ethereum/abi.ts'))), cryptoHelperSha256: hash(read(join(repositoryRoot, 'shared/ethereum/crypto.ts'))),
      forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(), anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(), node: process.version },
    artifacts, receipts, ...comparisons(receipts), status: 'passed' };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, artifacts, measuredReceiptCount: receipts.measuredReceiptCount,
    registrationReceiptCount: receipts.registrationReceiptCount, main: report.rows.filter(row => row.name.startsWith('crate-')),
    bounds: report.rows.filter(row => row.name.includes('all-split-')), report: outputPath }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
