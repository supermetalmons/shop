import type React from 'react';
import { FaXTwitter } from 'react-icons/fa6';
import { navigate } from '../navigation';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';

type ShopHeaderProps = {
  onNavigateHome?: () => void;
  renderRight?: (options: { interactive: boolean; xLink: React.ReactNode }) => React.ReactNode;
  scrollHomeToTop?: boolean;
  variant?: 'default' | 'drif';
  hidden?: boolean;
  showXLink?: boolean;
};

function ShopHeaderXLink({ interactive }: { interactive: boolean }) {
  return (
    <a
      href={interactive ? 'https://x.com/monsdotshop' : undefined}
      className="top__settings"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={interactive ? 'mons.shop on X' : undefined}
      tabIndex={interactive ? undefined : -1}
    >
      <FaXTwitter size={16} aria-hidden />
    </a>
  );
}

function ShopHeaderBrand({
  interactive,
  onNavigateHome,
  scrollHomeToTop,
}: {
  interactive: boolean;
  onNavigateHome?: () => void;
  scrollHomeToTop: boolean;
}) {
  const handleHomeClick = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    if (!interactive) return;
    if (evt.defaultPrevented || evt.button !== 0 || evt.metaKey || evt.altKey || evt.ctrlKey || evt.shiftKey) {
      return;
    }

    evt.preventDefault();
    if (scrollHomeToTop) {
      window.scrollTo({ top: 0, left: 0 });
    } else {
      onNavigateHome?.();
    }
    navigate('/');
  };

  return (
    <div className="brand">
      <a
        href="/"
        className="brand__home-link"
        aria-label={interactive ? 'Go to mons.shop home' : undefined}
        draggable={false}
        tabIndex={interactive ? undefined : -1}
        onClick={handleHomeClick}
        onDragStart={(evt) => {
          evt.preventDefault();
        }}
      >
        <h1>
          <img src="https://cdn.lil.org/mons/shop/favicon/logo.webp" alt="" className="brand-icon" draggable={false} />
          <span>mons.shop</span>
        </h1>
      </a>
    </div>
  );
}

export function ShopHeader({
  onNavigateHome,
  renderRight,
  scrollHomeToTop = false,
  variant = 'default',
  hidden = false,
  showXLink = Boolean(renderRight),
}: ShopHeaderProps) {
  const renderControls = (interactive: boolean) => {
    const xLink = showXLink ? <ShopHeaderXLink interactive={interactive} /> : null;
    return renderRight ? renderRight({ interactive, xLink }) : xLink;
  };
  const right = renderControls(true);
  const spacerRight = renderControls(false);
  const headerClassName = `top--shop${variant === 'drif' ? ' top--drif' : ''}${showXLink ? ' top--with-x' : ''}`;

  return (
    <>
      <BackgroundLayerPortal placement="leading">
        <header
          className={`top top--fixed ${headerClassName}`}
          hidden={hidden}
        >
          <div className="top__backdrop" aria-hidden="true" />
          <ShopHeaderBrand
            interactive
            onNavigateHome={onNavigateHome}
            scrollHomeToTop={scrollHomeToTop}
          />
          {right ? <div className="top__right">{right}</div> : null}
        </header>
      </BackgroundLayerPortal>
      <header
        className={`top top--spacer ${headerClassName}`}
        aria-hidden="true"
      >
        <ShopHeaderBrand interactive={false} scrollHomeToTop={false} />
        {spacerRight ? <div className="top__right">{spacerRight}</div> : null}
      </header>
    </>
  );
}
