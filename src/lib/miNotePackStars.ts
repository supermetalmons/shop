export type MiNotePackStar = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
  readonly foldPosition: number;
  readonly rotationOffsetDegrees: number;
};

export const MI_NOTE_PACK_STARS: readonly MiNotePackStar[] = [
  { id: 'blush', name: 'Blush Star', src: new URL('../../stars/Blush Star.PNG', import.meta.url).href, foldPosition: 0.578, rotationOffsetDegrees: 2.8 },
  { id: 'twinkle', name: 'Twinkle Star', src: new URL('../../stars/Twinkle Star.PNG', import.meta.url).href, foldPosition: 0.49, rotationOffsetDegrees: 3.2 },
  { id: 'zombie', name: 'Zombie Star', src: new URL('../../stars/Zombie Star.PNG', import.meta.url).href, foldPosition: 0.487, rotationOffsetDegrees: 2.4 },
];
