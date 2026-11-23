export function apiServiceRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  url.pathname = url.pathname.slice('/api'.length);
  return new Request(url, request);
}

export async function handleFrontendRequest(
  request: Request,
  env: Pick<Env, 'ASSETS' | 'MONS_API'>,
): Promise<Response> {
  const serviceRequest = apiServiceRequest(request);
  if (serviceRequest) {
    try {
      return await env.MONS_API.fetch(serviceRequest);
    } catch (error) {
      if (serviceRequest.signal.aborted && error === serviceRequest.signal.reason) {
        return new Response(null, {
          status: 499,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      throw error;
    }
  }
  const response = await env.ASSETS.fetch(request);
  const path = new URL(request.url).pathname;
  if (path.replace(/\/+$/, '') !== '/nfc') return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  fetch(request, env): Promise<Response> {
    return handleFrontendRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
