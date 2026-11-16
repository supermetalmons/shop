import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import {
  deploymentTreasuryAlias,
  RECEIPT_POOL_DEPLOYMENT_FIELDS,
  type BoxMinterConfigTombstone,
  type ReceiptPoolDeployment,
} from '../../shared/deploymentRegistry.ts';
import { normalizeMediaMapConfig } from '../../shared/mediaMap.ts';
import {
  defaultStripeCheckoutEnabledForDropFamily,
  defaultStripeProductTaxCodeForDropFamily,
  resolveStripeCheckoutEnabledForDropFamily,
} from '../../shared/stripeCheckoutCore.ts';
import type {
  DeploymentDropConfigSerialized,
  MediaMapConfigSerialized,
  MintSelectionConfigSerialized,
} from './deploymentRegistryTypes.ts';
import {
  assertNoBoxMinterConfigRegistryCollisions,
  assertValidReceiptPoolDeployment,
  defaultFrontendBoxMediaForDropFamily,
  defaultFrontendFigureMediaForDropFamily,
  defaultSecondaryMarketHref,
  normalizeAndValidateDropId,
  normalizeBoxMinterConfigTombstone,
} from './deploymentRegistryValidation.ts';

function tsStringLiteral(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

function tsPropertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? value
    : tsStringLiteral(value);
}

function mediaMapConfigsEqual(
  left: MediaMapConfigSerialized | undefined,
  right: MediaMapConfigSerialized | undefined,
): boolean {
  return JSON.stringify(normalizeMediaMapConfig(left)) ===
    JSON.stringify(normalizeMediaMapConfig(right));
}

function renderMediaMapConfigLiteral(
  propertyName: 'figureMedia' | 'boxMedia',
  config: MediaMapConfigSerialized,
): string[] {
  const lines = [`    ${propertyName}: {`];
  if (config.strategy) {
    lines.push(`      strategy: ${tsStringLiteral(config.strategy)},`);
  }
  if (config.count) lines.push(`      count: ${Math.floor(config.count)},`);
  const overrides = Object.entries(config.overrides || {})
    .map(
      ([tokenId, mediaId]) =>
        [Math.floor(Number(tokenId)), Math.floor(Number(mediaId))] as const,
    )
    .filter(
      ([tokenId, mediaId]) =>
        Number.isFinite(tokenId) &&
        tokenId > 0 &&
        Number.isFinite(mediaId) &&
        mediaId > 0,
    )
    .sort(([left], [right]) => left - right);
  if (overrides.length) {
    lines.push('      overrides: {');
    overrides.forEach(([tokenId, mediaId]) => {
      lines.push(`        ${tokenId}: ${mediaId},`);
    });
    lines.push('      },');
  }
  lines.push('    },');
  return lines;
}

function renderMintSelectionConfigLiteral(
  config: MintSelectionConfigSerialized,
): string[] {
  const lines = [
    '    mintSelection: {',
    `      kind: ${tsStringLiteral(config.kind)},`,
    '      options: [',
  ];
  config.options.forEach((option) => {
    lines.push(
      `        { key: ${tsStringLiteral(option.key)}, label: ${tsStringLiteral(option.label)}, startId: ${Math.floor(option.startId)}, endId: ${Math.floor(option.endId)} },`,
    );
  });
  lines.push('      ],', '    },');
  return lines;
}

