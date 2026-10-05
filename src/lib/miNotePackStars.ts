export type MiNotePackStar = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
};

export const MI_NOTE_PACK_STARS: readonly MiNotePackStar[] = [
  { id: 'yellow', name: 'Yellow Star', src: new URL('../../stars/Yellow Star.PNG', import.meta.url).href },
  { id: 'blush', name: 'Blush Star', src: new URL('../../stars/Blush Star.PNG', import.meta.url).href },
  { id: 'boy', name: 'Boy Star', src: new URL('../../stars/Boy Star.PNG', import.meta.url).href },
  { id: 'cheery', name: 'Cheery Star-Burst', src: new URL('../../stars/Cheery Star-Burst.PNG', import.meta.url).href },
  { id: 'magenta', name: 'Magenta Star', src: new URL('../../stars/Magenta Star.PNG', import.meta.url).href },
  { id: 'malfy', name: 'Malfy Star', src: new URL('../../stars/Malfy Star.PNG', import.meta.url).href },
  { id: 'orange-cream', name: 'Orange Cream Star', src: new URL('../../stars/Orange Cream Star.PNG', import.meta.url).href },
  { id: 'phoenix', name: 'Phoenix Star', src: new URL('../../stars/Phoenix Star.PNG', import.meta.url).href },
  { id: 'pink-gummy', name: 'Pink Gummy Star', src: new URL('../../stars/Pink Gummy Star.PNG', import.meta.url).href },
  { id: 'rainbow', name: 'Rainbow Star', src: new URL('../../stars/Rainbow Star.PNG', import.meta.url).href },
  { id: 'sentient', name: 'Sentient Star', src: new URL('../../stars/Sentient Star.PNG', import.meta.url).href },
  { id: 'supermetal', name: 'Supermetal Star', src: new URL('../../stars/Supermetal Star.PNG', import.meta.url).href },
  { id: 'twinkle', name: 'Twinkle Star', src: new URL('../../stars/Twinkle Star.PNG', import.meta.url).href },
  { id: 'white-gummy', name: 'White Gummy Star', src: new URL('../../stars/White Gummy Star.PNG', import.meta.url).href },
  { id: 'zombie', name: 'Zombie Star', src: new URL('../../stars/Zombie Star.PNG', import.meta.url).href },
  { id: 'acid-snowflake', name: 'Acid Snowflake', src: new URL('../../stars/Acid Snowflake.PNG', import.meta.url).href },
  { id: '83', name: 'Star 83', src: new URL('../../stars/83.png', import.meta.url).href },
];
