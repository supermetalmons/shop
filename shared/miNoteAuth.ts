export const MI_NOTE_SESSION_HEADER = 'X-Mi-Note-Session';
export const MI_NOTE_AUTH_CHALLENGE_PATH = '/mi-note-cards/auth/challenge';
export const MI_NOTE_AUTH_VERIFY_PATH = '/mi-note-cards/auth/verify';
export const MI_NOTE_AUTH_LOGOUT_PATH = '/mi-note-cards/auth/logout';

export type MiNoteEthereumChallenge = {
  challengeId: string;
  message: string;
  expiresAtMs: number;
};

export type MiNoteEthereumSession = {
  token: string;
  address: string;
  preorderId: string;
  expiresAtMs: number;
};
