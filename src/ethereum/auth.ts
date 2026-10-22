import type { Ethereum111kConfig, EthereumSession } from '../../shared/ethereum/api';
import { ethereumApi } from './api';
import { readEthereumSession, saveEthereumSession } from './state';
import type { ethereumOperation } from './wallet';

export async function authenticateEthereumWallet(
  operation: ReturnType<typeof ethereumOperation>,
  config: Ethereum111kConfig,
  scope: string,
  onAuthenticated?: (session: EthereumSession) => void,
): Promise<EthereumSession> {
  const existing = readEthereumSession(scope, config, operation.address);
  if (existing) {
    operation.assertCurrent();
    onAuthenticated?.(existing);
    return existing;
  }
  await operation.ensureNetwork();
  const challenge = await ethereumApi.challenge(operation.address, config, operation.signal);
  operation.assertCurrent();
  const message = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const signature = await operation.provider.request({ method: 'personal_sign', params: [message, operation.address] });
  operation.assertCurrent();
  if (typeof signature !== 'string') throw new Error('Your wallet did not return a signature.');
  const session = await ethereumApi.verify(challenge.challengeId, signature, operation.signal);
  operation.assertCurrent();
  if (session.address !== operation.address || session.chainId !== config.chainId || session.dropId !== config.dropId || session.expiresAtMs <= Date.now()) {
    throw new Error('The Ethereum session does not match your wallet.');
  }
  saveEthereumSession(scope, session);
  onAuthenticated?.(session);
  return session;
}
