import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ethereumItemDisplayIdMaximum, ethereumItemKind } from './protocol.ts';

export type EthereumMetadataNetwork = 'sepolia' | 'mainnet';

export interface EthereumPlaceholderMetadata {
  name: string;
  description: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

const labels = ['', 'Artwork', 'Crate', 'Warehouse', 'Artwork Receipt', 'Crate Receipt'];
const palettes = [
  ['#f8edc8', '#e47e70', '#567c60', '#739267'],
  ['#cbdfe5', '#fff7e5', '#4c7866', '#7b9b7a'],
  ['#f6e1d5', '#9b82c0', '#537d62', '#87a178'],
  ['#e2eddf', '#dc8fa7', '#4f7c61', '#80a172'],
  ['#e9e0ee', '#e99765', '#5d7b62', '#8ba27a'],
  ['#f6efdf', '#7b9fcb', '#4b7860', '#84a17b'],
];

function petalRing(count: number, shape: string): string {
  return Array.from({ length: count }, (_, index) => `<g transform="rotate(${Math.floor(index * 360 / count)})">${shape}</g>`).join('');
}

function petals(seed: bigint, family: number): string {
  if (family === 0) return petalRing(10 + 2 * Number((seed >> 8n) % 2n), '<ellipse cy="-72" rx="23" ry="79"/>');
  if (family === 1) return petalRing(5, '<path d="M-18 -12C-54 -24 -80 -75 -65 -113C-54 -145 -22 -151 0 -129C22 -151 54 -145 65 -113C80 -75 54 -24 18 -12Z"/>');
  if (family === 2) return petalRing(4, '<path d="M-18 -10C-92 -22 -108 -91 -66 -129C-22 -163 43 -146 65 -105C91 -58 49 -17 18 -10Z"/>');
  return petalRing(8, '<path d="M-10 -20Q-60 -80 0 -157Q60 -80 10 -20Z"/>') +
    '<g transform="rotate(22.5)">' + petalRing(8, '<ellipse cy="-49" rx="26" ry="55"/>') +
    '</g><g transform="rotate(22.5)" fill="#ffffff" fill-opacity=".2">' +
    petalRing(8, '<ellipse cy="-49" rx="26" ry="55"/>') + '</g>';
}

function leaf(x: number, y: number, left: boolean, color: string): string {
  return `<path transform="translate(${x} ${y})" d="${left ? 'M0 0C-12 -45 -76 -73 -118 -68C-100 -12 -43 8 0 0Z' : 'M0 0C10 -62 76 -92 126 -98C122 -36 68 5 0 0Z'}" fill="${color}"/>`;
}

function artwork(id: number): string {
  const encoded = new Uint8Array(32);
  new DataView(encoded.buffer).setUint32(28, id);
  const seed = BigInt(`0x${bytesToHex(keccak_256(encoded))}`);
  const colors = palettes[Number(seed % 6n)];
  const block = Math.floor((id - 1) / 111111);
  const key = (((id - 1) % 111111) * 65537 + 7919) % 111111 + block * 111111;
  const x = 264 + 3 * (key % 64);
  const y = 202 + 2 * (Math.floor(key / 64) % 64);
  const base = 320 + Number((seed >> 32n) % 81n);
  const stem = `<path d="M${base} 642Q${x - 50} 470 ${x} ${y}" fill="none" stroke="${colors[2]}" stroke-width="13" stroke-linecap="round"/>` +
    leaf(Math.floor((base + 3 * x - 100) / 4), Math.floor((1582 + y) / 4), false, colors[2]) +
    leaf(Math.floor((9 * base + 7 * x - 300) / 16), Math.floor((8598 + y) / 16), true, colors[3]);
  return `<rect width="720" height="720" fill="${colors[0]}"/>${stem}` +
    `<g transform="translate(${x} ${y}) rotate(${Number((seed >> 16n) % 60n)})" fill="${colors[1]}">${petals(seed, id % 4)}</g>` +
    `<circle cx="${x}" cy="${y}" r="${24 + Math.floor(key / 4096)}" fill="#efb84c"/>`;
}

function crate(id: number): string {
  return '<g stroke="#68513b" stroke-width="5" stroke-linejoin="round">' +
    '<path d="M360 260L540 350L360 440L180 350Z" fill="#e8c77f"/>' +
    '<path d="M180 350L360 440V646L180 553Z" fill="#c59454"/>' +
    '<path d="M360 440L540 350V553L360 646Z" fill="#d9b16b"/>' +
    '<path d="M264 307L444 398V600M276 600V398L456 307" fill="none"/>' +
    '<path d="M180 415L360 507L540 415M180 491L360 583L540 491" fill="none" stroke-width="3"/>' +
    '<path d="M405 463L497 417V492L405 538Z" fill="#fff7e6" stroke-width="2"/></g>' +
    `<g transform="matrix(1 -.5 0 1 451 478)"><text x="0" y="8" text-anchor="middle" font-size="22" font-weight="900" letter-spacing="-1" fill="#68513b">${id}</text></g>`;
}

function warehouse(id: number): string {
  return '<g stroke="#52664f" stroke-width="5" stroke-linejoin="round">' +
    '<path d="M150 374L360 246L570 374V644H150Z" fill="#c6d1bb"/>' +
    '<path d="M132 382L360 240L588 382" fill="none" stroke-width="9"/>' +
    '<path d="M203 409H517V644H203Z" fill="#91a787"/>' +
    '<path d="M203 452H517M203 493H517M203 534H517M203 575H517M203 616H517" stroke-width="3"/>' +
    '<path d="M258 291H462V355H258Z" fill="#f6f2e6"/>' +
    '<rect x="302" y="533" width="116" height="111" fill="#e1e7d8"/>' +
    '<path d="M360 533V644M302 588H418" stroke-width="3"/></g>' +
    `<text x="360" y="335" text-anchor="middle" font-size="34" font-weight="900" letter-spacing="-1" fill="#52664f">${id}</text>`;
}

const receiptFrame = '<path d="M88 44H632V620L616 610L600 620L584 610L568 620L552 610L536 620L520 610L504 620L488 610L472 620L456 610L440 620L424 610L408 620L392 610L376 620L360 610L344 620L328 610L312 620L296 610L280 620L264 610L248 620L232 610L216 620L200 610L184 620L168 610L152 620L136 610L120 620L104 610L88 620Z" fill="#fbfaf5" stroke="#191d29" stroke-width="2"/>';
const receiptSticker = '<g transform="translate(548 580) rotate(-12)"><rect x="-105" y="-28" width="210" height="56" rx="3" fill="#c93c2e"/>' +
  '<text x="0" y="7" text-anchor="middle" font-size="19" font-weight="700" letter-spacing="2" fill="#fbfaf5">REDEEMED</text></g>';

function svg(kind: number, displayId: number): string {
  const opening = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">';
  if (kind === 1) return opening + artwork(displayId) + '</svg>';
  const receipt = kind >= 4;
  const hero = kind === 4 ? `<svg x="151" y="103" width="418" height="418" viewBox="0 0 720 720" overflow="hidden">${artwork(displayId)}</svg>` :
    `<g transform="translate(360 ${receipt ? '312' : '360'}) scale(${kind === 3 ? '1.28' : receipt ? '1.08' : '1.3'}) translate(-360 ${receipt ? '-448' : kind === 3 ? '-441' : '-453'})">${kind === 3 ? warehouse(displayId) : crate(displayId)}</g>`;
  return opening + (receipt ? '<rect width="720" height="720" fill="#f4f0e6"/>' : '') +
    '<g fill="#191d29" font-family="Arial,Helvetica,sans-serif">' +
    (receipt ? '<g transform="translate(360 360) scale(.84) translate(-360 -332)">' + receiptFrame : '') +
    hero + (receipt ? '</g>' + receiptSticker : '') + '</g></svg>';
}

function description(kind: number, displayId: number): string {
  if (kind === 1) return 'A numbered artwork, redeemable for physical delivery.';
  if (kind === 2) return displayId === 5555 ? 'Crate number 5555 contains 31 artworks.' : 'A sealed crate containing 20 artworks.';
  if (kind === 3) return 'A warehouse containing 11 crates. Unpack it before opening or redeeming its crates.';
  if (kind === 4) return 'A receipt for a physical artwork. This receipt cannot be redeemed again.';
  return 'A receipt for a physical crate. Its secret code allows its owner to claim the artwork receipts.';
}

export function ethereumPlaceholderMetadata(kind: number, displayId: number, network: EthereumMetadataNetwork = 'sepolia'): EthereumPlaceholderMetadata {
  const itemKind = ethereumItemKind(kind);
  if (!Number.isInteger(kind) || !itemKind || !Number.isInteger(displayId) || displayId < 1 || displayId > ethereumItemDisplayIdMaximum(itemKind)) {
    throw new Error('Invalid 111K metadata identity');
  }
  if (network !== 'sepolia' && network !== 'mainnet') throw new Error('Invalid 111K metadata network');
  const label = labels[kind];
  return {
    name: `111K ${label} #${displayId}`,
    description: `111K ${network === 'sepolia' ? 'Sepolia test collection' : 'collection'}. Artwork placeholders served from the collection CDN. ${description(kind, displayId)}`,
    image: `data:image/svg+xml;base64,${btoa(svg(kind, displayId))}`,
    attributes: [
      { trait_type: 'Type', value: label },
      { trait_type: 'Item number', value: displayId },
      { trait_type: 'Network', value: network === 'sepolia' ? 'Sepolia' : 'Ethereum Mainnet' },
    ],
  };
}
