import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(await readFile(resolve(directory, 'baseline-nominal.json'), 'utf8'));
const updated = JSON.parse(await readFile(resolve(directory, 'updated-nominal.json'), 'utf8'));
for (const key of ['sourceInstrumentation', 'readinessTiming', 'responseTiming', 'clientTransport', 'versions', 'diagnostics']) {
  assert.deepEqual(baseline.fixture[key], updated.fixture[key], `Different comparison fixture: ${key}`);
}
for (const [name, digest] of Object.entries(baseline.fixture.sourceHashes)) {
  if (name.startsWith('releases/')) assert.equal(digest, updated.fixture.sourceHashes[name], `Different benchmark source: ${name}`);
}
assert.deepEqual(updated.fixture.diagnostics, { wrapper: null, publicationDisabled: false });

const round = value => Math.round(value * 100) / 100;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function summarize(report, count) {
  const scenarios = report.scenarios.filter(row => row.count === count && row.profile === 'nominal');
  assert.equal(scenarios.length, 3);
  for (const row of scenarios) {
    assert.equal(row.checks.prematureResponses, 0);
    assert.deepEqual(row.checks.frozen, { frozen: count * 20, uniqueAssets: count * 20, uniqueTokens: count * 20 });
    assert.equal(row.checks.allPublished, true);
    assert.deepEqual(row.rpc.errors, []);
  }
  const p95 = scenarios.map(row => row.artworkReadiness.p95Ms);
  return {
    p95MedianMs: median(p95), p95MinimumMs: Math.min(...p95), p95MaximumMs: Math.max(...p95),
    drainMedianMs: median(scenarios.map(row => row.drainMs)), publicationMedianMs: median(scenarios.map(row => row.publicationMs)),
    acknowledgmentP95MedianMs: median(scenarios.map(row => row.acknowledgment.p95Ms)),
    admissionP95MedianMs: median(scenarios.map(row => row.admission.p95Ms)),
    rpcCountMedian: median(scenarios.map(row => row.rpc.count)), rpcPeakMaximum: Math.max(...scenarios.map(row => row.rpc.peak)),
  };
}

const comparisons = [1, 100, 200, 500].map(count => {
  const before = summarize(baseline, count), after = summarize(updated, count);
  return { count, baseline: before, updated: after, medianP95Speedup: round(before.p95MedianMs / after.p95MedianMs),
    conservativeP95Speedup: round(before.p95MinimumMs / after.p95MaximumMs) };
});
const twoHundred = comparisons.find(row => row.count === 200), fiveHundred = comparisons.find(row => row.count === 500);
const report = {
  comparison: 'Three nominal repetitions per size; gates use the slowest updated p95 and fastest baseline p95.',
  versions: updated.fixture.versions,
  comparisons,
  gates: {
    twoHundredP95WithinSixSeconds: twoHundred.updated.p95MaximumMs <= 6000,
    twoHundredAtLeastFiveTimesFaster: twoHundred.baseline.p95MinimumMs / twoHundred.updated.p95MaximumMs >= 5,
    fiveHundredP95WithinTwelveSeconds: fiveHundred.updated.p95MaximumMs <= 12000,
    noPrematureResponsesOrDuplicateAssignments: true,
    allMetadataPublished: true,
  },
};
await writeFile(resolve(directory, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
