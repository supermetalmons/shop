import assert from 'node:assert/strict';

function names(values, label) {
  assert.ok(values && typeof values === 'object' && !Array.isArray(values), `${label}: invalid measurements`);
  const keys = Object.keys(values).sort();
  assert.ok(keys.length > 0, `${label}: no measurements`);
  for (const key of keys) {
    assert.ok(Number.isSafeInteger(values[key]) && values[key] > 0, `${label}/${key}: invalid gas`);
  }
  return keys;
}

export function assertRepeatedGas(first, second, expectedNames, label) {
  assert.deepEqual(names(first, label), [...expectedNames].sort(), `${label}: measurement coverage changed`);
  assert.deepEqual(names(second, label), [...expectedNames].sort(), `${label}: repeat coverage changed`);
  for (const name of expectedNames) {
    assert.equal(first[name], second[name], `${label}/${name}: repeated gas changed`);
  }
}

export function compareGas(reference, candidate, expectedNames, label) {
  assert.deepEqual(names(reference, label), [...expectedNames].sort(), `${label}: reference coverage changed`);
  assert.deepEqual(names(candidate, label), [...expectedNames].sort(), `${label}: candidate coverage changed`);
  return [...expectedNames].sort().map(name => {
    const before = reference[name];
    const after = candidate[name];
    assert.ok(BigInt(after) * 100n < BigInt(before) * 101n,
      `${label}/${name}: gas increased by at least 1% (${before} -> ${after})`);
    return { name, reference: before, candidate: after, delta: after - before, percent: (after - before) * 100 / before };
  });
}

export function summarizeGas(rows) {
  assert.ok(rows.length > 0, 'Cannot summarize empty measurements');
  return {
    count: rows.length,
    worstPercentage: rows.reduce((worst, row) => row.percent > worst.percent ? row : worst),
    worstAbsolute: rows.reduce((worst, row) => row.delta > worst.delta ? row : worst),
  };
}
