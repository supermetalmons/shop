import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [baselinePath, currentPath, manifestPath] = process.argv.slice(2);

if (!baselinePath || !currentPath) {
  throw new Error('Usage: node scripts/check-anchor-idl-compat.mjs <baseline-idl> <current-idl> [manifest]');
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

const baselineInstructions = indexedByName(baseline.instructions);
const currentInstructions = indexedByName(current.instructions);
if (baselineInstructions.size !== 10) throw new Error(`Expected 10 historical instructions, found ${baselineInstructions.size}`);
for (const [name, instruction] of baselineInstructions) {
  assertEqual(`instruction ${name}`, instruction, currentInstructions.get(name));
}

const addedInstructions = [...currentInstructions.keys()].filter((name) => !baselineInstructions.has(name));
assertEqual(
  'added instructions',
  ['migrate_collection_uri', 'migrate_core_asset_uri', 'migrate_receipt_uri', 'set_uri_base'],
  [...addedInstructions].sort(),
);

for (const section of ['accounts', 'constants']) {
  assertEqual(section, baseline[section] || [], current[section] || []);
}

const baselineTypes = indexedByName(baseline.types);
const currentTypes = indexedByName(current.types);
for (const [name, type] of baselineTypes) {
  assertEqual(`type ${name}`, type, currentTypes.get(name));
}
const addedTypes = [...currentTypes.keys()].filter((name) => !baselineTypes.has(name));
assertEqual('added types', ['MigrateReceiptUriArgs'], addedTypes);

const baselineErrors = new Map((baseline.errors || []).map((value) => [value.code, value]));
const currentErrors = new Map((current.errors || []).map((value) => [value.code, value]));
if (baselineErrors.size !== 49) throw new Error(`Expected 49 historical errors, found ${baselineErrors.size}`);
for (const [code, error] of baselineErrors) {
  assertEqual(`error ${code}`, error, currentErrors.get(code));
}
const addedErrors = [...currentErrors.values()].filter((error) => !baselineErrors.has(error.code));
assertEqual('added errors', [{
  code: 6049,
  name: 'InvalidMigrationTarget',
  msg: 'URI migration requires a recognized Poncho Drifella base',
}], addedErrors);

const manifest = {
  baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
  currentSha256: createHash('sha256').update(currentBytes).digest('hex'),
  preservedInstructionCount: baselineInstructions.size,
  addedInstructions,
  addedTypes,
  addedErrors,
  preservedSections: ['accounts', 'constants'],
  preservedTypes: baselineTypes.size,
  preservedErrors: baselineErrors.size,
};

if (manifestPath) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
