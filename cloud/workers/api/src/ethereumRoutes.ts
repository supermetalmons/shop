import { handleEthereumRequest } from './ethereumHandler.js';
import { ethereumRouteDefinitions } from './ethereumRouteDefinitions.js';
import { trackProviderFetch } from './providerMetrics.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const ethereumRoutes: readonly ExactWorkerRoute[] = Object.entries(ethereumRouteDefinitions).map(([path, route]) => exactRoute(path, {
  commerceMutation: route.commerceMutation,
  cors: route.originPolicy === 'checkout-status' ? 'ethereum-checkout-status' : 'ethereum',
  profileOriginGate: route.originPolicy !== 'checkout-status', staff: 'skip', unexpectedError: 'profile',
}, async (context) => ({ response: await handleEthereumRequest(context.request, context.env, path, {
  fetch: trackProviderFetch(context.dependencies.providerFetch, context.metrics),
}) })));
