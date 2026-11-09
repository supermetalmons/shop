const rawJson = JSON as JSON & { rawJSON(source: string): object; isRawJSON(value: unknown): value is { rawJSON: string } };

export function parseMetadataJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (context?.source === undefined) throw new Error('Missing metadata number literal.');
    return String(value) === context.source ? value : rawJson.rawJSON(context.source);
  });
}

export function metadataNumber(value: unknown): number {
  if (rawJson.isRawJSON(value)) return Number(value.rawJSON);
  return typeof value === 'number' ? value : NaN;
}