function renderDeploymentDropEntry(
  drop: DeploymentDropConfigSerialized,
): string {
  const lines = [
    `  ${tsPropertyName(drop.dropId)}: {`,
    `    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},`,
    `    dropId: ${tsStringLiteral(drop.dropId)},`,
    `    dropFamily: ${tsStringLiteral(drop.dropFamily)},`,
    `    collectionName: ${tsStringLiteral(drop.collectionName)},`,
  ];
  if (drop.displayName) {
    lines.push(`    displayName: ${tsStringLiteral(drop.displayName)},`);
  }
  if (drop.salesMode) {
    lines.push(`    salesMode: ${tsStringLiteral(drop.salesMode)},`);
  }
  if (drop.receiptPoolId) {
    lines.push(`    receiptPoolId: ${tsStringLiteral(drop.receiptPoolId)},`);
  }
  lines.push(
    `    metadataBase: ${tsStringLiteral(drop.metadataBase)},`,
  );
  if (drop.metadataBaseAliases?.length) {
    lines.push(
      `    metadataBaseAliases: [${drop.metadataBaseAliases.map(tsStringLiteral).join(', ')}],`,
    );
  }
  lines.push(
    `    metadataPathFormat: ${tsStringLiteral(drop.metadataPathFormat)},`,
  );
  const defaultMarket = defaultSecondaryMarketHref(drop.dropId);
  if (
    drop.secondaryMarketHref &&
    drop.secondaryMarketHref !== defaultMarket
  ) {
    lines.push(
      `    secondaryMarketHref: ${tsStringLiteral(drop.secondaryMarketHref)},`,
    );
  }
  const defaultFigureMedia = defaultFrontendFigureMediaForDropFamily(
    drop.dropFamily,
  );
  if (
    drop.figureMedia &&
    !mediaMapConfigsEqual(drop.figureMedia, defaultFigureMedia)
  ) {
    lines.push(...renderMediaMapConfigLiteral('figureMedia', drop.figureMedia));
  }
  const defaultBoxMedia = defaultFrontendBoxMediaForDropFamily(drop.dropFamily);
  if (
    drop.boxMedia &&
    !mediaMapConfigsEqual(drop.boxMedia, defaultBoxMedia)
  ) {
    lines.push(...renderMediaMapConfigLiteral('boxMedia', drop.boxMedia));
  }
  if (drop.forceSoldOut === true) {
    lines.push('    forceSoldOut: true,');
  }
  if (drop.mintSelection) {
    lines.push(...renderMintSelectionConfigLiteral(drop.mintSelection));
  }
  if (drop.paymentRouting) {
    lines.push('    paymentRouting: {', '      mintProceeds: [');
    drop.paymentRouting.mintProceeds.forEach((recipient) => {
      lines.push(
        `        { address: ${tsStringLiteral(recipient.address)}, percentage: ${recipient.percentage} },`,
      );
    });
    lines.push(
      '      ],',
      `      deliveryPaymentReceiver: ${tsStringLiteral(drop.paymentRouting.deliveryPaymentReceiver)},`,
      '    },',
    );
  } else {
    lines.push(
      `    treasury: ${tsStringLiteral(deploymentTreasuryAlias(drop))},`,
    );
  }
  lines.push(
    `    priceSol: ${Number(drop.priceSol)},`,
    `    discountPriceSol: ${Number(drop.discountPriceSol)},`,
  );
  const defaultStripeEnabled =
    defaultStripeCheckoutEnabledForDropFamily(drop.dropFamily);
  if (drop.stripeCheckoutEnabled === true && !defaultStripeEnabled) {
    lines.push('    stripeCheckoutEnabled: true,');
  } else if (
    drop.stripeCheckoutEnabled === false &&
    defaultStripeEnabled
  ) {
    lines.push('    stripeCheckoutEnabled: false,');
  }
  if (drop.stripeLiveUnitAmountCents != null) {
    lines.push(
      `    stripeLiveUnitAmountCents: ${Math.floor(drop.stripeLiveUnitAmountCents)},`,
    );
  }
  const defaultTaxCode = defaultStripeProductTaxCodeForDropFamily(
    drop.dropFamily,
  );
  const stripeCheckoutEnabled = resolveStripeCheckoutEnabledForDropFamily(
    drop.stripeCheckoutEnabled,
    drop.dropFamily,
  ).enabled;
  if (
    drop.stripeProductTaxCode &&
    (drop.stripeProductTaxCode !== defaultTaxCode ||
      !stripeCheckoutEnabled)
  ) {
    lines.push(
      `    stripeProductTaxCode: ${tsStringLiteral(drop.stripeProductTaxCode)},`,
    );
  }
  lines.push(
    `    discountMintsPerWallet: ${Math.floor(drop.discountMintsPerWallet)},`,
    `    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},`,
    `    maxSupply: ${Math.floor(drop.maxSupply)},`,
  );
  if (drop.operationsConfig) {
    lines.push(
      '    operationsConfig: {',
      `      configId: ${tsStringLiteral(drop.operationsConfig.configId)},`,
      `      boxMinterConfigPda: ${tsStringLiteral(drop.operationsConfig.boxMinterConfigPda)},`,
      `      maxSupply: ${drop.operationsConfig.maxSupply},`,
      '    },',
    );
  }
  if (drop.inventoryManifest) {
    lines.push(
      '    inventoryManifest: {',
      `      sha256: ${tsStringLiteral(drop.inventoryManifest.sha256)},`,
      '      cardIds: [',
    );
    for (let index = 0; index < drop.inventoryManifest.cardIds.length; index += 20) {
      lines.push(`        ${drop.inventoryManifest.cardIds.slice(index, index + 20).join(', ')},`);
    }
    lines.push('      ],', '    },');
  }
  if (drop.receiptMaxId != null) {
    lines.push(`    receiptMaxId: ${Math.floor(drop.receiptMaxId)},`);
  }
  lines.push(
    `    itemsPerBox: ${Math.floor(drop.itemsPerBox)},`,
    `    maxPerTx: ${Math.floor(drop.maxPerTx)},`,
    `    namePrefix: ${tsStringLiteral(drop.namePrefix)},`,
    `    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},`,
    `    symbol: ${tsStringLiteral(drop.symbol)},`,
    `    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},`,
  );
  if (drop.boxMinterConfigPda) {
    lines.push(
      `    boxMinterConfigPda: ${tsStringLiteral(drop.boxMinterConfigPda)},`,
    );
  }
  lines.push(
    `    collectionMint: ${tsStringLiteral(drop.collectionMint)},`,
    `    receiptsMerkleTree: ${tsStringLiteral(drop.receiptsMerkleTree)},`,
  );
  if (drop.receiptsTreeMaxDepth != null) {
    lines.push(
      `    receiptsTreeMaxDepth: ${Math.floor(drop.receiptsTreeMaxDepth)},`,
    );
  }
  if (drop.receiptsTreeCanopyDepth != null) {
    lines.push(
      `    receiptsTreeCanopyDepth: ${Math.floor(drop.receiptsTreeCanopyDepth)},`,
    );
  }
  lines.push(
    `    deliveryLookupTable: ${tsStringLiteral(drop.deliveryLookupTable)},`,
    '  },',
  );
  return lines.join('\n');
}

