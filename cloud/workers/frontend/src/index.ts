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
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env): Promise<Response> {
    return handleFrontendRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
