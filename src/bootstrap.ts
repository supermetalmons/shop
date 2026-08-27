type BrowserBootstrapActions = {
  redirect: (url: string) => void;
  setup: () => void;
  mount: () => void;
};

export function runBrowserBootstrap(
  canonicalUrl: string | null,
  actions: BrowserBootstrapActions,
): 'redirected' | 'mounted' {
  if (canonicalUrl) {
    actions.redirect(canonicalUrl);
    return 'redirected';
  }

  actions.setup();
  actions.mount();
  return 'mounted';
}
