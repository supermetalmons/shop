import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(resolve(root, 'test/NFT111KGas.t.sol'), 'utf8');
  const benchmarks = [...source.matchAll(/\bfunction\s+(testGas([A-Z]\w*))\s*\(\s*\)/g)]
    .map(([, test, name]) => ({ test: `${test}()`, name: name[0].toLowerCase() + name.slice(1) }));
  const names = benchmarks.map(({ name }) => name);
  if (!names.length || new Set(names).size !== names.length) throw new Error('Gas benchmark names are missing or duplicated.');
  const config = JSON.parse(execFileSync('forge', ['config', '--json'], { cwd: root, encoding: 'utf8' }));
  if (typeof config.snapshots !== 'string' || !config.snapshots) throw new Error('Foundry snapshot directory is not configured.');
  const snapshotPath = resolve(root, config.snapshots, 'NFT111KGasTest.json');
  const snapshots = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) throw new Error('Gas snapshots must be a JSON object.');
  const missing = names.filter(name => !Object.hasOwn(snapshots, name));
  const unexpected = Object.keys(snapshots).filter(name => !names.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`Gas snapshot keys do not match benchmarks. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`);
  }
  for (const name of names) {
    const value = snapshots[name];
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Gas snapshot ${name} must be a positive safe integer string.`);
    }
  }
  const expectedTests = new Set(benchmarks.map(({ test }) => test));
  const resultsError = `Gas benchmark results do not match the ${expectedTests.size} expected tests.`;
  const output = execFileSync('forge', [
    'test', '--offline', '--isolate', '--match-contract', '^NFT111KGasTest$',
    '--gas-snapshot-check=false', '--gas-snapshot-emit=false', '--json',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let suites;
  try { suites = JSON.parse(output); }
  catch { throw new Error(resultsError); }
  const suiteName = 'test/NFT111KGas.t.sol:NFT111KGasTest';
  const results = suites?.[suiteName]?.test_results;
  if (!results || Object.keys(suites).length !== 1 || Object.keys(results).length !== expectedTests.size ||
    Object.keys(results).some(test => !expectedTests.has(test))) {
    throw new Error(resultsError);
  }
  for (const { test, name } of benchmarks) {
    const result = results[test];
    if (result.status !== 'Success') throw new Error(`Gas benchmark ${test} did not succeed: ${result.status}.`);
    const groups = result.gas_snapshots;
    const measurements = groups?.NFT111KGasTest;
    if (!measurements || Object.keys(groups).length !== 1 || Object.keys(measurements).length !== 1 ||
      !Object.hasOwn(measurements, name)) {
      throw new Error(`Gas measurements for ${test} do not match the expected snapshot ${name}.`);
    }
    if (measurements[name] !== snapshots[name]) {
      throw new Error(`Gas snapshot mismatch for ${name}: expected ${snapshots[name]}, received ${measurements[name]}.`);
    }
  }
  console.log(`Validated all ${names.length} gas benchmarks and runtime measurements without updating snapshots.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
