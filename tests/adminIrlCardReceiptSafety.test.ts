import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_CARD_RECEIPT_CLAIM_ABSENCE_PROOF_MAX_AGE_MS,
  activeDirectCardReceiptClaimSignatures,
  adminIrlCardReceiptProofHasIdentity,
  classifyAdminIrlCardReceiptLookupError,
  classifyDirectCardReceiptClaimSubmission,
  classifyDirectCardReceiptClaimTransferVerificationError,
  directCardReceiptClaimHasRecipientLock,
  directCardReceiptClaimSubmissionProvesNoDelivery,
  resolveDirectCardReceiptClaimRecoveryAction,
  shouldKeepDirectCardReceiptClaimProcessing,
} from '../functions/src/adminIrlCardReceipt.ts';

test('Admin IRL card receipt lookup errors distinguish indexing, transient, and fatal failures', () => {
  assert.equal(classifyAdminIrlCardReceiptLookupError({ code: 'not-found' }), 'indexing');
  assert.equal(
    classifyAdminIrlCardReceiptLookupError({ code: 'unavailable', details: { status: 404 } }),
    'indexing',
  );
  assert.equal(classifyAdminIrlCardReceiptLookupError({ code: 'unavailable' }), 'transient');
  assert.equal(classifyAdminIrlCardReceiptLookupError({ code: 'resource-exhausted' }), 'transient');
  assert.equal(classifyAdminIrlCardReceiptLookupError({ code: 'deadline-exceeded' }), 'transient');
  assert.equal(classifyAdminIrlCardReceiptLookupError(new TypeError('fetch failed')), 'transient');
  assert.equal(
    classifyAdminIrlCardReceiptLookupError({
      code: 'unavailable',
      message: 'Helius asset error: unauthorized',
      details: { status: 401 },
    }),
    'fatal',
  );
  assert.equal(classifyAdminIrlCardReceiptLookupError(new Error('Missing HELIUS_API_KEY')), 'fatal');
  assert.equal(classifyAdminIrlCardReceiptLookupError({ code: 'failed-precondition' }), 'fatal');
});

test('Admin IRL card receipt proof waits for tree and root identity before validation', () => {
  assert.equal(adminIrlCardReceiptProofHasIdentity(null), false);
  assert.equal(adminIrlCardReceiptProofHasIdentity({}), false);
  assert.equal(adminIrlCardReceiptProofHasIdentity({ tree_id: 'tree' }), false);
  assert.equal(adminIrlCardReceiptProofHasIdentity({ root: 'root' }), false);
  assert.equal(adminIrlCardReceiptProofHasIdentity({ tree_id: 'tree', root: 'root' }), true);
  assert.equal(adminIrlCardReceiptProofHasIdentity({ treeId: 'tree', root: 'root' }), true);
});

test('direct card claim transfer verification distinguishes rejected proof from unresolved history', () => {
  assert.equal(classifyDirectCardReceiptClaimTransferVerificationError({ code: 'failed-precondition' }), 'rejected');
  assert.equal(
    classifyDirectCardReceiptClaimTransferVerificationError({ code: 'functions/failed-precondition' }),
    'rejected',
  );
  assert.equal(classifyDirectCardReceiptClaimTransferVerificationError({ code: 'unavailable' }), 'unresolved');
  assert.equal(classifyDirectCardReceiptClaimTransferVerificationError({ code: 'deadline-exceeded' }), 'unresolved');
  assert.equal(classifyDirectCardReceiptClaimTransferVerificationError(new TypeError('fetch failed')), 'unresolved');
});

test('direct card claim keeps only transfer signatures that may still have landed', () => {
  assert.deepEqual(
    activeDirectCardReceiptClaimSignatures({
      receiptTxs: ['legacy-unknown', 'terminal', 'submitted', 'terminal'],
      submissions: [
        { signature: 'terminal', status: 'not_landed' },
        { signature: 'submitted', status: 'submitted' },
      ],
    }),
    ['legacy-unknown', 'submitted'],
  );
  assert.deepEqual(
    activeDirectCardReceiptClaimSignatures({
      receiptTxs: ['legacy-unknown'],
      submissions: [],
    }),
    ['legacy-unknown'],
  );
});

