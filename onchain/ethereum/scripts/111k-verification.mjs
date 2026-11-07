import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode, decode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';

const CHAIN_ID = 11155111;
const ZERO = '0x' + '0'.repeat(40);
const CONTRACT = 'src/NFT111K.sol:NFT111K';
const SOURCIFY = 'https://sourcify.dev/server/v2';
const ETHERSCAN = 'https://api.etherscan.io/v2/api';
const STAGES = ['closed', 'reserved', 'open', 'mint-qa', 'unpack-qa'];
const STAGE_ACTIONS = ['deploy', 'reserve', 'open', 'mint-qa', 'unpack-qa'];
const CONSTRUCTOR_TYPES = ['address', 'address', 'address', 'string', 'bytes32', 'address[]', 'uint256[]', '(address,uint16,uint16,uint16)[]', 'uint256'];
const STATS_TYPES = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'];
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => '0x' + Buffer.from(keccak_256(value)).toString('hex');
const bytes = value => Buffer.from(value.slice(2), 'hex');
const address = value => {
  assert.ok(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value), 'Invalid verification address');
  return value.toLowerCase();
};
const callData = (signature, types = [], values = []) => hash(signature).slice(0, 10) + Buffer.from(encode(types, values)).toString('hex');
const decodedValue = value => value instanceof Uint8Array ? '0x' + Buffer.from(value).toString('hex')
  : Array.isArray(value) ? value.map(decodedValue) : value;
const readJson = async (directory, name) => JSON.parse(await readFile(join(directory, name), 'utf8'));
const save = (directory, name, value) => writeFile(join(directory, name), json(value), { mode: 0o600 });

function immutableDeclarations(compilerOutput) {
  const names = {};
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable') names[value.id] = value.name;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  for (const source of Object.values(compilerOutput.sources || {})) visit(source.ast);
  return names;
}

export function expected111kRuntime(artifact, manifest, compilerOutput) {
  const runtime = artifact.deployedBytecode.object;
  assert.match(runtime, /^0x(?:[0-9a-f]{2})+$/i, 'Invalid frozen runtime');
  const short = value => {
    const word = Buffer.alloc(32);
    word.write(value, 0, 'utf8');
    word[31] = Buffer.byteLength(value);
    return '0x' + word.toString('hex');
  };
  const hashedName = hash('111K');
  const hashedVersion = hash('2');
  const domain = hash(encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    hash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    hashedName, hashedVersion, CHAIN_ID, manifest.contractAddress,
  ]));
  const values = {
    _cachedDomainSeparator: domain,
    _cachedChainId: '0x' + BigInt(CHAIN_ID).toString(16).padStart(64, '0'),
    _cachedThis: '0x' + address(manifest.contractAddress).slice(2).padStart(64, '0'),
    _hashedName: hashedName,
    _hashedVersion: hashedVersion,
    _name: short('111K'),
    _version: short('2'),
  };
  const declarations = immutableDeclarations(compilerOutput);
  const result = bytes(runtime);
  const verified = new Set();
  for (const [id, references] of Object.entries(artifact.deployedBytecode.immutableReferences)) {
    const name = declarations[id];
    assert.ok(Object.hasOwn(values, name), 'Unknown frozen runtime immutable');
    if (manifest.immutableNames) assert.equal(manifest.immutableNames[id], name, 'Frozen immutable name changed');
    assert.ok(!verified.has(name), 'Duplicate immutable declaration');
    verified.add(name);
    assert.ok(references.length > 0, 'Missing immutable references');
    for (const { start, length } of references) {
      assert.ok(Number.isSafeInteger(start) && start >= 0 && length === 32 && start + length <= result.length, 'Invalid immutable reference');
      bytes(values[name]).copy(result, start);
    }
  }
  assert.deepEqual([...verified].sort(), Object.keys(values).sort(), 'Incomplete EIP-712 immutable verification');
  return '0x' + result.toString('hex');
}

