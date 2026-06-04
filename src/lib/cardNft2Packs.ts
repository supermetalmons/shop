export type CardNft2PackImage = {
  src: string;
  width: number;
  height: number;
};

export const CARD_NFT_2_PACK_IMAGES: readonly CardNft2PackImage[] = [
  { src: '/card_nft_2/pack/1.webp', width: 837, height: 1400 },
  { src: '/card_nft_2/pack/2.webp', width: 844, height: 1400 },
  { src: '/card_nft_2/pack/3.webp', width: 872, height: 1400 },
  { src: '/card_nft_2/pack/4.webp', width: 866, height: 1400 },
];

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
