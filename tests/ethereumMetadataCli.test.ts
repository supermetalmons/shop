import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseMetadataCliArgs } from '../scripts/ethereum-metadata/cli.ts';

test('metadata remote commands require an explicit network before reading credentials', () => {
  for (const command of ['upload', 'verify', 'restore']) {
    assert.throws(() => parseMetadataCliArgs([command]), /explicitly select/);
    assert.throws(() => parseMetadataCliArgs([command, '--network', 'production']), /explicitly select/);
    assert.deepEqual(parseMetadataCliArgs([command, '--network', 'all'])?.networks, ['sepolia', 'mainnet']);
  }
});

test('metadata generation is network-independent and defaults to bounded concurrency for remote work', () => {
  const generated = parseMetadataCliArgs(['generate', '--directory', '.cache/metadata-test']);
  assert.equal(generated?.directory, resolve('.cache/metadata-test'));
  assert.deepEqual(generated?.networks, []);
  assert.equal(parseMetadataCliArgs(['upload', '--network', 'sepolia'])?.concurrency, 32);
  assert.throws(() => parseMetadataCliArgs(['generate', '--network', 'mainnet']), /network-independent/);
  assert.throws(() => parseMetadataCliArgs(['validate', '--concurrency', '32']), /remote commands/);
});

test('metadata CLI rejects malformed, duplicated and misplaced sample selections', () => {
  for (const ids of ['', '0', '-1', '1,', '1,1', '01', '0x1', '../1', '1, 2']) {
    assert.throws(() => parseMetadataCliArgs(['upload', '--network', 'all', `--token-ids=${ids}`]), /unique comma-separated/);
  }
  assert.deepEqual(parseMetadataCliArgs(['verify', '--network', 'sepolia', '--token-ids', '1,111112,2005555'])?.tokenIds,
    ['1', '111112', '2005555']);
  for (const command of ['generate', 'validate', 'restore']) {
    const args = command === 'restore' ? [command, '--network', 'all'] : [command];
    assert.throws(() => parseMetadataCliArgs([...args, '--token-ids', '1']), /only to upload and verify/);
  }
});

test('metadata CLI rejects unsafe concurrency and prevents snapshot options on the wrong command', () => {
  for (const concurrency of ['0', '-1', '1.5', '257', 'Infinity', 'NaN', '1e2']) {
    assert.throws(() => parseMetadataCliArgs(['upload', '--network', 'all', `--concurrency=${concurrency}`]), /integer between/);
  }
  assert.throws(() => parseMetadataCliArgs(['verify', '--network', 'all', '--snapshot-directory', 'snapshot']), /only to upload/);
  assert.throws(() => parseMetadataCliArgs(['upload', '--network', 'all', '--prior-cache-root', ' ']), /cannot be empty/);
  assert.throws(() => parseMetadataCliArgs(['generate', '--directory', '']), /cannot be empty/);
});

test('metadata CLI displays help without any command and rejects unknown flags and extra commands', () => {
  assert.equal(parseMetadataCliArgs(['--help']), null);
  assert.throws(() => parseMetadataCliArgs(['upload', '--network', 'all', '--force']), /Unknown option/);
  assert.throws(() => parseMetadataCliArgs(['generate', 'upload']), /Usage:/);
});
