export type DropLabelSource = {
  namePrefix?: string;
  figureNamePrefix?: string;
} | null | undefined;

export type DropMintSelectionSource = {
  mintSelection?: {
    kind: string;
    options: Array<{
      label: string;
      startId: number;
      endId: number;
    }>;
  };
} | null | undefined;

export type DropAssetKind = 'box' | 'figure';

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function normalizeWord(value: unknown, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed || fallback;
}

function pluralize(word: string): string {
  if (!word) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

function boxWord(source?: DropLabelSource): string {
  return normalizeWord(source?.namePrefix, 'box');
}

function figureWord(source?: DropLabelSource): string {
  return normalizeWord(source?.figureNamePrefix, 'figure');
}

function usesUnboxAction(source?: DropLabelSource): boolean {
  return boxWord(source).toLowerCase() === 'box';
}

export function dropAssetLabel(
  source: DropLabelSource,
  kind: DropAssetKind,
  count = 1,
  options?: { capitalize?: boolean },
): string {
  const singular = kind === 'box' ? boxWord(source) : figureWord(source);
  const label = count === 1 ? singular : pluralize(singular);
  return options?.capitalize ? capitalize(label) : label;
}

export function dropAssetCount(
  source: DropLabelSource,
  kind: DropAssetKind,
  count: number,
  options?: { capitalize?: boolean },
): string {
  return `${count} ${dropAssetLabel(source, kind, count, options)}`;
}

export function dropAssetReference(
  source: DropLabelSource,
  kind: DropAssetKind,
  reference: string | number,
  options?: { capitalize?: boolean },
): string {
  return `${dropAssetLabel(source, kind, 1, { capitalize: options?.capitalize !== false })} ${reference}`;
}

export function dropOpenActionLabel(source: DropLabelSource): string {
  return usesUnboxAction(source) ? 'Unbox' : 'Open';
}

export function dropOpenActionProgress(source: DropLabelSource): string {
  return usesUnboxAction(source) ? 'Unboxing…' : 'Opening…';
}

export function dropOpenGerund(source: DropLabelSource): string {
  return usesUnboxAction(source) ? 'unboxing' : 'opening';
}

/**
 * For drops with a `size` mint selection, resolves the size label that owns the
 * given asset id (boxId or dudeId — they share the same id space within a drop).
 * Returns `undefined` when the drop has no size variants or the id falls outside
 * any configured range.
 */
export function dropMintSelectionLabel(
  source: DropMintSelectionSource,
  reference: number | string | null | undefined,
): string | undefined {
  const selection = source?.mintSelection;
  if (selection?.kind !== 'size') return undefined;
  const id = Math.floor(Number(reference));
  if (!Number.isFinite(id) || id < 1) return undefined;
  return selection.options.find((option) => id >= option.startId && id <= option.endId)?.label;
}