test('direct card claim distinguishes proven non-landing from old expired history', () => {
  const nowMs = 1_000_000;
  const base = {
    currentBlockHeight: 501,
    lastValidBlockHeight: 500,
    submittedAtMs: nowMs - 90_000,
    nowMs,
  };
  assert.equal(classifyDirectCardReceiptClaimSubmission({ ...base, signatureStatus: 'missing' }), 'not_landed');
  assert.equal(directCardReceiptClaimSubmissionProvesNoDelivery({ ...base, signatureStatus: 'missing' }), true);
  assert.equal(
    classifyDirectCardReceiptClaimSubmission({
      ...base,
      signatureStatus: 'missing',
      currentBlockHeight: 500,
    }),
    'unresolved',
  );
  assert.equal(
    classifyDirectCardReceiptClaimSubmission({
      ...base,
      signatureStatus: 'missing',
      submittedAtMs: nowMs - DIRECT_CARD_RECEIPT_CLAIM_ABSENCE_PROOF_MAX_AGE_MS - 1,
    }),
    'expired_unverified',
  );
  assert.equal(
    classifyDirectCardReceiptClaimSubmission({
      ...base,
      signatureStatus: 'missing',
      currentBlockHeight: Number.NaN,
    }),
    'unresolved',
  );
  assert.equal(classifyDirectCardReceiptClaimSubmission({ ...base, signatureStatus: 'failed' }), 'not_landed');
  assert.equal(classifyDirectCardReceiptClaimSubmission({ ...base, signatureStatus: 'succeeded' }), 'unresolved');
  assert.equal(directCardReceiptClaimSubmissionProvesNoDelivery({ ...base, signatureStatus: 'failed' }), true);
  assert.equal(directCardReceiptClaimSubmissionProvesNoDelivery({ ...base, signatureStatus: 'succeeded' }), false);
});

test('direct card claim recovery prioritizes historical proof, exact ownership, or a safe wait', () => {
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'none',
      recipientOwnsReceipt: true,
      adminOwnsReceipt: false,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'none',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: true,
    }),
    'transfer',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'none',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: false,
    }),
    'wait',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'none',
      recipientOwnsReceipt: true,
      adminOwnsReceipt: true,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'verified',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: false,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'verified',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: true,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'unresolved',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: true,
    }),
    'wait',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'unresolved',
      recipientOwnsReceipt: true,
      adminOwnsReceipt: false,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'rejected',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: true,
    }),
    'transfer',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'expired_unverified',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: true,
    }),
    'transfer',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'expired_unverified',
      recipientOwnsReceipt: true,
      adminOwnsReceipt: false,
    }),
    'finalize',
  );
  assert.equal(
    resolveDirectCardReceiptClaimRecoveryAction({
      transferEvidence: 'expired_unverified',
      recipientOwnsReceipt: false,
      adminOwnsReceipt: false,
    }),
    'wait',
  );
});

test('direct card claim recovery preserves and repairs the first-recipient lock', () => {
  assert.equal(
    directCardReceiptClaimHasRecipientLock({ hasRecipient: true, receiptTxCount: 0 }),
    false,
  );
  assert.equal(
    directCardReceiptClaimHasRecipientLock({ hasRecipient: true, receiptTxCount: 1 }),
    true,
  );
  assert.equal(
    directCardReceiptClaimHasRecipientLock({ hasRecipient: false, receiptTxCount: 1 }),
    false,
  );
  assert.equal(
    shouldKeepDirectCardReceiptClaimProcessing({
      resumingPreviousProcessingClaim: true,
      recipientOwnershipConfirmed: false,
    }),
    true,
  );
  assert.equal(
    shouldKeepDirectCardReceiptClaimProcessing({
      resumingPreviousProcessingClaim: false,
      recipientOwnershipConfirmed: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepDirectCardReceiptClaimProcessing({
      resumingPreviousProcessingClaim: false,
      recipientOwnershipConfirmed: false,
    }),
    false,
  );
});
