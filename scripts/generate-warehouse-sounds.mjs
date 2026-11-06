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

function iceImpact(critical) {
  const noise = random(critical ? 111971 : 111421);
  const duration = critical ? 1.12 : 0.48;
  let low = 0;
  let previous = 0;
  return Float32Array.from({ length: Math.ceil(duration * sampleRate) }, (_, index) => {
    const time = index / sampleRate;
    const white = noise();
    low = low * 0.94 + white * 0.06;
    const brittle = white - previous * 0.72;
    previous = white;
    const attack = Math.min(1, time / 0.0015);
    const body = Math.sin(2 * Math.PI * (critical ? 61 : 83) * time - 24 * time * time)
      * Math.exp(-time * (critical ? 10 : 17)) * 0.42;
    const strike = brittle * Math.exp(-time * 100) * 0.3;
    const ringing = [1271, 2117, 3331, 4549].reduce((sum, frequency, band) =>
      sum + Math.sin(2 * Math.PI * frequency * time) * Math.exp(-time * (18 + band * 8)) / (band + 2), 0) * 0.14;
    const chips = [0.04, 0.09, 0.16, 0.24, 0.34].reduce((sum, start, chip) =>
      sum + (time < start ? 0 : brittle * Math.exp(-(time - start) * (110 - chip * 9)) / (chip + 3)), 0) * 0.24;
    const collapseAt = 0.14;
    const collapseTime = Math.max(0, time - collapseAt);
    const collapse = critical && time >= collapseAt
      ? (low * 1.8 + white * 0.035) * Math.min(1, collapseTime / 0.045) * Math.exp(-collapseTime * 4.8) : 0;
    const tail = Math.min(1, (duration - time) / 0.035);
    return (body + strike + ringing + chips + collapse) * attack * tail;
  });
}

await mkdir(directory, { recursive: true });
await writeFile(`${directory}ice-impact.wav`, wav(iceImpact(false)));
await writeFile(`${directory}ice-critical.wav`, wav(iceImpact(true)));
