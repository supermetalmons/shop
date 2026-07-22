import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireDeploymentRegistryMutationLock,
  CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
  canonicalizeDropAssetUrl,
  DeploymentRegistryPostCommitVerificationError,
  defaultDropFamilyForDropId,
  dropPathsFromBase,
  isDeploymentRegistryPostCommitVerificationError,
  normalizeAndValidateMetadataBaseInput,
  normalizeAndValidateDropId,
  normalizeDropBase,
  readDeploymentDropRegistry,
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  renderDeploymentRegistryFile,
  renderDeploymentRegistryFileFromSource,
  resolveDropAssetUrl,
  writeDeploymentRegistryFile,
  type DeploymentDropConfigSerialized,
} from '../scripts/shared/deploymentRegistry.ts';
import { defineNewDropConfig } from '../scripts/shared/newDropConfig.ts';
import { resolveDeploymentConfig } from '../scripts/startMint.ts';
import { decodeBoxMinterConfigForPriceUpdate } from '../scripts/setMintPrices.ts';
import {
  DEPLOYMENT_DROPS,
  DEPLOYMENT_REGISTRY_DROP_FIELDS,
  getDeploymentDrop,
  type DeploymentRegistryDrop,
} from '../functions/src/shared/deploymentRegistry.ts';
import {
  FUNCTIONS_DROPS,
  getFunctionsDrop,
} from '../functions/src/config/deployment.ts';
import {
  FRONTEND_DROPS,
  getFrontendDrop,
  secondaryMarketplaceLinksForDropId,
} from '../src/config/deployment.ts';
import { BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS } from '../functions/src/shared/boxMinterConfigCodec.ts';
import {
  CARD_NFT_2_BOX_MEDIA,
  LITTLE_SWAG_BOXES_FIGURE_MEDIA,
} from '../functions/src/shared/dropMediaDefaults.ts';

const VALID_IPFS_CID =
  'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const CANONICAL_SOURCE_URL = new URL(
  '../functions/src/shared/deploymentRegistry.ts',
  import.meta.url,
);
const DEPLOYMENT_CORE_SOURCE_URL = new URL(
  '../functions/src/shared/deploymentCore.ts',
  import.meta.url,
);
const STRIPE_CHECKOUT_CORE_SOURCE_URL = new URL(
  '../functions/src/shared/stripeCheckoutCore.ts',
  import.meta.url,
);
const FRONTEND_SOURCE_URL = new URL(
  '../src/config/deployment.ts',
  import.meta.url,
);
const FUNCTIONS_SOURCE_URL = new URL(
  '../functions/src/config/deployment.ts',
  import.meta.url,
);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('deployment registry CLIs remain importable by raw Node strip-types execution', () => {
  const moduleUrls = [
    'functions/src/shared/boxMinterConfigCodec.ts',
    'functions/src/shared/deploymentRegistry.ts',
    'scripts/shared/optimisticTextFile.ts',
    'scripts/shared/deploymentRegistry.ts',
    'scripts/deploy-all-onchain.ts',
    'functions/scripts/wipeDrop.ts',
    'scripts/setMintPrices.ts',
    'scripts/startMint.ts',
  ].map((relativePath) =>
    pathToFileURL(path.join(REPO_ROOT, relativePath)).href,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `for (const moduleUrl of ${JSON.stringify(moduleUrls)}) await import(moduleUrl);`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
});

test('upgrade-onchain runs with the exact raw Node strip-types runner', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(REPO_ROOT, 'scripts', 'upgrade-onchain.ts'),
      '--help',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  assert.match(
    result.stdout,
    /Usage:\n  npm run upgrade-onchain -- <dropId> \[options\]/,
  );
});

function registryDrop(
  dropId: string,
  overrides: Partial<DeploymentDropConfigSerialized> = {},
): DeploymentDropConfigSerialized {
  return {
    solanaCluster: 'devnet',
    dropId,
    dropFamily: 'default',
    collectionName: dropId,
    metadataBase: `https://assets.example.com/drops/${dropId}`,
    metadataPathFormat: 'compact',
    treasury: 'Treasury11111111111111111111111111111111',
    priceSol: 1,
    discountPriceSol: 0.5,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '11'.repeat(32),
    maxSupply: 10,
    itemsPerBox: 1,
    maxPerTx: 5,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'mons',
    boxMinterProgramId: 'Program1111111111111111111111111111111111',
    collectionMint: 'Collection11111111111111111111111111111111',
    receiptsMerkleTree: 'Tree111111111111111111111111111111111111',
    deliveryLookupTable: 'Lookup1111111111111111111111111111111111',
    ...overrides,
  };
}

type OptionalDeploymentRegistryDropField = {
  [Field in keyof DeploymentRegistryDrop]-?:
    {} extends Pick<DeploymentRegistryDrop, Field> ? Field : never;
}[keyof DeploymentRegistryDrop];

const ALL_OPTIONAL_DEPLOYMENT_FIELD_VALUES = {
  secondaryMarketHref: 'https://market.example.com/all_optional_fields',
  figureMedia: {
    strategy: 'cyclic',
    count: 2,
    overrides: { 3: 2 },
  },
  boxMedia: {
    strategy: 'cyclic',
    count: 3,
    overrides: { 4: 3 },
  },
  forceSoldOut: true,
  mintSelection: {
    kind: 'size',
    options: [
      { key: 'S', label: 'Small', startId: 1, endId: 5 },
      { key: 'M', label: 'Medium', startId: 6, endId: 8 },
      { key: 'L', label: 'Large', startId: 9, endId: 10 },
    ],
  },
  stripeCheckoutEnabled: true,
  stripeLiveUnitAmountCents: 12_345,
  stripeProductTaxCode: 'txcd_custom_optional_field_test',
  boxMinterConfigPda: 'Config11111111111111111111111111111111111',
} satisfies Required<
  Pick<DeploymentRegistryDrop, OptionalDeploymentRegistryDropField>
>;

async function withTempCanonical(
  source: string,
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-test-'),
  );
  const sharedDir = path.join(root, 'functions', 'src', 'shared');
  const filePath = path.join(sharedDir, 'deploymentRegistry.ts');
  try {
    await mkdir(sharedDir, { recursive: true });
    await Promise.all([
      writeFile(filePath, source, 'utf8'),
      writeFile(
        path.join(sharedDir, 'deploymentCore.ts'),
        await readFile(DEPLOYMENT_CORE_SOURCE_URL, 'utf8'),
        'utf8',
      ),
      writeFile(
        path.join(sharedDir, 'stripeCheckoutCore.ts'),
        await readFile(STRIPE_CHECKOUT_CORE_SOURCE_URL, 'utf8'),
        'utf8',
      ),
    ]);
    await run(filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const REGISTRY_START =
  '// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY';
const REGISTRY_END =
  '// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY';

function markedRegistrySource(declaration: string): string {
  return [
    '// preserved header',
    REGISTRY_START,
    declaration,
    REGISTRY_END,
    '// preserved footer',
    '',
  ].join('\n');
}

test('deployment registry mutation lock excludes overlapping operations and releases idempotently', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-lock-test-'),
  );
  const release = acquireDeploymentRegistryMutationLock({
    root,
    operation: 'deploy test_drop',
  });
  t.after(async () => {
    release();
    await rm(root, { recursive: true, force: true });
  });

  assert.throws(
    () =>
      acquireDeploymentRegistryMutationLock({
        root,
        operation: 'wipe test_drop',
      }),
    /Another deployment-registry operation may still be running/,
  );
  assert.equal(release(), true);
  assert.equal(release(), true);
});

