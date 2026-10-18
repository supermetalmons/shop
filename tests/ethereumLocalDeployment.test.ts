import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the local API rejects old deployment manifests before connecting to Anvil', () => {
  const directory = mkdtempSync(join(tmpdir(), '111k-deployment-test-'));
  const deploymentFile = join(directory, 'deployment.json');
  const start = (manifest: object) => {
    writeFileSync(deploymentFile, JSON.stringify(manifest));
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ethereum111k-dev-api.ts'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ETHEREUM_111K_LOCAL_DEPLOYMENT: deploymentFile },
    });
  };
  try {
    for (const protocolVersion of [undefined, 1, 2, 3]) {
      const result = start({ protocolVersion });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /The local deployment does not support the current batch contract interface\./);
      assert.match(result.stderr, /Restart Anvil and run npm --prefix onchain\/ethereum run deploy:local again\./);
    }
    const current = start({ protocolVersion: 4, chainId: 1, rpcUrl: 'http://127.0.0.1:8545' });
    assert.ifError(current.error);
    assert.equal(current.status, 1);
    assert.match(current.stderr, /The local API accepts only an Anvil deployment on an HTTP loopback URL, chain ID 31337\./);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
