export type MiNotePackStar = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
  readonly foldPosition: number;
  readonly rotationOffsetDegrees: number;
};

export const MI_NOTE_PACK_STARS: readonly MiNotePackStar[] = [
  { id: 'yellow', name: 'Yellow Star', src: new URL('../../stars/Yellow Star.PNG', import.meta.url).href, foldPosition: 0.532, rotationOffsetDegrees: 9.3 },
  { id: 'blush', name: 'Blush Star', src: new URL('../../stars/Blush Star.PNG', import.meta.url).href, foldPosition: 0.556, rotationOffsetDegrees: 7.7 },
  { id: 'twinkle', name: 'Twinkle Star', src: new URL('../../stars/Twinkle Star.PNG', import.meta.url).href, foldPosition: 0.49, rotationOffsetDegrees: 3.2 },
  { id: 'zombie', name: 'Zombie Star', src: new URL('../../stars/Zombie Star.PNG', import.meta.url).href, foldPosition: 0.487, rotationOffsetDegrees: 2.4 },
];