test('deployment registry lock preserves a replacement owner', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-owner-test-'),
  );
  const lockPath = path.join(
    root,
    '.cache',
    'deployment-registry-mutation.lock',
  );
  const release = acquireDeploymentRegistryMutationLock({
    root,
    operation: 'deploy original',
  });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const replacement = {
    ...JSON.parse(await readFile(lockPath, 'utf8')),
    token: 'replacement-owner',
  };
  await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');
  assert.equal(release(), true);
  assert.equal(existsSync(lockPath), true);
});

test('deployment registry lock release retries after a transient unreadable lock', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-lock-retry-test-'),
  );
  const lockPath = path.join(
    root,
    '.cache',
    'deployment-registry-mutation.lock',
  );
  const release = acquireDeploymentRegistryMutationLock({
    root,
    operation: 'deploy retry_test_drop',
  });
  t.after(async () => {
    release();
    await rm(root, { recursive: true, force: true });
  });

  const ownedPayload = await readFile(lockPath, 'utf8');
  await writeFile(lockPath, '{not valid json\n', 'utf8');
  assert.equal(release(), false);
  assert.equal(existsSync(lockPath), true);

  await writeFile(lockPath, ownedPayload, 'utf8');
  assert.equal(release(), true);
  assert.equal(existsSync(lockPath), false);
});

test('one nonempty canonical registry owns both public projections', async () => {
  const dropIds = Object.keys(DEPLOYMENT_DROPS).sort();
  assert.ok(dropIds.length > 0);
  assert.deepEqual(Object.keys(FRONTEND_DROPS).sort(), dropIds);
  assert.deepEqual(Object.keys(FUNCTIONS_DROPS).sort(), dropIds);

  for (const dropId of dropIds) {
    const canonical = DEPLOYMENT_DROPS[dropId];
    const frontend = FRONTEND_DROPS[dropId];
    const functionsDrop = FUNCTIONS_DROPS[dropId];
    assert.equal(canonical.dropId, dropId);
    assert.equal(frontend.dropId, dropId);
    assert.equal(functionsDrop.dropId, dropId);
    for (const field of [
      'solanaCluster',
      'dropFamily',
      'collectionName',
      'metadataBase',
      'metadataPathFormat',
      'treasury',
      'priceSol',
      'discountPriceSol',
      'discountMintsPerWallet',
      'discountMerkleRoot',
      'maxSupply',
      'itemsPerBox',
      'maxPerTx',
      'namePrefix',
      'figureNamePrefix',
      'symbol',
      'boxMinterProgramId',
      'boxMinterConfigPda',
      'collectionMint',
    ] as const) {
      assert.deepEqual(frontend[field], functionsDrop[field], `${dropId}.${field}`);
      assert.deepEqual(frontend[field], canonical[field], `${dropId}.${field}`);
    }
    assert.equal('receiptsMerkleTree' in frontend, false);
    assert.equal('deliveryLookupTable' in frontend, false);
    assert.equal('stripeProductTaxCode' in frontend, false);
    assert.equal('figureMedia' in functionsDrop, false);
    assert.equal('boxMedia' in functionsDrop, false);
    assert.equal('forceSoldOut' in functionsDrop, false);
    assert.equal('secondaryMarketHref' in functionsDrop, false);
    assert.equal('paths' in functionsDrop, false);
  }
});

test('canonical field descriptor owns allowed fields and requiredness', () => {
  const knownFields = new Set(
    Object.keys(DEPLOYMENT_REGISTRY_DROP_FIELDS),
  );
  const requiredFields = Object.entries(
    DEPLOYMENT_REGISTRY_DROP_FIELDS,
  )
    .filter(([, descriptor]) => descriptor.required)
    .map(([field]) => field);

  for (const [dropId, drop] of Object.entries(DEPLOYMENT_DROPS)) {
    for (const field of Object.keys(drop)) {
      assert.equal(
        knownFields.has(field),
        true,
        `${dropId}.${field} is described`,
      );
    }
    for (const field of requiredFields) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(drop, field),
        true,
        `${dropId}.${field} is required`,
      );
    }
  }
});

test('frontend and Functions projections retain media, sold-out, Stripe, and server defaults', () => {
  assert.deepEqual(
    FRONTEND_DROPS.little_swag_boxes.figureMedia,
    LITTLE_SWAG_BOXES_FIGURE_MEDIA,
  );
  assert.deepEqual(
    FRONTEND_DROPS.card_nft_2_devnet_final.boxMedia,
    CARD_NFT_2_BOX_MEDIA,
  );
  const soldOutDropIds = [
    'card_nft_2',
    'drifella_shirt',
    'little_swag_boxes',
    'poncho_drifella',
  ];
  assert.deepEqual(
    Object.values(DEPLOYMENT_DROPS)
      .filter((drop) => drop.forceSoldOut === true)
      .map((drop) => drop.dropId)
      .sort(),
    soldOutDropIds,
  );
  assert.deepEqual(
    Object.values(FRONTEND_DROPS)
      .filter((drop) => drop.forceSoldOut === true)
      .map((drop) => drop.dropId)
      .sort(),
    soldOutDropIds,
  );
  assert.equal(
    Object.values(FUNCTIONS_DROPS).some((drop) =>
      Object.prototype.hasOwnProperty.call(drop, 'forceSoldOut'),
    ),
    false,
  );
  assert.equal(FRONTEND_DROPS.card_nft_2.stripeCheckoutEnabled, true);
  assert.equal(FUNCTIONS_DROPS.card_nft_2.stripeCheckoutEnabled, true);
  assert.equal(
    FUNCTIONS_DROPS.card_nft_2.stripeProductTaxCode,
    CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
  );
  assert.equal(
    FUNCTIONS_DROPS.little_swag_hoodies.stripeProductTaxCode,
    'txcd_30011000',
  );
});

