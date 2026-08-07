export type DeferredOverlayActionKind = 'reconcile' | 'presentation';

export type DeferredOverlayAction = {
  kind: DeferredOverlayActionKind;
  run: () => void;
};

export function runDeferredOverlayActions(
  actions: readonly DeferredOverlayAction[],
  { includePresentation = true }: { includePresentation?: boolean } = {},
) {
  for (const action of actions) {
    if (action.kind === 'presentation' && !includePresentation) continue;
    action.run();
  }
}
