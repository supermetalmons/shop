const RELIC_MID_DIMENSIONS = [
  [1320, 1858], [1320, 986], [1320, 1320], [1320, 990], [1320, 990], [1279, 1230],
  [1320, 1974], [1320, 1492], [1060, 1484], [1320, 1548], [1320, 1519], [1320, 1349],
  [1320, 1980], [1320, 1821], [1320, 1760], [1320, 1760], [1320, 880], [1320, 750],
] as const;

export function relicDisplayMedia(image: string | undefined) {
  const match = image?.match(/^https:\/\/cdn\.lil\.org\/nft\/111k\/relics\/(?:([1-9]|1[0-8])\.(?:png|webp)|mid\/([1-9]|1[0-8])\.webp)$/);
  if (!match || match[0] !== image) return undefined;
  const id = Number(match[1] ?? match[2]);
  const [width, height] = RELIC_MID_DIMENSIONS[id - 1]!;
  return { src: `https://cdn.lil.org/nft/111k/relics/mid/${id}.webp`, width, height, aspectRatio: width / height };
}
