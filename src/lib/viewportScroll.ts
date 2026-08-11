export type ViewportScrollPosition = {
  left: number;
  top: number;
};

export function captureViewportScrollPosition(): ViewportScrollPosition {
  return {
    left: window.scrollX,
    top: window.scrollY,
  };
}

export function restoreViewportScrollPosition(position: ViewportScrollPosition) {
  const root = document.documentElement;
  const previousScrollBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  try {
    window.scrollTo(position.left, position.top);
  } finally {
    root.style.scrollBehavior = previousScrollBehavior;
  }
}