export async function load111kVerification(directory) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.chainId, CHAIN_ID, 'Verification supports Sepolia only');
  assert.equal(manifest.network, 'sepolia', 'Verification supports Sepolia only');
  for (const field of ['contractAddress', 'deployer', 'owner', 'quoteSigner', 'initialDeliveryReceiver']) address(manifest[field]);
  const frozen = {};
  for (const [name, field] of [['artifact', 'artifactSha256'], ['standard-input', 'standardInputSha256'], ['compiler-output', 'compilerOutputSha256']]) {
    const content = await readFile(join(directory, `NFT111K.${name}.json`));
    assert.equal(sha256(content), manifest[field], `Frozen ${name} changed`);
    frozen[name] = JSON.parse(content.toString('utf8'));
  }
  const artifact = frozen.artifact;
  const input = frozen['standard-input'];
  const compilerOutput = frozen['compiler-output'];
  assert.deepEqual(artifact.metadata.settings.compilationTarget, { 'src/NFT111K.sol': 'NFT111K' });
  assert.equal(input.language, 'Solidity');
  assert.deepEqual(Object.keys(input.sources).sort(), Object.keys(artifact.metadata.sources).sort(), 'Frozen source set changed');
  for (const [name, source] of Object.entries(input.sources)) {
    assert.equal(hash(source.content), artifact.metadata.sources[name].keccak256, `Frozen source changed: ${name}`);
  }
  const expectedArgs = '0x' + Buffer.from(encode(CONSTRUCTOR_TYPES, [manifest.owner, manifest.quoteSigner,
    manifest.initialDeliveryReceiver, manifest.metadataBaseURI, manifest.discountRoot,
    manifest.proceeds.mintRecipients, manifest.proceeds.mintSharesBps,
    manifest.freeMintAllocations.map(value => [value.wallet, value.crateLimit, value.warehouseLimit, value.relicLimit]),
    manifest.maxDiscountedMints])).toString('hex');
  assert.equal(manifest.constructorArgs.toLowerCase(), expectedArgs, 'Constructor arguments do not match frozen configuration');
  assert.equal(manifest.creationCode.toLowerCase(), artifact.bytecode.object.toLowerCase() + expectedArgs.slice(2), 'Frozen creation code changed');
  const compiled = compilerOutput.contracts['src/NFT111K.sol'].NFT111K;
  assert.equal('0x' + compiled.evm.bytecode.object.replace(/^0x/, ''), artifact.bytecode.object);
  assert.equal('0x' + compiled.evm.deployedBytecode.object.replace(/^0x/, ''), artifact.deployedBytecode.object);
  assert.deepEqual(compiled.evm.deployedBytecode.immutableReferences, artifact.deployedBytecode.immutableReferences);
  const manifestSha256 = sha256(manifestBytes);
  let journal;
  try { journal = await readJson(directory, 'transactions.private.json'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    journal = { manifestSha256, actions: {} };
  }
  assert.equal(journal.manifestSha256, manifestSha256, 'Transaction journal belongs to a different manifest');
  return { directory, manifest, manifestSha256, artifact, input, compilerOutput, journal,
    runtime: expected111kRuntime(artifact, manifest, compilerOutput) };
}

export function verificationRpc(environment = process.env, request = fetch) {
  const apiKey = environment.ALCHEMY_API_KEY || environment.ALCHEMY_MI_NOTE_API_KEY;
  const rpcUrl = environment.ETHEREUM_111K_RPC_URL || (apiKey
    ? 'https://eth-sepolia.g.alchemy.com/v2/' + encodeURIComponent(apiKey) : null);
  assert.ok(rpcUrl && new URL(rpcUrl).protocol === 'https:',
    'Set an HTTPS ETHEREUM_111K_RPC_URL, ALCHEMY_API_KEY, or ALCHEMY_MI_NOTE_API_KEY');
  let id = 0;
  return async (method, params = []) => {
    let response;
    try {
      response = await request(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    } catch { throw new Error(`Verification RPC unavailable for ${method}`); }
    assert.ok(response.ok, `Verification RPC HTTP ${response.status} for ${method}`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`Invalid verification RPC response for ${method}`); }
    assert.ok(!body.error && Object.hasOwn(body, 'result'), `Verification RPC failed for ${method}`);
    return body.result;
  };
}

