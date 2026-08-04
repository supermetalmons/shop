import { createInterface } from 'node:readline/promises';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

export async function promptMaskedInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Interactive terminal input is required');
  const input = process.stdin;
  const output = process.stdout;
  output.write(prompt);
  input.setEncoding('utf8');
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  let value = '';
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          output.write('\n');
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          output.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (character < ' ' && character !== '\t') continue;
        value += character;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}

export async function promptYConfirmation(prompt: string) {
  if (!process.stdin.isTTY) throw new Error('Interactive terminal input is required');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(prompt)).trim().toLowerCase() === 'y';
  } finally {
    readline.close();
  }
}

export function parsePrivateKeyInput(input: string) {
  const raw = input.trim();
  if (!raw) throw new Error('Empty private key input');
  let bytes: Uint8Array;
  if (raw.startsWith('[')) {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error('Invalid JSON private key');
    }
    bytes = Uint8Array.from(value);
  } else {
    try {
      bytes = bs58.decode(raw);
    } catch {
      throw new Error('Invalid base58 private key');
    }
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Invalid private key length: ${bytes.length}`);
}
