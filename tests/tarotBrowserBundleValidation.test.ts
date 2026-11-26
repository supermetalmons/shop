import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { tarotCodeHashInput } from '../shared/ethereum/tarot.ts';
import { TAROT_CREDENTIAL_PIN_PATH, tarotCredentialPin, type TarotClaimLinks } from '../scripts/tarot/claimLinks.ts';
import { mainnetCredentialFingerprint, type MainnetClaimLinks } from '../scripts/tarot/mainnetClaims.ts';

const code = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const codes = Array.from({ length: 777 }, (_, index) => index === 0 ? code :
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
const mainnetCodes = Array.from({ length: 777 }, (_, index) =>
  `abcdefab-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
const api = JSON.parse(readFileSync(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));

function releaseManifest(): TarotClaimLinks {
  return { version: 1, chainId: 11155111, contractAddress: api.vars.ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS.toLowerCase(), createdAtMs: 1_000,
    links: codes.map((code, index) => ({ code, tokenId: index + 1,
      url: `https://mons.shop/nfc?code=${code}&tokenId=${index + 1}&testnet=true` })) };
}

function mainnetManifest(): MainnetClaimLinks {
  return { version: 1, chainId: 1, collectionKey: 'dmx-mainnet-v1', contractAddress: null,
    batchId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', createdAtMs: 1_000,
    links: mainnetCodes.map((code, index) => ({ code, tokenId: index + 1,
      url: `https://mons.shop/nfc?code=${code}&tokenId=${index + 1}` })) };
}

function mainnetPin() {
  return { chainId: 1, collectionKey: 'dmx-mainnet-v1', contractAddress: api.vars.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS.toLowerCase(),
    status: 'bound', credentialCount: 777, allCredentialsVerified: true,
    credentialSetSha256: mainnetCredentialFingerprint(mainnetManifest()), checkedAt: '2026-11-25T21:31:06.838Z' };
}

function validate(content: string, options: {
  strict?: boolean; manifest?: unknown; rawManifest?: string;
  pin?: unknown; rawPin?: string; omitPin?: boolean;
  location?: 'explicit' | 'default' | 'absent' | 'missing-explicit'; args?: string[];
  mainnet?: { manifest?: unknown; rawManifest?: string; location?: 'explicit' | 'default' | 'absent' | 'missing-explicit';
    pin?: unknown; rawPin?: string; omitPin?: boolean; contractAddress?: string; enabled?: string };
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tarot-browser-bundle-'));
  try {
    for (const filename of ['scripts/validate-browser-bundle.ts', 'scripts/tarot/claimLinks.ts', 'scripts/tarot/mainnetClaims.ts',
      'shared/ethereum/tarot.ts', 'shared/ethereum/tarotCard.ts', 'shared/ethereum/dmx.ts', 'shared/ethereum/abi.ts', 'shared/ethereum/protocol.ts',
      'cloud/workers/api/wrangler.jsonc']) {
      mkdirSync(dirname(join(directory, filename)), { recursive: true });
      copyFileSync(resolve(filename), join(directory, filename));
    }
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'));
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const config = structuredClone(api);
    if (options.mainnet?.contractAddress !== undefined) config.vars.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS = options.mainnet.contractAddress;
    if (options.mainnet?.enabled !== undefined) config.vars.ETHEREUM_TAROT_MAINNET_ENABLED = options.mainnet.enabled;
    writeFileSync(join(directory, 'cloud/workers/api/wrangler.jsonc'), JSON.stringify(config));
    if (!options.omitPin) {
      const pin = Object.hasOwn(options, 'pin') ? options.pin : {
        ...tarotCredentialPin(releaseManifest()), verifiedAt: '2026-11-23T00:00:00.000Z',
      };
      mkdirSync(dirname(join(directory, TAROT_CREDENTIAL_PIN_PATH)), { recursive: true });
      writeFileSync(join(directory, TAROT_CREDENTIAL_PIN_PATH), options.rawPin ?? JSON.stringify(pin));
    }
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist', 'bundle.js'), content);
    const location = options.location ?? 'explicit';
    const manifest = location === 'default' ? join(directory, '.operations', 'dmx-sepolia-v3', 'claim-links.private.json')
      : join(directory, 'claim-links.private.json');
    if (location !== 'absent' && location !== 'missing-explicit') {
      if (location === 'default') mkdirSync(join(directory, '.operations', 'dmx-sepolia-v3'), { recursive: true });
      const value = Object.hasOwn(options, 'manifest') ? options.manifest : options.strict ? releaseManifest() : { links: codes.map(code => ({ code })) };
      writeFileSync(manifest, options.rawManifest ?? JSON.stringify(value), { mode: 0o600 });
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ETHEREUM_PRE111K_ACCESS_CODES: '["synthetic-relic-placeholder"]' };
    delete env.ETHEREUM_TAROT_PRIVATE_MANIFEST;
    delete env.ETHEREUM_DMX_MAINNET_PRIVATE_MANIFEST;
    if (location === 'explicit' || location === 'missing-explicit') env.ETHEREUM_TAROT_PRIVATE_MANIFEST = manifest;
    const mainnet = options.mainnet ?? (options.strict ? {} : undefined);
    if (mainnet) {
      const mainnetLocation = mainnet.location ?? 'default';
      const filename = mainnetLocation === 'default'
        ? join(directory, '.operations', 'dmx-mainnet-v1', 'claim-links.private.json')
        : join(directory, 'mainnet-claim-links.private.json');
      if (mainnetLocation !== 'absent' && mainnetLocation !== 'missing-explicit') {
        mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        const value = Object.hasOwn(mainnet, 'manifest') ? mainnet.manifest : mainnetManifest();
        writeFileSync(filename, mainnet.rawManifest ?? JSON.stringify(value), { mode: 0o600 });
      }
      if (mainnetLocation === 'explicit' || mainnetLocation === 'missing-explicit') env.ETHEREUM_DMX_MAINNET_PRIVATE_MANIFEST = filename;
      if (!mainnet.omitPin) {
        const pinFilename = join(directory, 'releases/dmx-mainnet-v1/credential-binding.json');
        mkdirSync(dirname(pinFilename), { recursive: true });
        writeFileSync(pinFilename, mainnet.rawPin ?? JSON.stringify(Object.hasOwn(mainnet, 'pin') ? mainnet.pin : mainnetPin()));
      }
    }
    return spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'scripts/validate-browser-bundle.ts'),
      ...(options.strict ? ['--require-tarot-manifest'] : []), ...(options.args ?? [])], {
      cwd: directory, encoding: 'utf8', env,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [label, spelling] of [['lowercase', code], ['uppercase', code.toUpperCase()],
  ['mixed case', 'AbCdEfAb-CdEf-4aBc-8dEf-AbCdEfAbCdEf']]) {
  for (const strict of [false, true]) test(`${strict ? 'release' : 'local'} bundle validation rejects a valid ${label} Tarot credential without printing secrets`, () => {
    const scope = { chainId: 11155111, contractAddress: '0x1111111111111111111111111111111111111111', tokenId: 1 };
    assert.equal(tarotCodeHashInput({ ...scope, code: spelling }), tarotCodeHashInput({ ...scope, code }));
    const result = validate(`const claimCode = "${spelling}";`, { strict });
    assert.equal(result.status, 1);
    const diagnostics = result.stdout + result.stderr;
    assert.match(diagnostics, /a configured Tarot claim code/);
    assert.equal(codes.some(value => diagnostics.toLowerCase().includes(value)), false);
  });
}

test('bundle validation permits unrelated UUIDs', () => {
  for (const strict of [false, true]) {
    const result = validate('const publicId = "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF";', { strict });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No private credentials/);
    assert.equal(codes.some(value => (result.stdout + result.stderr).toLowerCase().includes(value)), false);
  }
});

test('bundle scans inspect every staged mainnet code without printing credentials', () => {
  for (const [index, code] of mainnetCodes.entries()) {
    const spelling = index % 2 ? code.toUpperCase() : code;
    const result = validate(`const claimCode = "${spelling}";`, { location: 'absent', mainnet: {} });
    assert.equal(result.status, 1, `Card ${index + 1}`);
    const diagnostics = result.stdout + result.stderr;
    assert.match(diagnostics, /a configured DMX mainnet claim code/);
    assert.equal(mainnetCodes.some(value => diagnostics.toLowerCase().includes(value)), false);
  }
});

test('mainnet release scans support explicit paths and normalized addresses without weakening Sepolia validation', () => {
  const contractAddress = '0x' + api.vars.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS.slice(2).toUpperCase();
  for (const location of ['default', 'explicit'] as const) {
    assert.equal(validate('const safe = true;', { strict: true, mainnet: { location, contractAddress } }).status, 0);
    for (const code of [codes[0], mainnetCodes[0], mainnetCodes[776].toUpperCase()]) {
      const result = validate(`const claimCode = "${code}";`, { strict: true, mainnet: { location, contractAddress } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, code === codes[0] ? /a configured Tarot claim code/ : /a configured DMX mainnet claim code/);
      assert.doesNotMatch(result.stdout, /No private credentials/);
      assert.equal([...codes, ...mainnetCodes].some(value => (result.stdout + result.stderr).toLowerCase().includes(value)), false);
    }
    const unpinned = validate('const safe = true;', { strict: true, omitPin: true, mainnet: { location } });
    assert.equal(unpinned.status, 1);
    assert.match(unpinned.stderr, /private Tarot manifest for the configured deployment is required/);
  }
});

test('staged mainnet manifests are optional but fail closed when configured or present and invalid', () => {
  assert.equal(validate('const safe = true;', { location: 'absent' }).status, 0);
  const changed = (change: (manifest: ReturnType<typeof mainnetManifest>) => void) => {
    const manifest = mainnetManifest();
    change(manifest);
    return manifest;
  };
  const invalid = [null, {}, { ...mainnetManifest(), version: 2 }, { ...mainnetManifest(), chainId: 11155111 },
    { ...mainnetManifest(), collectionKey: 'another-collection' }, { ...mainnetManifest(), contractAddress: '0x' + '1'.repeat(40) },
    { ...mainnetManifest(), batchId: 'invalid' }, { ...mainnetManifest(), createdAtMs: -1 },
    changed(manifest => { manifest.links.pop(); }),
    changed(manifest => { manifest.links[1].code = manifest.links[0].code;
      manifest.links[1].url = `https://mons.shop/nfc?code=${manifest.links[1].code}&tokenId=2`; }),
    changed(manifest => { [manifest.links[0], manifest.links[1]] = [manifest.links[1], manifest.links[0]]; }),
    changed(manifest => { manifest.links[0].url += '&testnet=true'; }),
    changed(manifest => { manifest.links[0].code = 'private-invalid-code'; }),
  ];
  for (const mainnet of [{ location: 'missing-explicit' as const }, { rawManifest: '{' },
    ...invalid.map(manifest => ({ manifest }))]) {
    const result = validate('const safe = true;', { location: 'absent', mainnet });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid private DMX mainnet staging manifest/);
    assert.doesNotMatch(result.stdout, /No private credentials/);
    assert.equal(mainnetCodes.some(code => (result.stdout + result.stderr).toLowerCase().includes(code)), false);
  }
});

test('mainnet release scans require both default and explicit private manifests', () => {
  for (const location of ['absent', 'missing-explicit'] as const) {
    const result = validate(`const leaked = "${mainnetCodes[0]}";`, { strict: true, mainnet: { location } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mainnet/i);
    assert.doesNotMatch(result.stdout, /No private credentials/);
    assert.equal(mainnetCodes.some(value => (result.stdout + result.stderr).toLowerCase().includes(value)), false);
  }
  assert.equal(validate('const safe = true;', { mainnet: { location: 'absent', omitPin: true } }).status, 0);
});

test('mainnet release scans reject another valid credential set before scanning', () => {
  const alternate = mainnetManifest();
  alternate.links[0] = { tokenId: 1, code: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    url: 'https://mons.shop/nfc?code=ffffffff-ffff-4fff-8fff-ffffffffffff&tokenId=1' };
  for (const content of ['const safe = true;', `const leaked = "${mainnetCodes[0]}";`]) {
    const result = validate(content, { strict: true, mainnet: { manifest: alternate } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mainnet/i);
    assert.doesNotMatch(result.stdout, /No private credentials/);
    const diagnostics = (result.stdout + result.stderr).toLowerCase();
    assert.equal(mainnetCodes.some(value => diagnostics.includes(value)), false);
    assert.equal(alternate.links.some(link => diagnostics.includes(link.code)), false);
  }
});

test('mainnet release scans fail closed on missing, malformed, or conflicting binding pins', () => {
  const pin = mainnetPin();
  for (const mainnet of [{ omitPin: true }, { rawPin: '{' }, { pin: null }, { pin: {} }, { pin: [] },
    ...[{ chainId: 11155111 }, { collectionKey: 'another-collection' }, { contractAddress: `0x${'11'.repeat(20)}` },
      { status: 'staged' }, { credentialCount: 776 }, { allCredentialsVerified: false },
      { credentialSetSha256: '0'.repeat(64) }, { credentialSetSha256: 'invalid' },
      { checkedAt: 'invalid' }, { checkedAt: '' }, { checkedAt: 0 }].map(change => ({ pin: { ...pin, ...change } }))]) {
    const result = validate(`const leaked = "${mainnetCodes[0]}";`, { strict: true, mainnet });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mainnet/i);
    assert.doesNotMatch(result.stdout, /No private credentials/);
    assert.equal(mainnetCodes.some(value => (result.stdout + result.stderr).toLowerCase().includes(value)), false);
  }
  assert.equal(validate('const safe = true;', { mainnet: { omitPin: true } }).status, 0);
});

test('mainnet release scans retain credential requirements while claims are disabled', () => {
  for (const mainnet of [{ location: 'absent' as const }, { omitPin: true }]) {
    const result = validate('const safe = true;', { strict: true, mainnet: { ...mainnet, enabled: 'false' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mainnet/i);
    assert.doesNotMatch(result.stdout, /No private credentials/);
  }
  assert.equal(validate('const safe = true;', { strict: true, mainnet: { enabled: 'false' } }).status, 0);
  assert.equal(validate('const safe = true;', { strict: true,
    mainnet: { enabled: 'false', contractAddress: '', location: 'absent', omitPin: true } }).status, 0);
});

test('mainnet release scans reject enabled mainnet without a configured contract', () => {
  for (const contractAddress of ['', 'not-an-address']) {
    const result = validate('const safe = true;', { strict: true, mainnet: { enabled: 'true', contractAddress } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mainnet/i);
    assert.doesNotMatch(result.stdout, /No private credentials/);
  }
});

test('release scans require the Tarot manifest while local scans preserve optional behavior', () => {
  assert.equal(validate('const value = "safe";', { location: 'absent' }).status, 0);
  for (const location of ['absent', 'missing-explicit'] as const) {
    const result = validate('const value = "safe";', { strict: true, location });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private Tarot manifest for the configured deployment is required/);
    assert.doesNotMatch(result.stdout, /No private credentials/);
  }
  assert.equal(validate('const value = "safe";', { location: 'missing-explicit' }).status, 1);
  assert.equal(validate('const value = "safe";', { strict: true, location: 'default' }).status, 0);
});

test('release scans reject malformed, wrong-scope, duplicate and unordered credentials', () => {
  const variants: Array<[string, unknown]> = [['missing scope', { links: codes.map(code => ({ code })) }], ['null', null]];
  const changed = (label: string, change: (manifest: TarotClaimLinks) => void) => {
    const manifest = releaseManifest();
    change(manifest);
    variants.push([label, manifest]);
  };
  changed('mainnet', manifest => { manifest.chainId = 1; });
  changed('wrong contract', manifest => {
    manifest.contractAddress = manifest.contractAddress === `0x${'11'.repeat(20)}` ? `0x${'22'.repeat(20)}` : `0x${'11'.repeat(20)}`;
  });
  changed('incomplete', manifest => { manifest.links.pop(); });
  changed('duplicate code', manifest => {
    manifest.links[1].code = manifest.links[0].code;
    manifest.links[1].url = `https://mons.shop/nfc?code=${manifest.links[1].code}&tokenId=2&testnet=true`;
  });
  changed('duplicate ID', manifest => { manifest.links[1].tokenId = 1; });
  changed('unordered IDs', manifest => { [manifest.links[0], manifest.links[1]] = [manifest.links[1], manifest.links[0]]; });
  changed('wrong URL', manifest => { manifest.links[0].url = 'https://example.com'; });
  changed('invalid UUID', manifest => { manifest.links[0].code = 'private-invalid-code'; });
  for (const [label, manifest] of variants) {
    const result = validate('const value = "safe";', { strict: true, manifest });
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /private Tarot manifest for the configured deployment is required/, label);
    assert.equal(codes.some(value => (result.stdout + result.stderr).toLowerCase().includes(value)), false, label);
  }
  assert.equal(validate('const value = "safe";', { strict: true, rawManifest: '{' }).status, 1);
});

test('release scans reject another valid same-contract credential set before scanning', () => {
  const alternate = releaseManifest();
  alternate.links[0] = { tokenId: 1, code: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    url: 'https://mons.shop/nfc?code=ffffffff-ffff-4fff-8fff-ffffffffffff&tokenId=1&testnet=true' };
  for (const content of ['const safe = true;', `const leaked = "${code}";`]) {
    const result = validate(content, { strict: true, manifest: alternate });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /No private credentials/);
    assert.equal((result.stdout + result.stderr).toLowerCase().includes(code), false);
  }
});

test('release scans fail closed on missing, malformed, or conflicting credential pins', () => {
  const pin = { ...tarotCredentialPin(releaseManifest()), verifiedAt: '2026-11-23T00:00:00.000Z' };
  for (const options of [{ omitPin: true }, { rawPin: '{' }, { pin: null },
    ...[{ version: 2 }, { chainId: 1 }, { contractAddress: `0x${'11'.repeat(20)}` }, { credentialCount: 776 },
      { credentialSetSha256: '0'.repeat(64) }, { verifiedAt: 'invalid' }].map(change => ({ pin: { ...pin, ...change } }))]) {
    assert.equal(validate('const safe = true;', { strict: true, ...options }).status, 1);
  }
  assert.equal(validate('const safe = true;', { location: 'absent', omitPin: true }).status, 0);
});

test('unknown or repeated release flags cannot silently select an optional scan', () => {
  for (const args of [['--skip-tarot-manifest'], ['--require-tarot-manifest=false'], ['--require-tarot-manifest', '--require-tarot-manifest']]) {
    const result = validate('const value = "safe";', { args });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use --require-tarot-manifest/);
  }
});

test('frontend publication and release dry runs enforce the strict scan before Wrangler', () => {
  const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(scripts['validate:browser-bundle:release'], 'npm run validate:browser-bundle -- --require-tarot-manifest');
  for (const command of ['deploy', 'dry-run:frontend']) {
    const steps = scripts[command].split(' && ');
    assert.equal(steps[0], 'npm run check:frontend', command);
    const scan = steps.indexOf('npm run validate:browser-bundle:release');
    const publication = steps.findIndex(step => step.startsWith('wrangler deploy '));
    assert.ok(scan > steps.indexOf('npm run check:frontend') && scan < publication, command);
  }
  assert.equal(scripts.build, 'vite build');
  assert.doesNotMatch(scripts['validate:browser-bundle'], /--require-tarot-manifest/);
  assert.doesNotMatch(scripts.build, /PRIVATE_MANIFEST|bundle-scan/);
});
