export type DeliveryReadyToShipStatusSnapshot = {
  status?: unknown;
} | null | undefined;

export function shouldNotifyShippersForDeliveryReadyToShipWrite(args: {
  before?: DeliveryReadyToShipStatusSnapshot;
  after?: DeliveryReadyToShipStatusSnapshot;
}): boolean {
  return args.after?.status === 'ready_to_ship' && args.before?.status !== 'ready_to_ship';
}
