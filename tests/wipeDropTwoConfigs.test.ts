import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { buildRepoPlan } from '../scripts/ops/wipeDrop.ts';
import { readDeploymentDropRegistry } from '../scripts/shared/deploymentRegistry.ts';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';

for (const cluster of ['devnet', 'mainnet-beta'] as const) {
  for (const split of [false, true]) {
    test(`wipe planning tombstones both ${cluster} config roles with ${split ? 'split' : 'legacy'} payments`, async (t) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'shop-two-config-wipe-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const dropId = cluster === 'devnet' ? 'mi_note_cards_devnet' : 'mi_note_cards';
      const operationsId = `${dropId}_operations`;
      const program = new PublicKey(cluster === 'devnet'
        ? '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6'
        : '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
      const pda = (id: string) => PublicKey.findProgramAddressSync([
        Buffer.from('config'), createHash('sha256').update(id).digest(),
      ], program)[0].toBase58();
      const maxSupply = cluster === 'devnet' ? 704 : 627;
      const base = {
        ...miNoteDropFixture(), solanaCluster: cluster, dropId, maxSupply,
        collectionMint: getPreorderConfig(dropId)!.collection,
        boxMinterProgramId: program.toBase58(), boxMinterConfigPda: pda(dropId),
        operationsConfig: { configId: operationsId, boxMinterConfigPda: pda(operationsId), maxSupply: 715 },
        inventoryManifest: {
          sha256: 'a'.repeat(64),
          cardIds: [...Array.from({ length: maxSupply * 2 - 1 }, (_, index) => index + 1), 1430],
        },
      };
      const { treasury, ...withoutTreasury } = base;
      const drop: DeploymentRegistryDrop = split ? {
        ...withoutTreasury,
        paymentRouting: {
          mintProceeds: [
            { address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE', percentage: 50 },
            { address: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq', percentage: 50 },
          ],
          deliveryPaymentReceiver: treasury!,
        },
      } : base;
      const registryPath = path.join(root, 'shared/deploymentRegistry.ts');
      mkdirSync(path.dirname(registryPath), { recursive: true });
      const original = `export const DEPLOYMENT_DROPS = ${JSON.stringify({
        [dropId]: drop, card_nft_2: DEPLOYMENT_DROPS.card_nft_2,
      }, null, 2)};\nexport const BOX_MINTER_CONFIG_TOMBSTONES = {};\n`;
      writeFileSync(registryPath, original);
      for (const args of [['init', '--quiet'], ['add', '.']]) {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      const before = await readDeploymentDropRegistry(registryPath);
      const plan = await buildRepoPlan({ root, dropId });
      assert.equal(readFileSync(registryPath, 'utf8'), original);
      assert.equal(plan.registryWillChange, true);
      assert.equal(Object.hasOwn(plan.dropsNext, dropId), false);
      assert.equal(Object.hasOwn(plan.dropsNext, operationsId), false);
      writeFileSync(registryPath, plan.registryNextContent);
      const after = await readDeploymentDropRegistry(registryPath);
      assert.deepEqual(Object.keys(after.drops), ['card_nft_2']);
      assert.deepEqual(after.drops.card_nft_2, before.drops.card_nft_2);
      assert.deepEqual(Object.keys(after.tombstones).sort(), [dropId, operationsId].sort());
      for (const id of [dropId, operationsId]) {
        assert.deepEqual(after.tombstones[id], {
          solanaCluster: cluster, dropId: id,
          dropSeed: createHash('sha256').update(id).digest('hex'),
          boxMinterProgramId: program.toBase58(), boxMinterConfigPda: pda(id),
          collectionMint: drop.collectionMint, reason: 'drop-wiped',
          ...(split ? { accountSize: 488, schema: 'split-payments-v1', paymentRouting: drop.paymentRouting }
            : { accountSize: 376, schema: 'legacy', treasury: drop.treasury }),
        });
      }
    });
  }
}
