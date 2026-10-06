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
  { id: 'zombie', name: 'Zombie Star', src: new URL('../../stars/Zombie Star.PNG', import.meta.url).href, foldPosition: 0.487, rotationOffsetDegrees: 2.4, sizeScale: 1 },
  { id: 'acid-snowflake', name: 'Acid Snowflake', src: new URL('../../stars/Acid Snowflake.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'boy', name: 'Boy Star', src: new URL('../../stars/Boy Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'cheery', name: 'Cheery Star-Burst', src: new URL('../../stars/Cheery Star-Burst.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'magenta', name: 'Magenta Star', src: new URL('../../stars/Magenta Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'malfy', name: 'Malfy Star', src: new URL('../../stars/Malfy Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'orange-cream', name: 'Orange Cream Star', src: new URL('../../stars/Orange Cream Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'phoenix', name: 'Phoenix Star', src: new URL('../../stars/Phoenix Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'pink-gummy', name: 'Pink Gummy Star', src: new URL('../../stars/Pink Gummy Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'rainbow', name: 'Rainbow Star', src: new URL('../../stars/Rainbow Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'sentient', name: 'Sentient Star', src: new URL('../../stars/Sentient Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: '83', name: 'Star 83', src: new URL('../../stars/83.png', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'supermetal', name: 'Supermetal Star', src: new URL('../../stars/Supermetal Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'white-gummy', name: 'White Gummy Star', src: new URL('../../stars/White Gummy Star.PNG', import.meta.url).href, foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
  { id: 'yellow', name: 'Yellow Star', src: new URL('../../stars/Yellow Star.PNG', import.meta.url).href, foldPosition: 0.532, rotationOffsetDegrees: 9.3, sizeScale: 1 },
];
