import { FaTableCellsLarge } from 'react-icons/fa6';
import {
  isDropFamily,
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  CARD_NFT_2_PACK_VIDEO_POSTER_URL
} from '../../lib/cardNft2Packs';
import {
  dropPath
} from '../../lib/dropConfig';
import {
  mintPanelPreviewImage
} from '../../lib/dropContent';
import { navigate } from '../../navigation';
import { WIP_ROUTES } from '../../routes';
import type { ShopAccount } from '../account/useShopAccount';
import { BUILD_INFO } from './feedback';

type ShopHeaderActionsProps = Pick<ShopAccount,
  'canUseAdminMenu'
  | 'canUseAdminViewer'
  | 'settingsRef'
  | 'settingsOpen'
  | 'setSettingsOpen'
  | 'ownerPickerOpened'
  | 'setOwnerPickerOpened'
  | 'authenticatedWallet'
  | 'adminViewedOwner'
  | 'setAdminViewedOwner'
  | 'deliveryOrderOwners'
  | 'wipPickerOpened'
  | 'setWipPickerOpened'
  | 'devnetDropsPickerOpened'
  | 'setDevnetDropsPickerOpened'
  | 'deliveryOrderOwnersLoadingMore'
  | 'fetchNextDeliveryOrderOwners'
  | 'deliveryOrderOwnersHasNextPage'
  | 'deliveryOrderOwnersError'
  | 'owner'
