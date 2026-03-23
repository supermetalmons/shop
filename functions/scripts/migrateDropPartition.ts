import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FUNCTIONS_DEPLOYMENT } from '../src/config/deployment.ts';

type Mode = 'dry-run' | 'commit';

type Stats = {
  scanned: number;
  copied: number;
  updated: number;
  skipped: number;
  wouldCopy: number;
  wouldUpdate: number;
  errors: number;
};

type Args = {
  mode: Mode;
  dropId: string;
};

function usage(): string {
  return [
    'Migrate legacy Firestore drop data into drop-scoped paths.',
    '',
    'Usage:',
    '  npm run migrate-drop-partition',
    '  npm run migrate-drop-partition -- --dry-run',
    '  npm run migrate-drop-partition -- --commit',
    '  npm run migrate-drop-partition -- --commit --drop-id little_swag_boxes',
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
  let dropId = normalizeDropId(FUNCTIONS_DEPLOYMENT.dropId || 'little_swag_boxes');

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

function makeStats(): Stats {
  return {
    scanned: 0,
    copied: 0,
    updated: 0,
    skipped: 0,
    wouldCopy: 0,
    wouldUpdate: 0,
    errors: 0,
  };
}

function printStats(label: string, stats: Stats) {
  console.log(
    `${label}: scanned=${stats.scanned} copied=${stats.copied} updated=${stats.updated} skipped=${stats.skipped} ` +
      `wouldCopy=${stats.wouldCopy} wouldUpdate=${stats.wouldUpdate} errors=${stats.errors}`,
  );
}

async function copyLegacyCollection(args: {
  mode: Mode;
  dropId: string;
  collection: 'boxAssignments' | 'dudeAssignments' | 'deliveryOrders';
}): Promise<Stats> {
  const { mode, dropId, collection } = args;
  const db = getFirestore();
  const stats = makeStats();

  const sourceSnap = await db.collection(collection).get();
  for (const doc of sourceSnap.docs) {
    stats.scanned += 1;
    const targetRef = db.doc(`drops/${dropId}/${collection}/${doc.id}`);
    try {
      const targetSnap = await targetRef.get();
      if (targetSnap.exists) {
        stats.skipped += 1;
        continue;
      }

      const data = doc.data();
      const payload =
        collection === 'deliveryOrders'
          ? { ...data, ...(typeof data?.dropId === 'string' && data.dropId ? {} : { dropId }) }
          : data;

      if (mode === 'commit') {
        await targetRef.set(payload);
        stats.copied += 1;
      } else {
        stats.wouldCopy += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[copy:${collection}] failed for ${doc.id}`, err instanceof Error ? err.message : String(err));
    }
  }

  return stats;
}

async function copyLegacyMetaDudePool(args: { mode: Mode; dropId: string }): Promise<Stats> {
  const { mode, dropId } = args;
  const db = getFirestore();
  const stats = makeStats();

  const sourceRef = db.doc('meta/dudePool');
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) return stats;

  stats.scanned += 1;
  const targetRef = db.doc(`drops/${dropId}/meta/dudePool`);
  try {
    const targetSnap = await targetRef.get();
    if (targetSnap.exists) {
      stats.skipped += 1;
      return stats;
    }

    if (mode === 'commit') {
      await targetRef.set(sourceSnap.data() || {});
      stats.copied += 1;
    } else {
      stats.wouldCopy += 1;
    }
  } catch (err) {
    stats.errors += 1;
    console.error('[copy:meta/dudePool] failed', err instanceof Error ? err.message : String(err));
  }

  return stats;
}

async function backfillClaimCodeDropId(args: { mode: Mode; dropId: string }): Promise<Stats> {
  const { mode, dropId } = args;
  const db = getFirestore();
  const stats = makeStats();
  const claimsSnap = await db.collection('claimCodes').get();

  for (const doc of claimsSnap.docs) {
    stats.scanned += 1;
    const data = doc.data() as any;
    if (typeof data?.dropId === 'string' && data.dropId.trim()) {
      stats.skipped += 1;
      continue;
    }

    try {
      if (mode === 'commit') {
        await doc.ref.set({ dropId }, { merge: true });
        stats.updated += 1;
      } else {
        stats.wouldUpdate += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[claimCodes] failed for ${doc.id}`, err instanceof Error ? err.message : String(err));
    }
  }

  return stats;
}

async function printParity(dropId: string) {
  const db = getFirestore();
  const paths: Array<{ legacy: string; scoped: string; label: string }> = [
    { legacy: 'boxAssignments', scoped: `drops/${dropId}/boxAssignments`, label: 'boxAssignments' },
    { legacy: 'dudeAssignments', scoped: `drops/${dropId}/dudeAssignments`, label: 'dudeAssignments' },
    { legacy: 'deliveryOrders', scoped: `drops/${dropId}/deliveryOrders`, label: 'deliveryOrders' },
  ];

  console.log('\nParity check (legacy vs scoped):');
  for (const path of paths) {
    const [legacySnap, scopedSnap] = await Promise.all([db.collection(path.legacy).get(), db.collection(path.scoped).get()]);
    console.log(`${path.label}: legacy=${legacySnap.size} scoped=${scopedSnap.size}`);
  }

  const [legacyMeta, scopedMeta] = await Promise.all([db.doc('meta/dudePool').get(), db.doc(`drops/${dropId}/meta/dudePool`).get()]);
  console.log(`meta/dudePool: legacy=${legacyMeta.exists ? 1 : 0} scoped=${scopedMeta.exists ? 1 : 0}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'mons-shop';
  initializeApp({ projectId });

  console.log(`Mode: ${args.mode}`);
  console.log(`Project: ${projectId}`);
  console.log(`Drop id: ${args.dropId}`);
  console.log('');

  const boxStats = await copyLegacyCollection({ mode: args.mode, dropId: args.dropId, collection: 'boxAssignments' });
  const dudeStats = await copyLegacyCollection({ mode: args.mode, dropId: args.dropId, collection: 'dudeAssignments' });
  const deliveryStats = await copyLegacyCollection({ mode: args.mode, dropId: args.dropId, collection: 'deliveryOrders' });
  const metaStats = await copyLegacyMetaDudePool({ mode: args.mode, dropId: args.dropId });
  const claimStats = await backfillClaimCodeDropId({ mode: args.mode, dropId: args.dropId });

  printStats('boxAssignments', boxStats);
  printStats('dudeAssignments', dudeStats);
  printStats('deliveryOrders', deliveryStats);
  printStats('meta/dudePool', metaStats);
  printStats('claimCodes.dropId', claimStats);

  await printParity(args.dropId);

  const totalErrors =
    boxStats.errors + dudeStats.errors + deliveryStats.errors + metaStats.errors + claimStats.errors;
  if (totalErrors > 0) {
    throw new Error(`Migration finished with ${totalErrors} error(s).`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
