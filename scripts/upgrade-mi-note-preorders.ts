import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { Keypair, PublicKey, type AccountInfo, type Connection, type VersionedTransaction } from '@solana/web3.js';
import { decodeBoxMinterConfigData } from '../shared/boxMinterConfigCodec.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import { acquireDeploymentRegistryMutationLock } from './shared/deploymentRegistry.ts';
import { registerDeploymentCleanup } from './deploy-all-onchain.ts';
import { createScriptSolanaConnection, scriptSolanaRpcHost } from './shared/solanaRpcEnvironment.ts';
import { validateNewMiNoteDropConfigs } from './shared/miNoteInventoryPreflight.ts';
import { verifyMiNoteMintResources } from './shared/miNoteMintResources.ts';
import { verifyTwoConfigGateForDeployment } from './verify-two-config-programs.ts';
import { MI_NOTE_CLUSTER_GENESIS, miNoteManifestDigest } from './shared/miNoteDropManifest.ts';
import {
  buildMiNoteUpgradeTransaction, createMiNoteUpgradeManifest, inspectMiNoteUpgradeAsset, loadMiNoteUpgradeSource,
  miNoteUpgradeCollectionFingerprint, PREORDER_UPGRADE_BATCH_SIZE, readMiNoteUpgradeJournal,
  validateMiNoteUpgradeAttempt, validateMiNoteUpgradeManifest, writeMiNoteUpgradeJson,
  type MiNoteUpgradeAttempt, type MiNoteUpgradeSource,
} from './shared/miNotePreorderUpgrade.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'npm run upgrade-mi-note-preorders -- <preorderId> --prepare <file> | --manifest <file> [--check | --write [--yes] [--allow-mainnet]]';

export type MiNotePreorderUpgradeOptions = {
  preorderId: string;
  preparePath?: string;
  manifestPath?: string;
  check: boolean;
  write: boolean;
  yes: boolean;
  allowMainnet: boolean;
  root?: string;
};

export function parseMiNotePreorderUpgradeArgs(argv: string[]): MiNotePreorderUpgradeOptions {
  const options: MiNotePreorderUpgradeOptions = { preorderId: argv[0], check: false, write: false, yes: false, allowMainnet: false };
  if (!['mi_note_cards_devnet', 'mi_note_cards'].includes(options.preorderId)) throw new Error(USAGE);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--prepare' && !options.preparePath && argv[index + 1] && !argv[index + 1].startsWith('--')) options.preparePath = argv[++index];
    else if (flag === '--manifest' && !options.manifestPath && argv[index + 1] && !argv[index + 1].startsWith('--')) options.manifestPath = argv[++index];
    else if (flag === '--check' && !options.check) options.check = true;
    else if (flag === '--write' && !options.write) options.write = true;
    else if (flag === '--yes' && !options.yes) options.yes = true;
    else if (flag === '--allow-mainnet' && !options.allowMainnet) options.allowMainnet = true;
    else throw new Error(USAGE);
  }
  if (Boolean(options.preparePath) === Boolean(options.manifestPath) || options.check && options.write ||
    options.preparePath && (options.check || options.write || options.yes || options.allowMainnet) ||
    (options.yes || options.allowMainnet) && !options.write) throw new Error(USAGE);
  return options;
}

export type MiNoteUpgradeDependencies = {
  loadSource: typeof loadMiNoteUpgradeSource;
  createConnection: (source: MiNoteUpgradeSource, root: string) => Connection;
  verifyPrograms: (source: MiNoteUpgradeSource, connection: Connection) => Promise<string>;
  verifyResources: (source: MiNoteUpgradeSource, read: Connection['getMultipleAccountsInfoAndContext'], minimumSlot: number) => Promise<void>;
  confirm: (summary: string) => Promise<boolean>;
  promptPrivateKey: () => Promise<string>;
  now: () => Date;
  log: (message: string) => void;
};