test('drop IDs use one bounded safe slug policy and reject prototype names', () => {
  assert.equal(normalizeAndValidateDropId('a'), 'a');
  assert.equal(normalizeAndValidateDropId('  Alpha-DROP_1  '), 'alpha-drop_1');
  assert.equal(normalizeAndValidateDropId('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizeAndValidateDropId('0_-'), '0_-');

  for (const value of [
    '',
    '-alpha',
    '_alpha',
    'alpha/beta',
    'alpha.beta',
    'alpha beta',
    'a'.repeat(65),
    'constructor',
    '__proto__',
  ]) {
    assert.throws(
      () => normalizeAndValidateDropId(value),
      /Invalid dropId/,
      value,
    );
  }
});

test('deployment lookup facades never expose Object.prototype properties', () => {
  for (const inheritedName of ['constructor', '__proto__', 'toString']) {
    assert.equal(getDeploymentDrop(inheritedName), undefined);
    assert.equal(getFrontendDrop(inheritedName), undefined);
    assert.equal(getFunctionsDrop(inheritedName), undefined);
  }
  assert.equal(getDeploymentDrop(' CARD_NFT_2 '), DEPLOYMENT_DROPS.card_nft_2);
  assert.equal(getFrontendDrop(' CARD_NFT_2 '), FRONTEND_DROPS.card_nft_2);
  assert.equal(getFunctionsDrop(' CARD_NFT_2 '), FUNCTIONS_DROPS.card_nft_2);
});

test('shared family and marketplace helpers ignore inherited prototype values', () => {
  for (const inheritedName of ['constructor', '__proto__']) {
    assert.equal(defaultDropFamilyForDropId(inheritedName), 'default');
    assert.deepEqual(
      secondaryMarketplaceLinksForDropId(inheritedName).map(
        ({ key, href }) => ({ key, href }),
      ),
      [
        {
          key: 'magiceden',
          href: `https://magiceden.io/marketplace/${inheritedName}`,
        },
        {
          key: 'tensor',
          href: `https://www.tensor.trade/trade/${inheritedName}`,
        },
      ],
    );
  }
});

test('drifella shirt secondary marketplaces use the mainnet collection address', () => {
  const collectionAddress = DEPLOYMENT_DROPS.drifella_shirt.collectionMint;
  assert.deepEqual(
    secondaryMarketplaceLinksForDropId('drifella_shirt').map(
      ({ key, href }) => ({ key, href }),
    ),
    [
      {
        key: 'magiceden',
        href: `https://magiceden.io/marketplace/${collectionAddress}`,
      },
      {
        key: 'tensor',
        href: `https://www.tensor.trade/trade/${collectionAddress}`,
      },
    ],
  );
});

test('checked-in projection modules contain no registry rows or generated core templates', async () => {
  const [canonicalSource, frontendSource, functionsSource] = await Promise.all([
    readFile(CANONICAL_SOURCE_URL, 'utf8'),
    readFile(FRONTEND_SOURCE_URL, 'utf8'),
    readFile(FUNCTIONS_SOURCE_URL, 'utf8'),
  ]);
  for (const dropId of Object.keys(DEPLOYMENT_DROPS)) {
    assert.match(canonicalSource, new RegExp(`\\b${dropId}\\b`));
    const embeddedRow = new RegExp(
      `dropId:\\s*["']${dropId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    );
    assert.doesNotMatch(frontendSource, embeddedRow);
    assert.doesNotMatch(functionsSource, embeddedRow);
  }
  assert.equal(
    canonicalSource.match(
      /BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY/g,
    )?.length,
    1,
  );
  const generatorSource = await readFile(
    new URL('../scripts/shared/deploymentRegistry.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(generatorSource, /createFrontendDrop/);
  assert.doesNotMatch(generatorSource, /createFunctionsDrop/);
  assert.doesNotMatch(
    generatorSource,
    /BEGIN AUTO-GENERATED FRONTEND DROP REGISTRY/,
  );
  assert.doesNotMatch(
    generatorSource,
    /BEGIN AUTO-GENERATED FUNCTIONS DROP REGISTRY/,
  );
  assert.doesNotMatch(frontendSource, /FORCE_SOLD_OUT_DROP_OVERRIDES/);
});

test('canonical registry reader requires an existing file', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'missing-deployment-registry-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');

  await assert.rejects(
    readDeploymentDropRegistry(filePath),
    /Missing canonical deployment registry/,
  );
});

test('canonical registry reader requires its own object-valued DEPLOYMENT_DROPS export', async () => {
  const invalidSources = [
    markedRegistrySource('export const SOMETHING_ELSE = {};'),
    markedRegistrySource('export const DEPLOYMENT_DROPS = [];'),
    markedRegistrySource('export const DEPLOYMENT_DROPS = null;'),
  ];

  for (const source of invalidSources) {
    await withTempCanonical(source, async (filePath) => {
      await assert.rejects(
        readDeploymentDropRegistry(filePath),
        /must export DEPLOYMENT_DROPS as an object/,
      );
    });
  }
});

test('canonical registry reader rejects invalid rows and exact key/dropId mismatches', async () => {
  const invalidRows = [
    {
      source: markedRegistrySource(
        'export const DEPLOYMENT_DROPS = { invalid: null };',
      ),
      message: /Invalid canonical deployment registry row invalid/,
    },
    {
      source: markedRegistrySource(
        `export const DEPLOYMENT_DROPS = { alpha: ${JSON.stringify(
          registryDrop('alpha', { maxSupply: 0 }),
        )} };`,
      ),
      message: /Invalid canonical deployment registry row alpha: maxSupply/,
    },
    {
      source: markedRegistrySource(
        `export const DEPLOYMENT_DROPS = {
  alpha: { dropId: 'alpha' },
};`,
      ),
      message: /Invalid canonical deployment registry row alpha: solanaCluster/,
    },
    {
      source: markedRegistrySource(
        `export const DEPLOYMENT_DROPS = { alpha: ${JSON.stringify(
          registryDrop('beta'),
        )} };`,
      ),
      message: /key alpha does not match embedded dropId beta/,
    },
    {
      source: markedRegistrySource(
        `export const DEPLOYMENT_DROPS = { alpha: ${JSON.stringify(
          registryDrop('alpha', { dropId: ' alpha ' }),
        )} };`,
      ),
      message: /key alpha does not match embedded dropId  alpha /,
    },
  ];

  for (const { source, message } of invalidRows) {
    await withTempCanonical(source, async (filePath) => {
      await assert.rejects(readDeploymentDropRegistry(filePath), message);
    });
  }
});

test('canonical registry reader validates missing, reversed, and duplicate markers', async () => {
  const invalidSources = [
    'export const DEPLOYMENT_DROPS = {};\n',
    [
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      '',
    ].join('\n'),
    [
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      REGISTRY_END,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_START,
      '',
    ].join('\n'),
    [
      REGISTRY_START,
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      REGISTRY_START,
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      `prefix ${REGISTRY_START}`,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      ` ${REGISTRY_START}`,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      `${REGISTRY_START} trailing`,
      'export const DEPLOYMENT_DROPS = {};',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      ` ${REGISTRY_END}`,
      '',
    ].join('\n'),
    [
      REGISTRY_START,
      'export const DEPLOYMENT_DROPS = {};',
      `${REGISTRY_END} trailing`,
      '',
    ].join('\n'),
  ];

  for (const source of invalidSources) {
    await withTempCanonical(source, async (filePath) => {
      await assert.rejects(
        readDeploymentDropRegistry(filePath),
        /Malformed or missing canonical deployment registry markers/,
      );
    });
  }
});

test('canonical registry requires its sole DEPLOYMENT_DROPS declaration inside the markers', async () => {
  const outside = [
    'export const DEPLOYMENT_DROPS = {};',
    REGISTRY_START,
    'const generatedSectionPlaceholder = true;',
    REGISTRY_END,
    '',
  ].join('\n');
  await withTempCanonical(outside, async (filePath) => {
    await assert.rejects(
      readDeploymentDropRegistry(filePath),
      /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
    );
  });

  const duplicated = [
    'export const DEPLOYMENT_DROPS = {};',
    REGISTRY_START,
    'export const DEPLOYMENT_DROPS = {};',
    REGISTRY_END,
    '',
  ].join('\n');
  await withTempCanonical(duplicated, async (filePath) => {
    await assert.rejects(
      readDeploymentDropRegistry(filePath),
      /Failed to load existing deployment registry|exactly one DEPLOYMENT_DROPS export/,
    );
    assert.throws(
      () =>
        renderDeploymentRegistryFileFromSource({
          filePath,
          existingContent: duplicated,
          drops: {},
        }),
      /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
    );
  });

  const commentInsideWithAliasedExportOutside = [
    'const rows = {};',
    'export { rows as DEPLOYMENT_DROPS };',
    REGISTRY_START,
    '// export const DEPLOYMENT_DROPS = {};',
    REGISTRY_END,
    '',
  ].join('\n');
  await withTempCanonical(
    commentInsideWithAliasedExportOutside,
    async (filePath) => {
      await assert.rejects(
        readDeploymentDropRegistry(filePath),
        /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
      );
      assert.throws(
        () =>
          renderDeploymentRegistryFileFromSource({
            filePath,
            existingContent: commentInsideWithAliasedExportOutside,
            drops: {},
          }),
        /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
      );
    },
  );
});

test('canonical registry rejects markers that split the DEPLOYMENT_DROPS declaration', async () => {
  const splitDeclaration = [
    REGISTRY_START,
    'export const DEPLOYMENT_DROPS = {',
    REGISTRY_END,
    '};',
    '',
  ].join('\n');

  await withTempCanonical(splitDeclaration, async (filePath) => {
    await assert.rejects(
      readDeploymentDropRegistry(filePath),
      /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
    );
    assert.throws(
      () =>
        renderDeploymentRegistryFileFromSource({
          filePath,
          existingContent: splitDeclaration,
          drops: {},
        }),
      /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
    );
  });
});

test('canonical registry ignores DEPLOYMENT_DROPS text in comments and templates', async () => {
  const falsePositiveSources = [
    [
      'const DEPLOYMENT_DROPS = {};',
      'export { DEPLOYMENT_DROPS };',
      REGISTRY_START,
      '/*',
      'export const DEPLOYMENT_DROPS = {};',
      '*/',
      REGISTRY_END,
      '',
    ].join('\n'),
    [
      'const DEPLOYMENT_DROPS = {};',
      'export { DEPLOYMENT_DROPS };',
      REGISTRY_START,
      'const example = `',
      'export const DEPLOYMENT_DROPS = {};',
      '`;',
      REGISTRY_END,
      '',
    ].join('\n'),
  ];

  for (const source of falsePositiveSources) {
    await withTempCanonical(source, async (filePath) => {
      await assert.rejects(
        readDeploymentDropRegistry(filePath),
        /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
      );
      assert.throws(
        () =>
          renderDeploymentRegistryFileFromSource({
            filePath,
            existingContent: source,
            drops: {},
          }),
        /exactly one DEPLOYMENT_DROPS export inside its generated markers/,
      );
    });
  }
});

test('canonical registry reader rejects source mutation during module import', async () => {
  const source = [
    "import { appendFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    REGISTRY_START,
    'export const DEPLOYMENT_DROPS = {};',
    REGISTRY_END,
    "appendFileSync(fileURLToPath(import.meta.url), '// import drift\\n');",
    '',
  ].join('\n');

  await withTempCanonical(source, async (filePath) => {
    await assert.rejects(
      readDeploymentDropRegistry(filePath),
      /changed while it was being loaded/,
    );
  });
});

test('canonical registry reader returns the exact source bytes it validated', async () => {
  const source = markedRegistrySource(
    'export const DEPLOYMENT_DROPS = {};',
  );
  await withTempCanonical(source, async (filePath) => {
    const registry = await readDeploymentDropRegistry(filePath);
    assert.deepEqual(registry.drops, {});
    assert.equal(registry.sourceContent, source);
  });
});

test('canonical renderer is stable for the checked-in registry', async () => {
  const filePath = fileURLToPath(CANONICAL_SOURCE_URL);
  const [source, registry] = await Promise.all([
    readFile(filePath, 'utf8'),
    readDeploymentDropRegistry(filePath),
  ]);
  assert.equal(registry.sourceContent, source);
  assert.equal(
    renderDeploymentRegistryFile(registry),
    source,
  );
});

test('canonical renderer round-trips every optional deployment field', async () => {
  const drop = registryDrop(
    'all_optional_fields',
    ALL_OPTIONAL_DEPLOYMENT_FIELD_VALUES,
  );
  const source = renderDeploymentRegistryFile({
    drops: { [drop.dropId]: drop },
  });

  assert.match(source, /forceSoldOut: true,/);
  await withTempCanonical(source, async (filePath) => {
    const registry = await readDeploymentDropRegistry(filePath);
    assert.deepEqual(registry.drops[drop.dropId], drop);
    assert.equal(renderDeploymentRegistryFileFromSource({
      filePath,
      existingContent: registry.sourceContent,
      drops: registry.drops,
    }), source);
  });
});

test('canonical reads and rendering do not infer sold-out state from a drop ID', async () => {
  const drop = registryDrop('card_nft_2', {
    dropFamily: 'card_nft_2',
  });
  const source = renderDeploymentRegistryFile({
    drops: { [drop.dropId]: drop },
  });
  const registrySection = source.slice(
    source.indexOf('// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY'),
    source.indexOf('// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY'),
  );
  assert.doesNotMatch(registrySection, /forceSoldOut/);

  await withTempCanonical(source, async (filePath) => {
    const registry = await readDeploymentDropRegistry(filePath);
    assert.equal(registry.drops.card_nft_2.forceSoldOut, undefined);
  });
});

test('canonical renderer and writer round-trip a superset row without duplicating defaults', async () => {
  const drop = registryDrop('future_card_drop', {
    dropFamily: 'card_nft_2',
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    boxMedia: CARD_NFT_2_BOX_MEDIA,
  });
  const customMedia = {
    strategy: 'cyclic' as const,
    count: 4,
    overrides: {
      10: 2,
    },
  };
  const customMediaDrop = registryDrop('custom_media_drop', {
    boxMinterProgramId: 'Program2222222222222222222222222222222222',
    boxMedia: customMedia,
  });
  const source = renderDeploymentRegistryFile({
    drops: {
      [drop.dropId]: drop,
      [customMediaDrop.dropId]: customMediaDrop,
    },
  });
  const registrySection = source.slice(
    source.indexOf('// BEGIN AUTO-GENERATED DEPLOYMENT DROP REGISTRY'),
    source.indexOf('// END AUTO-GENERATED DEPLOYMENT DROP REGISTRY'),
  );
  const defaultCardEntry = registrySection.slice(
    registrySection.indexOf('future_card_drop: {'),
  );
  assert.match(source, /future_card_drop: \{/);
  assert.doesNotMatch(registrySection, /createFrontendDrop|createFunctionsDrop/);
  assert.doesNotMatch(defaultCardEntry, /\n    boxMedia: \{/);
  assert.doesNotMatch(defaultCardEntry, /stripeProductTaxCode/);
  assert.match(registrySection, /custom_media_drop: \{/);
  assert.match(registrySection, /count: 4/);
  assert.match(registrySection, /10: 2/);

  await withTempCanonical(source, async (filePath) => {
    const registry = await readDeploymentDropRegistry(filePath);
    assert.deepEqual(registry.drops.future_card_drop.boxMedia, CARD_NFT_2_BOX_MEDIA);
    assert.equal(registry.drops.future_card_drop.stripeCheckoutEnabled, true);
    assert.equal(
      registry.drops.future_card_drop.stripeProductTaxCode,
      CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    );
    assert.deepEqual(
      registry.drops.custom_media_drop.boxMedia,
      customMedia,
    );

    registry.drops.future_card_drop.priceSol = 2;
    await chmod(filePath, 0o666);
    const before = await stat(filePath);
    const nextContent = renderDeploymentRegistryFileFromSource({
      filePath,
      existingContent: registry.sourceContent,
      drops: registry.drops,
    });
    writeDeploymentRegistryFile({
      filePath,
      expectedContent: registry.sourceContent,
      nextContent,
    });
    const after = await stat(filePath);
    assert.equal(await readFile(filePath, 'utf8'), nextContent);
    assert.match(nextContent, /priceSol: 2,/);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o666);
  });
});

test('canonical renderer round-trips default Stripe tax codes according to effective checkout state', async () => {
  const disabled = registryDrop('disabled_card_checkout', {
    dropFamily: 'card_nft_2',
    stripeCheckoutEnabled: false,
    stripeProductTaxCode: CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    boxMinterProgramId: 'Program1111111111111111111111111111111111',
  });
  const enabled = registryDrop('enabled_card_checkout', {
    dropFamily: 'card_nft_2',
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    boxMinterProgramId: 'Program2222222222222222222222222222222222',
  });
  const source = renderDeploymentRegistryFile({
    drops: {
      [disabled.dropId]: disabled,
      [enabled.dropId]: enabled,
    },
  });
  const generatedSection = source.slice(
    source.indexOf(REGISTRY_START),
    source.indexOf(REGISTRY_END),
  );
  const disabledSection = generatedSection.slice(
    generatedSection.indexOf('disabled_card_checkout: {'),
    generatedSection.indexOf('enabled_card_checkout: {'),
  );
  const enabledSection = generatedSection.slice(
    generatedSection.indexOf('enabled_card_checkout: {'),
  );
  assert.match(disabledSection, /stripeCheckoutEnabled: false/);
  assert.match(
    disabledSection,
    new RegExp(
      `stripeProductTaxCode: '${CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE}'`,
    ),
  );
  assert.doesNotMatch(enabledSection, /stripeProductTaxCode/);

  await withTempCanonical(source, async (filePath) => {
    const firstRead = await readDeploymentDropRegistry(filePath);
    assert.equal(
      firstRead.drops.disabled_card_checkout.stripeProductTaxCode,
      CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    );
    assert.equal(
      firstRead.drops.enabled_card_checkout.stripeProductTaxCode,
      CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    );
    const renderedAgain = renderDeploymentRegistryFileFromSource({
      filePath,
      existingContent: firstRead.sourceContent,
      drops: firstRead.drops,
    });
    assert.equal(renderedAgain, source);
    writeDeploymentRegistryFile({
      filePath,
      expectedContent: firstRead.sourceContent,
      nextContent: renderedAgain,
    });
    const secondRead = await readDeploymentDropRegistry(filePath);
    assert.deepEqual(secondRead.drops, firstRead.drops);
    assert.equal(secondRead.sourceContent, source);
  });
});

test('canonical registry writer requires an existing target', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-missing-writer-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');

  assert.throws(
    () =>
      writeDeploymentRegistryFile({
        filePath,
        expectedContent: 'before\n',
        nextContent: 'after\n',
      }),
    (err: unknown) =>
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'ENOENT',
  );
  assert.equal(existsSync(filePath), false);
});

test('canonical registry writer rejects stale preparation without overwriting concurrent content', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-conflict-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  const concurrent = 'concurrent\n';
  await writeFile(filePath, concurrent, 'utf8');

  assert.throws(
    () =>
      writeDeploymentRegistryFile({
        filePath,
        expectedContent: 'prepared\n',
        nextContent: 'ours\n',
      }),
    /changed after it was prepared/,
  );
  assert.equal(await readFile(filePath, 'utf8'), concurrent);
});

test('canonical registry writer leaves inode and mutation timestamps untouched on a no-op', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-noop-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  const content = 'unchanged\n';
  await writeFile(filePath, content, 'utf8');
  await utimes(filePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const before = await stat(filePath);

  writeDeploymentRegistryFile({
    filePath,
    expectedContent: content,
    nextContent: content,
  });

  const after = await stat(filePath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(await readFile(filePath, 'utf8'), content);
});

test('canonical registry writer preserves hard-link identity and updates every link', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-hardlink-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  const hardLinkPath = path.join(root, 'deploymentRegistry-hardlink.ts');
  await writeFile(filePath, 'before\n', 'utf8');
  await link(filePath, hardLinkPath);
  const before = await stat(filePath);

  writeDeploymentRegistryFile({
    filePath,
    expectedContent: 'before\n',
    nextContent: 'after\n',
  });

  const [fileAfter, linkAfter] = await Promise.all([
    stat(filePath),
    stat(hardLinkPath),
  ]);
  assert.equal(fileAfter.ino, before.ino);
  assert.equal(linkAfter.ino, before.ino);
  assert.equal(fileAfter.mode, before.mode);
  assert.equal(fileAfter.uid, before.uid);
  assert.equal(fileAfter.gid, before.gid);
  assert.equal(await readFile(filePath, 'utf8'), 'after\n');
  assert.equal(await readFile(hardLinkPath, 'utf8'), 'after\n');
});

test('canonical registry writer follows a symlink without replacing it', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-symlink-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'deploymentRegistry-target.ts');
  const symlinkPath = path.join(root, 'deploymentRegistry.ts');
  await writeFile(targetPath, 'before\n', 'utf8');
  await symlink(targetPath, symlinkPath);
  const before = await stat(targetPath);

  writeDeploymentRegistryFile({
    filePath: symlinkPath,
    expectedContent: 'before\n',
    nextContent: 'after\n',
  });

  assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal((await stat(targetPath)).ino, before.ino);
  assert.equal(await readFile(targetPath, 'utf8'), 'after\n');
  assert.equal(await readFile(symlinkPath, 'utf8'), 'after\n');
});