function renderDeploymentRegistrySection(args: {
  drops: Record<string, DeploymentDropConfigSerialized>;
}): string {
  const entries = Object.keys(args.drops)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      if (!Object.prototype.hasOwnProperty.call(args.drops, registryKey)) {
        throw new Error(
          `Canonical deployment registry row is not an own property: ${registryKey}`,
        );
      }
      const normalizedRegistryKey = normalizeAndValidateDropId(
        registryKey,
        'deployment registry key',
      );
      if (normalizedRegistryKey !== registryKey) {
        throw new Error(
          `Canonical deployment registry key must be normalized: ${registryKey}`,
        );
      }
      const drop = args.drops[registryKey];
      const normalizedDropId = normalizeAndValidateDropId(
        drop?.dropId,
        'deployment registry row dropId',
      );
      if (drop.dropId !== normalizedDropId || normalizedDropId !== registryKey) {
        throw new Error(
          `Canonical deployment registry key ${registryKey} does not match embedded dropId ${String(drop?.dropId)}`,
        );
      }
      return renderDeploymentDropEntry(drop);
    })
    .join('\n');
  return `export const DEPLOYMENT_DROPS: DeploymentDropsMap = {
${entries}
};`;
}

function renderBoxMinterConfigTombstoneEntry(
  tombstone: BoxMinterConfigTombstone,
): string {
  const lines = [
    `  ${tsPropertyName(tombstone.dropId)}: {`,
    `    solanaCluster: ${tsStringLiteral(tombstone.solanaCluster)},`,
    `    dropId: ${tsStringLiteral(tombstone.dropId)},`,
    `    dropSeed: ${tsStringLiteral(tombstone.dropSeed)},`,
    `    boxMinterProgramId: ${tsStringLiteral(tombstone.boxMinterProgramId)},`,
    `    boxMinterConfigPda: ${tsStringLiteral(tombstone.boxMinterConfigPda)},`,
    `    collectionMint: ${tsStringLiteral(tombstone.collectionMint)},`,
    `    accountSize: ${tombstone.accountSize},`,
    `    schema: ${tsStringLiteral(tombstone.schema)},`,
  ];
  if (tombstone.paymentRouting) {
    lines.push('    paymentRouting: {', '      mintProceeds: [');
    tombstone.paymentRouting.mintProceeds.forEach((recipient) => {
      lines.push(
        `        { address: ${tsStringLiteral(recipient.address)}, percentage: ${recipient.percentage} },`,
      );
    });
    lines.push(
      '      ],',
      `      deliveryPaymentReceiver: ${tsStringLiteral(tombstone.paymentRouting.deliveryPaymentReceiver)},`,
      '    },',
    );
  } else {
    lines.push(`    treasury: ${tsStringLiteral(tombstone.treasury)},`);
  }
  lines.push(
    `    reason: ${tsStringLiteral(tombstone.reason)},`,
    '  },',
  );
  return lines.join('\n');
}

function renderBoxMinterConfigTombstonesSection(args: {
  tombstones: Record<string, BoxMinterConfigTombstone>;
}): string {
  const entries = Object.keys(args.tombstones)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      if (!Object.prototype.hasOwnProperty.call(args.tombstones, registryKey)) {
        throw new Error(
          `BoxMinter config tombstone is not an own property: ${registryKey}`,
        );
      }
      const tombstone = normalizeBoxMinterConfigTombstone({
        registryKey,
        value: args.tombstones[registryKey],
        filePath: 'rendered deployment registry',
      });
      if (!isDeepStrictEqual(tombstone, args.tombstones[registryKey])) {
        throw new Error(
          `BoxMinter config tombstone ${registryKey} must be canonical`,
        );
      }
      return renderBoxMinterConfigTombstoneEntry(tombstone);
    })
    .join('\n');
  return `export const BOX_MINTER_CONFIG_TOMBSTONES: BoxMinterConfigTombstonesMap = {
${entries}
};`;
}

