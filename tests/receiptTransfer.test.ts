import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal } from '../src/components/Modal.tsx';
import { ReceiptTransferForm } from '../src/components/ReceiptTransferForm.tsx';
import { acquireBodyScrollLock, releaseBodyScrollLock } from '../src/lib/bodyScrollLock.ts';
import { trapTabFocusWithin } from '../src/lib/focusTrap.ts';
import { shouldHandleOverlayEscape } from '../src/hooks/useOverlayScrollLock.ts';
import {
  canSignReceiptTransferTransaction,
  normalizeReceiptTransferDestination,
  rebaseReceiptOperationsAfterWalletChange,
  removeReceiptOperationsForAssets,
  receiptOperationAssetIds,
  receiptOperationKey,
  receiptReconciliationDisposition,
  resolveReceiptTransferTarget,
  setReceiptOperation,
  transitionReceiptOperation,
  type ReceiptOperation,
  type ReceiptOperationRegistry,
} from '../src/lib/receiptTransfer.ts';

const OWNER = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const DESTINATION = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const RECEIPT_ASSET_ID = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const OTHER_RECEIPT_ASSET_ID = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

test('an underlying overlay handles Escape only while it owns dismissal', () => {
  assert.equal(
    shouldHandleOverlayEscape({
      defaultPrevented: false,
      escapeEnabled: true,
      hasEscapeHandler: true,
      key: 'Escape',
    }),
    true,
  );
  assert.equal(
    shouldHandleOverlayEscape({
      defaultPrevented: false,
      escapeEnabled: false,
      hasEscapeHandler: true,
      key: 'Escape',
    }),
    false,
  );
  assert.equal(
    shouldHandleOverlayEscape({
      defaultPrevented: true,
      escapeEnabled: true,
      hasEscapeHandler: true,
      key: 'Escape',
    }),
    false,
  );
  assert.equal(
    shouldHandleOverlayEscape({
      defaultPrevented: false,
      escapeEnabled: true,
      hasEscapeHandler: false,
      key: 'Escape',
    }),
    false,
  );
});

test('receipt transfer signing requires a signTransaction function', () => {
  assert.equal(canSignReceiptTransferTransaction(undefined, new Set(['legacy', 0])), false);
  assert.equal(canSignReceiptTransferTransaction(null, new Set(['legacy', 0])), false);
  assert.equal(canSignReceiptTransferTransaction(true, new Set(['legacy', 0])), false);
});

test('receipt transfer signing rejects legacy-only and unspecified transaction versions', () => {
  const signTransaction = async () => undefined;

  assert.equal(canSignReceiptTransferTransaction(signTransaction, new Set(['legacy'])), false);
  assert.equal(canSignReceiptTransferTransaction(signTransaction, null), false);
  assert.equal(canSignReceiptTransferTransaction(signTransaction, undefined), false);
});

test('receipt transfer signing accepts a signer with v0 transaction support', () => {
  const signTransaction = async () => undefined;

  assert.equal(canSignReceiptTransferTransaction(signTransaction, new Set(['legacy', 0])), true);
  assert.equal(canSignReceiptTransferTransaction(signTransaction, new Set([0])), true);
});

test('receipt reconciliation maps confirmed, definitive failure, and unknown separately', () => {
  assert.equal(receiptReconciliationDisposition('confirmed'), 'hidden');
  assert.equal(receiptReconciliationDisposition('failed'), 'available');
  assert.equal(receiptReconciliationDisposition('expired'), 'available');
  assert.equal(receiptReconciliationDisposition('unknown'), 'unverified');
});

function receiptOperation(args: {
  wallet?: string;
  assetId?: string;
  generation: number;
  phase?: ReceiptOperation['phase'];
}): ReceiptOperation {
  const wallet = args.wallet ?? OWNER;
  const assetId = args.assetId ?? RECEIPT_ASSET_ID;
  return {
    key: receiptOperationKey(wallet, assetId),
    wallet,
    assetId,
    dropId: 'card_nft_2',
    createdGeneration: args.generation,
    generation: args.generation,
    phase: args.phase ?? 'in-flight',
  };
}

test('newer receipt operation generations reject stale same-wallet transitions', () => {
  let registry: ReceiptOperationRegistry = new Map();
  const first = receiptOperation({ generation: 1 });
  const second = receiptOperation({ generation: 2 });
  registry = setReceiptOperation(registry, first);
  registry = setReceiptOperation(registry, second);

  const staleResult = transitionReceiptOperation(registry, first.key, first.generation, (current) => ({
    ...current,
    phase: 'unverified',
  }));

  assert.equal(staleResult, registry);
  assert.deepEqual(staleResult.get(first.key), second);
});

