import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';

import { FUNCTIONS_DROPS } from '../functions/src/config/deployment.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';

const DISCOUNT_MERKLE_DIR = path.resolve('src/drops/discountMerkles');
const ROOT_RE = /^[0-9a-f]{64}$/;
const FAMILY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const FAMILY_FILE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*\.json$/;

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

function hashSortedPair(left: Buffer, right: Buffer): Buffer {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat(ordered));
}

function assertValidProof(address: string, proof: unknown, expectedRoot: string, filename: string): void {
  assert.ok(Array.isArray(proof), `discount proof for ${address} in ${filename} must be an array`);
  let hash = sha256(new PublicKey(address).toBuffer());
  for (const siblingHex of proof) {
    assert.equal(typeof siblingHex, 'string', `discount proof for ${address} in ${filename} must contain hex strings`);
    assert.match(siblingHex, ROOT_RE, `discount proof for ${address} in ${filename} contains an invalid hash`);
    hash = hashSortedPair(hash, Buffer.from(siblingHex, 'hex'));
  }
  assert.equal(hash.toString('hex'), expectedRoot, `discount proof for ${address} in ${filename} must resolve to its root`);
}

test('discount merkle registries and datasets are canonical and complete', async () => {
  const frontendDropIds = Object.keys(FRONTEND_DROPS).sort();
  const functionsDropIds = Object.keys(FUNCTIONS_DROPS).sort();
  assert.deepEqual(
    functionsDropIds,
    frontendDropIds,
    'frontend and Functions registries must contain exactly the same drop IDs',
  );

  const rootByFamily = new Map<string, string>();
  const familyByRoot = new Map<string, string>();
  for (const dropId of frontendDropIds) {
    const frontendDrop = FRONTEND_DROPS[dropId];
    const functionsDrop = FUNCTIONS_DROPS[dropId];

    assert.equal(frontendDrop.dropId, dropId, `frontend registry key ${dropId} must match its embedded dropId`);
    assert.equal(functionsDrop.dropId, dropId, `Functions registry key ${dropId} must match its embedded dropId`);
    assert.match(
      frontendDrop.discountMerkleRoot,
      ROOT_RE,
      `frontend discount Merkle root for ${dropId} must be canonical lowercase 64-character hex`,
    );
    assert.match(
      functionsDrop.discountMerkleRoot,
      ROOT_RE,
      `Functions discount Merkle root for ${dropId} must be canonical lowercase 64-character hex`,
    );
    assert.equal(
      functionsDrop.discountMerkleRoot,
      frontendDrop.discountMerkleRoot,
      `frontend and Functions discount Merkle roots must match for ${dropId}`,
    );
    assert.equal(
      functionsDrop.dropFamily,
      frontendDrop.dropFamily,
      `frontend and Functions drop families must match for ${dropId}`,
    );
    assert.match(
      frontendDrop.dropFamily,
      FAMILY_RE,
      `drop family for ${dropId} must be canonical lowercase snake case`,
    );

    const existingRoot = rootByFamily.get(frontendDrop.dropFamily);
    assert.ok(
      !existingRoot || existingRoot === frontendDrop.discountMerkleRoot,
      `drop family ${frontendDrop.dropFamily} must resolve to exactly one discount Merkle root`,
    );
    rootByFamily.set(frontendDrop.dropFamily, frontendDrop.discountMerkleRoot);

    const existingFamily = familyByRoot.get(frontendDrop.discountMerkleRoot);
    assert.ok(
      !existingFamily || existingFamily === frontendDrop.dropFamily,
      `discount Merkle root ${frontendDrop.discountMerkleRoot} must resolve to exactly one drop family`,
    );
    familyByRoot.set(frontendDrop.discountMerkleRoot, frontendDrop.dropFamily);
  }

  const filenames = (await readdir(DISCOUNT_MERKLE_DIR))
    .filter((filename) => filename.toLowerCase().endsWith('.json'))
    .sort();

  for (const filename of filenames) {
    assert.match(
      filename,
      FAMILY_FILE_RE,
      `discount Merkle dataset filename must be a canonical lowercase snake-case family: ${filename}`,
    );
  }

  assert.deepEqual(
    filenames,
    [...rootByFamily.keys()].sort().map((family) => `${family}.json`),
    'proof data must contain exactly one family-named file for every configured discount Merkle dataset',
  );

  for (const filename of filenames) {
    const family = filename.slice(0, -'.json'.length);
    const expectedRoot = rootByFamily.get(family);
    assert.ok(expectedRoot, `discount Merkle dataset ${filename} must belong to a configured family`);
    const dataset = JSON.parse(await readFile(path.join(DISCOUNT_MERKLE_DIR, filename), 'utf8')) as {
      root?: unknown;
      proofs?: unknown;
    };

    assert.equal(dataset.root, expectedRoot);
    assert.equal(typeof dataset.proofs, 'object');
    assert.ok(dataset.proofs !== null);
    const proofs = dataset.proofs as Record<string, unknown>;
    assert.ok(
      Object.keys(proofs).length > 0,
      `discount Merkle dataset ${filename} must contain at least one proof`,
    );
    for (const [address, proof] of Object.entries(proofs)) {
      assertValidProof(address, proof, expectedRoot, filename);
    }
  }
});
