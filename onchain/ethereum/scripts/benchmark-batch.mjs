import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');
const json = path => JSON.parse(read(path));
execFileSync(process.execPath, ['scripts/check-gas-snapshots.mjs'], { cwd: root, stdio: 'inherit' });
const gas = json('snapshots/NFT111KGasTest.json');
const artifact = json('out/NFT111K.sol/NFT111K.json');
const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
const runtimeBytes = artifact.deployedBytecode.object.replace(/^0x/, '').length / 2;
const uriBytes = Buffer.byteLength('https://cdn.mons.shop/111k-sepolia/1222222.json');
const metadataAbiBytes = 64 + 30 * (64 + Math.ceil(uriBytes / 32) * 32);
const infoAbiBytes = 64 + 150 * 96;
const comparison = (batchName, separateName) => {
  const batch = Number(gas[batchName]);
  const separate = Number(gas[separateName]);
  return { batch, separate, saved: separate - batch, savedPercent: Number(((separate - batch) / separate * 100).toFixed(2)) };
};
const paths = [
  'src/NFT111K.sol', 'src/NFT111KUrlRenderer.sol', 'src/INFT111KRenderer.sol',
  'test/NFT111KGas.t.sol', 'test/TestSupport.sol', 'test/NFT111KBatch.t.sol',
  'foundry.toml', 'package-lock.json', 'snapshots/NFT111KGasTest.json', 'fixtures/discounts/proof.json',
  'scripts/benchmark-batch.mjs',
];
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(read(path)).digest('hex')])),
  toolchain: {
    forge: execFileSync('forge', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
    compiler: metadata.compiler.version,
    compilerSettings: metadata.settings,
    dependencies: json('package.json').devDependencies,
  },
  measurement: {
    command: 'node onchain/ethereum/scripts/benchmark-batch.mjs',
    gas: 'Verified committed Forge --isolate measurements. Batch costs are one transaction; separate costs sum fifteen isolated transactions with identical initial state and token order. Setup and harness costs are excluded. Write costs include intrinsic/calldata gas and refunds. Read costs measure the callee STATICCALL.',
    response: 'ABI return sizes derive from the exact static tuple layout or a URL for the maximum artwork receipt ID, including array heads, lengths and padding. Hex sizes include the 0x prefix but omit the JSON-RPC envelope.',
    receiver: 'MinimalGasReceiver; arbitrary contract-wallet callback work is excluded.',
  },
  runtime: { bytes: runtimeBytes, eip170Limit: 24576, headroomBytes: 24576 - runtimeBytes },
  unbox15: {
    ordinary: {
      artworks: 300,
      eoa: comparison('unboxCrates15', 'unboxCrates15Separate'),
      receiver: comparison('unboxCrates15Receiver', 'unboxCrates15SeparateReceiver'),
    },
    bonus: {
      artworks: 311,
      eoa: comparison('unboxCrates15Bonus', 'unboxCrates15BonusSeparate'),
      receiver: comparison('unboxCrates15BonusReceiver', 'unboxCrates15BonusSeparateReceiver'),
    },
  },
  tokenInfo150: {
    sparseArtworkTailsIncludingBonusGas: Number(gas.getTokenInfos150Fresh),
    cratesGas: Number(gas.getTokenInfos150Spot),
    absentTokensGas: Number(gas.getTokenInfos150Missing),
    abiReturnBytes: infoAbiBytes,
    rpcHexValueBytes: 2 + 2 * infoAbiBytes,
  },
  metadata30: {
    artworkGas: Number(gas.previewTokenURIs30Artworks),
    artworkReceiptGas: Number(gas.previewTokenURIs30ArtworkReceipts),
    mixedKindsGas: Number(gas.previewTokenURIs30Mixed),
    responseScenario: { kind: 4, displayId: 222222, repetitions: 30, singleUriBytes: uriBytes },
    abiReturnBytes: metadataAbiBytes,
    rpcHexValueBytes: 2 + 2 * metadataAbiBytes,
    testedCallGasBudget: 25000000,
    testedHexResponseBudgetBytes: 512 * 1024,
  },
};
const destination = join(root, 'benchmarks/batch-operations.json');
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`Wrote ${destination}\n`);