test('canonical registry writer refuses a read-only target without changing it', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can open read-only files for writing');
    return;
  }
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-readonly-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  await writeFile(filePath, 'before\n', 'utf8');
  await chmod(filePath, 0o444);

  try {
    assert.throws(
      () =>
        writeDeploymentRegistryFile({
          filePath,
          expectedContent: 'before\n',
          nextContent: 'after\n',
        }),
      (err: unknown) =>
        err instanceof Error &&
        ['EACCES', 'EPERM'].includes(
          String((err as NodeJS.ErrnoException).code),
        ),
    );
    assert.equal(await readFile(filePath, 'utf8'), 'before\n');
  } finally {
    await chmod(filePath, 0o600);
  }
});

test('canonical registry writer restores prepared bytes through the same inode after a partial write failure', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-write-failure-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  const beforeContent = 'prepared registry bytes\n';
  const nextContent = 'new registry bytes that are longer\n';
  await writeFile(filePath, beforeContent, 'utf8');
  const before = await stat(filePath);
  const injectedError = new Error('injected positional write failure');
  let shouldFail = true;
  const failingWrite = ((
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    if (shouldFail) {
      shouldFail = false;
      const partialLength = Math.max(1, Math.floor(length / 2));
      writeSync(fd, buffer, offset, partialLength, position);
      throw injectedError;
    }
    return writeSync(fd, buffer, offset, length, position);
  }) as typeof writeSync;

  assert.throws(
    () =>
      writeDeploymentRegistryFile(
        {
          filePath,
          expectedContent: beforeContent,
          nextContent,
        },
        { write: failingWrite },
      ),
    (err: unknown) => err === injectedError,
  );

  const after = await stat(filePath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(filePath, 'utf8'), beforeContent);
});

