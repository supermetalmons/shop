import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import { clusterApiUrl, Connection } from '@solana/web3.js';

type ScriptSolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet';
export type ScriptSolanaRpcOptions = {
  cluster: ScriptSolanaCluster;
  explicitUrl?: string;
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function text(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function httpsRpcUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Solana RPC URL is invalid.'); }
  if (url.protocol !== 'https:') throw new Error('Solana RPC URL must use HTTPS.');
  return url.toString();
}

export function scriptSolanaRpcHost(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return 'invalid RPC host'; }
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
  let key = text(env.HELIUS_API_KEY);
  if (!key) {
    const root = path.resolve(options.root || DEFAULT_ROOT);
    const roots = [...new Set([root, primaryCheckout(root)].filter((value): value is string => Boolean(value)))];
    for (const directory of roots) {
      key = heliusKeyFromFile(path.join(directory, '.env.local')) || heliusKeyFromFile(path.join(directory, '.env'));
      if (key) break;
    }
  }
  if (!key) return clusterApiUrl(options.cluster);
  const endpoint = new URL(`https://${options.cluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/`);
  endpoint.searchParams.set('api-key', key);
  return endpoint.toString();
}

class ScriptSolanaRpcError extends Error {
  constructor(message: string) { super(message); this.name = 'ScriptSolanaRpcError'; }
}

function redactRpcError(value: unknown, endpoint: URL, depth = 0): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/https?:\/\/[^\s"'<>]+/gi, url => scriptSolanaRpcHost(url));
    const secrets = [endpoint.username, endpoint.password,
      ...[...endpoint.searchParams].filter(([name]) => /key|token|secret|auth|password/i.test(name)).map(([, secret]) => secret)];
    for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
    return safe.slice(0, 2048);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[RPC detail omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map(entry => redactRpcError(entry, endpoint, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) =>
    [String(redactRpcError(key, endpoint, depth + 1)), redactRpcError(entry, endpoint, depth + 1)]));
}

async function readRpcBody(response: Response, host: string): Promise<string> {
  if (!response.body) throw new ScriptSolanaRpcError(`Solana RPC returned an empty response from ${host}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ScriptSolanaRpcError(`Solana RPC response from ${host} exceeded the response limit.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createScriptSolanaConnection(options: ScriptSolanaRpcOptions): Connection {
  const endpoint = resolveScriptSolanaRpcUrl(options);
  const parsed = new URL(endpoint);
  const host = scriptSolanaRpcHost(endpoint);
  return new Connection(endpoint, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const signal = init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
          : AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
        try {
          const response = await fetch(input, { ...init, redirect: 'error', signal });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < MAX_ATTEMPTS) {
              const retryAfter = Number(response.headers.get('retry-after'));
              const delay = Math.min(2000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            throw new ScriptSolanaRpcError(`Solana RPC request to ${host} failed with HTTP ${response.status} after ${attempt + 1} attempt(s).`);
          }
          const body = await readRpcBody(response, host);
          let payload: unknown;
          try { payload = JSON.parse(body); } catch { throw new ScriptSolanaRpcError(`Solana RPC returned invalid JSON from ${host}.`); }
          let changed = false;
          const sanitize = (packet: unknown) => {
            if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !('error' in packet)) return packet;
            changed = true;
            return { ...packet, error: redactRpcError(packet.error, parsed) };
          };
          const sanitized = Array.isArray(payload) ? payload.map(sanitize) : sanitize(payload);
          return new Response(changed ? JSON.stringify(sanitized) : body, { status: response.status, headers: { 'content-type': 'application/json' } });
        } catch (error) {
          if (error instanceof ScriptSolanaRpcError) throw error;
          throw new ScriptSolanaRpcError(`Solana RPC transport ${signal.aborted ? 'timed out or was cancelled' : 'failed'} for ${host}.`);
        }
      }
      throw new ScriptSolanaRpcError(`Solana RPC retry limit reached for ${host}.`);
    },
  });
}