async function canonicalAction(context, action, rpc, head) {
  const entry = context.journal.actions[action];
  assert.ok(entry && /^0x[0-9a-f]{64}$/i.test(entry.hash), `Missing ${action} transaction`);
  const [receipt, transaction] = await Promise.all([
    rpc('eth_getTransactionReceipt', [entry.hash]), rpc('eth_getTransactionByHash', [entry.hash]),
  ]);
  assert.ok(receipt && transaction, `${action} transaction is not mined`);
  assert.equal(BigInt(receipt.status), 1n, `${action} transaction failed`);
  assert.equal(receipt.transactionHash.toLowerCase(), entry.hash.toLowerCase());
  assert.equal(transaction.hash.toLowerCase(), entry.hash.toLowerCase());
  assert.equal(address(transaction.from), address(context.manifest.deployer));
  assert.equal(transaction.input.toLowerCase(), entry.data.toLowerCase());
  assert.equal(BigInt(transaction.value), BigInt(entry.valueWei));
  assert.equal(BigInt(transaction.nonce), BigInt(entry.nonce));
  if (transaction.chainId !== undefined && transaction.chainId !== null) assert.equal(BigInt(transaction.chainId), BigInt(CHAIN_ID));
  else {
    const recovery = BigInt(transaction.v);
    assert.ok(recovery >= 35n, 'Deployment action is not replay protected');
    assert.equal((recovery - 35n) / 2n, BigInt(CHAIN_ID));
  }
  assert.equal(transaction.blockHash, receipt.blockHash);
  assert.equal(BigInt(transaction.blockNumber), BigInt(receipt.blockNumber));
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  assert.equal(block?.hash, receipt.blockHash, `${action} receipt is not canonical`);
  assert.equal(BigInt(block.number), BigInt(receipt.blockNumber));
  const confirmations = BigInt(head.number) - BigInt(receipt.blockNumber) + 1n;
  assert.ok(confirmations >= 3n, `${action} requires three canonical confirmations`);
  if (action === 'deploy') {
    assert.equal(transaction.to, null, 'Deployment transaction is not contract creation');
    assert.equal(address(receipt.contractAddress), address(context.manifest.contractAddress));
    assert.equal(transaction.input.toLowerCase(), context.manifest.creationCode.toLowerCase());
    assert.equal(BigInt(transaction.value), 0n);
  } else {
    assert.equal(address(transaction.to), address(context.manifest.contractAddress));
    if (action === 'reserve') {
      assert.equal(entry.data.toLowerCase(), callData('allocateRelics(uint256)', ['uint256'], [18]));
      assert.equal(BigInt(entry.valueWei), 18_000_000_000_000_000n);
    } else if (action === 'open') {
      assert.equal(entry.data.toLowerCase(), callData('setSaleActive(bool)', ['bool'], [true]));
      assert.equal(BigInt(entry.valueWei), 0n);
    } else if (action === 'mint-qa') {
      assert.equal(entry.data.toLowerCase(), callData('mintCrates(uint256)', ['uint256'], [1]));
      assert.equal(BigInt(entry.valueWei), 100_000_000_000_000n, 'QA must use the paid public mint');
    } else if (action === 'unpack-qa') assert.equal(BigInt(entry.valueWei), 0n);
  }
  return { transactionHash: entry.hash.toLowerCase(), blockNumber: Number(BigInt(receipt.blockNumber)),
    blockHash: receipt.blockHash, confirmations: Number(confirmations), gasUsed: BigInt(receipt.gasUsed).toString(), logs: receipt.logs || [] };
}

async function parallel(items, operation) {
  const result = [];
  for (let index = 0; index < items.length; index += 8) {
    result.push(...await Promise.all(items.slice(index, index + 8).map((value, offset) => operation(value, index + offset))));
  }
  return result;
}

