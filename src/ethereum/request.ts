import { ETHEREUM_SESSION_HEADER, type EthereumSession } from '../../shared/ethereum/api';
import { monsApiOrigin } from '../lib/monsApiOrigin';

export type EthereumRequestOptions = { body?: unknown; session?: EthereumSession | null; signal?: AbortSignal };

export async function requestEthereumJson(path: string, options: EthereumRequestOptions): Promise<{ response: Response; value: unknown }> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(`${monsApiOrigin()}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' } : {}),
      ...(options.session ? { [ETHEREUM_SESSION_HEADER]: options.session.token } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: 'no-store', signal,
  });
  const value: unknown = await response.json();
  return { response, value };
}
