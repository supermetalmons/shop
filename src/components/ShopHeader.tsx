import { useState } from 'react';
import type React from 'react';
import { navigate } from '../navigation';
import { useDropPageScrollFade } from '../hooks/useDropPageScrollFade';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';

type ShopHeaderProps = {
  onNavigateHome?: () => void;
  renderRight?: (options: { interactive: boolean }) => React.ReactNode;
  scrollHomeToTop?: boolean;
  fadeBackdrop?: boolean;
  variant?: 'default' | 'drif';
};

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
  fadeBackdrop = false,
  variant = 'default',
}: ShopHeaderProps) {
  const [fixedHeader, setFixedHeader] = useState<HTMLElement | null>(null);
  const right = renderRight?.({ interactive: true });
  const spacerRight = renderRight?.({ interactive: false });
  useDropPageScrollFade({ active: fadeBackdrop, target: fixedHeader });

  return (
    <>
      <BackgroundLayerPortal placement="leading">
        <header
          ref={setFixedHeader}
          className={`top top--fixed top--shop${fadeBackdrop ? ' top--fade-backdrop' : ''}${
            variant === 'drif' ? ' top--drif' : ''
          }`}
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
        className={`top top--spacer top--shop${variant === 'drif' ? ' top--drif' : ''}`}
        aria-hidden="true"
      >
        <ShopHeaderBrand interactive={false} scrollHomeToTop={false} />
        {spacerRight ? <div className="top__right">{spacerRight}</div> : null}
      </header>
    </>
  );
}
