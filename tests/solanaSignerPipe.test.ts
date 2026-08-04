import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startSolanaSignerPipe } from '../scripts/shared/solanaSignerPipe.ts';

test('private Solana signer pipe can be reopened without persisting its key', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mons-signer-pipe-test-'));
  const pipePath = path.join(directory, 'authority.pipe');
  const secretKey = Uint8Array.from([3, 1, 4, 1, 5, 9]);
  const expected = `${JSON.stringify(Array.from(secretKey))}\n`;
  const server = await startSolanaSignerPipe(pipePath, secretKey);
  try {
    assert.equal(statSync(pipePath).isFIFO(), true);
    assert.equal(statSync(pipePath).mode & 0o777, 0o600);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(readFileSync(pipePath, 'utf8'), expected);
    }
    assert.equal(server.spawnargs.includes(expected), false);
  } finally {
    server.kill('SIGTERM');
    secretKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
