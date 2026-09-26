import miNoteCollections from '../../../../mi_note_eth.json';
import { MI_NOTE_CONTRACT_ADDRESSES, type MiNoteContractAddress } from '../../../../shared/miNoteCards.js';
import type { PreorderConfig } from '../../../../shared/preorders.js';
import type { RequestDeadline } from './boundedRequest.js';
import { ProfileReadError } from './dataAccess.js';
import type { DeferredWork } from './deferredWork.js';
import { collectMiNoteOwnership } from './miNoteCards.js';
import type { WorkerDependencies, WorkerRequestMetrics } from './publicRouteSupport.js';

const DEVNET_ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const DEVNET_TEST_WALLETS: Readonly<Record<string, number>> = {
  '0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe': 1,
  '0x5bfce4149f520fe0823dc8c0afaf979121e824ec': 11,
};
const CATALOG = MI_NOTE_CONTRACT_ADDRESSES.map((contract) => ({
  contract,
  tokens: miNoteCollections.find((collection) => collection.contractAddress.toLowerCase() === contract)!.tokens,
}));

export type MiNoteEligibility = {
  cardIds: number[];
  unavailableCardIds: number[];
  ownershipStatus: 'success' | 'partial';
  requiresAdminSignIn: boolean;
};

export async function loadMiNoteEligibility(args: {
  request: Request;
  env: Pick<Env, 'ALCHEMY_MI_NOTE_API_KEY' | 'OPENSEA_API_KEY' | 'PUBLIC_SHOP_RATE_LIMITER'>;
  config: PreorderConfig;
  address: string;
  buyer: string | null;
  fresh: boolean;
  dependencies: Pick<WorkerDependencies, 'cache' | 'providerFetch' | 'log'> & { now: () => number };
  metrics: Pick<WorkerRequestMetrics, 'upstreamCalls' | 'providerDurationMs'>;
  deadline: RequestDeadline;
  defer: DeferredWork;
}): Promise<MiNoteEligibility> {
  const firstTestId = args.config.cluster === 'devnet' ? DEVNET_TEST_WALLETS[args.address] : undefined;
  if (firstTestId !== undefined && args.buyer === DEVNET_ADMIN) {
    return { cardIds: Array.from({ length: 10 }, (_, index) => firstTestId + index), unavailableCardIds: [],
      ownershipStatus: 'success', requiresAdminSignIn: false };
  }
  const result = await collectMiNoteOwnership({
    ...args,
    dependencies: { ...args.dependencies, cache: args.fresh ? null : args.dependencies.cache },
  });
  if (!result.successes) {
    if (firstTestId !== undefined) {
      return { cardIds: [], unavailableCardIds: CATALOG.flatMap(({ tokens }) => tokens.map((token) => token.clean_card_id)),
        ownershipStatus: 'partial', requiresAdminSignIn: true };
    }
    throw new ProfileReadError('unavailable', 503, 'Couldn’t check your Ethereum holdings. Please try again.');
  }
  const unavailableContracts = new Set<MiNoteContractAddress>(MI_NOTE_CONTRACT_ADDRESSES.filter(
    (contract) => result.body.resultsByContract[contract].status === 'error',
  ));
  return {
    cardIds: CATALOG.flatMap(({ contract, tokens }) => {
      const owned = new Set(result.body.tokenIdsByContract[contract]);
      return tokens.filter((token) => owned.has(token.id)).map((token) => token.clean_card_id);
    }),
    unavailableCardIds: CATALOG.filter(({ contract }) => unavailableContracts.has(contract))
      .flatMap(({ tokens }) => tokens.map((token) => token.clean_card_id)),
    ownershipStatus: unavailableContracts.size ? 'partial' : 'success',
    requiresAdminSignIn: firstTestId !== undefined,
  };
}

export function assertMiNoteEligibility(eligibility: MiNoteEligibility, cardIds: number[]): void {
  if (cardIds.some((id) => eligibility.unavailableCardIds.includes(id))) {
    throw new ProfileReadError('unavailable', 503, 'Couldn’t verify ownership of a selected card. Please try again.');
  }
  if (cardIds.some((id) => !eligibility.cardIds.includes(id))) {
    throw new ProfileReadError('permission-denied', 403, 'You can only preorder cards owned by your verified Ethereum wallet.');
  }
}