export async function verify111kDeployment(context, rpc, stage = 'closed') {
  assert.ok(STAGES.includes(stage), 'Unknown verification stage');
  assert.equal(BigInt(await rpc('eth_chainId')), BigInt(CHAIN_ID), 'Verification RPC chain mismatch');
  const snapshot = await rpc('eth_getBlockByNumber', ['latest', false]);
  assert.ok(snapshot && /^0x[0-9a-f]{64}$/i.test(snapshot.hash), 'Invalid verification block');
  const actions = {};
  for (const action of STAGE_ACTIONS.slice(0, STAGES.indexOf(stage) + 1)) actions[action] = await canonicalAction(context, action, rpc, snapshot);
  const { manifest } = context;
  const reference = { blockHash: snapshot.hash, requireCanonical: true };
  const call = async (signature, resultTypes, types = [], values = []) => decodedValue(decode(resultTypes,
    await rpc('eth_call', [{ to: manifest.contractAddress, data: callData(signature, types, values) }, reference])));
  const [runtime, balance, owner, pendingOwner, signer, uri, recipientCount, deliveryCount, deliveryConfig, stats, domain,
    supply, totalReceived, totalReleased, claimedMask, redemptionsPaused] = await parallel([
    () => rpc('eth_getCode', [manifest.contractAddress, reference]),
    () => rpc('eth_getBalance', [manifest.contractAddress, reference]),
    () => call('owner()', ['address']), () => call('pendingOwner()', ['address']), () => call('quoteSigner()', ['address']),
    () => call('baseURI()', ['string']), () => call('mintRecipientCount()', ['uint256']),
    () => call('deliveryConfigCount()', ['uint256']),
    () => call('deliveryConfigs(uint256)', ['address', 'address', 'uint16', 'uint256', 'uint256', 'uint256'], ['uint256'], [1]),
    () => call('stats(address)', STATS_TYPES, ['address'], [ZERO]),
    () => call('eip712Domain()', ['bytes1', 'string', 'string', 'uint256', 'address', 'bytes32', 'uint256[]']),
    () => call('totalSupply()', ['uint256']), () => call('totalMintReceived()', ['uint256']),
    () => call('totalMintReleased()', ['uint256']), () => call('getRelicClaimedMask()', ['uint256']),
    () => call('redemptionsPaused()', ['bool']),
  ], operation => operation());
  assert.equal(runtime.toLowerCase(), context.runtime.toLowerCase(), 'Runtime or constructor immutables differ');
  assert.equal(owner[0], address(manifest.owner));
  assert.equal(pendingOwner[0], ZERO);
  assert.equal(signer[0], address(manifest.quoteSigner));
  assert.equal(uri[0], manifest.metadataBaseURI);
  assert.equal(recipientCount[0], BigInt(manifest.proceeds.mintRecipients.length));
  assert.equal(recipientCount[0], 14n, 'Expected the fourteen-receiver mint split');
  assert.equal(deliveryCount[0], 1n);
  assert.deepEqual(deliveryConfig.slice(0, 3), [address(manifest.initialDeliveryReceiver), ZERO, 0n]);
  assert.equal(deliveryConfig[5], 0n);
  assert.ok(deliveryConfig[4] <= deliveryConfig[3]);
  assert.deepEqual(domain, ['0x0f', '111K', '2', BigInt(CHAIN_ID), address(manifest.contractAddress), '0x' + '0'.repeat(64), []]);
  const reserved = stage !== 'closed';
  const minted = stage === 'mint-qa' || stage === 'unpack-qa';
  const unpacked = stage === 'unpack-qa';
  const opened = STAGES.indexOf(stage) >= 2;
  const minimumRevenue = (reserved ? 18_000_000_000_000_000n : 0n) + (minted ? 100_000_000_000_000n : 0n);
  assert.deepEqual(stats.slice(3, 10), [100_000_000_000_000n, 1_100_000_000_000_000n,
    opened, manifest.discountRoot.toLowerCase(), 50_000_000_000_000n, 1n, 0n]);
  assert.equal(stats[10], reserved ? 18n : 0n);
  assert.equal(stats[12], BigInt(manifest.maxDiscountedMints));
  assert.ok(stats[0] >= (reserved ? 1998n : 0n) + (minted ? 1n : 0n) && stats[0] <= 5555n);
  assert.ok(stats[1] <= 505n && stats[2] <= 111111n);
  assert.ok(stats[11] <= stats[10] && stats[13] <= stats[12] && stats[13] <= stats[0]);
  assert.ok(claimedMask[0] < (1n << 18n));
  assert.equal(BigInt(claimedMask[0].toString(2).replaceAll('0', '').length), stats[11]);
  assert.ok(totalReceived[0] >= minimumRevenue);
  assert.ok(totalReleased[0] <= totalReceived[0]);
  const pendingMint = totalReceived[0] - totalReleased[0];
  const pendingDelivery = deliveryConfig[3] - deliveryConfig[4];
  assert.ok(BigInt(balance) >= pendingMint + pendingDelivery, 'Contract balance does not cover accounted proceeds');
  if (!opened) {
    assert.deepEqual([stats[0], stats[1], stats[2], stats[11], stats[13]], [reserved ? 1998n : 0n, 0n, 0n, 0n, 0n]);
    assert.equal(supply[0], 0n);
    assert.equal(totalReceived[0], minimumRevenue);
    assert.equal(deliveryConfig[3], 0n);
  }
  assert.equal(redemptionsPaused[0], false);
  const recipients = await parallel(manifest.proceeds.mintRecipients, async (recipient, index) => {
    const [stored, share, released, releasable] = await Promise.all([
      call('mintRecipients(uint256)', ['address'], ['uint256'], [index]),
      call('mintSharesBps(address)', ['uint256'], ['address'], [recipient]),
      call('mintReleased(address)', ['uint256'], ['address'], [recipient]),
      call('releasableMint(address)', ['uint256'], ['address'], [recipient]),
    ]);
    assert.equal(stored[0], address(recipient));
    assert.equal(share[0], BigInt(manifest.proceeds.mintSharesBps[index]));
    const entitlement = totalReceived[0] * share[0] / 10_000n;
    assert.ok(released[0] <= entitlement);
    assert.equal(releasable[0], entitlement - released[0]);
    return { address: stored[0], shareBps: share[0], released: released[0], releasable: releasable[0] };
  });
  assert.equal(recipients.reduce((total, recipient) => total + recipient.released, 0n), totalReleased[0],
    'Released mint total does not match recipient accounting');
  const allowances = await parallel(manifest.freeMintAllocations, async allocation => {
    const values = await call('freeMintAllowances(address)', Array(6).fill('uint16'), ['address'], [allocation.wallet]);
    assert.deepEqual(values.slice(0, 3), [BigInt(allocation.crateLimit), BigInt(allocation.warehouseLimit), BigInt(allocation.relicLimit)]);
    for (let index = 0; index < 3; index++) assert.ok(values[index + 3] <= values[index]);
    if (!opened) assert.deepEqual(values.slice(3), [0n, 0n, 0n]);
    return { wallet: address(allocation.wallet), values };
  });
  const previews = await parallel([[1, 1, 1], [1, 111111, 111111], [2, 1, 111112], [2, 5555, 116666],
    [3, 1, 116667], [3, 505, 117171], [4, 1, 1000001], [4, 222222, 1222222],
    [5, 1, 2000001], [5, 5555, 2005555], [6, 1, 117172], [6, 18, 117189], [7, 1, 3000001], [7, 18, 3000018]], async ([kind, id, tokenId]) => {
    const [value] = await call('previewTokenURI(uint8,uint256)', ['string'], ['uint8', 'uint256'], [kind, id]);
    assert.equal(value, `${manifest.metadataBaseURI}${tokenId}.json`);
    return { kind, displayId: id, tokenId, uri: value };
  });
  let qa = null;
  if (minted) {
    const event = (action, signature, types, ownerTopic) => {
      const rows = actions[action].logs.filter(log => address(log.address) === address(manifest.contractAddress) &&
        log.topics[0]?.toLowerCase() === hash(signature));
      assert.equal(rows.length, 1, `Expected one ${action} event`);
      assert.equal(rows[0].topics[ownerTopic]?.toLowerCase(), '0x' + address(manifest.deployer).slice(2).padStart(64, '0'));
      return { values: decodedValue(decode(types, rows[0].data)), topics: rows[0].topics };
    };
    const { values: [crateTokenId, quantity, paid] } = event('mint-qa', 'CratesPurchased(address,uint256,uint256,uint256)',
      ['uint256', 'uint256', 'uint256'], 1);
    assert.equal(quantity, 1n);
    assert.equal(paid, 100_000_000_000_000n);
    assert.ok(crateTokenId >= 111112n && crateTokenId <= 116666n);
    let firstArtwork = null;
    let artworkCount = 0;
    if (unpacked) {
      assert.equal(context.journal.actions['unpack-qa'].data.toLowerCase(), callData('unboxCrate(uint256)', ['uint256'], [crateTokenId]));
      const { values: [first, count], topics } = event('unpack-qa', 'CrateUnboxed(uint256,address,uint256,uint256)',
        ['uint256', 'uint256'], 2);
      const openedCrate = BigInt(topics[1]);
      assert.equal(openedCrate, crateTokenId);
      assert.equal(count, crateTokenId === 116666n ? 31n : 20n);
      assert.ok(first > 0n && first + count - 1n <= 111111n);
      firstArtwork = first;
      artworkCount = Number(count);
    }
    const tokens = unpacked ? Array.from({ length: artworkCount }, (_, index) => firstArtwork + BigInt(index)) : [crateTokenId];
    for (const tokenId of tokens) {
      const info = await call('getTokenInfo(uint256)', ['uint8', 'uint256', 'address'], ['uint256'], [tokenId]);
      assert.deepEqual(info, [unpacked ? 1n : 2n, unpacked ? tokenId : crateTokenId - 111111n, address(manifest.deployer)]);
    }
    if (unpacked) assert.deepEqual(await call('getTokenInfo(uint256)', ['uint8', 'uint256', 'address'], ['uint256'], [crateTokenId]), [0n, 0n, ZERO]);
    qa = { wallet: address(manifest.deployer), crateTokenId, firstArtwork, artworkCount, tokenIds: tokens };
  }
  assert.equal((await rpc('eth_getBlockByNumber', [snapshot.number, false]))?.hash, snapshot.hash, 'Verification snapshot reorganized');
  return { stage, chainId: CHAIN_ID, deploymentId: manifest.deploymentId, contractAddress: address(manifest.contractAddress),
    metadataBaseURI: manifest.metadataBaseURI, manifestSha256: context.manifestSha256, checkedAt: new Date().toISOString(),
    snapshotBlock: Number(BigInt(snapshot.number)), snapshotBlockHash: snapshot.hash,
    transactionHash: actions.deploy.transactionHash, deploymentBlock: actions.deploy.blockNumber, confirmations: actions.deploy.confirmations,
    runtimeBytes: bytes(runtime).length, runtimeKeccak256: hash(bytes(runtime)), runtimeAndImmutablesMatch: true,
    owner: owner[0], quoteSigner: signer[0], initialDeliveryReceiver: deliveryConfig[0], deliveryConfigId: 1,
    mintRecipients: recipients, freeMintAllowances: allowances, stats, totalSupply: supply[0], totalMintReceived: totalReceived[0],
    totalMintReleased: totalReleased[0], contractBalanceWei: BigInt(balance), claimedRelicMask: claimedMask[0], qa,
    actions: Object.fromEntries(Object.entries(actions).map(([name, { logs, ...action }]) => [name, action])), metadataPreviews: previews };
}

