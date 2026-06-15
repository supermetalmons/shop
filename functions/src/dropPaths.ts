export function dropRootPath(dropId: string): string {
  return `drops/${dropId}`;
}

export function dropBoxAssignmentPath(dropId: string, boxAssetId: string): string {
  return `${dropRootPath(dropId)}/boxAssignments/${boxAssetId}`;
}

export function dropDudeAssignmentPath(dropId: string, dudeId: number): string {
  return `${dropRootPath(dropId)}/dudeAssignments/${dudeId}`;
}

export function dropDudePoolPath(dropId: string): string {
  return `${dropRootPath(dropId)}/meta/dudePool`;
}

export function dropPackStatusPath(dropId: string): string {
  return `${dropRootPath(dropId)}/meta/packStatus`;
}

export function dropDeliveryOrdersCollectionPath(dropId: string): string {
  return `${dropRootPath(dropId)}/deliveryOrders`;
}

export function dropDeliveryOrderPath(dropId: string, deliveryId: number): string {
  return `${dropDeliveryOrdersCollectionPath(dropId)}/${deliveryId}`;
}