const defaults: MiNoteUpgradeDependencies = {
  loadSource: loadMiNoteUpgradeSource,
  createConnection: (source, root) => createScriptSolanaConnection({ cluster: source.config.cluster, root }),
  verifyPrograms: async (source, connection) => {
    const gate = await verifyTwoConfigGateForDeployment({ cluster: source.config.cluster as 'devnet' | 'mainnet-beta', rpcUrl: connection.rpcEndpoint });
    return miNoteManifestDigest(gate.target.programs.map(program => ({ name: program.name, programId: program.programId,
      loader: program.loader, programDataAddress: program.programDataAddress, deploymentSlot: program.deploymentSlot,
      sha256: program.sha256, bytes: program.bytes })).sort((left, right) => left.name.localeCompare(right.name)));
  },
  verifyResources: async (source, read, minimumSlot) => {
    const roles = await read([new PublicKey(source.drop.boxMinterConfigPda!), new PublicKey(source.drop.operationsConfig!.boxMinterConfigPda)], {
      commitment: 'finalized', minContextSlot: minimumSlot,
    });
    const configurations = roles.value.map(account => {
      if (!account || account.executable || account.owner.toBase58() !== source.drop.boxMinterProgramId) throw new Error('Upgrade role config is missing or has the wrong owner.');
      return account.data;
    });
    validateNewMiNoteDropConfigs(source.drop, source.inventory, configurations, { allowActiveMint: true });
    await verifyMiNoteMintResources({ connection: { getMultipleAccountsInfoAndContext: read }, drop: source.drop,
      collectionConfig: source.collectionConfig, approvedCollectionDelegates: source.approvedCollectionDelegates,
      mintStarted: decodeBoxMinterConfigData(configurations[0]).started, minimumSlot: roles.context.slot });
  },
  confirm: promptYConfirmation,
  promptPrivateKey: () => promptMaskedInput('Existing collection authority private key (masked, memory only): '),
  now: () => new Date(), log: message => console.log(message),
};

function simulatedAccount(value: unknown): AccountInfo<Buffer> | null {
  if (value === null) return null;
  const account = value as { data?: unknown; owner?: unknown; executable?: unknown; lamports?: unknown };
  if (!account || !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' || typeof account.owner !== 'string' || typeof account.executable !== 'boolean' ||
    !Number.isSafeInteger(account.lamports) || Number(account.lamports) < 0) throw new Error('Invalid simulated upgrade account.');
  const data = Buffer.from(account.data[0], 'base64');
  if (data.toString('base64') !== account.data[0]) throw new Error('Invalid simulated account encoding.');
  return { data, owner: new PublicKey(account.owner), executable: account.executable, lamports: Number(account.lamports), rentEpoch: 0 };
}