export function verificationSourceRequests(context) {
  const { manifest, artifact, input, journal } = context;
  const transactionHash = journal.actions.deploy?.hash;
  assert.match(transactionHash || '', /^0x[0-9a-f]{64}$/i, 'Missing deployment transaction hash');
  return {
    sourcify: { stdJsonInput: input, compilerVersion: artifact.metadata.compiler.version,
      contractIdentifier: CONTRACT, creationTransactionHash: transactionHash },
    etherscan: { chainid: String(CHAIN_ID), module: 'contract', action: 'verifysourcecode',
      contractaddress: manifest.contractAddress, sourceCode: JSON.stringify(input), codeformat: 'solidity-standard-json-input',
      contractname: CONTRACT, compilerversion: 'v' + artifact.metadata.compiler.version,
      optimizationUsed: input.settings.optimizer.enabled ? '1' : '0', runs: String(input.settings.optimizer.runs),
      constructorArguments: manifest.constructorArgs.slice(2), evmVersion: input.settings.evmVersion, licenseType: '1' },
  };
}

async function remoteJson(url, init = {}, request = fetch) {
  let response;
  try { response = await request(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
  catch { throw new Error('Source verification service is unavailable'); }
  assert.ok(response.ok || response.status === 404, `Source verification HTTP ${response.status}`);
  let value;
  try { value = await response.json(); }
  catch { throw new Error('Invalid source verification service response'); }
  return { status: response.status, value };
}

export async function sourceVerification(context, provider, command, { rpc, request = fetch, apiKey } = {}) {
  assert.ok(['sourcify', 'etherscan'].includes(provider));
  assert.ok(['submit', 'status', 'verify'].includes(command));
  const { directory, manifest, artifact, input } = context;
  const requests = verificationSourceRequests(context);
  if (command === 'submit') {
    assert.ok(rpc, 'Source submission requires deployment confirmation');
    assert.equal(BigInt(await rpc('eth_chainId')), BigInt(CHAIN_ID));
    await canonicalAction(context, 'deploy', rpc, await rpc('eth_getBlockByNumber', ['latest', false]));
  }
  if (provider === 'sourcify') {
    const contractUrl = `${SOURCIFY}/contract/${CHAIN_ID}/${manifest.contractAddress}`;
    let result;
    if (command === 'submit') {
      const existing = await remoteJson(contractUrl, {}, request);
      if (existing.status === 200 && ['creationMatch', 'runtimeMatch'].every(field => ['match', 'exact_match'].includes(existing.value[field]))) {
        return { alreadyPublished: true, contractAddress: manifest.contractAddress };
      }
      assert.ok(existing.status === 200 || existing.status === 404);
      await save(directory, 'NFT111K.sourcify-request.json', requests.sourcify);
      result = await remoteJson(`${SOURCIFY}/verify/${CHAIN_ID}/${manifest.contractAddress}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requests.sourcify),
      }, request);
      assert.ok(result.status === 200 || result.status === 202, 'Sourcify submission failed');
      await save(directory, 'NFT111K.sourcify-submission.json', result);
    } else if (command === 'status') {
      let submission;
      try { submission = await readJson(directory, 'NFT111K.sourcify-submission.json'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const id = submission?.value?.verificationId;
      result = await remoteJson(id ? `${SOURCIFY}/verify/${encodeURIComponent(id)}` : contractUrl, {}, request);
      assert.equal(result.status, 200, 'Sourcify publication or job not found');
      await save(directory, 'NFT111K.sourcify-job.json', result.value);
    } else {
      result = await remoteJson(contractUrl + '?fields=all', {}, request);
      assert.equal(result.status, 200, 'Sourcify publication not found');
      const published = result.value;
      assert.equal(published.chainId, String(CHAIN_ID));
      assert.equal(address(published.address), address(manifest.contractAddress));
      for (const field of ['match', 'creationMatch', 'runtimeMatch']) assert.ok(['match', 'exact_match'].includes(published[field]), `Sourcify ${field} incomplete`);
      assert.equal(published.compilation.fullyQualifiedName, CONTRACT);
      assert.equal(published.compilation.compilerVersion.replace(/^v/, ''), artifact.metadata.compiler.version);
      assert.equal(published.deployment.transactionHash.toLowerCase(), context.journal.actions.deploy.hash.toLowerCase());
      assert.deepEqual(Object.keys(published.sources).sort(), Object.keys(input.sources).sort());
      for (const [name, source] of Object.entries(input.sources)) assert.equal(published.sources[name].content, source.content, `Published source changed: ${name}`);
      assert.equal(published.creationBytecode.onchainBytecode.toLowerCase(), manifest.creationCode.toLowerCase());
      assert.equal(published.creationBytecode.recompiledBytecode.toLowerCase(), artifact.bytecode.object.toLowerCase());
      assert.equal(published.creationBytecode.transformationValues.constructorArguments.toLowerCase(), manifest.constructorArgs.toLowerCase());
      assert.equal(published.runtimeBytecode.onchainBytecode.toLowerCase(), context.runtime.toLowerCase());
      await save(directory, 'NFT111K.sourcify-published.json', published);
      const report = { chainId: CHAIN_ID, contractAddress: address(manifest.contractAddress),
        transactionHash: context.journal.actions.deploy.hash, checkedAt: new Date().toISOString(),
        creationMatch: published.creationMatch, runtimeMatch: published.runtimeMatch, frozenSourcesMatch: true,
        runtimeAndImmutablesMatch: true, url: `https://repo.sourcify.dev/${CHAIN_ID}/${manifest.contractAddress}` };
      await save(directory, 'NFT111K.sourcify-verification.json', report);
      return report;
    }
    return result.value;
  }
  assert.ok(typeof apiKey === 'string' && apiKey.trim(), 'Set ETHERSCAN_API_KEY for Etherscan verification');
  const invoke = async (parameters, post = false) => {
    const query = new URLSearchParams(post
      ? { module: parameters.module, action: parameters.action, apikey: apiKey, chainid: String(CHAIN_ID) }
      : { ...parameters, apikey: apiKey, chainid: String(CHAIN_ID) });
    const body = new URLSearchParams(Object.entries(parameters).filter(([key]) => !['module', 'action', 'apikey', 'chainid'].includes(key)));
    const response = await remoteJson(`${ETHERSCAN}?${query}`, post
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() } : {}, request);
    assert.equal(response.status, 200, 'Etherscan request failed');
    return response.value;
  };
  const sanitized = value => String(value).replaceAll(apiKey, '[redacted]').replaceAll(encodeURIComponent(apiKey), '[redacted]');
  if (command === 'submit') {
    await save(directory, 'NFT111K.etherscan-request.json', requests.etherscan);
    const result = await invoke(requests.etherscan, true);
    const response = { status: sanitized(result.status), message: sanitized(result.message), result: sanitized(result.result),
      submittedAt: new Date().toISOString() };
    await save(directory, 'NFT111K.etherscan-submission-response.json', response);
    assert.equal(result.status, '1', 'Etherscan source submission failed: ' + response.result);
    const report = { status: result.status, guid: result.result, submittedAt: new Date().toISOString() };
    await save(directory, 'NFT111K.etherscan-submission.json', report);
    return report;
  }
  if (command === 'status') {
    const { guid } = await readJson(directory, 'NFT111K.etherscan-submission.json');
    const result = await invoke({ module: 'contract', action: 'checkverifystatus', guid });
    const report = { status: result.status, result: sanitized(result.result), checkedAt: new Date().toISOString() };
    await save(directory, 'NFT111K.etherscan-status.json', report);
    return report;
  }
  const result = await invoke({ module: 'contract', action: 'getsourcecode', address: manifest.contractAddress });
  assert.equal(result.status, '1', 'Etherscan source lookup failed');
  assert.equal(result.result?.length, 1, 'Missing Etherscan source');
  const published = result.result[0];
  assert.equal(published.ContractName, 'NFT111K');
  assert.equal(published.CompilerVersion.replace(/^v/, ''), artifact.metadata.compiler.version);
  assert.equal(published.ConstructorArguments.toLowerCase(), manifest.constructorArgs.slice(2).toLowerCase());
  assert.ok(!published.SimilarMatch, 'Etherscan only reports a similar match');
  assert.notEqual(published.ABI, 'Contract source code not verified');
  const sourceText = published.SourceCode.startsWith('{{') ? published.SourceCode.slice(1, -1) : published.SourceCode;
  const sources = JSON.parse(sourceText).sources;
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(input.sources).sort());
  for (const [name, source] of Object.entries(input.sources)) assert.equal(sources[name].content, source.content, `Etherscan source changed: ${name}`);
  const report = { chainId: CHAIN_ID, contractAddress: address(manifest.contractAddress), checkedAt: new Date().toISOString(),
    frozenSourcesMatch: true, constructorArgumentsMatch: true, compilerVersion: published.CompilerVersion,
    url: `https://sepolia.etherscan.io/address/${manifest.contractAddress}#code` };
  await save(directory, 'NFT111K.etherscan-verification.json', report);
  return report;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...arguments_] = argv;
  const options = {};
  assert.ok(['verify', 'prepare-sources', 'sourcify-submit', 'sourcify-status', 'sourcify-verify',
    'etherscan-submit', 'etherscan-status', 'etherscan-verify'].includes(command), 'Use verify|prepare-sources|sourcify-submit|sourcify-status|sourcify-verify|etherscan-submit|etherscan-status|etherscan-verify --directory PATH [--stage STAGE]');
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    assert.ok(['--directory', '--stage'].includes(key) && arguments_[index + 1] && !options[key], 'Invalid or repeated verification option');
    options[key] = arguments_[index + 1];
  }
  assert.ok(options['--directory'], 'Verification directory is required');
  assert.ok(command === 'verify' || options['--stage'] === undefined, '--stage applies only to verify');
  const directory = resolve(options['--directory']);
  const context = await load111kVerification(directory);
  let result;
  if (command === 'verify') {
    const stage = options['--stage'] || 'closed';
    result = await verify111kDeployment(context, verificationRpc(environment), stage);
    await save(directory, `deployment-${stage}.json`, result);
  } else if (command === 'prepare-sources') {
    const requests = verificationSourceRequests(context);
    for (const provider of ['sourcify', 'etherscan']) await save(directory, `NFT111K.${provider}-request.json`, requests[provider]);
    result = { chainId: CHAIN_ID, contractAddress: context.manifest.contractAddress, prepared: ['sourcify', 'etherscan'] };
  } else {
    const [provider, action] = command.split('-');
    result = await sourceVerification(context, provider, action, { apiKey: environment.ETHERSCAN_API_KEY,
      ...(action === 'submit' ? { rpc: verificationRpc(environment) } : {}) });
  }
  process.stdout.write(json(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`111k verification failed: ${error.message}\n`); process.exitCode = 1; });
}
