import { ETHEREUM_API_PATHS } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_CHECKOUT_PATHS } from '../../../../shared/ethereum/checkout.js';
import { ethereumReadPaths, handleEthereumRequest } from './ethereumHandler.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const ethereumRoutes: readonly ExactWorkerRoute[] = [...Object.values(ETHEREUM_API_PATHS), ...Object.values(ETHEREUM_CHECKOUT_PATHS)].map((path) => exactRoute(path, {
  commerceMutation: !ethereumReadPaths.has(path) && !path.startsWith('/ethereum/auth/') && path !== ETHEREUM_API_PATHS.transactionsConfirm,
  cors: path === ETHEREUM_CHECKOUT_PATHS.status ? 'ethereum-checkout-status' : 'ethereum',
  profileOriginGate: path !== ETHEREUM_CHECKOUT_PATHS.status, staff: 'skip', unexpectedError: 'profile',
}, async (context) => ({ response: await handleEthereumRequest(context.request, context.env, path, { fetch: context.dependencies.providerFetch }) })));