> & {
  interactive: boolean;
  showHeaderWalletButton: boolean;
  connectedWallet: string | undefined;
  handleHeaderWalletSignIn: () => Promise<void>;
  adminMenuDevnetDrops: FrontendDeploymentConfig[];
};
export function ShopHeaderActions({
  canUseAdminMenu,
  canUseAdminViewer,
  settingsRef,
  settingsOpen,
  setSettingsOpen,
  ownerPickerOpened,
  setOwnerPickerOpened,
  authenticatedWallet,
  adminViewedOwner,
  setAdminViewedOwner,
  deliveryOrderOwners,
  wipPickerOpened,
  setWipPickerOpened,
  devnetDropsPickerOpened,
  setDevnetDropsPickerOpened,
  deliveryOrderOwnersLoadingMore,
  fetchNextDeliveryOrderOwners,
  deliveryOrderOwnersHasNextPage,
  deliveryOrderOwnersError,
  owner,
  interactive,
  showHeaderWalletButton,
  connectedWallet,
  handleHeaderWalletSignIn,
  adminMenuDevnetDrops,
}: ShopHeaderActionsProps) {
  const adminMenuLabel = (value: string) => value.replace(/^\/+/, '');
  const adminMenuSectionLabel = (value: string, expanded: boolean) => `${value} ${expanded ? '▾' : '▸'}`;
  const adminMenuIcon = (dropId?: string) => {
    const src = !dropId
      ? undefined
      : isDropFamily(dropId, 'card_nft_2')
        ? CARD_NFT_2_PACK_VIDEO_POSTER_URL
        : mintPanelPreviewImage(dropId);
    if (!src) return null;
    return (
      <img
        className="top__submenu-nav-icon"
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={(evt) => {
          evt.currentTarget.hidden = true;
        }}
      />
    );
  };
  const ownerPickerValue = owner || '';
  const deliveryOrderOwnersErrorMessage = deliveryOrderOwnersError instanceof Error ? deliveryOrderOwnersError.message : '';
  const canLoadMoreOwners = Boolean(deliveryOrderOwnersHasNextPage);

  const walletAction = showHeaderWalletButton ? (
    <button
      type="button"
      className="top__wallet-button secondary-light"
      onClick={interactive ? handleHeaderWalletSignIn : undefined}
      aria-label={interactive ? (connectedWallet ? 'Sign in with Solana' : 'Connect wallet and sign in with Solana') : undefined}
      tabIndex={interactive ? undefined : -1}
    >
      <span>Connect Wallet</span>
    </button>
  ) : (
    <div className="top__wallet-spacer" aria-hidden="true" />
  );
  const adminMenu = !canUseAdminMenu ? null : interactive ? (
    <div className="top__actions" ref={settingsRef}>
      <button
        type="button"
        className={`top__settings${settingsOpen ? ' top__settings--active' : ''}`}
        onClick={() => setSettingsOpen((prev) => !prev)}
        aria-label="App menu"
        data-background-blur-focus-fallback=""
        aria-haspopup="menu"
        aria-expanded={settingsOpen}
      >
        <FaTableCellsLarge aria-hidden />
      </button>
      {settingsOpen ? (
        <div className="top__submenu" role="menu" aria-label="App menu">
          {canUseAdminViewer && !ownerPickerOpened ? (
            <button
              type="button"
              className="link small top__submenu-nav"
              aria-expanded={ownerPickerOpened}
              onClick={() => {
                setOwnerPickerOpened(true);
              }}
            >
              override address
            </button>
          ) : null}
          {canUseAdminViewer && ownerPickerOpened ? (
            <select
              id="admin-owner-picker"
              aria-label="Viewer owner"
              value={ownerPickerValue}
              onChange={(evt) => {
                const value = evt.target.value.trim();
                if (!authenticatedWallet || !value || value === authenticatedWallet) {
                  setAdminViewedOwner(null);
                  return;
                }
                setAdminViewedOwner(value);
              }}
            >
              {authenticatedWallet ? (
                <option value={authenticatedWallet}>{authenticatedWallet}</option>
              ) : null}
              {adminViewedOwner && !deliveryOrderOwners.includes(adminViewedOwner) ? (
                <option value={adminViewedOwner}>{adminViewedOwner}</option>
              ) : null}
              {deliveryOrderOwners
                .filter((entry) => entry !== authenticatedWallet)
                .map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
            </select>
          ) : null}
          <button
            type="button"
            className="link small top__submenu-nav"
            onClick={() => {
              navigate('/fulfillment');
            }}
          >
            {adminMenuLabel('/fulfillment')}
          </button>
          <button
            type="button"
            className="link small top__submenu-nav top__submenu-section"
            aria-expanded={wipPickerOpened}
            onClick={() => {
              setWipPickerOpened((prev) => !prev);
            }}
          >
            {adminMenuSectionLabel('wip', wipPickerOpened)}
          </button>
          {wipPickerOpened
            ? WIP_ROUTES.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="link small top__submenu-nav"
                onClick={() => {
                  navigate(entry.path);
                }}
              >
                {adminMenuIcon(entry.dropId)}
                {adminMenuLabel(entry.path)}
              </button>
            ))
            : null}
          {adminMenuDevnetDrops.length ? (
            <button
              type="button"
              className="link small top__submenu-nav top__submenu-section"
              aria-expanded={devnetDropsPickerOpened}
              onClick={() => {
                setDevnetDropsPickerOpened((prev) => !prev);
              }}
            >
              {adminMenuSectionLabel('devnet drops', devnetDropsPickerOpened)}
            </button>
          ) : null}
          {devnetDropsPickerOpened
            ? adminMenuDevnetDrops.map((drop) => (
              <button
                key={drop.dropId}
                type="button"
                className="link small top__submenu-nav"
                onClick={() => {
                  navigate(dropPath(drop.dropId));
                }}
              >
                {adminMenuIcon(drop.dropId)}
                {adminMenuLabel(dropPath(drop.dropId))}
              </button>
            ))
            : null}
          {canUseAdminViewer && canLoadMoreOwners ? (
            <button
              type="button"
              className="link small top__submenu-more"
              disabled={deliveryOrderOwnersLoadingMore}
              onClick={() => {
                void fetchNextDeliveryOrderOwners();
              }}
            >
              {deliveryOrderOwnersLoadingMore ? 'Loading more owners…' : 'Show more owners'}
            </button>
          ) : null}
          {canUseAdminViewer && deliveryOrderOwnersErrorMessage ? (
            <div className="error small">{deliveryOrderOwnersErrorMessage}</div>
          ) : null}
          <div className="muted small top__build-info">{BUILD_INFO}</div>
        </div>
      ) : null}
    </div>
  ) : (
    <div className="top__actions">
      <button type="button" className="top__settings" tabIndex={-1}>
        <FaTableCellsLarge aria-hidden />
      </button>
    </div>
  );

  return (
    <>
      {walletAction}
      {adminMenu}
    </>
  );

}