export async function runMiNotePreorderUpgrade(options: MiNotePreorderUpgradeOptions, overrides: Partial<MiNoteUpgradeDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  const root = options.root ?? ROOT;
  if (!['mi_note_cards_devnet', 'mi_note_cards'].includes(options.preorderId) ||
    Boolean(options.preparePath) === Boolean(options.manifestPath) || options.check && options.write ||
    options.preparePath && (options.check || options.write || options.yes || options.allowMainnet) ||
    (options.yes || options.allowMainnet) && !options.write) throw new Error(USAGE);
  if (options.write && options.preorderId === 'mi_note_cards' && !options.allowMainnet) throw new Error('Mainnet upgrades require explicit --allow-mainnet and a matching deployed public drop.');
  const manifestPath = path.resolve(root, options.preparePath ?? options.manifestPath!);
  if (options.preparePath && existsSync(manifestPath)) throw new Error('The reviewed upgrade manifest already exists; it will not be overwritten.');
  const manifestSource = options.manifestPath ? readFileSync(manifestPath, 'utf8') : undefined;
  let source = await deps.loadSource(root, options.preorderId);
  const connection = deps.createConnection(source, root);
  const genesis = MI_NOTE_CLUSTER_GENESIS[source.config.cluster as 'devnet' | 'mainnet-beta'];
  if (source.config.preorderId !== options.preorderId || await connection.getGenesisHash() !== genesis) throw new Error('Preorder upgrade selected the wrong identity or RPC cluster.');
  let slot = source.inventory.chain.slot;
  const advance = (value: number) => {
    if (!Number.isSafeInteger(value) || value < slot) throw new Error('Upgrade RPC returned stale finalized context.');
    slot = value;
  };
  const read: Connection['getMultipleAccountsInfoAndContext'] = async (keys, input) => {
    const minimum = Math.max(slot, typeof input === 'object' ? input.minContextSlot ?? 0 : 0);
    const result = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot: minimum });
    if (result.value.length !== keys.length || result.context.slot < minimum) throw new Error('Upgrade account read was incomplete or stale.');
    advance(result.context.slot);
    return result;
  };
  let programsSha256 = await deps.verifyPrograms(source, connection);
  await deps.verifyResources(source, read, slot);
  const readAssets = async () => {
    const states = new Map<number, ReturnType<typeof inspectMiNoteUpgradeAsset>>();
    for (let offset = 0; offset < source.assets.length; offset += 100) {
      const batch = source.assets.slice(offset, offset + 100);
      const result = await read(batch.map(asset => new PublicKey(asset.address)), { commitment: 'finalized', minContextSlot: slot });
      batch.forEach((asset, index) => states.set(asset.id, inspectMiNoteUpgradeAsset(result.value[index], asset, source)));
    }
    return states;
  };
  let states = await readAssets();
  let manifest = options.preparePath ? createMiNoteUpgradeManifest(source, programsSha256, slot, deps.now())
    : validateMiNoteUpgradeManifest(JSON.parse(manifestSource!), source, programsSha256);
  slot = Math.max(slot, manifest.sourceSlot);
  const requireManifestUnchanged = () => {
    if (manifestSource !== undefined && readFileSync(manifestPath, 'utf8') !== manifestSource) throw new Error('Upgrade manifest changed after review.');
  };
  const revalidate = async () => {
    requireManifestUnchanged();
    const fresh = await deps.loadSource(root, options.preorderId);
    programsSha256 = await deps.verifyPrograms(fresh, connection);
    validateMiNoteUpgradeManifest(manifest, fresh, programsSha256);
    source = fresh;
    await deps.verifyResources(source, read, slot);
    states = await readAssets();
    const last = await deps.loadSource(root, options.preorderId);
    validateMiNoteUpgradeManifest(manifest, last, programsSha256);
    source = last;
  };
  await revalidate();
  const simulate = async (cardIds: number[], saved?: MiNoteUpgradeAttempt) => {
    const batch = cardIds.map(id => manifest.assets.find(asset => asset.id === id)!);
    const keys = [...batch.map(asset => new PublicKey(asset.address)), new PublicKey(manifest.collection), new PublicKey(manifest.authority)];
    const before = await read(keys, { commitment: 'finalized', minContextSlot: slot });
    const assetStates = batch.map((asset, index) => inspectMiNoteUpgradeAsset(before.value[index], asset, source));
    const collectionSha256 = miNoteUpgradeCollectionFingerprint(before.value[batch.length]);
    if (!before.value.at(-1)) throw new Error('Upgrade fee payer account is missing.');
    let transaction: VersionedTransaction;
    let blockhash: { blockhash: string; lastValidBlockHeight: number };
    if (saved) { transaction = validateMiNoteUpgradeAttempt(saved, manifest); blockhash = saved; }
    else {
      if (assetStates.some(state => state.state !== 'original')) throw new Error('A batch asset changed to target metadata; recheck before preparing another attempt.');
      const latest = await connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: slot });
      advance(latest.context.slot); blockhash = latest.value;
      transaction = buildMiNoteUpgradeTransaction(manifest, cardIds, blockhash.blockhash);
    }
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: Boolean(saved), commitment: 'finalized', minContextSlot: slot,
      accounts: { encoding: 'base64', addresses: keys.map(key => key.toBase58()) } });
    advance(simulation.context.slot);
    if (simulation.value.err || simulation.value.accounts?.length !== keys.length) throw new Error(`Upgrade simulation failed for card IDs ${cardIds.join(', ')}.`);
    const after = simulation.value.accounts.map(simulatedAccount);
    const protectedBefore = batch.map((asset, index) => ({ id: asset.id, protectedSha256: assetStates[index].protectedSha256,
      sequence: assetStates[index].sequence?.toString() ?? null }));
    for (const [index, asset] of batch.entries()) {
      const updated = inspectMiNoteUpgradeAsset(after[index], asset, source);
      const original = assetStates[index];
      if (updated.state !== 'target' || updated.protectedSha256 !== original.protectedSha256 ||
        updated.sequence !== (original.sequence === null ? null : original.sequence + 1n)) throw new Error(`Simulation changed protected fields for card ${asset.id}.`);
    }
    if (miNoteUpgradeCollectionFingerprint(after[batch.length]) !== collectionSha256) throw new Error('Simulation changed the collection policy or metadata.');
    const fee = (await connection.getFeeForMessage(transaction.message, 'finalized')).value;
    if (!Number.isSafeInteger(fee) || fee === null || fee < 0 || fee > 100_000) throw new Error('Upgrade transaction fee is outside the approved bound.');
    const assetRentDelta = batch.reduce((total, _asset, index) => total + after[index]!.lamports - before.value[index]!.lamports, 0);
    const payerDelta = after.at(-1)!.lamports - before.value.at(-1)!.lamports;
    if (after[batch.length]!.lamports !== before.value[batch.length]!.lamports || payerDelta + assetRentDelta !== -fee) {
      throw new Error('Simulation lamport changes do not match metadata resizing and the transaction fee.');
    }
    return { transaction, blockhash, before: protectedBefore, collectionSha256, feeLamports: fee,
      simulationUnits: simulation.value.unitsConsumed ?? 0, assetRentDelta };
  };
  const remainingIds = () => manifest.assets.filter(asset => states.get(asset.id)!.state === 'original').map(asset => asset.id);
  const summary = () => ({ preorderId: manifest.preorderId, cluster: manifest.cluster, manifestSha256: manifest.sha256,
    totalAssets: manifest.assets.length, remainingAssets: remainingIds().length, convertedAssets: manifest.assets.length - remainingIds().length,
    finalizedSlot: slot, eligiblePublicCards: source.inventory.eligibleCardIds.length, availablePublicCards: source.available, assignedPublicCards: source.assigned });
  const journalPath = path.join(path.dirname(manifestPath), 'journal.json');
  const verificationPath = path.join(path.dirname(manifestPath), 'verification.json');
  deps.log(`Preorder upgrade: ${manifest.preorderId}; ${manifest.cluster}; RPC host ${scriptSolanaRpcHost(connection.rpcEndpoint)}; ${manifest.assets.length} assets.`);
  if (options.preparePath) {
    writeMiNoteUpgradeJson(manifestPath, manifest);
    return { mode: 'prepared', manifestPath, ...summary() };
  }
  const inspect = async (attempt: MiNoteUpgradeAttempt): Promise<'pending' | Exclude<MiNoteUpgradeAttempt['status'], 'signed'>> => {
    const status = async () => {
      const result = await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true });
      if (!Number.isSafeInteger(result.context.slot) || result.context.slot < slot || result.value.length !== 1) {
        throw new Error('Incomplete or stale upgrade signature history.');
      }
      const signature = result.value[0];
      if (signature?.confirmationStatus === 'finalized') {
        if (!Number.isSafeInteger(signature.slot)) throw new Error('Invalid finalized upgrade signature slot.');
        slot = Math.max(slot, signature.slot);
      }
      return result.value[0];
    };
    let found = await status();
    if (found?.confirmationStatus === 'finalized') return found.err ? 'failed' : 'finalized';
    if (attempt.cardIds.every(id => states.get(id)?.state === 'target')) return 'state-verified';
    if (found) return 'pending';
    const epoch = await connection.getEpochInfo({ commitment: 'finalized', minContextSlot: slot });
    advance(epoch.absoluteSlot);
    const valid = await connection.isBlockhashValid(attempt.blockhash, { commitment: 'finalized', minContextSlot: slot });
    advance(valid.context.slot);
    if (valid.value !== false || !Number.isSafeInteger(epoch.blockHeight) || epoch.blockHeight! <= attempt.lastValidBlockHeight) return 'pending';
    found = await status();
    if (found?.confirmationStatus === 'finalized') return found.err ? 'failed' : 'finalized';
    return found ? 'pending' : 'expired';
  };
  const verifyPreserved = async (attempt: MiNoteUpgradeAttempt, requireTarget: boolean) => {
    const collection = await read([new PublicKey(manifest.collection)], { commitment: 'finalized', minContextSlot: slot });
    if (miNoteUpgradeCollectionFingerprint(collection.value[0]) !== attempt.collectionSha256) throw new Error('Collection policy changed during the upgrade attempt.');
    for (const before of attempt.before) {
      const current = states.get(before.id)!;
      if (current.protectedSha256 !== before.protectedSha256 || requireTarget && current.state !== 'target') {
        throw new Error(`Card ${before.id} differs from its saved ownership/authority/plugin baseline; inspect before recovery.`);
      }
    }
  };
  if (options.check) {
    const saved = readMiNoteUpgradeJournal(journalPath, manifest, deps.now());
    slot = Math.max(slot, saved.journal.lastVerifiedSlot);
    await revalidate();
    const pending = saved.journal.attempts.find(attempt => attempt.status === 'signed');
    if (pending) {
      const outcome = await inspect(pending);
      await revalidate();
      if (outcome !== 'finalized' && outcome !== 'state-verified') throw new Error(`Upgrade journal has an ${outcome} attempt; use --write to reconcile its retained history.`);
      await verifyPreserved(pending, true);
    }
    if (remainingIds().length) throw new Error(`Upgrade is incomplete: ${remainingIds().length} assets still have preorder metadata.`);
    return { mode: 'check', complete: true, ...summary(), journalPresent: saved.source !== undefined,
      historicalPreservationVerified: saved.journal.attempts.filter(attempt => attempt.preservationVerifiedAtSlot !== undefined).length,
      pendingPreservationVerified: Boolean(pending) };
  }
  if (!options.write) {
    const simulations = [];
    const remaining = remainingIds();
    for (let offset = 0; offset < remaining.length; offset += PREORDER_UPGRADE_BATCH_SIZE) {
      const cardIds = remaining.slice(offset, offset + PREORDER_UPGRADE_BATCH_SIZE);
      const simulated = await simulate(cardIds);
      simulations.push({ cardIds, feeLamports: simulated.feeLamports, simulationUnits: simulated.simulationUnits, assetRentDelta: simulated.assetRentDelta });
    }
    return { mode: 'preview', ...summary(), simulations };
  }
  const release = acquireDeploymentRegistryMutationLock({ root, operation: `upgrade-preorders:${manifest.preorderId}` });
  const cleanup = registerDeploymentCleanup({ releaseDeploymentRegistryLock: release });
  let secret: Uint8Array | undefined;
  let signer: Keypair | undefined;
  try {
    const saved = readMiNoteUpgradeJournal(journalPath, manifest, deps.now());
    const journal = saved.journal;
    let journalSource = saved.source;
    slot = Math.max(slot, journal.lastVerifiedSlot);
    const persist = () => { journal.lastVerifiedSlot = slot; journalSource = writeMiNoteUpgradeJson(journalPath, journal, journalSource); };
    const unchanged = () => {
      requireManifestUnchanged();
      if (journalSource !== undefined && readFileSync(journalPath, 'utf8') !== journalSource) throw new Error('Upgrade journal changed after review.');
    };
    const resolve = async (attempt: MiNoteUpgradeAttempt, status: Exclude<MiNoteUpgradeAttempt['status'], 'signed'>) => {
      if (status === 'finalized' || status === 'state-verified') {
        await revalidate();
        await verifyPreserved(attempt, true);
        attempt.preservationVerifiedAtSlot = slot;
      }
      attempt.status = status; attempt.finalizedSlot = slot; persist();
    };
    const broadcast = async (attempt: MiNoteUpgradeAttempt) => {
      unchanged();
      const transaction = validateMiNoteUpgradeAttempt(attempt, manifest);
      try {
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
        if (signature !== attempt.signature) throw new Error('RPC returned a different upgrade signature.');
        await connection.confirmTransaction({ signature, blockhash: attempt.blockhash, lastValidBlockHeight: attempt.lastValidBlockHeight }, 'finalized');
      } catch { }
      await revalidate();
      const outcome = await inspect(attempt);
      if (outcome === 'pending') throw new Error(`Upgrade outcome is uncertain for ${attempt.signature}. Rerun the same manifest to recover the same signed bytes.`);
      await resolve(attempt, outcome);
      if (outcome === 'failed' || outcome === 'expired') throw new Error(`Upgrade attempt ${outcome}; history is preserved. Rerun to review a fresh attempt.`);
    };
    await revalidate();
    const pending = journal.attempts.find(attempt => attempt.status === 'signed');
    if (pending) {
      const outcome = await inspect(pending);
      if (outcome !== 'pending') await resolve(pending, outcome);
      else {
        await verifyPreserved(pending, false);
        const preview = await simulate(pending.cardIds, pending);
        deps.log(`Recover cards ${pending.cardIds.join(', ')}; same signature ${pending.signature}; fee ${preview.feeLamports} lamports.`);
        if (!options.yes && !await deps.confirm('Resend only this saved metadata-only transaction? Type y: ')) throw new Error('Cancelled; upgrade recovery history is retained.');
        await revalidate();
        const latest = await inspect(pending);
        if (latest !== 'pending') await resolve(pending, latest);
        else { await verifyPreserved(pending, false); await broadcast(pending); }
      }
    }
    if (journal.status === 'complete' && remainingIds().length) throw new Error('Completed upgrade and current asset metadata disagree.');
    while (remainingIds().length) {
      await revalidate();
      const cardIds = remainingIds().slice(0, PREORDER_UPGRADE_BATCH_SIZE);
      if (!cardIds.length) break;
      const preview = await simulate(cardIds);
      deps.log(`Cards ${cardIds.join(', ')}: metadata-only UpdateV1; payer ${manifest.authority}; fee ${preview.feeLamports} lamports (cap 100000); asset rent delta ${preview.assetRentDelta}; ${preview.simulationUnits} CU.`);
      if (!options.yes && !await deps.confirm(`Update these ${cardIds.length} existing NFTs on ${manifest.cluster}? Type y: `)) throw new Error('Cancelled; existing upgrade history is retained.');
      if (!signer) {
        const parsed = parsePrivateKeyInput(await deps.promptPrivateKey());
        secret = parsed.secretKey; signer = Keypair.fromSecretKey(secret);
        if (signer.publicKey.toBase58() !== manifest.authority) throw new Error('Signer is not the existing collection authority.');
      }
      await revalidate();
      const prepared = await simulate(cardIds);
      await revalidate();
      const collection = await read([new PublicKey(manifest.collection)], { commitment: 'finalized', minContextSlot: slot });
      if (miNoteUpgradeCollectionFingerprint(collection.value[0]) !== prepared.collectionSha256 || prepared.before.some(before =>
        states.get(before.id)!.state !== 'original' || states.get(before.id)!.protectedSha256 !== before.protectedSha256)) {
        throw new Error('Batch ownership or collection policy changed after simulation; recheck before signing.');
      }
      unchanged();
      if (await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: slot }) > prepared.blockhash.lastValidBlockHeight) throw new Error('Upgrade blockhash expired before signing; retry with fresh RPC state.');
      prepared.transaction.sign([signer]);
      const attempt: MiNoteUpgradeAttempt = { cardIds, before: prepared.before, collectionSha256: prepared.collectionSha256,
        ...prepared.blockhash, signature: bs58.encode(prepared.transaction.signatures[0]),
        transactionBase64: Buffer.from(prepared.transaction.serialize()).toString('base64'), signedAt: deps.now().toISOString(), status: 'signed' };
      validateMiNoteUpgradeAttempt(attempt, manifest);
      if (journal.attempts.some(previous => previous.signature === attempt.signature)) throw new Error('RPC reused an earlier upgrade signature; no new attempt was saved or sent.');
      journal.attempts.push(attempt); journal.status = 'running'; persist();
      await broadcast(attempt);
    }
    await revalidate();
    if (remainingIds().length || journal.attempts.some(attempt => attempt.status === 'signed')) throw new Error('Upgrade is not fully verified.');
    journal.status = 'complete'; persist();
    const report = { version: 1, ...summary(), checkedAt: deps.now().toISOString(), complete: true,
      metadataOnly: true, originalOrdersAndClaimsPreserved: true, publicInventoryExclusionsPreserved: true };
    if (!existsSync(verificationPath)) writeMiNoteUpgradeJson(verificationPath, report);
    else {
      const previous = JSON.parse(readFileSync(verificationPath, 'utf8'));
      if (previous.manifestSha256 !== manifest.sha256 || previous.complete !== true) throw new Error('Another verification report already exists; it was preserved.');
    }
    return { mode: 'write', ...report, journalPath, verificationPath };
  } finally { secret?.fill(0); cleanup.cleanup(); }
}

async function main() {
  const result = await runMiNotePreorderUpgrade(parseMiNotePreorderUpgradeArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error((error instanceof Error ? error.message : 'Preorder upgrade failed.').replace(/https?:\/\/[^\s"'<>]+/gi, url => scriptSolanaRpcHost(url)));
    process.exitCode = 1;
  });
}
