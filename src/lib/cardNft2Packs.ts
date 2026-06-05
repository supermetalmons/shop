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
  { src: '/card_nft_2/pack/1.webp', width: 837, height: 1400 },
  { src: '/card_nft_2/pack/2.webp', width: 844, height: 1400 },
  { src: '/card_nft_2/pack/3.webp', width: 872, height: 1400 },
  { src: '/card_nft_2/pack/4.webp', width: 866, height: 1400 },
];

export const CARD_NFT_2_PACK_LIGHT_VIDEO_SOURCES: readonly CardNft2PackVideoSource[] = [
  { src: '/card_nft_2/pack/shapeshifting-h264.mp4', type: 'video/mp4' },
  { src: '/card_nft_2/pack/shapeshifting.webm', type: 'video/webm' },
];

export const CARD_NFT_2_PACK_DARK_VIDEO_SOURCES: readonly CardNft2PackVideoSource[] = [
  { src: '/card_nft_2/pack/shapeshifting_dark-h264.mp4', type: 'video/mp4' },
  { src: '/card_nft_2/pack/shapeshifting_dark.webm', type: 'video/webm' },
];

export const CARD_NFT_2_PACK_LIGHT_VIDEO_POSTER_URL = '/card_nft_2/pack/shapeshifting-poster.webp';
export const CARD_NFT_2_PACK_DARK_VIDEO_POSTER_URL = '/card_nft_2/pack/shapeshifting_dark-poster.webp';

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
