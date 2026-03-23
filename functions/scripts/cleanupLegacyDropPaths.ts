import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FUNCTIONS_DEPLOYMENT } from '../src/config/deployment.ts';

type Mode = 'dry-run' | 'commit';

type CollectionCleanupStats = {
  scanned: number;
  deleted: number;
  wouldDelete: number;
  errors: number;
};

type DocCleanupStats = {
  scanned: number;
  deleted: number;
  wouldDelete: number;
  skipped: number;
  errors: number;
};

type Args = {
  mode: Mode;
  dropId: string;
};

function usage(): string {
  return [
    'Delete legacy root-level drop documents after drop partition migration.',
    '',
    'Usage:',
    '  npm run cleanup-legacy-drop-paths',
    '  npm run cleanup-legacy-drop-paths -- --dry-run',
    '  npm run cleanup-legacy-drop-paths -- --commit',
    '  npm run cleanup-legacy-drop-paths -- --commit --drop-id little_swag_boxes',
    '',
    'Notes:',
    '  - Default mode is --dry-run',
    '  - Requires Firestore Admin credentials (ADC / GOOGLE_APPLICATION_CREDENTIALS)',
  ].join('\n');
}

function normalizeDropId(raw: string): string {
  const value = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`Invalid drop id: ${raw}`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  let mode: Mode = 'dry-run';
  let dropId = normalizeDropId(FUNCTIONS_DEPLOYMENT.dropId);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--dry-run') {
      mode = 'dry-run';
      continue;
    }
    if (arg === '--commit') {
      mode = 'commit';
      continue;
    }
    if (arg === '--drop-id') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --drop-id');
      dropId = normalizeDropId(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  return { mode, dropId };
}

function printCollectionStats(label: string, stats: CollectionCleanupStats) {
  console.log(`${label}: scanned=${stats.scanned} deleted=${stats.deleted} wouldDelete=${stats.wouldDelete} errors=${stats.errors}`);
}

function printDocStats(label: string, stats: DocCleanupStats) {
  console.log(
    `${label}: scanned=${stats.scanned} deleted=${stats.deleted} wouldDelete=${stats.wouldDelete} skipped=${stats.skipped} errors=${stats.errors}`,
  );
}

async function countCollection(path: string): Promise<number> {
  const db = getFirestore();
  const snap = await db.collection(path).get();
  return snap.size;
}

async function countDoc(path: string): Promise<number> {
  const db = getFirestore();
  const snap = await db.doc(path).get();
  return snap.exists ? 1 : 0;
}

async function printParity(dropId: string, label: string): Promise<void> {
  const pairs: Array<{ name: string; legacy: string; scoped: string; type: 'collection' | 'doc' }> = [
    { name: 'boxAssignments', legacy: 'boxAssignments', scoped: `drops/${dropId}/boxAssignments`, type: 'collection' },
    { name: 'dudeAssignments', legacy: 'dudeAssignments', scoped: `drops/${dropId}/dudeAssignments`, type: 'collection' },
    { name: 'deliveryOrders', legacy: 'deliveryOrders', scoped: `drops/${dropId}/deliveryOrders`, type: 'collection' },
    { name: 'meta/dudePool', legacy: 'meta/dudePool', scoped: `drops/${dropId}/meta/dudePool`, type: 'doc' },
  ];

  console.log(`\n${label}`);
  for (const pair of pairs) {
    if (pair.type === 'collection') {
      const [legacy, scoped] = await Promise.all([countCollection(pair.legacy), countCollection(pair.scoped)]);
      console.log(`${pair.name}: legacy=${legacy} scoped=${scoped}`);
    } else {
      const [legacy, scoped] = await Promise.all([countDoc(pair.legacy), countDoc(pair.scoped)]);
      console.log(`${pair.name}: legacy=${legacy} scoped=${scoped}`);
    }
  }
}

async function cleanupLegacyCollection(path: string, mode: Mode): Promise<CollectionCleanupStats> {
  const db = getFirestore();
  const stats: CollectionCleanupStats = {
    scanned: 0,
    deleted: 0,
    wouldDelete: 0,
    errors: 0,
  };

  const snap = await db.collection(path).get();
  stats.scanned = snap.size;
  if (mode !== 'commit') {
    stats.wouldDelete = snap.size;
    return stats;
  }

  if (!snap.size) {
    return stats;
  }

  const BATCH_LIMIT = 450;
  let batch = db.batch();
  let opCount = 0;

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    opCount += 1;
    if (opCount >= BATCH_LIMIT) {
      try {
        await batch.commit();
        stats.deleted += opCount;
      } catch (err) {
        stats.errors += opCount;
        console.error(`[cleanup:${path}] batch delete failed`, err instanceof Error ? err.message : String(err));
      }
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    try {
      await batch.commit();
      stats.deleted += opCount;
    } catch (err) {
      stats.errors += opCount;
      console.error(`[cleanup:${path}] batch delete failed`, err instanceof Error ? err.message : String(err));
    }
  }

  return stats;
}

async function cleanupLegacyDoc(path: string, mode: Mode): Promise<DocCleanupStats> {
  const db = getFirestore();
  const stats: DocCleanupStats = {
    scanned: 0,
    deleted: 0,
    wouldDelete: 0,
    skipped: 0,
    errors: 0,
  };

  const ref = db.doc(path);
  const snap = await ref.get();
  if (!snap.exists) {
    stats.skipped = 1;
    return stats;
  }

  stats.scanned = 1;
  if (mode !== 'commit') {
    stats.wouldDelete = 1;
    return stats;
  }

  try {
    await ref.delete();
    stats.deleted = 1;
  } catch (err) {
    stats.errors = 1;
    console.error(`[cleanup:${path}] delete failed`, err instanceof Error ? err.message : String(err));
  }

  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'mons-shop';
  initializeApp({ projectId });

  console.log(`Mode: ${args.mode}`);
  console.log(`Project: ${projectId}`);
  console.log(`Drop id: ${args.dropId}`);

  await printParity(args.dropId, 'Parity before cleanup (legacy vs scoped):');
  console.log('');

  const boxStats = await cleanupLegacyCollection('boxAssignments', args.mode);
  const dudeStats = await cleanupLegacyCollection('dudeAssignments', args.mode);
  const deliveryStats = await cleanupLegacyCollection('deliveryOrders', args.mode);
  const metaStats = await cleanupLegacyDoc('meta/dudePool', args.mode);

  printCollectionStats('cleanup boxAssignments', boxStats);
  printCollectionStats('cleanup dudeAssignments', dudeStats);
  printCollectionStats('cleanup deliveryOrders', deliveryStats);
  printDocStats('cleanup meta/dudePool', metaStats);

  await printParity(args.dropId, 'Parity after cleanup (legacy vs scoped):');

  const totalErrors = boxStats.errors + dudeStats.errors + deliveryStats.errors + metaStats.errors;
  if (totalErrors > 0) {
    throw new Error(`Cleanup finished with ${totalErrors} error(s).`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
