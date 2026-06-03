import type React from 'react';
import { navigate } from '../navigation';

type ShopHeaderProps = {
  renderRight?: (options: { interactive: boolean }) => React.ReactNode;
  scrollHomeToTop?: boolean;
};

function ShopHeaderBrand({
  interactive,
  scrollHomeToTop,
}: {
  interactive: boolean;
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
          <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" draggable={false} />
          <span>mons.shop</span>
        </h1>
      </a>
    </div>
  );
}

export function ShopHeader({ renderRight, scrollHomeToTop = false }: ShopHeaderProps) {
  const right = renderRight?.({ interactive: true });
  const spacerRight = renderRight?.({ interactive: false });

  return (
    <>
      <header className="top top--fixed top--shop">
        <ShopHeaderBrand interactive scrollHomeToTop={scrollHomeToTop} />
        {right ? <div className="top__right">{right}</div> : null}
      </header>
      <header className="top top--spacer top--shop" aria-hidden="true">
        <ShopHeaderBrand interactive={false} scrollHomeToTop={false} />
        {spacerRight ? <div className="top__right">{spacerRight}</div> : null}
      </header>
    </>
  );
}