test('canonical registry writer does not report a close failure after a durable commit', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-close-failure-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  await writeFile(filePath, 'before\n', 'utf8');

  assert.doesNotThrow(() =>
    writeDeploymentRegistryFile(
      {
        filePath,
        expectedContent: 'before\n',
        nextContent: 'after\n',
      },
      {
        close(fd) {
          closeSync(fd);
          throw new Error('injected post-fsync close failure');
        },
      },
    ),
  );
  assert.equal(await readFile(filePath, 'utf8'), 'after\n');
});

test('canonical registry writer never rolls back durable bytes after post-write path replacement', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'deployment-registry-post-write-replacement-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'deploymentRegistry.ts');
  const detachedPath = path.join(root, 'deploymentRegistry-detached.ts');
  const beforeContent = 'before\n';
  const nextContent = 'after durable write\n';
  const editorContent = 'editor replacement\n';
  await writeFile(filePath, beforeContent, 'utf8');
  let replaced = false;
  const replacingWrite = ((
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const written = writeSync(fd, buffer, offset, length, position);
    if (!replaced) {
      replaced = true;
      renameSync(filePath, detachedPath);
      writeFileSync(filePath, editorContent, 'utf8');
    }
    return written;
  }) as typeof writeSync;

  assert.throws(
    () =>
      writeDeploymentRegistryFile(
        {
          filePath,
          expectedContent: beforeContent,
          nextContent,
        },
        { write: replacingWrite },
      ),
    (error: unknown) => {
      assert.equal(
        isDeploymentRegistryPostCommitVerificationError(error),
        true,
      );
      assert.equal(
        error instanceof DeploymentRegistryPostCommitVerificationError,
        true,
      );
      assert.match(
        String((error as Error).cause),
        /target changed after it was opened/,
      );
      return true;
    },
  );

  assert.equal(await readFile(detachedPath, 'utf8'), nextContent);
  assert.equal(await readFile(filePath, 'utf8'), editorContent);
  assert.equal(
    isDeploymentRegistryPostCommitVerificationError(
      new Error('ordinary failure'),
    ),
    false,
  );
});

