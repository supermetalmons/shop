import {
  CommerceWriteConflict,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
} from './commerceRepository.js';
import {
  readCommerceRecord,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';

export async function mutateSubmissionJournal(args: {
  context: CommerceRepositoryContext;
  key: CommerceDocumentKey;
  phase: 'persist' | 'settle';
  createCleanupContext: () => CommerceRepositoryContext;
  plan: (document: CommerceDocumentRecord | null) => CommerceDocumentWriteData | undefined;
  isApplied: (document: CommerceDocumentRecord | null) => boolean;
}): Promise<void> {
  try {
    await runCommerceTransaction(args.context, async (transaction) => {
      const document = await readCommerceRecord(args.context, args.key, transaction);
      const updates = args.plan(document);
      if (updates) await transaction.update(args.key, updates);
    });
  } catch (error) {
    if (args.phase === 'persist' && error instanceof CommerceWriteConflict) throw error;
    try {
      const document = await readCommerceRecord(args.createCleanupContext(), args.key);
      if (args.isApplied(document)) return;
    } catch {}
    throw error;
  }
}
