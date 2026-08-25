export function randomSessionSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function sha256Bytes(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256Bytes(value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function matchesSha256Hex(value: string, expectedHex: string): Promise<boolean> {
  const actual = await sha256Bytes(value);
  const expected = new Uint8Array(32);
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  for (let index = 0; index < expected.length; index += 1) {
    expected[index] = Number.parseInt(expectedHex.slice(index * 2, index * 2 + 2), 16);
  }
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(actual, expected);
  const actualBytes = new Uint8Array(actual);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actualBytes[index] ^ expected[index];
  }
  return difference === 0;
}
