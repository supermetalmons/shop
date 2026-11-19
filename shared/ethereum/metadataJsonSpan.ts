function stringEnd(json: string, start: number, invalid: (reason: string) => never): number {
  for (let index = start + 1; index < json.length; index++) {
    if (json[index] === '\\') index++;
    else if (json[index] === '"') return index + 1;
  }
  return invalid('unterminated JSON string');
}

function valueEnd(json: string, start: number, invalid: (reason: string) => never): number {
  if (json[start] === '"') return stringEnd(json, start, invalid);
  let depth = 0;
  for (let index = start; index < json.length; index++) {
    const character = json[index];
    if (character === '"') index = stringEnd(json, index, invalid) - 1;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') {
      if (!depth) return index;
      if (--depth === 0) return index + 1;
    } else if (character === ',' && !depth) return index;
  }
  return invalid('unterminated JSON value');
}

export function metadataJsonSpan(json: string, field: string, invalid: (reason: string) => never): { start: number; end: number } | undefined {
  const skipWhitespace = (index: number) => { while (/\s/.test(json[index] ?? '') && index < json.length) index++; return index; };
  let cursor = skipWhitespace(0) + 1;
  let literal: { start: number; end: number } | undefined;
  const names = new Set<string>();
  while (json[skipWhitespace(cursor)] !== '}') {
    cursor = skipWhitespace(cursor);
    const end = stringEnd(json, cursor, invalid);
    const name: string = JSON.parse(json.slice(cursor, end));
    if (names.has(name)) invalid('duplicate metadata property');
    names.add(name);
    const start = skipWhitespace(skipWhitespace(end) + 1);
    const next = valueEnd(json, start, invalid);
    if (name === field) literal = { start, end: next };
    cursor = skipWhitespace(next);
    if (json[cursor] === ',') cursor++;
  }
  return literal;
}
