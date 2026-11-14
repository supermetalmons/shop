import assert from 'node:assert/strict';

export function required<T>(value: T, message = 'Expected fixture value to be present'): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}
