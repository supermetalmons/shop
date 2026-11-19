import { metadataJsonSpan } from './metadataJsonSpan.ts';

export type TwinRole = 'good twin' | 'evil twin';

function invalid(reason: string): never { throw new Error(`Invalid twin metadata: ${reason}.`); }

export function appendTwinTrait(json: string, role: TwinRole): string {
  if (role !== 'good twin' && role !== 'evil twin') invalid('role');
  const metadata: unknown = JSON.parse(json);
  if (!metadata || typeof metadata !== 'object' || !('attributes' in metadata) || !Array.isArray(metadata.attributes)) invalid('attributes');
  if (metadata.attributes.some(item => item?.trait_type === 'good twin' || item?.trait_type === 'evil twin')) invalid('existing twin trait');
  const span = metadataJsonSpan(json, 'attributes', invalid);
  if (!span || json[span.start] !== '[' || json[span.end - 1] !== ']') invalid('attributes range');
  let end = span.end - 1;
  while (end > span.start + 1 && /\s/.test(json[end - 1])) end--;
  const item = JSON.stringify({ trait_type: role, value: true });
  return json.slice(0, end) + (metadata.attributes.length ? ',' : '') + item + json.slice(end);
}
