import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import { clusterApiUrl, Connection, type Commitment } from '@solana/web3.js';
import { createScriptSolanaRpcFetch } from './solanaRpcTransport.ts';
export { scriptSolanaRpcHost } from './solanaRpcTransport.ts';

type ScriptSolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet';
export type ScriptSolanaRpcOptions = {
  cluster: ScriptSolanaCluster;
  explicitUrl?: string;
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function text(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function httpsRpcUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Solana RPC URL is invalid.'); }
  if (url.protocol !== 'https:') throw new Error('Solana RPC URL must use HTTPS.');
  return url.toString();
}


function primaryCheckout(root: string): string | undefined {
  try {
    const directory = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    const common = path.resolve(root, directory);
    return path.basename(common) === '.git' ? path.dirname(common) : undefined;
  } catch { return undefined; }
}

function heliusKeyFromFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const source = readFileSync(filePath, 'utf8');
    if (typeof util.parseEnv === 'function') return text(util.parseEnv(source).HELIUS_API_KEY);
    const match = source.match(/^\s*(?:export\s+)?HELIUS_API_KEY\s*=\s*(.*)$/m);
    if (!match) return undefined;
    const raw = match[1].trim();
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const end = raw.indexOf(raw[0], 1);
      return end > 0 ? text(raw.slice(1, end)) : undefined;
    }
    return text(raw.split('#', 1)[0]);
  } catch { throw new Error(`Could not read Solana RPC credentials from ${path.basename(filePath)}.`); }
}

export function resolveScriptSolanaRpcUrl(options: ScriptSolanaRpcOptions): string {
  if (!['devnet', 'mainnet-beta', 'testnet'].includes(options.cluster)) throw new Error('Unsupported Solana RPC cluster.');
  const env = options.env ?? process.env;
  const clusterOverride = options.cluster === 'devnet'
    ? text(env.TWO_CONFIG_DEVNET_RPC_URL) || text(env.SOLANA_DEVNET_RPC_URL)
    : options.cluster === 'mainnet-beta'
      ? text(env.TWO_CONFIG_MAINNET_RPC_URL) || text(env.SOLANA_MAINNET_RPC_URL)
      : text(env.SOLANA_TESTNET_RPC_URL);
  const explicit = text(options.explicitUrl) || clusterOverride || text(env.SOLANA_RPC_URL);
  if (explicit) return httpsRpcUrl(explicit);
  if (options.cluster === 'testnet') return clusterApiUrl('testnet');
  const key = resolveHeliusKey(options);
  if (!key) return clusterApiUrl(options.cluster);
  const endpoint = new URL(`https://${options.cluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/`);
  endpoint.searchParams.set('api-key', key);
  return endpoint.toString();
}

function resolveHeliusKey(options: Pick<ScriptSolanaRpcOptions, 'env' | 'root'>): string | undefined {
  let key = text((options.env ?? process.env).HELIUS_API_KEY);
  if (!key) {
    const root = path.resolve(options.root || DEFAULT_ROOT);
    const roots = [...new Set([root, primaryCheckout(root)].filter((value): value is string => Boolean(value)))];
    for (const directory of roots) {
      key = heliusKeyFromFile(path.join(directory, '.env.local')) || heliusKeyFromFile(path.join(directory, '.env'));
      if (key) break;
    }
  }
  return key;
}

export function resolveScriptHeliusRpcUrl(options: Omit<ScriptSolanaRpcOptions, 'explicitUrl'>): string {
  if (!['devnet', 'mainnet-beta', 'testnet'].includes(options.cluster)) throw new Error('Unsupported Solana RPC cluster.');
  const key = resolveHeliusKey(options);
  if (!key) throw new Error('Missing HELIUS_API_KEY for Helius DAS.');
  const host = options.cluster === 'mainnet-beta' ? 'mainnet' : options.cluster;
  const endpoint = new URL(`https://${host}.helius-rpc.com/`);
  endpoint.searchParams.set('api-key', key);
  return endpoint.toString();
}

export function createScriptSolanaConnection(options: ScriptSolanaRpcOptions & { commitment?: Commitment }): Connection {
  const endpoint = resolveScriptSolanaRpcUrl(options);
  return new Connection(endpoint, {
    commitment: options.commitment ?? 'finalized', disableRetryOnRateLimit: true,
    fetch: createScriptSolanaRpcFetch(endpoint),
  });
}

export function createScriptHeliusRpc(options: Omit<ScriptSolanaRpcOptions, 'explicitUrl'>,
  transportOptions: Parameters<typeof createScriptSolanaRpcFetch>[1] = {}) {
  const endpoint = resolveScriptHeliusRpcUrl(options);
  const request = createScriptSolanaRpcFetch(endpoint, transportOptions);
  return async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' || !('id' in payload) || payload.id !== method) {
      throw new Error(`Helius ${method} returned an invalid JSON-RPC response.`);
    }
    if ('error' in payload && payload.error) {
      const error = payload.error;
      const message = typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : `Helius ${method} failed.`;
      throw new Error(message);
    }
    if (!('result' in payload)) throw new Error(`Helius ${method} returned no result.`);
    return payload.result as T;
  };
}
