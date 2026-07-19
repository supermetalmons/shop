import {
  boxIdFromMetadataUri,
  dudeIdFromMetadataUri,
  metadataKindFromUri,
  selectMetadataUri,
} from './dropMetadataUri.js';

export type DasAsset = Record<string, any>;
export type DasAssetKind = 'box' | 'dude' | 'certificate';
type DasAssetMetadataNameMode = 'string-only' | 'coerce';

export type DasAssetNameParsingOptions = {
  metadataNameMode: DasAssetMetadataNameMode;
};

export type DasAssetBurnParsingOptions = {
  missingAssetResult: boolean;
  nonBooleanFlagIsBurnt: boolean;
  includeAlternateFlagNames?: boolean;
  includeOwnershipState?: boolean;
};

function dasAssetMetadataNameValue(asset: DasAsset | null | undefined): unknown {
  return asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
}

function dasAssetMetadataNameForParsing(
  asset: DasAsset | null | undefined,
  mode: DasAssetMetadataNameMode,
): string {
  const value = dasAssetMetadataNameValue(asset);
  return mode === 'coerce'
    ? String(value).toLowerCase()
    : typeof value === 'string'
      ? value.toLowerCase()
      : '';
}

function dasAssetMetadataAttributeValue(
  asset: DasAsset | null | undefined,
  traitType: string,
): unknown {
  const attributes = asset?.content?.metadata?.attributes;
  if (!Array.isArray(attributes)) return undefined;
  return attributes.find(
    (attribute: any) => attribute?.trait_type === traitType,
  )?.value;
}

export function dasAssetMetadataUri(asset: DasAsset | null | undefined): string {
  return selectMetadataUri(
    asset?.content?.json_uri,
    asset?.content?.jsonUri,
    asset?.content?.metadata?.json_uri,
    asset?.content?.metadata?.jsonUri,
    asset?.content?.metadata?.uri,
  );
}

export function dasAssetMetadataName(asset: DasAsset | null | undefined): string | undefined {
  const name = dasAssetMetadataNameValue(asset);
  return typeof name === 'string' && name ? name : undefined;
}

export function dasAssetKind(
  asset: DasAsset | null | undefined,
  options: DasAssetNameParsingOptions,
): DasAssetKind | null {
  const attributeKind = dasAssetMetadataAttributeValue(asset, 'type');
  if (attributeKind === 'box' || attributeKind === 'dude' || attributeKind === 'certificate') {
    return attributeKind;
  }

  const uriKind = metadataKindFromUri(dasAssetMetadataUri(asset));
  if (uriKind) return uriKind;

  const name = dasAssetMetadataNameForParsing(asset, options.metadataNameMode);
  if (name.includes('blind box')) return 'box';
  if (name.includes('receipt') || name.includes('authenticity')) return 'certificate';
  if (name.includes('figure')) return 'dude';
  if (/^(b|box)#?\d+$/.test(name.replace(/\s+/g, ''))) return 'box';
  return null;
}

export function dasAssetBoxId(
  asset: DasAsset | null | undefined,
  options: DasAssetNameParsingOptions,
): string | undefined {
  const attributeValue = dasAssetMetadataAttributeValue(asset, 'box_id');
  if (typeof attributeValue === 'string' && attributeValue) return attributeValue;

  const uriBoxId = boxIdFromMetadataUri(dasAssetMetadataUri(asset));
  if (uriBoxId) return uriBoxId;

  const normalizedName = dasAssetMetadataNameForParsing(asset, options.metadataNameMode)
    .replace(/\s+/g, '');
  return normalizedName.match(/^(b|box)#?(\d+)$/)?.[2];
}

export function dasAssetDudeId(asset: DasAsset | null | undefined): number | undefined {
  const attributeId = Number(dasAssetMetadataAttributeValue(asset, 'dude_id'));
  if (Number.isFinite(attributeId)) return attributeId;

  const uriId = dudeIdFromMetadataUri(dasAssetMetadataUri(asset));
  return typeof uriId === 'number' ? uriId : undefined;
}

export function dasAssetLooksBurntOrClosed(
  asset: DasAsset | null | undefined,
  options: DasAssetBurnParsingOptions,
): boolean {
  if (!asset || typeof asset !== 'object') return options.missingAssetResult;

  const burntFlag = options.includeAlternateFlagNames === false
    ? asset?.burnt ??
      asset?.burned ??
      asset?.compression?.burnt ??
      asset?.compression?.burned ??
      asset?.ownership?.burnt ??
      asset?.ownership?.burned
    : asset?.burnt ??
      asset?.burned ??
      asset?.is_burnt ??
      asset?.isBurnt ??
      asset?.compression?.burnt ??
      asset?.compression?.burned ??
      asset?.compression?.is_burnt ??
      asset?.compression?.isBurnt ??
      asset?.ownership?.burnt ??
      asset?.ownership?.burned;
  if (typeof burntFlag === 'boolean') return burntFlag;
  if (options.nonBooleanFlagIsBurnt && burntFlag != null && burntFlag !== false) return true;
  if (options.includeOwnershipState === false) return false;

  const ownershipState = String(
    asset?.ownership?.ownership_state || asset?.ownership?.ownershipState || asset?.ownership?.state || '',
  ).toLowerCase();
  return Boolean(ownershipState && /burn/.test(ownershipState));
}

export function dasAssetMatchesCollection(
  asset: DasAsset | null | undefined,
  expectedCollectionMint: string,
): boolean {
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const group of grouped) {
      if (group?.group_key === 'collection' && group?.group_value === expectedCollectionMint) {
        return true;
      }
    }
  }

  const collectionKey = asset?.content?.metadata?.collection?.key;
  return typeof collectionKey === 'string' && collectionKey === expectedCollectionMint;
}
