import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeReturn, encodeCall } from '../../shared/ethereum/abi.ts';
import { parseFreeMintConfig } from '../../onchain/ethereum/scripts/free-mint-config.mjs';

test('local deployment rejects current-address payees and deploys one collection at the current nonce', { timeout: 90_000 }, async () => {
  const root = resolve(import.meta.dirname, '../..');
  const originalProject = join(root, 'onchain/ethereum');
  const directory = mkdtempSync(join(tmpdir(), '111k-single-deployment-'));
  const project = join(directory, 'onchain/ethereum');
  mkdirSync(project, { recursive: true });
  for (const path of ['onchain/ethereum/scripts/deploy-local.mjs', 'onchain/ethereum/scripts/proceeds-config.mjs',
    'onchain/ethereum/scripts/free-mint-config.mjs', 'onchain/ethereum/config/free-mints.json',
    'onchain/ethereum/scripts/discount-cap-config.mjs', 'onchain/ethereum/config/discount-caps.json',
    'onchain/ethereum/fixtures/free-mints.json',
    'onchain/ethereum/foundry.toml', 'onchain/ethereum/fixtures/eip712.json',
    'onchain/ethereum/config/proceeds.json', 'onchain/ethereum/config/delivery-routing.json', 'src/ethereum/discounts/111k.json']) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  for (const path of ['src', 'node_modules']) symlinkSync(join(originalProject, path), join(project, path), 'dir');
  const port = await new Promise<number>((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate Anvil port')); return; }
      server.close(error => error ? reject(error) : done(address.port));
    });
  });
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--hardfork', 'prague', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let anvilError = '';
  anvil.stderr.on('data', data => { anvilError += String(data); });
  anvil.on('error', error => { anvilError += error.message; });
  const rpcUrl = `http://127.0.0.1:${port}`;
  let requestId = 0;
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(5000) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (!response.ok || body.error) throw new Error(body.error?.message || `RPC HTTP ${response.status}`);
    return body.result;
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rpc('eth_chainId'); break; }
      catch {
        if (attempt >= 100 || anvil.exitCode !== null || anvilError) throw new Error(`Anvil failed: ${anvilError}`);
        await delay(25);
      }
    }
    const [deployer, owner] = await rpc<string[]>('eth_accounts');
    await rpc('anvil_setNonce', [deployer, '0x5']);
    const predicted = execFileSync('cast', ['compute-address', deployer, '--nonce', '5'], { encoding: 'utf8' })
      .match(/^Computed Address: (0x[0-9a-fA-F]{40})\s*$/)?.[1];
    assert.ok(predicted);
    const proceedsPath = join(project, 'config/proceeds.json');
    const deliveryRoutingPath = join(project, 'config/delivery-routing.json');
    const freeMintsPath = join(project, 'config/free-mints.json');
    const discountCapsPath = join(project, 'config/discount-caps.json');
    const discountCaps = JSON.parse(readFileSync(discountCapsPath, 'utf8'));
    const freeMints = JSON.parse(readFileSync(join(project, 'fixtures/free-mints.json'), 'utf8'));
    const proceeds = JSON.parse(readFileSync(proceedsPath, 'utf8'));
    const deliveryRouting = JSON.parse(readFileSync(deliveryRoutingPath, 'utf8'));
    const fixture = JSON.parse(readFileSync(join(project, 'fixtures/eip712.json'), 'utf8'));
    const discounts = JSON.parse(readFileSync(join(directory, 'src/ethereum/discounts/111k.json'), 'utf8'));
    const baseURI = 'https://cdn.mons.shop/111k-sepolia/v14/';
    const run = () => spawnSync(process.execPath, ['scripts/deploy-local.mjs'], {
      cwd: project, encoding: 'utf8', timeout: 60_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FOUNDRY_|DAPP_)/.test(name) && name !== 'ETHEREUM_111K_LOCAL_METADATA_BASE_URI')),
        ETHEREUM_111K_LOCAL_RPC_URL: rpcUrl, ETHEREUM_111K_LOCAL_OWNER: owner,
        ETHEREUM_111K_LOCAL_QUOTE_SIGNER: fixture.signer, ETHEREUM_111K_LOCAL_DISCOUNT_ROOT: discounts.root,
      },
    });
    for (const invalid of [
      { ...proceeds, mintRecipients: [predicted, ...proceeds.mintRecipients.slice(1)] },
    ]) {
      writeFileSync(proceedsPath, JSON.stringify(invalid));
      const result = run();
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid proceeds receiver address/);
      assert.equal(await rpc('eth_getTransactionCount', [deployer, 'latest']), '0x5');
    }
    writeFileSync(proceedsPath, JSON.stringify(proceeds));
    for (const invalid of [
      { initialReceiver: predicted }, { initialReceiver: proceeds.mintRecipients[0] },
      { ...deliveryRouting, receiver2: predicted },
    ]) {
      writeFileSync(deliveryRoutingPath, JSON.stringify(invalid));
      const result = run();
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /delivery/i);
      assert.equal(await rpc('eth_getTransactionCount', [deployer, 'latest']), '0x5');
    }
    writeFileSync(deliveryRoutingPath, JSON.stringify(deliveryRouting));
    for (const invalid of [
      { chainId: 11155111, groups: [{ name: 'Sepolia only', crates: 0, warehouses: 0, relics: 3, wallets: [owner] }] },
      { groups: [{ name: 'A', crates: 1, warehouses: 0, relics: 0, wallets: [predicted] }] },
      { groups: [{ ...freeMints.groups[0], wallets: Array.from({ length: 33 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`) }] },
      { groups: [{ ...freeMints.groups[0], wallets: [freeMints.groups[0].wallets[0], freeMints.groups[0].wallets[0].toLowerCase()] }] },
    ]) {
      writeFileSync(freeMintsPath, JSON.stringify(invalid));
      const invalidResult = run();
      assert.ifError(invalidResult.error);
      assert.equal(invalidResult.status, 1);
      assert.match(invalidResult.stderr, /free mint|Free mint/);
      assert.equal(await rpc('eth_getTransactionCount', [deployer, 'latest']), '0x5');
    }
    writeFileSync(freeMintsPath, JSON.stringify(freeMints));
    for (const invalid of [5556, -1, '500']) {
      writeFileSync(discountCapsPath, JSON.stringify({ ...discountCaps, local: invalid }));
      const invalidResult = run();
      assert.ifError(invalidResult.error);
      assert.equal(invalidResult.status, 1);
      assert.match(invalidResult.stderr, /Discounted mint caps/);
      assert.equal(await rpc('eth_getTransactionCount', [deployer, 'latest']), '0x5');
    }
    writeFileSync(discountCapsPath, JSON.stringify(discountCaps));
    const result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest, JSON.parse(readFileSync(join(project, '.local/deployment.json'), 'utf8')));
    assert.equal(manifest.protocolVersion, 15);
    const mintRecipients = (proceeds.mintRecipients as string[]).map(recipient => recipient.toLowerCase());
    assert.equal(mintRecipients.length, 14);
    assert.deepEqual(manifest.mintRecipients, mintRecipients);
    assert.deepEqual(manifest.mintSharesBps, proceeds.mintSharesBps);
    const encodedRecipientCount = await rpc<string>('eth_call', [{ to: manifest.contractAddress,
      data: encodeCall('mintRecipientCount()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['uint256'], encodedRecipientCount), [14n]);
    await Promise.all(mintRecipients.map(async (recipient, index) => {
      const [encodedRecipient, encodedShare] = await Promise.all([
        rpc<string>('eth_call', [{ to: manifest.contractAddress,
          data: encodeCall('mintRecipients(uint256)', ['uint256'], [index]) }, 'latest']),
        rpc<string>('eth_call', [{ to: manifest.contractAddress,
          data: encodeCall('mintSharesBps(address)', ['address'], [recipient]) }, 'latest']),
      ]);
      assert.deepEqual(decodeReturn(['address'], encodedRecipient), [recipient]);
      assert.deepEqual(decodeReturn(['uint256'], encodedShare), [BigInt(proceeds.mintSharesBps[index])]);
    }));
    assert.equal(manifest.maxDiscountedMints, 5555);
    assert.equal(manifest.initialDeliveryReceiver, deliveryRouting.initialReceiver.toLowerCase());
    assert.equal(manifest.deliveryConfigId, 1);
    const encodedConfig = await rpc<string>('eth_call', [{ to: manifest.contractAddress,
      data: encodeCall('deliveryConfigs(uint256)', ['uint256'], [1]) }, 'latest']);
    assert.deepEqual(decodeReturn(['address','address','uint16','uint256','uint256','uint256'], encodedConfig),
      [manifest.initialDeliveryReceiver, '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0n]);
    assert.equal('deliveryPaymentReceiver' in manifest, false);
    assert.equal(manifest.contractAddress.toLowerCase(), predicted.toLowerCase());
    assert.equal(manifest.metadataBaseURI, baseURI);
    assert.equal(manifest.owner, owner);
    assert.deepEqual(manifest.freeMintAllocations, parseFreeMintConfig(freeMints).allocations);
    assert.deepEqual(Object.keys(manifest).filter(key => /renderer/i.test(key)), []);
    assert.equal(await rpc('eth_getTransactionCount', [deployer, 'latest']), '0x6');
    const transaction = await rpc<{ nonce: string; to: string | null }>('eth_getTransactionByHash', [manifest.collectionTransactionHash]);
    assert.equal(transaction.nonce, '0x5');
    assert.equal(transaction.to, null);
    const encodedBase = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data: encodeCall('baseURI()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['string'], encodedBase as `0x${string}`), [baseURI]);
    const encodedSale = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data: encodeCall('saleActive()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['bool'], encodedSale as `0x${string}`), [false]);
    const encodedSupply = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data: encodeCall('totalSupply()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['uint256'], encodedSupply as `0x${string}`), [0n]);
    const encodedDiscountCap = await rpc<string>('eth_call', [{ to: manifest.contractAddress,
      data: encodeCall('maxDiscountedMints()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['uint256'], encodedDiscountCap), [5555n]);
    for (const getter of ['relicsAllocated()', 'relicsMinted()', 'allocatedCrates()', 'totalMintReceived()', 'getRelicClaimedMask()',
      'totalDiscountedMints()']) {
      const encoded = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data: encodeCall(getter, [], []) }, 'latest']);
      assert.deepEqual(decodeReturn(['uint256'], encoded), [0n]);
    }
    const encodedOwner = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data: encodeCall('owner()', [], []) }, 'latest']);
    assert.deepEqual(decodeReturn(['address'], encodedOwner), [owner.toLowerCase()]);
    for (const allocation of manifest.freeMintAllocations) {
      const data = encodeCall('freeMintAllowances(address)', ['address'], [allocation.wallet]);
      const encoded = await rpc<string>('eth_call', [{ to: manifest.contractAddress, data }, 'latest']);
      assert.deepEqual(decodeReturn(Array.from({ length: 6 }, () => 'uint16'), encoded),
        [BigInt(allocation.crateLimit), BigInt(allocation.warehouseLimit), BigInt(allocation.relicLimit), 0n, 0n, 0n]);
    }
  } finally {
    if (anvil.exitCode === null && anvil.pid) {
      const stopped = once(anvil, 'exit');
      anvil.kill('SIGTERM');
      await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