test('receipt operation transitions isolate different wallets and assets', () => {
  let registry: ReceiptOperationRegistry = new Map();
  const ownerReceipt = receiptOperation({ generation: 1 });
  const ownerOtherReceipt = receiptOperation({
    assetId: OTHER_RECEIPT_ASSET_ID,
    generation: 2,
    phase: 'hidden',
  });
  const destinationReceipt = receiptOperation({
    wallet: DESTINATION,
    generation: 3,
    phase: 'unverified',
  });
  registry = setReceiptOperation(registry, ownerReceipt);
  registry = setReceiptOperation(registry, ownerOtherReceipt);
  registry = setReceiptOperation(registry, destinationReceipt);

  registry = transitionReceiptOperation(registry, ownerReceipt.key, ownerReceipt.generation, (current) => ({
    ...current,
    phase: 'unverified',
  }));

  assert.equal(registry.get(ownerReceipt.key)?.phase, 'unverified');
  assert.equal(registry.get(ownerOtherReceipt.key)?.phase, 'hidden');
  assert.equal(registry.get(destinationReceipt.key)?.phase, 'unverified');
  assert.deepEqual(
    receiptOperationAssetIds(registry, OWNER, new Set(['hidden'])),
    new Set([OTHER_RECEIPT_ASSET_ID]),
  );
  assert.deepEqual(
    receiptOperationAssetIds(registry, OWNER, new Set(['unverified'])),
    new Set([RECEIPT_ASSET_ID]),
  );
});

test('definitive receipt reconciliation removes only the matching generation', () => {
  const operation = receiptOperation({ generation: 7, phase: 'hidden' });
  const registry = setReceiptOperation(new Map(), operation);

  const staleResult = transitionReceiptOperation(registry, operation.key, 6, () => null);
  const currentResult = transitionReceiptOperation(registry, operation.key, 7, () => null);

  assert.equal(staleResult, registry);
  assert.equal(currentResult.has(operation.key), false);
});

test('wallet switching invalidates stale callbacks and restores submitted receipts as unverified', () => {
  const submitted = {
    ...receiptOperation({ generation: 4, phase: 'hidden' }),
    signature: 'submitted-signature',
    recentBlockhash: 'submitted-blockhash',
  };
  const unsigned = receiptOperation({
    assetId: OTHER_RECEIPT_ASSET_ID,
    generation: 5,
    phase: 'in-flight',
  });
  const otherWallet = {
    ...receiptOperation({ wallet: DESTINATION, generation: 6, phase: 'hidden' }),
    signature: 'other-signature',
    recentBlockhash: 'other-blockhash',
  };
  let registry: ReceiptOperationRegistry = new Map([
    [submitted.key, submitted],
    [unsigned.key, unsigned],
    [otherWallet.key, otherWallet],
  ]);

  const rebased = rebaseReceiptOperationsAfterWalletChange(registry, OWNER, 6);
  registry = rebased.registry;

  assert.equal(registry.has(unsigned.key), false);
  assert.equal(registry.get(submitted.key)?.phase, 'unverified');
  assert.equal(registry.get(submitted.key)?.generation, 7);
  assert.deepEqual(registry.get(otherWallet.key), otherWallet);
  assert.equal(rebased.lastGeneration, 7);

  const staleCompletion = transitionReceiptOperation(
    registry,
    submitted.key,
    submitted.generation,
    () => null,
  );
  assert.equal(staleCompletion, registry);
  assert.equal(staleCompletion.get(submitted.key)?.phase, 'unverified');
});

test('a signed in-flight receipt remains checkable after its wallet session changes', () => {
  const operation = {
    ...receiptOperation({ generation: 8 }),
    signature: 'locally-derived-signature',
    recentBlockhash: 'recent-blockhash',
  };
  const registry = new Map([[operation.key, operation]]);

  const rebased = rebaseReceiptOperationsAfterWalletChange(registry, OWNER, 8);

  assert.equal(rebased.registry.get(operation.key)?.phase, 'unverified');
  assert.equal(rebased.registry.get(operation.key)?.signature, operation.signature);
  assert.equal(rebased.registry.get(operation.key)?.recentBlockhash, operation.recentBlockhash);
  assert.equal(rebased.registry.get(operation.key)?.generation, 9);
});

test('an authoritative inbound receipt clears only its matching wallet operation', () => {
  const returnedReceipt = receiptOperation({ generation: 10, phase: 'hidden' });
  const otherAsset = receiptOperation({
    assetId: OTHER_RECEIPT_ASSET_ID,
    generation: 11,
    phase: 'unverified',
  });
  const otherWallet = receiptOperation({
    wallet: DESTINATION,
    generation: 12,
    phase: 'hidden',
  });
  const registry = new Map([
    [returnedReceipt.key, returnedReceipt],
    [otherAsset.key, otherAsset],
    [otherWallet.key, otherWallet],
  ]);

  const next = removeReceiptOperationsForAssets(registry, OWNER, [RECEIPT_ASSET_ID]);

  assert.equal(next.has(returnedReceipt.key), false);
  assert.deepEqual(next.get(otherAsset.key), otherAsset);
  assert.deepEqual(next.get(otherWallet.key), otherWallet);
});

