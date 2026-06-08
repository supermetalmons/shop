export type CardNft2PackImage = {
  src: string;
  width: number;
  height: number;
};

export type CardNft2PackVideoSource = {
  src: string;
  type: string;
};

export const CARD_NFT_2_PACK_IMAGES: readonly CardNft2PackImage[] = [
  { src: '/card_nft_2/pack/tight/1.webp', width: 837, height: 1400 },
  { src: '/card_nft_2/pack/tight/2.webp', width: 844, height: 1400 },
  { src: '/card_nft_2/pack/tight/3.webp', width: 872, height: 1400 },
  { src: '/card_nft_2/pack/tight/4.webp', width: 866, height: 1400 },
];

const CARD_NFT_2_PACK_MOV_VIDEO_SOURCE: CardNft2PackVideoSource = {
  src: '/card_nft_2/pack/shapeshifting.mov',
  type: 'video/quicktime; codecs="hvc1"',
};

const CARD_NFT_2_PACK_WEBM_VIDEO_SOURCE: CardNft2PackVideoSource = {
  src: '/card_nft_2/pack/shapeshifting.webm',
  type: 'video/webm',
};

export const CARD_NFT_2_PACK_VIDEO_SOURCES: readonly CardNft2PackVideoSource[] = [
  CARD_NFT_2_PACK_MOV_VIDEO_SOURCE,
  CARD_NFT_2_PACK_WEBM_VIDEO_SOURCE,
];

export const CARD_NFT_2_PACK_WEBM_FIRST_VIDEO_SOURCES: readonly CardNft2PackVideoSource[] = [
  CARD_NFT_2_PACK_WEBM_VIDEO_SOURCE,
  CARD_NFT_2_PACK_MOV_VIDEO_SOURCE,
];

export const CARD_NFT_2_PACK_VIDEO_POSTER_URL = '/card_nft_2/pack/shapeshifting-poster.webp';

export const CARD_NFT_2_PACK_VIDEO_ASPECT_RATIO = 1;
export const CARD_NFT_2_PACK_VIDEO_SCALE = 1.18;
export const CARD_NFT_2_PACK_COMPACT_VIDEO_SCALE = 1.24;

export const CARD_NFT_2_PACK_IMAGE_SRCS = CARD_NFT_2_PACK_IMAGES.map((image) => image.src);

export const CARD_NFT_2_PACK_IMAGE_DIMENSIONS_BY_SRC = CARD_NFT_2_PACK_IMAGES.reduce<
  Record<string, CardNft2PackImage>
>((dimensionsBySrc, image) => {
  dimensionsBySrc[image.src] = image;
  return dimensionsBySrc;
}, {});

export const CARD_NFT_2_PACK_PREVIEW_IMAGE = CARD_NFT_2_PACK_IMAGES[0];
export const CARD_NFT_2_PACK_PREVIEW_IMAGE_URL = CARD_NFT_2_PACK_PREVIEW_IMAGE.src;
export const CARD_NFT_2_PACK_PREVIEW_ASPECT_RATIO =
  CARD_NFT_2_PACK_PREVIEW_IMAGE.width / CARD_NFT_2_PACK_PREVIEW_IMAGE.height;
