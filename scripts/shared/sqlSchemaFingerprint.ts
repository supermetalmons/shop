import { createHash } from 'node:crypto';

function isSqlWhitespace(character: string): boolean {
  return character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f';
}

export function sqlSchemaFingerprint(sql: string): string {
  let normalized = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let comment: 'block' | 'line' | null = null;
  let pendingSpace = false;
  let lineCommentBoundary = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      normalized += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          normalized += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (comment === 'line') {
      normalized += character;
      if (character === '\n') {
        comment = null;
        lineCommentBoundary = true;
      }
      continue;
    }
    if (comment === 'block') {
      normalized += character;
      if (character === '*' && sql[index + 1] === '/') {
        normalized += '/';
        index += 1;
        comment = null;
      }
      continue;
    }
    if (isSqlWhitespace(character)) {
      pendingSpace = normalized.length > 0 && !lineCommentBoundary;
      continue;
    }
    if (pendingSpace && normalized.at(-1) !== '(' && character !== ')') normalized += ' ';
    pendingSpace = false;
    lineCommentBoundary = false;
    if (character === '-' && sql[index + 1] === '-') {
      normalized += '--';
      index += 1;
      comment = 'line';
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      normalized += '/*';
      index += 1;
      comment = 'block';
      continue;
    }
    normalized += character;
    if (character === "'" || character === '"' || character === '`') quote = character;
    if (character === '[') quote = ']';
  }
  return createHash('sha256').update(normalized).digest('hex');
}
