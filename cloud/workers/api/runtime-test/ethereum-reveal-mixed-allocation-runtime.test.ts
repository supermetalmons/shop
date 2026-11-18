import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildMixedAllocation } from '../../../../scripts/ethereum-metadata/mixedAllocation.ts';
import { rehearseMixedAllocation } from '../../../../scripts/ethereum-metadata/rehearseMixedAllocation.ts';
import { mixedAllocationFixtureSource } from '../../../../tests/helpers/ethereumMixedAllocationSource.ts';

test('a mixed allocation exchanges only free eggs under concurrent reveal and owner activity', { timeout: 240_000 }, async t => {
  const source = await mixedAllocationFixtureSource();
  const release = await buildMixedAllocation(source, createHash('sha256').update(source).digest('hex'));
  const report = await rehearseMixedAllocation(release);
  t.diagnostic(JSON.stringify(report));
});
