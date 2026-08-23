import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import npmCheckUpdates from 'npm-check-updates';

const REQUIRED_NODE = '22.23.1';
const REQUIRED_NPM = '12.0.2';
const NCU_EXCLUDED_PACKAGES = '@types/node,@typescript/native,typescript,npm';
const COMPATIBILITY_LANES = [
  {
    dependency: '@types/node',
    registryPackage: '@types/node',
    major: 22,
    versionSpec: (version) => `^${version}`,
  },
  {
    dependency: '@typescript/native',
    registryPackage: 'typescript',
    major: 7,
    versionSpec: (version) => `npm:typescript@^${version}`,
  },
  {
    dependency: 'typescript',
    registryPackage: '@typescript/typescript6',
    major: 6,
    versionSpec: (version) => `npm:@typescript/typescript6@^${version}`,
  },
];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checkOnly = process.argv.includes('--check');

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });

  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}.`);
  return result.stdout || '';
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    fail(`Could not read ${label}.`);
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getLatestCompatibilityVersions() {
  return Object.fromEntries(COMPATIBILITY_LANES.map((lane) => {
    const output = run(
      `Checking ${lane.dependency} ${lane.major}.x`,
      npmCommand,
      ['view', `${lane.registryPackage}@${lane.major}`, 'version', '--json'],
      { capture: true },
    );
    let versions;
    try {
      const parsed = JSON.parse(output);
      versions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      fail(`Checking ${lane.dependency} ${lane.major}.x returned invalid JSON.`);
    }
    const latest = versions.at(-1);
    if (typeof latest !== 'string' || !latest) {
      fail(`Could not resolve the latest ${lane.dependency} ${lane.major}.x release.`);
    }
    return [lane.dependency, latest];
  }));
}

function syncCompatibilityLanes(packageFile, label, latestVersions, update) {
  console.log(`\nChecking ${label} compatibility lanes`);
  const packagePath = resolve(packageFile);
  const lockPath = resolve(dirname(packagePath), 'package-lock.json');
  const packageData = readJson(packagePath, packageFile);
  const lockData = readJson(lockPath, lockPath);
  let changed = false;
  let current = true;

  packageData.devDependencies ||= {};
  for (const lane of COMPATIBILITY_LANES) {
    const latest = latestVersions[lane.dependency];
    const desiredSpec = lane.versionSpec(latest);
    const currentSpec = packageData.devDependencies[lane.dependency];
    const lockedVersion = lockData.packages?.[`node_modules/${lane.dependency}`]?.version;
    if (currentSpec === desiredSpec && lockedVersion === latest) continue;

    current = false;
    console.log(`${lane.dependency}: ${currentSpec || 'missing'} (${lockedVersion || 'not installed'}) -> ${desiredSpec}`);
    if (update) {
      packageData.devDependencies[lane.dependency] = desiredSpec;
      changed = true;
    }
  }

  if (current) console.log('All compatibility-controlled dependencies are current.');
  if (changed) writeJson(packagePath, packageData);
}

function verifyToolchain() {
  const nodeVersion = process.version.slice(1);
  if (nodeVersion !== REQUIRED_NODE) {
    fail(`Expected Node ${REQUIRED_NODE}, received ${nodeVersion}. Run your Node version manager in this repository first.`);
  }

  const npmVersion = run('Checking npm', npmCommand, ['--version'], { capture: true }).trim();
  if (npmVersion !== REQUIRED_NPM) {
    fail(`Expected npm ${REQUIRED_NPM}, received ${npmVersion}. Install the packageManager version declared in package.json.`);
  }
}

async function runNcu(packageFile, update) {
  console.log(`\nChecking ${packageFile}`);
  const packagePath = resolve(packageFile);
  const packageData = readJson(packagePath, packageFile);
  let upgraded;
  try {
    upgraded = await npmCheckUpdates({
      packageData: {
        ...packageData,
        engines: {
          ...packageData.engines,
          node: REQUIRED_NODE,
        },
      },
      cwd: dirname(packagePath),
      target: 'latest',
      enginesNode: true,
      reject: NCU_EXCLUDED_PACKAGES,
      loglevel: 'silent',
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const entries = Object.entries(upgraded || {});
  if (entries.length === 0) {
    console.log('All dependencies match the latest compatible versions.');
    return;
  }
  for (const [name, version] of entries) {
    console.log(`${name}: ${version}`);
  }

  if (update) {
    for (const [name, version] of entries) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (packageData[section]?.[name] !== undefined) packageData[section][name] = version;
      }
    }
    writeJson(packagePath, packageData);
  }
}

function verifyInstallScripts(cwd, label) {
  const output = run(`Reviewing ${label} install scripts`, npmCommand, ['install-scripts', 'ls', '--json'], {
    cwd,
    capture: true,
  });
  const pending = JSON.parse(output).allowScripts || [];
  if (pending.length > 0) {
    const names = pending.map((entry) => entry.name).join(', ');
    fail(`Unreviewed dependency install scripts are blocked: ${names}. Review and update allowScripts before continuing.`);
  }
}

verifyToolchain();
await runNcu('package.json', !checkOnly);
const latestCompatibilityVersions = getLatestCompatibilityVersions();
syncCompatibilityLanes('package.json', 'root', latestCompatibilityVersions, !checkOnly);

if (checkOnly) {
  console.log('\nNode/npm remain pinned, and all dependency lanes were checked without changing files.');
  process.exit(0);
}

run('Installing root dependencies', npmCommand, ['install']);
verifyInstallScripts(process.cwd(), 'root');
run('Running the full project check', npmCommand, ['run', 'check']);
console.log('\nAll dependencies and checks are current.');
