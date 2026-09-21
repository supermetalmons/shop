import type { CommerceSqlQuery } from '../../cloud/workers/api/src/commerceQueries.ts';
import { sqlString } from './commerceD1Maintenance.ts';

export function renderCommerceQuerySql(query: CommerceSqlQuery): string {
  const bindings = query.bindings.map((value) => {
    if (typeof value === 'string') return sqlString(value);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 0 ? `(${value})` : String(value);
    }
    throw new Error('Commerce SQL bindings must be strings or finite numbers.');
  });
  let bindingIndex = 0;
  let quote = '';
  let comment = '';
  let rendered = '';
  for (let index = 0; index < query.sql.length; index += 1) {
    const character = query.sql[index];
    const next = query.sql[index + 1];
    if (comment) {
      rendered += character;
      if (comment === '--' && character === '\n') comment = '';
      if (comment === '/*' && character === '*' && next === '/') {
        rendered += next;
        index += 1;
        comment = '';
      }
    } else if (quote) {
      rendered += character;
      if (character === quote) {
        if (quote !== ']' && next === quote) {
          rendered += next;
          index += 1;
        } else {
          quote = '';
        }
      }
    } else if ((character === '-' && next === '-') || (character === '/' && next === '*')) {
      comment = character + next;
      rendered += comment;
      index += 1;
    } else if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      rendered += character;
    } else if (character === '?') {
      if (next !== undefined && /[0-9]/.test(next)) {
        throw new Error('Commerce SQL only supports anonymous ? placeholders.');
      }
      if (bindingIndex >= bindings.length) {
        throw new Error('Commerce SQL placeholder count does not match binding count.');
      }
      rendered += bindings[bindingIndex];
      bindingIndex += 1;
    } else {
      rendered += character;
    }
  }
  if (bindingIndex !== bindings.length) {
    throw new Error('Commerce SQL placeholder count does not match binding count.');
  }
  return rendered;
}