test('canonical generated registry rejects shared-program drops without explicit config PDAs', async () => {
  const source = renderDeploymentRegistryFile({
    drops: {
      alpha: registryDrop('alpha'),
      beta: registryDrop('beta', {
        collectionMint: 'Collection22222222222222222222222222222222',
      }),
    },
  });
  await withTempCanonical(source, async (filePath) => {
    await assert.rejects(
      import(`${pathToFileURL(filePath).href}?t=${Date.now()}`),
      /must set boxMinterConfigPda/,
    );
  });
});

test('legacy projection readers preserve defaults while canonical reads remain the mutation source', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'legacy-registry-reader-test-'),
  );
  const frontendPath = path.join(root, 'frontend.mjs');
  const functionsPath = path.join(root, 'functions.mjs');
  const customMarket = 'https://market.example.com/legacy-card';
  const figureMedia = {
    strategy: 'direct' as const,
    count: 7,
  };
  const boxMedia = {
    strategy: 'cyclic' as const,
    count: 3,
    overrides: { 4: 2 },
  };
  const common = registryDrop('legacy_card', {
    dropFamily: 'card_nft_2',
    secondaryMarketHref: customMarket,
    figureMedia,
    boxMedia,
    forceSoldOut: true,
  });
  const {
    receiptsMerkleTree,
    deliveryLookupTable,
    stripeProductTaxCode: _stripeProductTaxCode,
    ...frontend
  } = common;
  const {
    receiptsMerkleTree: _defaultReceipts,
    deliveryLookupTable: _defaultLookupTable,
    stripeProductTaxCode: _defaultTaxCode,
    ...defaultMarketFrontend
  } = registryDrop('default_market');
  defaultMarketFrontend.secondaryMarketHref =
    'https://www.tensor.trade/trade/default_market';
  try {
    await Promise.all([
      writeFile(
        frontendPath,
        `export const FRONTEND_DROPS = ${JSON.stringify({
          legacy_card: frontend,
          default_market: defaultMarketFrontend,
        })};\n`,
        'utf8',
      ),
      writeFile(
        functionsPath,
        `export const FUNCTIONS_DROPS = ${JSON.stringify({
          legacy_card: {
            ...frontend,
            receiptsMerkleTree,
            deliveryLookupTable,
          },
        })};\n`,
        'utf8',
      ),
    ]);
    const [frontendRegistry, functionsRegistry] = await Promise.all([
      readFrontendDropRegistry(frontendPath),
      readFunctionsDropRegistry(functionsPath),
    ]);
    assert.deepEqual(
      frontendRegistry.drops.legacy_card.figureMedia,
      figureMedia,
    );
    assert.deepEqual(
      frontendRegistry.drops.legacy_card.boxMedia,
      boxMedia,
    );
    assert.equal(
      frontendRegistry.drops.legacy_card.stripeCheckoutEnabled,
      true,
    );
    assert.equal(frontendRegistry.drops.legacy_card.secondaryMarketHref, customMarket);
    assert.equal(frontendRegistry.drops.legacy_card.forceSoldOut, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        frontendRegistry.drops.default_market,
        'secondaryMarketHref',
      ),
      false,
    );
    assert.equal(
      functionsRegistry.drops.legacy_card.secondaryMarketHref,
      customMarket,
    );
    assert.deepEqual(
      functionsRegistry.drops.legacy_card.figureMedia,
      figureMedia,
    );
    assert.deepEqual(
      functionsRegistry.drops.legacy_card.boxMedia,
      boxMedia,
    );
    assert.equal(functionsRegistry.drops.legacy_card.forceSoldOut, true);
    assert.equal(
      functionsRegistry.drops.legacy_card.stripeProductTaxCode,
      CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE,
    );
    assert.equal(
      functionsRegistry.drops.legacy_card.receiptsMerkleTree,
      receiptsMerkleTree,
    );
    assert.equal(
      functionsRegistry.drops.legacy_card.deliveryLookupTable,
      deliveryLookupTable,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy sold-out compatibility is derived only from canonical rows', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'legacy-sold-out-compatibility-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontendPath = path.join(root, 'frontend.mjs');
  const functionsPath = path.join(root, 'functions.mjs');
  const canonicalCard = DEPLOYMENT_DROPS.card_nft_2;
  const ordinaryCard = registryDrop('ordinary_card', {
    dropFamily: 'card_nft_2',
  });
  const {
    forceSoldOut: _canonicalFrontendForceSoldOut,
    stripeProductTaxCode: _canonicalFrontendTaxCode,
    receiptsMerkleTree: _canonicalFrontendReceipts,
    deliveryLookupTable: _canonicalFrontendLookupTable,
    ...canonicalFrontend
  } = canonicalCard;
  const {
    forceSoldOut: _canonicalFunctionsForceSoldOut,
    ...canonicalFunctions
  } = canonicalCard;
  const {
    stripeProductTaxCode: _ordinaryFrontendTaxCode,
    receiptsMerkleTree: _ordinaryFrontendReceipts,
    deliveryLookupTable: _ordinaryFrontendLookupTable,
    ...ordinaryFrontend
  } = ordinaryCard;

  await Promise.all([
    writeFile(
      frontendPath,
      `export const FRONTEND_DROPS = ${JSON.stringify({
        card_nft_2: canonicalFrontend,
        ordinary_card: ordinaryFrontend,
      })};\n`,
      'utf8',
    ),
    writeFile(
      functionsPath,
      `export const FUNCTIONS_DROPS = ${JSON.stringify({
        card_nft_2: canonicalFunctions,
        ordinary_card: ordinaryCard,
      })};\n`,
      'utf8',
    ),
  ]);

  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(frontendPath),
    readFunctionsDropRegistry(functionsPath),
  ]);
  assert.equal(frontendRegistry.drops.card_nft_2.forceSoldOut, true);
  assert.equal(functionsRegistry.drops.card_nft_2.forceSoldOut, true);
  assert.equal(frontendRegistry.drops.ordinary_card.forceSoldOut, undefined);
  assert.equal(functionsRegistry.drops.ordinary_card.forceSoldOut, undefined);
});

