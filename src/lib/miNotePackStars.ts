export type MiNotePackStar = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
  readonly foldPosition: number;
  readonly rotationOffsetDegrees: number;
  readonly sizeScale: number;
};

export const MI_NOTE_PACK_STARS: readonly MiNotePackStar[] = [
  { id: 'blush', name: 'Blush Star', src: new URL('../../stars/Blush Star.PNG', import.meta.url).href, foldPosition: 0.574, rotationOffsetDegrees: 2.8, sizeScale: 1.13 },
  { id: 'zombie', name: 'Zombie Star', src: new URL('../../stars/Zombie Star.PNG', import.meta.url).href, foldPosition: 0.513, rotationOffsetDegrees: 2.4, sizeScale: 1.22 },
  { id: 'supermetal', name: 'Supermetal Star', src: new URL('../../stars/Supermetal Star.PNG', import.meta.url).href, foldPosition: 0.58, rotationOffsetDegrees: 5.1, sizeScale: 1.18 },
];
