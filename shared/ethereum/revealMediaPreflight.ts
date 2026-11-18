const REVEAL_MEDIA_ORIGINS = ['https://mons.shop', 'https://vvv.so', 'https://www.vvv.so'] as const;

export async function checkRevealMedia(url: string, mimeTypes: readonly string[], fetchSource: typeof fetch = fetch): Promise<void> {
  for (const origin of REVEAL_MEDIA_ORIGINS) {
    let response: Response;
    try {
      response = await fetchSource(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Origin: origin, Range: 'bytes=0-32' } });
    } catch {
      throw new Error('Release media request failed.');
    }
    try {
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const cors = response.headers.get('access-control-allow-origin');
      if (![200, 206].includes(response.status) || !mimeTypes.includes(mime) || (cors !== '*' && cors !== origin)) {
        throw new Error('Release media failed its status, type or CORS check.');
      }
      if (!response.body) throw new Error('Release media returned no data.');
      const reader = response.body.getReader();
      try {
        const chunk = await reader.read().catch(() => undefined);
        if (!chunk?.value?.byteLength) throw new Error('Release media returned no readable data.');
      } finally {
        reader.releaseLock();
      }
    } finally { await response.body?.cancel().catch(() => undefined); }
  }
}
