import { ETHEREUM_API_PATHS } from '../../../../shared/ethereum/api.js';
import { ethereumReadPaths, handleEthereumRequest } from './ethereumHandler.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const ethereumRoutes: readonly ExactWorkerRoute[] = Object.values(ETHEREUM_API_PATHS).map((path) => exactRoute(path, {
  commerceMutation: !ethereumReadPaths.has(path) && !path.startsWith('/ethereum/auth/') && path !== ETHEREUM_API_PATHS.transactionsConfirm,
  cors: 'ethereum', profileOriginGate: true, staff: 'skip', unexpectedError: 'profile',
}, async (context) => ({ response: await handleEthereumRequest(context.request, context.env, path, { fetch: context.dependencies.providerFetch }) })));
