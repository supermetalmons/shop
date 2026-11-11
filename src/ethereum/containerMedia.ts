import { relicDisplayMedia } from './relicMedia';

export const ETHEREUM_CONTAINER_MEDIA = {
  crate: {
    label: 'Crate',
    pluralLabel: 'Crates',
    src: 'https://cdn.lil.org/nft/111k/crate.webp',
    width: 1448,
    height: 1086,
    aspectRatio: 1448 / 1086,
  },
  warehouse: {
    label: 'Warehouse',
    pluralLabel: 'Warehouses',
    src: 'https://cdn.lil.org/nft/111k/warehouse.webp',
    width: 1536,
    height: 1024,
    aspectRatio: 1536 / 1024,
  },
  relic: {
    label: 'Relic',
    pluralLabel: 'Relics',
    ...relicDisplayMedia('https://cdn.lil.org/nft/111k/relics/mid/1.webp')!,
  },
} as const;
