export function withRevealTraitFixture(otherFetch: typeof fetch,
  respond?: (url: URL) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://cdn.lil.org' || !url.pathname.includes('/json/')) return otherFetch(input, init);
    const path = /^\/nft\/111k\/(paintings|videos|3d|animated)\/json\/v0\/([1-9]\d*)\.json$/.exec(url.pathname);
    if (!path) throw new Error(`Unexpected fixture trait URL: ${url}`);
    if (respond) return respond(url);
    return Response.json({ 'collection block': path[1], attributes: [{ trait_type: 'asset ID', value: Number(path[2]) }] });
  };
}
