export function parseProceedsConfig(value, collectionAddress) {
  if (!value || typeof value !== 'object') throw new Error('Invalid proceeds configuration.');
  const { mintRecipients, mintSharesBps, deliveryPaymentReceiver } = value;
  if (!Array.isArray(mintRecipients) || mintRecipients.length < 2 || mintRecipients.length > 32 ||
    !Array.isArray(mintSharesBps) || mintSharesBps.length !== mintRecipients.length ||
    mintSharesBps.some(share => !Number.isInteger(share) || share <= 0 || share > 10_000) ||
    mintSharesBps.reduce((total, share) => total + share, 0) !== 10_000) throw new Error('Invalid mint proceeds split.');
  for (const address of [deliveryPaymentReceiver, ...mintRecipients]) {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address) ||
      address.toLowerCase() === collectionAddress?.toLowerCase()) throw new Error('Invalid proceeds receiver address.');
  }
  const recipients = mintRecipients.map(address => address.toLowerCase());
  const deliveryReceiver = deliveryPaymentReceiver.toLowerCase();
  if (new Set(recipients).size !== recipients.length || recipients.includes(deliveryReceiver)) {
    throw new Error('Proceeds receivers must be distinct.');
  }
  return { mintRecipients: recipients, mintSharesBps: [...mintSharesBps], deliveryPaymentReceiver: deliveryReceiver };
}
