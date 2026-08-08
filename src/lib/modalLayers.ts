export const MODAL_LAYER_PRIORITY = [
  'wallet',
  'transfer',
  'reveal',
  'claim',
  'shipment',
  'notify',
] as const;

export type ModalLayer = (typeof MODAL_LAYER_PRIORITY)[number];
export type ActiveModalLayer = ModalLayer | null;
export type ModalLayerState = Readonly<Record<ModalLayer, boolean>>;

export function resolveActiveModalLayer(state: ModalLayerState): ActiveModalLayer {
  return MODAL_LAYER_PRIORITY.find((layer) => state[layer]) ?? null;
}

export function isModalLayerSuspended({
  activeLayer,
  appSuspended = false,
  layer,
  open,
}: {
  activeLayer: ActiveModalLayer;
  appSuspended?: boolean;
  layer: ModalLayer;
  open: boolean;
}): boolean {
  if (appSuspended) return true;
  if (!open || activeLayer === null || activeLayer === layer) return false;
  return MODAL_LAYER_PRIORITY.indexOf(activeLayer) < MODAL_LAYER_PRIORITY.indexOf(layer);
}

export function shouldToastAppearAboveModal({
  activeLayer,
  receiptTransferOpen,
  receiptViewerOpen,
}: {
  activeLayer: ActiveModalLayer;
  receiptTransferOpen: boolean;
  receiptViewerOpen: boolean;
}): boolean {
  return (
    receiptTransferOpen ||
    receiptViewerOpen ||
    activeLayer === 'claim' ||
    activeLayer === 'shipment' ||
    activeLayer === 'notify'
  );
}
