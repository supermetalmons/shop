import { ETHEREUM_API_PATHS } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_CHECKOUT_PATHS } from '../../../../shared/ethereum/checkout.js';
import { ETHEREUM_REVEAL_PATHS } from '../../../../shared/ethereum/reveal.js';
import { ETHEREUM_OWNER_HATCHING_PATHS } from '../../../../shared/ethereum/ownerHatching.js';
import { ethereumAuth } from './ethereumAuth.js';
import { ethereumCheckout } from './ethereumCheckout.js';
import { ethereumCommerce } from './ethereumCommerce.js';
import { ethereumProfile } from './ethereumProfile.js';
import { ethereumPublicRequest } from './ethereumPublic.js';
import { ethereumRelics } from './ethereumRelics.js';
import { ethereumReveal } from './ethereumReveal.js';
import { ethereumOwnerHatching } from './ethereumOwnerHatching.js';
import type { EthereumContext } from './ethereumRuntime.js';

type EthereumRoutePath = typeof ETHEREUM_API_PATHS[keyof typeof ETHEREUM_API_PATHS] |
  typeof ETHEREUM_CHECKOUT_PATHS[keyof typeof ETHEREUM_CHECKOUT_PATHS] |
  typeof ETHEREUM_REVEAL_PATHS[keyof typeof ETHEREUM_REVEAL_PATHS] |
  typeof ETHEREUM_OWNER_HATCHING_PATHS[keyof typeof ETHEREUM_OWNER_HATCHING_PATHS];

type EthereumRouteDefinition = Readonly<{
  methods: readonly ('GET' | 'POST')[];
  handler: (request: Request, context: EthereumContext, path: string) => Promise<unknown>;
  commerceMutation: boolean;
  originPolicy: 'profile' | 'checkout-status' | 'reveal' | 'public-read' | 'public-confirm';
  publicRateLimit: boolean;
}>;

export const ethereumRouteDefinitions = {
  [ETHEREUM_OWNER_HATCHING_PATHS.ready]: {
    methods: ['GET'], handler: ethereumOwnerHatching, commerceMutation: false, originPolicy: 'public-read', publicRateLimit: false,
  },
  [ETHEREUM_OWNER_HATCHING_PATHS.hatch]: {
    methods: ['POST'], handler: ethereumOwnerHatching, commerceMutation: false, originPolicy: 'public-confirm', publicRateLimit: false,
  },
  [ETHEREUM_REVEAL_PATHS.transaction]: {
    methods: ['POST'], handler: ethereumReveal, commerceMutation: false, originPolicy: 'reveal', publicRateLimit: false,
  },
  [ETHEREUM_REVEAL_PATHS.tokens]: {
    methods: ['POST'], handler: ethereumReveal, commerceMutation: false, originPolicy: 'reveal', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.config]: {
    methods: ['GET'], handler: ethereumPublicRequest, commerceMutation: false, originPolicy: 'public-read', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.stats]: {
    methods: ['GET'], handler: ethereumPublicRequest, commerceMutation: false, originPolicy: 'public-read', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.relics]: {
    methods: ['GET'], handler: ethereumRelics, commerceMutation: false, originPolicy: 'checkout-status', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.inventory]: {
    methods: ['GET'], handler: ethereumPublicRequest, commerceMutation: false, originPolicy: 'public-read', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.metadata]: {
    methods: ['GET'], handler: ethereumPublicRequest, commerceMutation: false, originPolicy: 'public-read', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.transactionsConfirm]: {
    methods: ['POST'], handler: ethereumPublicRequest, commerceMutation: false, originPolicy: 'public-confirm', publicRateLimit: true,
  },
  [ETHEREUM_API_PATHS.authChallenge]: {
    methods: ['POST'], handler: ethereumAuth, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.authVerify]: {
    methods: ['POST'], handler: ethereumAuth, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.authLogout]: {
    methods: ['POST'], handler: ethereumAuth, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.profile]: {
    methods: ['GET'], handler: ethereumProfile, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.addresses]: {
    methods: ['GET', 'POST'], handler: ethereumProfile, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.shipments]: {
    methods: ['GET'], handler: ethereumProfile, commerceMutation: false, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.deliveryPrepare]: {
    methods: ['POST'], handler: ethereumCommerce, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.deliveryConfirm]: {
    methods: ['POST'], handler: ethereumCommerce, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.claimPrepare]: {
    methods: ['POST'], handler: ethereumCommerce, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_API_PATHS.claimConfirm]: {
    methods: ['POST'], handler: ethereumCommerce, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_CHECKOUT_PATHS.create]: {
    methods: ['POST'], handler: ethereumCheckout, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_CHECKOUT_PATHS.status]: {
    methods: ['GET'], handler: ethereumCheckout, commerceMutation: false, originPolicy: 'checkout-status', publicRateLimit: false,
  },
  [ETHEREUM_CHECKOUT_PATHS.prepare]: {
    methods: ['POST'], handler: ethereumCheckout, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_CHECKOUT_PATHS.submission]: {
    methods: ['POST'], handler: ethereumCheckout, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
  [ETHEREUM_CHECKOUT_PATHS.refresh]: {
    methods: ['POST'], handler: ethereumCheckout, commerceMutation: true, originPolicy: 'profile', publicRateLimit: false,
  },
} satisfies Readonly<Record<EthereumRoutePath, EthereumRouteDefinition>>;

const routes = new Map<string, EthereumRouteDefinition>(Object.entries(ethereumRouteDefinitions));

export function ethereumRouteDefinition(path: string): EthereumRouteDefinition | undefined {
  return routes.get(path);
}
