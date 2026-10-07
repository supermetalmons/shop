export type MiNotePackStar = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
  readonly foldPosition: number;
  readonly rotationOffsetDegrees: number;
  readonly sizeScale: number;
};

export const MI_NOTE_PACK_STARS: readonly MiNotePackStar[] = [
  { id: 'blush', name: 'Blush Star', src: 'https://cdn.lil.org/nft/mi_note_cards/packs/stars/blush.webp', foldPosition: 0.574, rotationOffsetDegrees: 2.8, sizeScale: 1.13 },
  { id: 'zombie', name: 'Zombie Star', src: 'https://cdn.lil.org/nft/mi_note_cards/packs/stars/zombie.webp', foldPosition: 0.513, rotationOffsetDegrees: 2.4, sizeScale: 1.22 },
  { id: 'supermetal', name: 'Supermetal Star', src: 'https://cdn.lil.org/nft/mi_note_cards/packs/stars/supermetal.webp', foldPosition: 0.58, rotationOffsetDegrees: 5.1, sizeScale: 1.18 },
];
