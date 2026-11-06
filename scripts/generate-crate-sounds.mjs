import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sampleRate = 22050;
const directory = fileURLToPath(new URL('../public/111k/sounds/', import.meta.url));

function random(seed) {
  let state = seed;
  return () => {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    return ((state ^ state >>> 14) >>> 0) / 4294967296 * 2 - 1;
  };
}

function wav(samples) {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write('RIFF', 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => result.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + index * 2));
  return result;
}

function impact(variant) {
  const noise = random(8731 + variant * 977);
  const duration = 0.24 + variant * 0.025;
  let filtered = 0;
  return Float32Array.from({ length: Math.ceil(duration * sampleRate) }, (_, index) => {
    const time = index / sampleRate;
    filtered = filtered * 0.68 + noise() * 0.32;
    const strike = filtered * Math.exp(-time * 140) * 0.65;
    const resonance = [172, 301, 487, 823].reduce((value, frequency, band) =>
      value + Math.sin(2 * Math.PI * frequency * (1 + variant * 0.037) * time) *
      Math.exp(-time * (22 + band * 17)) / (band + 2), 0);
    const chipAt = 0.042 + variant * 0.008;
    const chip = time >= chipAt ? noise() * Math.exp(-(time - chipAt) * 220) * 0.12 : 0;
    const attack = Math.min(1, time / 0.0008);
    return (strike + resonance * 0.6 + chip) * attack * Math.min(1, (duration - time) / 0.018);
  });
}

function opening() {
  const noise = random(111555);
  const duration = 0.7;
  let filtered = 0;
  return Float32Array.from({ length: Math.ceil(duration * sampleRate) }, (_, index) => {
    const time = index / sampleRate;
    filtered = filtered * 0.83 + noise() * 0.17;
    const envelope = Math.sin(Math.PI * time / duration) ** 2;
    const friction = filtered * envelope * (0.3 + 0.16 * Math.sin(2 * Math.PI * 37 * time));
    const creak = Math.sin(2 * Math.PI * (117 * time + 43 * time * time) + 0.8 * Math.sin(43 * time)) * envelope * 0.06;
    const release = time > 0.47 ? Math.sin(2 * Math.PI * 206 * (time - 0.47)) * Math.exp(-(time - 0.47) * 28) * 0.25 : 0;
    return friction + creak + release;
  });
}

await mkdir(directory, { recursive: true });
for (let variant = 0; variant < 3; variant++) await writeFile(`${directory}wood-hit-${variant + 1}.wav`, wav(impact(variant)));
await writeFile(`${directory}wood-open.wav`, wav(opening()));
