import { handleEthereumRequest } from './ethereumHandler.js';
import { ethereumRouteDefinitions } from './ethereumRouteDefinitions.js';
import { trackProviderFetch } from './providerMetrics.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const ethereumRoutes: readonly ExactWorkerRoute[] = Object.entries(ethereumRouteDefinitions).map(([path, route]) => exactRoute(path, {
  commerceMutation: route.commerceMutation,
  cors: route.originPolicy === 'reveal' ? 'ethereum-reveal' : route.originPolicy === 'checkout-status' ? 'ethereum-checkout-status'
    : route.originPolicy === 'public-read' ? 'ethereum-public-read' : route.originPolicy === 'public-confirm' ? 'ethereum-public-confirm' : 'ethereum',
  profileOriginGate: route.originPolicy === 'profile', staff: 'skip', unexpectedError: 'profile',
}, async (context) => ({ response: await handleEthereumRequest(context.request, context.env, path, {
  fetch: trackProviderFetch(context.dependencies.providerFetch, context.metrics),
  cache: context.dependencies.cache, defer: context.defer,
}) })));
