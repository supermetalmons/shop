import { canonicalizeDropAssetUrl } from '../config/deployment.ts';
import {
  CARD_NFT_2_PACK_BASE_URL,
  LITTLE_SWAG_BOXES_CDN_BASE_URL,
  LITTLE_SWAG_HOODIE_IMAGE_BASE_URL,
  PONCHO_DRIFELLA_CDN_BASE_URL,
} from '../config/dropMediaDefaults.ts';
import { CARD_NFT_2_ASSET_CDN_BASES } from './cardNft2Assets.ts';

type LegacyAssetsMonsDisplayMediaMapping = {
  prefix: string;
  baseUrl: string;
};

type LegacyIpfsDisplayMediaGroup = {
  baseUrl: string;
  cids: readonly string[];
};

const DISPLAY_MEDIA_PATH_RE = /\.(?:gif|jpe?g|mov|mp4|png|webm|webp)$/i;
const DISPLAY_MEDIA_URL_RE = /\.(?:gif|jpe?g|mov|mp4|png|webm|webp)(?:\/+)?(?:[?#]|$)/i;
const IPFS_PROTOCOL_RE = /^ipfs:\/\//i;
const IPFS_GATEWAY_PATH_RE = /\/ipfs\//i;
const IPFS_GATEWAY_HOST_RE = /\.ipfs\./i;
const KNOWN_CDN_URL_PREFIX = 'https://cdn.lil.org/';

const PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/receipts_videos`;
const PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/videos`;

const LEGACY_ASSETS_MONS_DISPLAY_MEDIA_MAPPINGS: readonly LegacyAssetsMonsDisplayMediaMapping[] = [
  { prefix: '/drops/cardnft2/img/', baseUrl: CARD_NFT_2_PACK_BASE_URL },
  { prefix: '/drops/lsb/', baseUrl: LITTLE_SWAG_BOXES_CDN_BASE_URL },
  { prefix: '/drops/poncho/', baseUrl: PONCHO_DRIFELLA_CDN_BASE_URL },
] as const;

const LEGACY_IPFS_DISPLAY_MEDIA_GROUPS: readonly LegacyIpfsDisplayMediaGroup[] = [
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.img, cids: ['bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.mask, cids: ['bafybeiapwcv66aqu2wzh3f5mp4j4j6h7zej3no7paae4qcqxpu3mg436ia'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.foil, cids: ['bafybeigzyk3qd7brxfd3uinftdywhwao65gdxuleqirv5zje3okftmxczy'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.receipt, cids: ['bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq'] },
  { baseUrl: LITTLE_SWAG_HOODIE_IMAGE_BASE_URL, cids: ['bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4'] },
  { baseUrl: PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL, cids: ['bafybeiamzyimzf77yvlmz5qevbk2looxjmmswyjxzvxqdnooihuderjvkq'] },
  { baseUrl: PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL, cids: ['bafybeihhtllco3nhn2vau3ezqu7zpzfjij4x7n7tcxz63k6fkq55jljram'] },
] as const;

const LEGACY_IPFS_DISPLAY_MEDIA_BASE_BY_CID = new Map(
  LEGACY_IPFS_DISPLAY_MEDIA_GROUPS.flatMap((group) => group.cids.map((cid) => [cid, group.baseUrl] as const)),
);

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isDisplayMediaPath(path: string): boolean {
  return DISPLAY_MEDIA_PATH_RE.test(path);
}

function isLegacyDisplayMediaCandidate(url: string): boolean {
  if (!DISPLAY_MEDIA_URL_RE.test(url)) return false;
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('assets.mons.link') ||
    IPFS_PROTOCOL_RE.test(lowerUrl) ||
    IPFS_GATEWAY_PATH_RE.test(lowerUrl) ||
    IPFS_GATEWAY_HOST_RE.test(lowerUrl)
  );
}

function joinDisplayMediaUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
}

function rewriteAssetsMonsDisplayMediaUrl(url: string): string | undefined {
  if (!url.toLowerCase().includes('assets.mons.link')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== 'assets.mons.link') return undefined;
  if (!isDisplayMediaPath(parsed.pathname)) return undefined;

  const found = LEGACY_ASSETS_MONS_DISPLAY_MEDIA_MAPPINGS.find((mapping) =>
    parsed.pathname.startsWith(mapping.prefix),
  );
  if (!found) return undefined;
  const rewritten = joinDisplayMediaUrl(found.baseUrl, parsed.pathname.slice(found.prefix.length));
  return `${rewritten}${parsed.search}${parsed.hash}`;
}

function rewriteIpfsDisplayMediaUrl(url: string): string | undefined {
  const lowerUrl = url.toLowerCase();
  if (!IPFS_PROTOCOL_RE.test(lowerUrl) && !IPFS_GATEWAY_PATH_RE.test(lowerUrl) && !IPFS_GATEWAY_HOST_RE.test(lowerUrl)) {
    return undefined;
  }
  const canonical = canonicalizeDropAssetUrl(url);
  const match = canonical.match(/^ipfs:\/\/([^/?#]+)\/([^?#]+)([?#].*)?$/i);
  if (!match?.[1] || !match[2]) return undefined;

  const cid = match[1].toLowerCase();
  const mediaPath = match[2];
  if (!isDisplayMediaPath(mediaPath)) return undefined;

  const baseUrl = LEGACY_IPFS_DISPLAY_MEDIA_BASE_BY_CID.get(cid);
  if (!baseUrl) return undefined;
  return `${joinDisplayMediaUrl(baseUrl, mediaPath)}${match[3] || ''}`;
}

export function isKnownCdnUrl(url: string): boolean {
  return url.toLowerCase().startsWith(KNOWN_CDN_URL_PREFIX);
}

export function rewriteLegacyDisplayMediaUrl(url: string): string | undefined {
  if (!isLegacyDisplayMediaCandidate(url)) return undefined;
  return rewriteAssetsMonsDisplayMediaUrl(url) || rewriteIpfsDisplayMediaUrl(url);
}
