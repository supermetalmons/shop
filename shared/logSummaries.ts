export function summarizeValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

export function summarizePayloadShape(payload: unknown): {
  type?: string;
  keys?: string[];
  types?: Record<string, string>;
  truncated?: boolean;
} {
  if (!payload || typeof payload !== 'object') {
    return { type: summarizeValueShape(payload) };
  }
  const object = payload as Record<string, unknown>;
  const allKeys = Object.keys(object);
  const keys = allKeys.slice(0, 30);
  const types: Record<string, string> = {};
  keys.forEach((key) => {
    types[key] = summarizeValueShape(object[key]);
  });
  return { keys, types, truncated: allKeys.length > keys.length };
}