test('an older inbound claim cannot clear a newer operation for the returned receipt', () => {
  const newerTransfer = receiptOperation({ generation: 15, phase: 'in-flight' });
  const registry = new Map([[newerTransfer.key, newerTransfer]]);

  const next = removeReceiptOperationsForAssets(registry, OWNER, [RECEIPT_ASSET_ID], 14);

  assert.equal(next, registry);
  assert.deepEqual(next.get(newerTransfer.key), newerTransfer);
});

test('an inbound claim never clears an operation that is still in flight', () => {
  const inFlight = receiptOperation({ generation: 13, phase: 'in-flight' });
  const registry = new Map([[inFlight.key, inFlight]]);

  const next = removeReceiptOperationsForAssets(registry, OWNER, [RECEIPT_ASSET_ID], 13);

  assert.equal(next, registry);
  assert.deepEqual(next.get(inFlight.key), inFlight);
});

test('an inbound claim still clears an older operation after wallet-session rebasing', () => {
  const submitted = {
    ...receiptOperation({ generation: 4, phase: 'hidden' }),
    signature: 'submitted-signature',
    recentBlockhash: 'submitted-blockhash',
  };
  const rebased = rebaseReceiptOperationsAfterWalletChange(
    new Map([[submitted.key, submitted]]),
    OWNER,
    6,
  ).registry;

  const next = removeReceiptOperationsForAssets(rebased, OWNER, [RECEIPT_ASSET_ID], 6);

  assert.equal(rebased.get(submitted.key)?.generation, 7);
  assert.equal(rebased.get(submitted.key)?.createdGeneration, 4);
  assert.equal(next.has(submitted.key), false);
});

test('Tab containment recovers when the focused modal control becomes disabled', () => {
  const originalDocument = globalThis.document;
  const disabledControl = {};
  let focused: unknown = disabledControl;
  let prevented = false;
  const firstControl = {
    tabIndex: 0,
    isConnected: true,
    matches: () => false,
    closest: () => null,
    focus: () => {
      focused = firstControl;
    },
  };
  const root = {
    contains: (target: unknown) => target === root || target === disabledControl || target === firstControl,
    focus: () => {
      focused = root;
    },
    querySelectorAll: () => [firstControl],
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get activeElement() {
        return focused;
      },
    },
  });

  try {
    trapTabFocusWithin(root as unknown as HTMLElement, {
      key: 'Tab',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent);
    assert.equal(prevented, true);
    assert.equal(focused, firstControl);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  }
});

test('nested body scroll locks restore the original overflow only after the final release', () => {
  const originalDocument = globalThis.document;
  const bodyStyle = { overflow: 'auto' };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: { style: bodyStyle } },
  });

  try {
    acquireBodyScrollLock();
    acquireBodyScrollLock();
    assert.equal(bodyStyle.overflow, 'hidden');

    releaseBodyScrollLock();
    assert.equal(bodyStyle.overflow, 'hidden');

    releaseBodyScrollLock();
    assert.equal(bodyStyle.overflow, 'auto');
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  }
});

test('receipt transfer destination normalization trims and canonicalizes a public key', () => {
  assert.equal(normalizeReceiptTransferDestination(`  ${DESTINATION}  `, OWNER), DESTINATION);
});

test('receipt transfer destination normalization rejects empty, malformed, system, and self addresses', () => {
  assert.throws(
    () => normalizeReceiptTransferDestination('   ', OWNER),
    /Enter a destination address/,
  );
  assert.throws(
    () => normalizeReceiptTransferDestination('not-a-solana-address', OWNER),
    /Enter a valid Solana address/,
  );
  assert.throws(
    () => normalizeReceiptTransferDestination('11111111111111111111111111111111', OWNER),
    /other than the system address/,
  );
  assert.throws(
    () => normalizeReceiptTransferDestination(` ${OWNER} `, OWNER),
    /different from the current wallet/,
  );
});

test('receipt transfer target resolves one real owned certificate in the active receipt viewer', () => {
  const receipt = {
    id: RECEIPT_ASSET_ID,
    dropId: 'card_nft_2',
    name: 'Card receipt #7',
    kind: 'certificate' as const,
  };

  assert.equal(
    resolveReceiptTransferTarget({
      wallet: OWNER,
      inventoryOwner: OWNER,
      inventoryItems: [receipt],
      viewerMode: 'receipt-image',
      viewerSize: 'receipt',
      dropId: receipt.dropId,
      receiptImages: [{ key: receipt.id }],
    }),
    receipt,
  );
});

