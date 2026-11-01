import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ETHEREUM_MAX_DELIVERY_CONFIGS } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumCall, requireEthereumContract, type EthereumContext } from './ethereumRuntime.js';

const ZERO = '0x0000000000000000000000000000000000000000';

function invalidConfig(): never {
  throw new EthereumApiError('unavailable', 'Ethereum delivery payment configuration is unavailable.');
}

export function requireEthereumDeliveryConfigId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ETHEREUM_MAX_DELIVERY_CONFIGS) invalidConfig();
  return value;
}

export async function resolveEthereumDeliveryConfig(context: EthereumContext): Promise<number> {
  const raw = context.env.ETHEREUM_111K_DELIVERY_CONFIG_ID;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) invalidConfig();
  const configId = requireEthereumDeliveryConfigId(Number(raw));
  const contract = requireEthereumContract(context);
  const result = await ethereumCall(context, encodeCall('deliveryConfigs(uint256)', ['uint256'], [configId]));
  if (result.length !== 2 + 64 * 6) invalidConfig();
  let fields: unknown[];
  try { fields = decodeReturn(['address', 'address', 'uint16', 'uint256', 'uint256', 'uint256'], result); }
  catch { invalidConfig(); }
  const [receiver1, receiver2, share, received, released1, released2] = fields as [string, string, bigint, bigint, bigint, bigint];
  if (receiver1 === ZERO || receiver1 === contract || receiver2 === contract || receiver1 === receiver2 ||
    (receiver2 === ZERO ? share !== 0n : share === 0n || share >= 10_000n)) invalidConfig();
  const entitlement2 = received * share / 10_000n;
  if (released1 > received - entitlement2 || released2 > entitlement2) invalidConfig();
  return configId;
}
