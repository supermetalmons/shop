const networks = new Map([[1, 'mainnet'], [11155111, 'sepolia'], [31337, 'local']]);

export function parseDiscountCapConfigJson(json, chainId) {
  const literals = [];
  const value = JSON.parse(json, (_key, value, context) => {
    if (typeof value === 'number') literals.push(context.source);
    return Object.is(value, -0) ? 0 : value;
  });
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'local,mainnet,sepolia') {
    throw new Error('Invalid discounted mint cap configuration.');
  }
  for (const maximum of Object.values(value)) {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 5555) {
      throw new Error('Discounted mint caps must be integers from 0 to 5555.');
    }
  }
  for (const literal of literals) {
    if (!/^(?:-?0|[1-9]\d*)$/.test(literal)) {
      throw new Error('Discounted mint caps must use nonnegative decimal integer JSON literals.');
    }
  }
  const network = networks.get(chainId);
  if (!network) throw new Error('Unsupported discounted mint cap chain ID.');
  return value[network];
}
