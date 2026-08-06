export const FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT = 3;

export function groupFulfillmentShipStationRates<T extends { rateId: string }>(
  rates: readonly T[],
  selectedRateId: string | null,
): {
  recommendedRates: T[];
  otherRates: T[];
  selectedOtherRate: T | null;
} {
  const recommendedRates = rates.slice(0, FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT);
  const otherRates = rates.slice(FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT);
  return {
    recommendedRates,
    otherRates,
    selectedOtherRate: otherRates.find((rate) => rate.rateId === selectedRateId) ?? null,
  };
}
