export default {
  async fetch(request: Request, env: { API: Fetcher }): Promise<Response> {
    const { transactionHashes, chainId, contractAddress } = await request.json() as {
      transactionHashes: string[]; chainId: number; contractAddress: string;
    };
    const startedAtMs = Date.now(), started = performance.now();
    const outcomes = await Promise.all(transactionHashes.map(async transactionHash => {
      const individualStart = performance.now();
      const startedOffsetMs = individualStart - started;
      const response = await env.API.fetch(new Request('https://api.mons.shop/ethereum/111k/reveal/transaction', {
        method: 'POST', headers: { Origin: 'https://vvv.so', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', 'CF-Connecting-IP': '192.0.2.250' },
        body: JSON.stringify({ chainId, contractAddress, transactionHash }),
      }));
      const body = await response.text();
      return { transactionHash, startedOffsetMs, elapsedMs: performance.now() - individualStart, status: response.status, body };
    }));
    return Response.json({ startedAtMs, elapsedMs: performance.now() - started, outcomes });
  },
};