test('legacy projection readers store prototype-named IDs as own rows', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'legacy-prototype-drop-id-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontendPath = path.join(root, 'frontend.mjs');
  const functionsPath = path.join(root, 'functions.mjs');
  const protoDrop = registryDrop('__proto__');
  const {
    receiptsMerkleTree,
    deliveryLookupTable,
    stripeProductTaxCode: _stripeProductTaxCode,
    ...frontendDrop
  } = protoDrop;
  await Promise.all([
    writeFile(
      frontendPath,
      `export const FRONTEND_DROPS = { source: ${JSON.stringify(frontendDrop)} };\n`,
      'utf8',
    ),
    writeFile(
      functionsPath,
      `export const FUNCTIONS_DROPS = { source: ${JSON.stringify({
        ...frontendDrop,
        receiptsMerkleTree,
        deliveryLookupTable,
      })} };\n`,
      'utf8',
    ),
  ]);

  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(frontendPath),
    readFunctionsDropRegistry(functionsPath),
  ]);
  for (const registry of [frontendRegistry.drops, functionsRegistry.drops]) {
    assert.equal(Object.getPrototypeOf(registry), Object.prototype);
    assert.equal(
      Object.prototype.hasOwnProperty.call(registry, '__proto__'),
      true,
    );
    assert.equal(registry['__proto__'].dropId, '__proto__');
  }
});

