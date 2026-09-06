import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getAdminProfileView, listDeliveryOrderOwners } from '../../api/profile';
import type { useSolanaAuth } from '../../hooks/useSolanaAuth';
import { ADMIN_WALLETS, hasDevnetInventoryAccess, hasFulfillmentAppAccess } from '../../lib/fulfillmentAccess';
import { profileForAuthorizedView } from '../../lib/profileState';
import { ADMIN_OWNER_DOC_PAGE_SIZE } from './display';

const DEFAULT_RUNTIME = { getAdminProfileView, listDeliveryOrderOwners };

type ShopAccountOptions = {
  auth: Pick<ReturnType<typeof useSolanaAuth>, 'profile' | 'sessionWallet' | 'authenticated' | 'deliveryRecoveryNextCheckAt'>;
  connectedWallet: string | undefined;
  stripeCheckoutDataOwner: string | undefined;
};

export function useShopAccount(
  { auth, connectedWallet, stripeCheckoutDataOwner }: ShopAccountOptions,
  runtime: typeof DEFAULT_RUNTIME = DEFAULT_RUNTIME,
) {
  const { getAdminProfileView, listDeliveryOrderOwners } = runtime;
  const { profile, sessionWallet, authenticated, deliveryRecoveryNextCheckAt } = auth;
  const [adminViewedOwner, setAdminViewedOwner] = useState<string | null>(null);
  const authenticatedWallet = authenticated && sessionWallet ? sessionWallet : undefined;
  const hasAuthenticatedAccount = Boolean(authenticatedWallet);
  const localAccountWallet = connectedWallet || authenticatedWallet;
  const isAdminWallet = Boolean(authenticatedWallet && ADMIN_WALLETS.has(authenticatedWallet));
  const isSignedInWallet = Boolean(authenticated && connectedWallet && sessionWallet === connectedWallet);
  const canUseAdminMenu = Boolean(
    authenticatedWallet && hasFulfillmentAppAccess(authenticatedWallet),
  );
  const canUseAdminViewer = isAdminWallet && hasAuthenticatedAccount;
  const owner =
    canUseAdminViewer && adminViewedOwner
      ? adminViewedOwner
      : stripeCheckoutDataOwner;
  const includeDevnetInventory = hasDevnetInventoryAccess(connectedWallet) || hasDevnetInventoryAccess(owner);
  const isViewerMode = Boolean(owner && authenticatedWallet && owner !== authenticatedWallet);
  const canReadOwnProfile = Boolean(
    authenticated && owner && sessionWallet === owner && !isViewerMode,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ownerPickerOpened, setOwnerPickerOpened] = useState(false);
  const [devnetDropsPickerOpened, setDevnetDropsPickerOpened] = useState(false);
  const [wipPickerOpened, setWipPickerOpened] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const {
    data: deliveryOrderOwnersData,
    isFetchingNextPage: deliveryOrderOwnersLoadingMore,
    hasNextPage: deliveryOrderOwnersHasNextPage,
    fetchNextPage: fetchNextDeliveryOrderOwners,
    error: deliveryOrderOwnersError,
  } = useInfiniteQuery({
    queryKey: ['adminDeliveryOrderOwners', authenticatedWallet],
    enabled: Boolean(canUseAdminViewer && settingsOpen && ownerPickerOpened),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listDeliveryOrderOwners({
        cursor: typeof pageParam === 'string' && pageParam ? pageParam : undefined,
        pageSize: ADMIN_OWNER_DOC_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined),
    staleTime: 30_000,
  });
  const deliveryOrderOwners = useMemo(() => {
    const unique = new Set<string>();
    if (authenticatedWallet) unique.add(authenticatedWallet);
    const fromApi =
      deliveryOrderOwnersData?.pages?.flatMap((page) => (Array.isArray(page?.owners) ? page.owners : [])) || [];
    fromApi.forEach((entry) => {
      if (typeof entry === 'string' && entry) unique.add(entry);
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [authenticatedWallet, deliveryOrderOwnersData]);

  const {
    data: viewedProfileData,
    isFetching: viewedProfileLoading,
    error: viewedProfileError,
  } = useQuery({
    queryKey: ['viewedProfile', authenticatedWallet, owner, hasAuthenticatedAccount],
    enabled: Boolean(hasAuthenticatedAccount && canUseAdminViewer && isViewerMode && owner),
    queryFn: () => getAdminProfileView(owner || ''),
    staleTime: 10_000,
  });

  const viewedProfile = useMemo(() => {
    return profileForAuthorizedView({
      ownProfile: profile,
      adminProfile: viewedProfileData?.profile || null,
      canReadOwnProfile,
      canUseAdminViewer,
      isViewerMode,
    });
  }, [
    canUseAdminViewer,
    canReadOwnProfile,
    isViewerMode,
    profile,
    viewedProfileData?.profile,
  ]);
  const currentOwnerDeliveryRecoveryNextCheckAt =
    hasAuthenticatedAccount && !isViewerMode ? deliveryRecoveryNextCheckAt : null;

  return {
    adminViewedOwner, setAdminViewedOwner,
    authenticatedWallet, hasAuthenticatedAccount, localAccountWallet,
    isAdminWallet, isSignedInWallet, canUseAdminMenu, canUseAdminViewer,
    owner, includeDevnetInventory, isViewerMode, canReadOwnProfile,
    settingsOpen, setSettingsOpen, ownerPickerOpened, setOwnerPickerOpened,
    devnetDropsPickerOpened, setDevnetDropsPickerOpened, wipPickerOpened, setWipPickerOpened, settingsRef,
    deliveryOrderOwners, deliveryOrderOwnersLoadingMore, deliveryOrderOwnersHasNextPage,
    fetchNextDeliveryOrderOwners, deliveryOrderOwnersError,
    viewedProfile, viewedProfileLoading, viewedProfileError, currentOwnerDeliveryRecoveryNextCheckAt,
  };
}

export type ShopAccount = ReturnType<typeof useShopAccount>;

export function useShopAccountEffects(account: ShopAccount) {
  const {
    adminViewedOwner, setAdminViewedOwner, authenticatedWallet, canUseAdminMenu, canUseAdminViewer,
    settingsOpen, setSettingsOpen, ownerPickerOpened, setOwnerPickerOpened,
    setDevnetDropsPickerOpened, setWipPickerOpened, settingsRef,
  } = account;
  useEffect(() => {
    if (!authenticatedWallet) {
      setAdminViewedOwner(null);
      setSettingsOpen(false);
      return;
    }
    if (adminViewedOwner === authenticatedWallet) {
      setAdminViewedOwner(null);
    }
  }, [adminViewedOwner, authenticatedWallet]);

  useEffect(() => {
    if (canUseAdminMenu) return;
    if (settingsOpen) setSettingsOpen(false);
  }, [canUseAdminMenu, settingsOpen]);

  useEffect(() => {
    if (canUseAdminViewer) return;
    if (adminViewedOwner) setAdminViewedOwner(null);
    if (ownerPickerOpened) setOwnerPickerOpened(false);
  }, [adminViewedOwner, canUseAdminViewer, ownerPickerOpened]);

  useEffect(() => {
    if (settingsOpen) return;
    setDevnetDropsPickerOpened(false);
    setWipPickerOpened(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) {
      setOwnerPickerOpened(false);
      return;
    }
    setOwnerPickerOpened(Boolean(adminViewedOwner && adminViewedOwner !== authenticatedWallet));
  }, [adminViewedOwner, authenticatedWallet, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (evt: MouseEvent) => {
      const root = settingsRef.current;
      if (!root) return;
      if (!root.contains(evt.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [settingsOpen]);
}