function renderReceiptPoolDeploymentEntry(
  registryKey: string,
  pool: ReceiptPoolDeployment,
): string {
  return [
    `  ${tsPropertyName(registryKey)}: {`,
    ...Object.keys(RECEIPT_POOL_DEPLOYMENT_FIELDS).map((field) => {
      const value = pool[field as keyof ReceiptPoolDeployment];
      return `    ${field}: ${typeof value === 'string' ? tsStringLiteral(value) : Math.floor(value)},`;
    }),
    '  },',
  ].join('\n');
}

function renderReceiptPoolDeploymentsSection(args: {
  receiptPools: Record<string, ReceiptPoolDeployment>;
}): string {
  const entries = Object.keys(args.receiptPools)
    .sort((left, right) => left.localeCompare(right))
    .map((registryKey) => {
      const pool = args.receiptPools[registryKey];
      const rowArgs = {
        registryKey,
        value: pool,
        filePath: 'rendered deployment registry',
      };
      assertValidReceiptPoolDeployment(rowArgs);
      return renderReceiptPoolDeploymentEntry(registryKey, pool);
    })
    .join('\n');
  return `export const RECEIPT_POOL_DEPLOYMENTS: ReceiptPoolDeploymentsMap = {
${entries}
};`;
}

type ExportedConstBounds = {
  start: number;
  end: number;
};

export function findUniqueExportedConst(args: {
  filePath: string;
  content: string;
  exportName: string;
}): ExportedConstBounds {
  const sourceFile = ts.createSourceFile(
    args.filePath,
    args.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1 ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      return [];
    }
    return statement.declarationList.declarations
      .filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === args.exportName,
      )
      .map(() => statement);
  });
  const declaration = declarations[0];
  if (declarations.length !== 1) {
    throw new Error(
      `Canonical deployment registry must contain exactly one top-level exported const ${args.exportName} declaration: ${args.filePath}`,
    );
  }
  return {
    start: declaration.getStart(sourceFile),
    end: declaration.end,
  };
}

function replaceExportedConst(args: {
  filePath: string;
  existingContent: string;
  nextDeclaration: string;
  exportName: string;
}): string {
  const bounds = findUniqueExportedConst({
    filePath: args.filePath,
    content: args.existingContent,
    exportName: args.exportName,
  });
  return `${args.existingContent.slice(0, bounds.start)}${args.nextDeclaration}${args.existingContent.slice(bounds.end)}`;
}

export function renderReceiptPoolDeploymentsFileFromSource(args: {
  filePath: string;
  existingContent: string;
  receiptPools: Record<string, ReceiptPoolDeployment>;
}): string {
  const bounds = findUniqueExportedConst({
    exportName: 'RECEIPT_POOL_DEPLOYMENTS',
    filePath: args.filePath,
    content: args.existingContent,
  });
  const nextDeclaration = renderReceiptPoolDeploymentsSection({
    receiptPools: args.receiptPools,
  });
  const next = `${args.existingContent.slice(0, bounds.start)}${nextDeclaration}${args.existingContent.slice(bounds.end)}`;
  return next.endsWith('\n') ? next : `${next}\n`;
}

export function renderDeploymentRegistryFileFromSource(args: {
  filePath: string;
  existingContent: string;
  drops: Record<string, DeploymentDropConfigSerialized>;
  tombstones?: Record<string, BoxMinterConfigTombstone>;
}): string {
  if (args.tombstones) {
    assertNoBoxMinterConfigRegistryCollisions({
      drops: args.drops,
      tombstones: args.tombstones,
      filePath: args.filePath,
    });
  }
  const dropsNext = replaceExportedConst({
    exportName: 'DEPLOYMENT_DROPS',
    filePath: args.filePath,
    existingContent: args.existingContent,
    nextDeclaration: renderDeploymentRegistrySection({ drops: args.drops }),
  });
  const next = args.tombstones
    ? replaceExportedConst({
        exportName: 'BOX_MINTER_CONFIG_TOMBSTONES',
        filePath: args.filePath,
        existingContent: dropsNext,
        nextDeclaration: renderBoxMinterConfigTombstonesSection({
          tombstones: args.tombstones,
        }),
      })
    : dropsNext;
  return next.endsWith('\n') ? next : `${next}\n`;
}
