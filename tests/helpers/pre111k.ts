import { resolvePre111kConfig, type Pre111kNetwork } from '../../shared/ethereum/pre111k.ts';

export function testPre111kConfig(network: Pre111kNetwork, input: Partial<Parameters<typeof resolvePre111kConfig>[1]> = {}) {
  return resolvePre111kConfig(network, {
    priceWei: network === 'mainnet' ? '2230000000000000000' : '3330000000000000',
    ...input,
  });
}
