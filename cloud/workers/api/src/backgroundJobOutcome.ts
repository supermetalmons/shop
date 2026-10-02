export type BackgroundJobMessage = Readonly<
  Pick<Message<unknown>, 'id' | 'body' | 'attempts'>
>;

export type BackgroundJobOutcome =
  | Readonly<{ outcome: 'complete' }>
  | Readonly<{ outcome: 'retry'; delaySeconds?: number }>;