test('receipt transfer target rejects grouped, synthetic, missing, non-certificate, and mismatched-drop viewers', () => {
  const receipt = {
    id: RECEIPT_ASSET_ID,
    dropId: 'card_nft_2',
    name: 'Card receipt #7',
    kind: 'certificate' as const,
  };
  const base = {
    wallet: OWNER,
    inventoryOwner: OWNER,
    inventoryItems: [receipt],
    viewerMode: 'receipt-image',
    viewerSize: 'receipt',
    dropId: receipt.dropId,
    receiptImages: [{ key: receipt.id }],
  };

  assert.equal(
    resolveReceiptTransferTarget({
      ...base,
      receiptImages: [{ key: receipt.id }, { key: OTHER_RECEIPT_ASSET_ID }],
    }),
    null,
  );
  assert.equal(
    resolveReceiptTransferTarget({
      ...base,
      receiptImages: [{ key: 'claimed-receipt-card_nft_2-7' }],
    }),
    null,
  );
  assert.equal(resolveReceiptTransferTarget({ ...base, inventoryItems: [] }), null);
  assert.equal(
    resolveReceiptTransferTarget({
      ...base,
      inventoryItems: [{ ...receipt, kind: 'dude' as const }],
    }),
    null,
  );
  assert.equal(resolveReceiptTransferTarget({ ...base, dropId: 'another_drop' }), null);
  assert.equal(resolveReceiptTransferTarget({ ...base, viewerSize: 'shipment' }), null);
});

test('receipt transfer target rejects disconnected and admin read-only inventory', () => {
  const receipt = {
    id: RECEIPT_ASSET_ID,
    dropId: 'card_nft_2',
    kind: 'certificate' as const,
  };
  const base = {
    wallet: OWNER,
    inventoryOwner: OWNER,
    inventoryItems: [receipt],
    viewerMode: 'receipt-image',
    viewerSize: 'receipt',
    dropId: receipt.dropId,
    receiptImages: [{ key: receipt.id }],
  };

  assert.equal(resolveReceiptTransferTarget({ ...base, wallet: null }), null);
  assert.equal(resolveReceiptTransferTarget({ ...base, inventoryOwner: DESTINATION }), null);
  assert.equal(resolveReceiptTransferTarget({ ...base, isAdminReadOnly: true }), null);
});

test('receipt transfer dialog renders its thumbnail above the title and omits debug details', () => {
  const markup = renderToStaticMarkup(
    createElement(Modal, {
      open: true,
      title: 'Transfer receipt',
      ariaLabel: 'Transfer receipt: Card receipt #7',
      titleAbove: createElement('img', {
        className: 'receipt-transfer-modal__thumbnail',
        src: '/receipt.webp',
        alt: '',
      }),
      onClose: () => undefined,
      showCloseButton: false,
      children: createElement(ReceiptTransferForm, {
        feePayer: OWNER,
        onTransfer: async () => undefined,
        onCancel: () => undefined,
      }),
    }),
  );

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /tabindex="-1"/);
  assert.match(markup, /data-overlay-scroll-allow=""/);
  assert.match(markup, /aria-label="Transfer receipt: Card receipt #7"/);
  assert.match(markup, /Transfer receipt/);
  assert.match(markup, /class="receipt-transfer-modal__thumbnail"/);
  assert.match(markup, /src="\/receipt.webp"/);
  const titleIndex = markup.indexOf('<div class="card__title">Transfer receipt</div>');
  const thumbnailIndex = markup.indexOf('class="receipt-transfer-modal__thumbnail"');
  assert.ok(titleIndex >= 0);
  assert.ok(thumbnailIndex >= 0);
  assert.ok(thumbnailIndex < titleIndex);
  assert.match(markup, /aria-label="Destination address"/);
  assert.match(markup, /placeholder="Destination address"/);
  assert.match(markup, /required=""/);
  assert.doesNotMatch(markup, /Receipt:/);
  assert.doesNotMatch(markup, /Network:/);
  assert.doesNotMatch(markup, /Fee-paying wallet:/);
  assert.match(markup, />Cancel<\/button>/);
  assert.match(markup, />OK<\/button>/);
});

test('a suspended modal is inert and hidden instead of exposing a second aria-modal dialog', () => {
  const markup = renderToStaticMarkup(
    createElement(Modal, {
      open: true,
      suspended: true,
      title: 'Underlying dialog',
      onClose: () => undefined,
      children: createElement('button', null, 'Underlying action'),
    }),
  );

  assert.match(markup, /inert=""/);
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /modal-overlay--suspended/);
  assert.doesNotMatch(markup, /aria-modal=/);
});
