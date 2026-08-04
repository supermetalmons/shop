import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [baselinePath, currentPath, manifestPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) {
  throw new Error('Usage: node scripts/check-card-anchor-idl-compat.mjs <baseline-idl> <current-idl> [manifest]');
}

const baselineBytes = await readFile(baselinePath);
const currentBytes = await readFile(currentPath);
const baseline = JSON.parse(baselineBytes.toString('utf8'));
const current = JSON.parse(currentBytes.toString('utf8'));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function assertEqual(label, expected, actual) {
  if (JSON.stringify(stable(expected)) !== JSON.stringify(stable(actual))) {
    throw new Error(`${label} changed`);
  }
}

function indexedByName(values) {
  return new Map((values || []).map((value) => [value.name, value]));
}

assertEqual('program address', baseline.address, current.address);
const baselineInstructions = indexedByName(baseline.instructions);
const currentInstructions = indexedByName(current.instructions);
if (baselineInstructions.size !== 14) {
  throw new Error(`Expected 14 historical instructions, found ${baselineInstructions.size}`);
}
for (const [name, instruction] of baselineInstructions) {
  assertEqual(`instruction ${name}`, instruction, currentInstructions.get(name));
}
const addedInstructions = [...currentInstructions.keys()].filter((name) => !baselineInstructions.has(name));
assertEqual('added instructions', ['set_uri_base'], addedInstructions);

for (const section of ['accounts', 'constants', 'events']) {
  assertEqual(section, baseline[section] || [], current[section] || []);
}
const baselineTypes = indexedByName(baseline.types);
const currentTypes = indexedByName(current.types);
for (const [name, type] of baselineTypes) {
  assertEqual(`type ${name}`, type, currentTypes.get(name));
}
assertEqual(
  'added types',
  [],
  [...currentTypes.keys()].filter((name) => !baselineTypes.has(name)),
);
assertEqual('errors', baseline.errors || [], current.errors || []);

const manifest = {
  programId: current.address,
  baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
  currentSha256: createHash('sha256').update(currentBytes).digest('hex'),
  preservedInstructionCount: baselineInstructions.size,
  addedInstructions,
  preservedAccounts: (baseline.accounts || []).length,
  preservedTypes: baselineTypes.size,
  preservedErrors: (baseline.errors || []).length,
};

if (manifestPath) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
