import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import productionExportBaseline from './lib/productionExportsBaseline.mjs';

const issueKinds = [
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, '..');
const baselinePath = resolve(scriptDirectory, 'lib/productionExportsBaseline.mjs');

function compareTuples(left, right) {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]) || left[2].localeCompare(right[2]);
}

function itemName(item) {
  return item.namespace ? `${item.namespace}.${item.name}` : item.name;
}

function normalizedIssues(report) {
  const issues = [];
  for (const entry of report.issues) {
    const unexpectedKinds = Object.keys(entry).filter(
      (key) => key !== 'file' && key !== 'owners' && !issueKinds.includes(key),
    );
    if (unexpectedKinds.length > 0) {
      throw new Error(`Unexpected Knip issue categories: ${unexpectedKinds.join(', ')}`);
    }
    for (const kind of issueKinds) {
      for (const item of entry[kind] ?? []) {
        const name = kind === 'duplicates'
          ? item.map(itemName).sort().join(' = ')
          : itemName(item);
        issues.push([entry.file, kind, name]);
      }
    }
  }
  return issues.sort(compareTuples);
}

function runKnip() {
  const result = spawnSync(
    process.execPath,
    [
      resolve(projectDirectory, 'node_modules/knip/bin/knip.js'),
      '--production',
      '--include',
      'exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,duplicates',
      '--include-entry-exports',
      '--reporter',
      'json',
      '--no-exit-code',
      '--no-progress',
    ],
    { cwd: projectDirectory, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return normalizedIssues(JSON.parse(result.stdout));
}

function countsByTuple(tuples) {
  const counts = new Map();
  for (const tuple of tuples) {
    const key = JSON.stringify(tuple);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function difference(left, right) {
  const remaining = countsByTuple(right);
  return left.filter((tuple) => {
    const key = JSON.stringify(tuple);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function formatBaseline(tuples) {
  const entries = tuples.map((tuple) => `  ${JSON.stringify(tuple)},`).join('\n');
  return `const productionExportBaseline = [\n${entries}\n];\n\nexport default productionExportBaseline;\n`;
}

const actual = runKnip();
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, formatBaseline(actual));
  console.log(`Updated production export baseline with ${actual.length} issues.`);
  process.exit(0);
}

const added = difference(actual, productionExportBaseline);
const removed = difference(productionExportBaseline, actual);
if (added.length === 0 && removed.length === 0) {
  console.log(`Production export baseline matched ${actual.length} issues.`);
  process.exit(0);
}

for (const [label, tuples] of [['Added', added], ['Removed', removed]]) {
  if (tuples.length === 0) continue;
  console.error(`${label} production export issues:`);
  for (const tuple of tuples) console.error(`  ${tuple.join(' | ')}`);
}
process.exit(1);