test('legacy Functions reader rejects Stripe-enabled mainnet rows without live pricing', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'stripe-registry-reader-test-'),
  );
  const filePath = path.join(root, 'functions.mjs');
  const drop = registryDrop('mainnet_card', {
    solanaCluster: 'mainnet-beta',
    dropFamily: 'card_nft_2',
  });
  try {
    await writeFile(
      filePath,
      `export const FUNCTIONS_DROPS = ${JSON.stringify({ mainnet_card: drop })};\n`,
      'utf8',
    );
    await assert.rejects(
      readFunctionsDropRegistry(filePath),
      /stripeLiveUnitAmountCents is required for Stripe-enabled mainnet drop mainnet_card/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata base and asset URL helpers preserve legacy and compact behavior', () => {
  assert.equal(normalizeDropBase(VALID_IPFS_CID), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(
    normalizeAndValidateMetadataBaseInput(
      'https://assets.example.com/drops/alpha/',
    ),
    'https://assets.example.com/drops/alpha',
  );
  assert.throws(
    () => normalizeAndValidateMetadataBaseInput('banana'),
    /Invalid metadataBase/,
  );
  assert.throws(
    () =>
      normalizeAndValidateMetadataBaseInput(
        'https://assets.example.com/drops/alpha?file=drop',
      ),
    /without query strings or fragments/,
  );
  assert.deepEqual(dropPathsFromBase(VALID_IPFS_CID), {
    base: `ipfs://${VALID_IPFS_CID}`,
    collectionJson: `ipfs://${VALID_IPFS_CID}/collection.json`,
    boxesJsonBase: `ipfs://${VALID_IPFS_CID}/b`,
    figuresJsonBase: `ipfs://${VALID_IPFS_CID}/f`,
    receiptsBoxesJsonBase: `ipfs://${VALID_IPFS_CID}/rb`,
    receiptsFiguresJsonBase: `ipfs://${VALID_IPFS_CID}/rf`,
  });
  assert.deepEqual(
    dropPathsFromBase(
      'https://assets.example.com/drops/alpha',
      'legacy',
    ),
    {
      base: 'https://assets.example.com/drops/alpha',
      collectionJson:
        'https://assets.example.com/drops/alpha/collection.json',
      boxesJsonBase:
        'https://assets.example.com/drops/alpha/json/boxes/',
      figuresJsonBase:
        'https://assets.example.com/drops/alpha/json/figures/',
      receiptsBoxesJsonBase:
        'https://assets.example.com/drops/alpha/json/receipts/boxes/',
      receiptsFiguresJsonBase:
        'https://assets.example.com/drops/alpha/json/receipts/figures/',
    },
  );
  assert.equal(
    canonicalizeDropAssetUrl(
      `https://nftstorage.link/ipfs/${VALID_IPFS_CID}/f12.json`,
    ),
    `ipfs://${VALID_IPFS_CID}/f12.json`,
  );
  assert.equal(
    resolveDropAssetUrl(`ipfs://${VALID_IPFS_CID}/rf12.json`),
    `https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/${VALID_IPFS_CID}/rf12.json`,
  );
});

function defineDropWithMetadataBase(metadataBase: string) {
  return defineNewDropConfig({
    shared: {
      isMainnet: false,
      dropSymbol: 'mons',
      sellerFeeBasisPoints: 500,
    },
    deploy: {
      reuseProgramId: false,
    },
    onchain: {
      dropId: 'metadata_base_test',
      dropFamily: 'default',
      metadataBase,
      collectionMetadata: {
        name: 'Metadata Base Test',
      },
      discountWhitelistCsvRelativePath: 'discounts.csv',
      receiptsTree: {
        maxDepth: 14,
        maxBufferSize: 64,
        canopyDepth: 10,
      },
      priceSol: 1,
      discountPriceSol: 0.5,
      discountMintsPerWallet: 1,
      maxSupply: 10,
      itemsPerBox: 1,
      maxPerTx: 5,
      namePrefix: 'box',
      figureNamePrefix: 'figure',
    },
  });
}

test('defineNewDropConfig rejects bare, query, and fragment metadata bases', () => {
  for (const metadataBase of [
    'banana',
    'https://assets.example.com/drops/alpha?filename=drop',
    'https://assets.example.com/drops/alpha#collection',
    `ipfs://${VALID_IPFS_CID}?filename=drop`,
    `ipfs://${VALID_IPFS_CID}#collection`,
  ]) {
    assert.throws(
      () => defineDropWithMetadataBase(metadataBase),
      metadataBase === 'banana'
        ? /Invalid metadataBase/
        : /without query strings or fragments/,
    );
  }
});

test('defineNewDropConfig accepts compact-like terminal metadata-base segments', () => {
  for (const metadataBase of [
    'https://assets.example.com/drops/b',
    'https://assets.example.com/drops/f',
    `ipfs://${VALID_IPFS_CID}/rb`,
    `ipfs://${VALID_IPFS_CID}/rf`,
  ]) {
    assert.equal(
      defineDropWithMetadataBase(metadataBase).onchain.metadataBase,
      metadataBase,
    );
  }
});

async function writeStartMintCanonical(
  root: string,
  drops: Record<string, DeploymentDropConfigSerialized>,
): Promise<string> {
  const canonicalPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(
    canonicalPath,
    markedRegistrySource(
      `export const DEPLOYMENT_DROPS = ${JSON.stringify(drops)};`,
    ),
    'utf8',
  );
  return canonicalPath;
}

test('start-mint resolves valid current checkouts from the canonical registry', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'start-mint-canonical-config-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = registryDrop('alpha');
  const beta = registryDrop('beta', {
    boxMinterProgramId: 'Program2222222222222222222222222222222222',
  });
  const canonicalPath = await writeStartMintCanonical(root, { beta, alpha });

  const resolved = await resolveDeploymentConfig({
    root,
    requestedDropId: ' ALPHA ',
  });

  assert.equal(resolved.registryLabel, canonicalPath);
  assert.deepEqual(resolved.knownDropIds, ['alpha', 'beta']);
  assert.equal(resolved.dropConfig.dropId, 'alpha');
  assert.equal(resolved.dropConfig.boxMinterProgramId, alpha.boxMinterProgramId);
});

test('start-mint never downgrades when an existing canonical registry is malformed', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'start-mint-malformed-canonical-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const legacyPath = path.join(root, 'src', 'config', 'deployed.ts');
  await Promise.all([
    mkdir(path.dirname(canonicalPath), { recursive: true }),
    mkdir(path.dirname(legacyPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      canonicalPath,
      'export const DEPLOYMENT_DROPS = {};\n',
      'utf8',
    ),
    writeFile(
      legacyPath,
      "export const DEPLOYMENT = { dropId: 'legacy_drop' };\n",
      'utf8',
    ),
  ]);

  await assert.rejects(
    resolveDeploymentConfig({
      root,
      requestedDropId: 'legacy_drop',
    }),
    /Malformed or missing canonical deployment registry markers/,
  );
});

test('start-mint never downgrades when the canonical path is a dangling symlink', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'start-mint-dangling-canonical-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalPath = path.join(
    root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const legacyPath = path.join(root, 'src', 'config', 'deployed.ts');
  await Promise.all([
    mkdir(path.dirname(canonicalPath), { recursive: true }),
    mkdir(path.dirname(legacyPath), { recursive: true }),
  ]);
  await Promise.all([
    symlink('missing-deployment-registry.ts', canonicalPath),
    writeFile(
      legacyPath,
      "export const DEPLOYMENT = { dropId: 'legacy_drop' };\n",
      'utf8',
    ),
  ]);

  await assert.rejects(
    resolveDeploymentConfig({
      root,
      requestedDropId: 'legacy_drop',
    }),
    /Missing canonical deployment registry/,
  );
});

test('start-mint does not treat the frontend projection as a raw-Node fallback', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'start-mint-frontend-only-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontendPath = path.join(root, 'src', 'config', 'deployment.ts');
  await mkdir(path.dirname(frontendPath), { recursive: true });
  await writeFile(
    frontendPath,
    "export const FRONTEND_DROPS = { frontend_only: { dropId: 'frontend_only' } };\n",
    'utf8',
  );

  await assert.rejects(
    resolveDeploymentConfig({
      root,
      requestedDropId: 'frontend_only',
    }),
    (error: unknown) => {
      assert.match(String(error), /Could not find deployment config/);
      assert.doesNotMatch(String(error), /src\/config\/deployment\.ts/);
      return true;
    },
  );
});

test('start-mint rejects unsafe IDs before attempting any config resolution', async () => {
  for (const requestedDropId of ['../outside', 'constructor', 'bad id']) {
    await assert.rejects(
      resolveDeploymentConfig({
        root: path.join(os.tmpdir(), 'unused-start-mint-root'),
        requestedDropId,
      }),
      /Invalid requested dropId/,
    );
  }
});

test('start-mint retains the legacy deployed.ts fallback', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'start-mint-legacy-config-test-'),
  );
  const legacyDir = path.join(root, 'src', 'config');
  const legacyPath = path.join(legacyDir, 'deployed.ts');
  try {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      `export const DEPLOYMENT = {
        dropId: 'legacy_drop',
        solanaCluster: 'devnet',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
      };\n`,
      'utf8',
    );
    const resolved = await resolveDeploymentConfig({
      root,
      requestedDropId: 'legacy_drop',
    });
    assert.equal(resolved.registryLabel, legacyPath);
    assert.deepEqual(resolved.knownDropIds, ['legacy_drop']);
    assert.equal(resolved.dropConfig.dropId, 'legacy_drop');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('set-mint-prices preserves its historical schema and discriminator errors', () => {
  assert.throws(
    () =>
      decodeBoxMinterConfigForPriceUpdate(
        Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 1),
      ),
    new RegExp(
      `Unsupported box minter config schema: expected at least ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS} bytes, got ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 1}`,
    ),
  );
  assert.throws(
    () =>
      decodeBoxMinterConfigForPriceUpdate(
        Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS),
      ),
    /Invalid box minter config discriminator/,
  );
});
