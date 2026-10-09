import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { isDeepStrictEqual } from 'node:util';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import {
  normalizeDropBase,
  normalizeAndValidateDropId,
  readDeploymentDropRegistry,
  acquireDeploymentRegistryMutationLock,
} from './shared/deploymentRegistry.ts';
import { decodeBoxMinterConfigData } from '../shared/boxMinterConfigCodec.ts';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
} from '../shared/deploymentCore.ts';
import { BOX_MINTER_CONFIG_SEED } from '../shared/boxMinterProtocol.ts';
import type { DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { assertReceiptPoolRpcGenesisHash } from './deploy-receipt-pool.ts';
import { registerDeploymentCleanup } from './deploy-all-onchain.ts';
import { createScriptSolanaConnection, scriptSolanaRpcHost, type ScriptSolanaRpcOptions } from './shared/solanaRpcEnvironment.ts';
import {
  buildMintActivationTransaction, inspectMintActivationAttempt, readMintActivationJournal,
  validateMintActivationAttempt, writeMintActivationJournal,
  type ActivationAttempt, type ActivationChainState, type ActivationIdentity, type ActivationJournal,
} from './shared/mintActivationJournal.ts';
import type { MiNoteSmokeRecord } from './smoke-mi-note-devnet.ts';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function formatKnownDrops(knownDropIds: string[]): string {
  return knownDropIds.length ? knownDropIds.join(', ') : '(none)';
}

function startMintUsage(): string {
  return `Run:\n  npm run start-mint -- <dropId> [--manifest <path>] [--allow-mainnet] [--yes] [--smoke]\n`;
}

export type StartMintOptions = {
  dropId: string;
  manifestPath?: string;
  allowMainnet: boolean;
  yes: boolean;
  smoke: boolean;
};

export function parseStartMintArgs(argv: string[]): StartMintOptions {
  const [dropId, ...flags] = argv;
  if (!dropId || dropId.startsWith('-')) throw new Error(startMintUsage());
  let manifestPath: string | undefined;
  let allowMainnet = false;
  let yes = false;
  let smoke = false;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--manifest' && flags[index + 1] && !flags[index + 1].startsWith('-') && !manifestPath) manifestPath = path.resolve(flags[++index]);
    else if (flags[index] === '--allow-mainnet' && !allowMainnet) allowMainnet = true;
    else if (flags[index] === '--yes' && !yes) yes = true;
    else if (flags[index] === '--smoke' && !smoke) smoke = true;
    else throw new Error(startMintUsage());
  }
  const normalizedDropId = normalizeAndValidateDropId(dropId, 'requested dropId');
  if (smoke && normalizedDropId !== 'mi_note_cards_devnet') throw new Error('The controlled smoke test is devnet Mi Note only.');
  return { dropId: normalizedDropId, manifestPath, allowMainnet, yes, smoke };
}

export async function resolveDeploymentConfig(args: {
  root: string;
  requestedDropId: string;
}): Promise<{
  dropConfig: DeploymentRegistryDrop;
  knownDropIds: string[];
  registryLabel: string;
}> {
  const requestedDropId = normalizeAndValidateDropId(
    args.requestedDropId,
    'requested dropId',
  );
  const canonicalPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(canonicalPath);
  if (Object.values(registry.drops).some((drop) => drop.operationsConfig?.configId === requestedDropId)) {
    throw new Error('Operations configuration B must remain unstarted; activate its logical mint drop only.');
  }
  const knownDropIds = Object.keys(registry.drops).sort((left, right) =>
    left.localeCompare(right),
  );
  const dropConfig = Object.prototype.hasOwnProperty.call(
    registry.drops,
    requestedDropId,
  )
    ? registry.drops[requestedDropId]
    : undefined;
  if (!dropConfig) {
    throw new Error(
      `Drop ${requestedDropId} is not present in ${canonicalPath}.\n` +
        `Known deployed drops: ${formatKnownDrops(knownDropIds)}\n` +
        `Run npm run deploy-all-onchain -- ${requestedDropId} for this drop before start-mint.`,
    );
  }
  if (Object.values(registry.drops).some((drop) => drop.operationsConfig && drop.solanaCluster === dropConfig.solanaCluster &&
    drop.boxMinterProgramId === dropConfig.boxMinterProgramId &&
    drop.operationsConfig?.boxMinterConfigPda === dropConfig.boxMinterConfigPda)) {
    throw new Error('An operations configuration cannot be activated through a standalone registry alias.');
  }
  return {
    dropConfig,
    knownDropIds,
    registryLabel: canonicalPath,
  };
}

export async function verifyTwoConfigMintReadiness(
  drop: DeploymentRegistryDrop, manifestPath: string, options: { allowActiveMint?: boolean; rpcUrl?: string; root?: string } = {},
): Promise<void> {
  if (!drop.operationsConfig || drop.solanaCluster === 'testnet') throw new Error('Unsupported two-config activation.');
  const [{ verifyTwoConfigGateForDeployment }, { parseMiNoteDropManifest, verifyMiNoteDropManifest },
    { verifyMiNoteInventoryDrop }, { runDudeInventoryControl }, { verifyMiNoteMintResources, resolveMiNoteCollectionDelegates },
    { loadPreorderCollectionConfig }] = await Promise.all([
    import('./verify-two-config-programs.ts'), import('./shared/miNoteDropManifest.ts'),
    import('./shared/miNoteInventoryPreflight.ts'), import('./ops/dudeInventoryControl.ts'),
    import('./shared/miNoteMintResources.ts'), import('./shared/preorderCollectionConfig.ts'),
  ]);
  const manifest = parseMiNoteDropManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.sourcePreorder.preorderId !== drop.dropId || manifest.sourcePreorder.cluster !== drop.solanaCluster ||
    manifest.sourcePreorder.collection !== drop.collectionMint || manifest.packCount !== drop.maxSupply ||
    manifest.sha256 !== drop.inventoryManifest?.sha256 ||
    !isDeepStrictEqual(manifest.eligibleCardIds, drop.inventoryManifest.cardIds)) throw new Error('Activation manifest does not match the drop.');
  await verifyTwoConfigGateForDeployment({ cluster: drop.solanaCluster, rpcUrl: options.rpcUrl });
  await verifyMiNoteDropManifest(manifest);
  const state = await verifyMiNoteInventoryDrop(drop.dropId, manifest, options);
  const root = options.root ?? ROOT;
  const { config: collectionConfig } = await loadPreorderCollectionConfig({ root, collectionId: drop.dropId });
  const recordPath = path.join(root, 'releases', drop.dropId.replaceAll('_', '-'), 'deployment.json');
  const approvedCollectionDelegates = await resolveMiNoteCollectionDelegates(
    JSON.parse(readFileSync(recordPath, 'utf8')), drop, collectionConfig.authority);
  await verifyMiNoteMintResources({ drop, collectionConfig, mintStarted: state.mintStarted, minimumSlot: state.slot,
    approvedCollectionDelegates, connection: createScriptSolanaConnection({ cluster: drop.solanaCluster, root, explicitUrl: options.rpcUrl }) });
  const report = await runDudeInventoryControl(['status', '--drop', drop.dropId]);
  if (!('drops' in report)) throw new Error('Initialize the approved inventory before enabling minting.');
  const inventory = report.drops.find((entry) => entry.dropId === drop.dropId);
  if (!report.active || !inventory?.ready || !inventory.configMatches || !state.mintStarted &&
    (inventory.assigned !== 0 || inventory.available !== manifest.eligibleCardIds.length)) {
    throw new Error('Mint activation requires ready, conserved inventory, active Commerce, and unused stock before the first activation.');
  }
}

function boxMinterConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
}

function configuredBoxMinterConfigPda(programId: PublicKey, configured: unknown): PublicKey {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value ? new PublicKey(value) : boxMinterConfigPda(programId);
}

export function decodeStartMintMetadataBase(data: Uint8Array): string {
  const config = decodeBoxMinterConfigData(data, {
    validateItemsPerBox: false,
    decodeExtensions: false,
  });
  return normalizeBoxMinterMetadataBaseForComparison(config.uriBase);
}

export type StartMintDependencies = {
  resolveDeployment: typeof resolveDeploymentConfig;
  createConnection: (options: ScriptSolanaRpcOptions) => Connection;
  verifyReadiness: typeof verifyTwoConfigMintReadiness;
  promptPrivateKey: () => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  runSmoke: (options: { authority: Keypair; manifestPath?: string; rpcUrl?: string;
    confirm?: (summary: string) => Promise<boolean> }) => Promise<Pick<MiNoteSmokeRecord, 'runId' | 'status'>>;
  now: () => Date;
  log: (message: string) => void;
};

const defaults: StartMintDependencies = {
  resolveDeployment: resolveDeploymentConfig,
  createConnection: createScriptSolanaConnection,
  verifyReadiness: verifyTwoConfigMintReadiness,
  promptPrivateKey: () => promptMaskedInput('Existing mint authority private key (masked, memory only): '),
  confirm: promptYConfirmation,
  runSmoke: async (options) => (await import('./smoke-mi-note-devnet.ts')).runMiNoteDevnetSmoke(options),
  now: () => new Date(), log: (message) => console.log(message),
};

function simulationAccount(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Activation simulation is missing a role account.');
  const account = value as { data?: unknown; owner?: unknown; executable?: unknown };
  if (!Array.isArray(account.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string' ||
    typeof account.owner !== 'string' || account.executable !== false) throw new Error('Invalid simulated activation account.');
  return { data: Buffer.from(account.data[0], 'base64'), owner: new PublicKey(account.owner), executable: false };
}

export async function runStartMint(
  options: StartMintOptions & { root?: string }, overrides: Partial<StartMintDependencies> = {},
): Promise<{ dropId: string; cluster: SolanaCluster; active: boolean; alreadyActive: boolean;
  signature?: string; activationPath?: string; smoke?: ActivationJournal['smoke'] }> {
  const deps = { ...defaults, ...overrides };
  const root = options.root || ROOT;
  const requestedDropId = normalizeAndValidateDropId(options.dropId, 'requested dropId');
  const resolved = await deps.resolveDeployment({ root, requestedDropId });
  const drop = resolved.dropConfig;
  if (drop.dropId !== requestedDropId) throw new Error('Resolved mint drop identity does not match the requested drop.');
  const dual = Boolean(drop.operationsConfig);
  if (dual && (!options.manifestPath || drop.solanaCluster === 'testnet')) throw new Error('Two-config activation requires a manifest and a supported cluster.');
  if (dual && drop.solanaCluster === 'mainnet-beta' && !options.allowMainnet) throw new Error('Mainnet activation requires explicit --allow-mainnet.');
  if (options.smoke && (!dual || drop.dropId !== 'mi_note_cards_devnet' || drop.solanaCluster !== 'devnet')) {
    throw new Error('The controlled smoke test requires the Mi Note devnet two-config drop.');
  }
  const manifestPath = options.manifestPath ? path.resolve(root, options.manifestPath) : undefined;
  const manifestSource = dual ? readFileSync(manifestPath!, 'utf8') : undefined;
  const miNote = dual ? await Promise.all([import('./shared/miNoteDropManifest.ts'), import('./shared/miNoteInventoryPreflight.ts')]) : undefined;
  const manifest = manifestSource ? miNote![0].parseMiNoteDropManifest(JSON.parse(manifestSource)) : undefined;
  const connection = deps.createConnection({ cluster: drop.solanaCluster, root,
    explicitUrl: process.env.SOLANA_RPC_URL || (dual ? process.env.MI_NOTE_PREORDER_RPC_URL : undefined) });
  if (drop.solanaCluster !== 'testnet') {
    assertReceiptPoolRpcGenesisHash({ solanaCluster: drop.solanaCluster, genesisHash: await connection.getGenesisHash() });
  }
  const program = new PublicKey(drop.boxMinterProgramId);
  const mintConfig = configuredBoxMinterConfigPda(program, drop.boxMinterConfigPda);
  const addresses = [mintConfig, ...(drop.operationsConfig ? [new PublicKey(drop.operationsConfig.boxMinterConfigPda)] : [])];
  const validateAccounts = (accounts: readonly ({ data: Buffer; owner: PublicKey; executable: boolean } | null)[], slot: number): ActivationChainState => {
    if (accounts.length !== addresses.length || accounts.some((account) => !account || account.executable || !account.owner.equals(program))) {
      throw new Error('Mint activation role accounts are missing or owned by another program.');
    }
    if (dual) miNote![1].validateNewMiNoteDropConfigs(drop, manifest!, accounts.map((account) => account!.data), { allowActiveMint: true });
    const mint = decodeBoxMinterConfigData(accounts[0]!.data);
    if (!boxMinterMetadataBaseMatchesDrop(mint.uriBase, normalizeDropBase(drop.metadataBase), drop.metadataBaseAliases)) {
      throw new Error('Mint config metadata base differs from the selected drop.');
    }
    return { started: mint.started, minted: mint.minted, authority: new PublicKey(mint.admin).toBase58(), slot };
  };
  const readState = async (minimumSlot = 0) => {
    const read = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: 'finalized', minContextSlot: minimumSlot });
    if (!Number.isSafeInteger(read.context.slot) || read.context.slot < minimumSlot) throw new Error('Mint activation account read is stale.');
    return validateAccounts(read.value, read.context.slot);
  };
  let state = await readState();
  const identity: ActivationIdentity = {
    dropId: drop.dropId, cluster: drop.solanaCluster, programId: program.toBase58(), mintConfig: mintConfig.toBase58(), authority: state.authority,
    ...(drop.operationsConfig ? { operationsConfig: drop.operationsConfig.boxMinterConfigPda, manifestSha256: drop.inventoryManifest!.sha256 } : {}),
  };
  const activationPath = dual ? path.join(root, 'releases', drop.dropId.replaceAll('_', '-'), 'activation.json') : undefined;
  const release = acquireDeploymentRegistryMutationLock({ root, operation: `start-mint:${drop.dropId}` });
  const cleanup = registerDeploymentCleanup({ releaseDeploymentRegistryLock: release });
  let signer: Keypair | undefined;
  let retainedSecret: Uint8Array | undefined;
  try {
    const saved = activationPath ? readMintActivationJournal(activationPath, identity, deps.now()) : undefined;
    const journal: ActivationJournal = saved?.journal ?? { version: 2, ...identity,
      createdAt: deps.now().toISOString(), status: 'prepared', attempts: [] };
    let journalSource = saved?.source;
    let migrated = saved?.migrated ?? false;
    const persist = () => {
      if (activationPath) journalSource = writeMintActivationJournal(activationPath, journal, journalSource);
      migrated = false;
    };
    const requireJournalUnchanged = () => {
      if (activationPath && journalSource !== undefined && readFileSync(activationPath, 'utf8') !== journalSource) {
        throw new Error('Activation journal changed after review; no transaction was sent.');
      }
    };
    const confirm = (message: string) => options.yes ? Promise.resolve(true) : deps.confirm(message);
    const getSigner = async () => {
      if (!signer) {
        const parsed = parsePrivateKeyInput(await deps.promptPrivateKey());
        retainedSecret = parsed.secretKey;
        signer = Keypair.fromSecretKey(retainedSecret);
        if (signer.publicKey.toBase58() !== identity.authority) throw new Error('Signer does not match the configured mint authority.');
      }
      return signer;
    };
    const revalidate = async () => {
      const current = await deps.resolveDeployment({ root, requestedDropId });
      if (!isDeepStrictEqual(current.dropConfig, drop)) throw new Error('Mint deployment configuration changed after review.');
      if (dual) {
        if (readFileSync(manifestPath!, 'utf8') !== manifestSource) throw new Error('Activation manifest changed after review.');
        await deps.verifyReadiness(drop, manifestPath!, { allowActiveMint: true, rpcUrl: connection.rpcEndpoint, root });
      }
      state = await readState(state.slot);
      if (state.authority !== identity.authority) throw new Error('Mint authority changed after review.');
      return state;
    };
    const recordActive = () => {
      if (journal.status !== 'active' || !journal.activeState || migrated) {
        journal.status = 'active';
        journal.activeState = { slot: state.slot, verifiedAt: deps.now().toISOString() };
        persist();
      }
    };
    const resolveAttempt = (attempt: ActivationAttempt, status: Exclude<ActivationAttempt['status'], 'signed'>, slot: number) => {
      if (attempt.status === 'signed') {
        attempt.status = status;
        attempt.finalizedSlot = slot;
        attempt.resolvedAt = deps.now().toISOString();
        journal.status = state.started ? 'active' : 'prepared';
        if (state.started) journal.activeState = { slot: state.slot, verifiedAt: deps.now().toISOString() };
        persist();
      } else if (migrated) {
        journal.status = state.started ? 'active' : 'prepared';
        if (state.started) journal.activeState = { slot: state.slot, verifiedAt: deps.now().toISOString() };
        persist();
      }
    };
    const latestBlockhash = async () => {
      const latest = await connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: state.slot });
      if (!Number.isSafeInteger(latest.context.slot) || latest.context.slot < state.slot) throw new Error('Activation blockhash context is stale.');
      return latest;
    };
    const simulate = async (transaction: VersionedTransaction, signed: boolean, minimumSlot = state.slot) => {
      const simulated = await connection.simulateTransaction(transaction, { sigVerify: signed, commitment: 'finalized', minContextSlot: minimumSlot,
        accounts: { encoding: 'base64', addresses: addresses.map((address) => address.toBase58()) } });
      if (!Number.isSafeInteger(simulated.context.slot) || simulated.context.slot < minimumSlot) throw new Error('Activation simulation context is stale.');
      if (simulated.value.err) throw new Error(`start_mint simulation failed (${JSON.stringify(simulated.value.err)}); no new transaction was sent.`);
      if (!simulated.value.accounts) throw new Error('start_mint simulation omitted role state.');
      const expected = validateAccounts(simulated.value.accounts.map(simulationAccount), simulated.context.slot);
      if (!expected.started) throw new Error('start_mint simulation did not activate configuration A.');
      const fee = (await connection.getFeeForMessage(transaction.message, 'finalized')).value;
      if (!Number.isSafeInteger(fee) || Number(fee) < 0) throw new Error('Activation fee could not be verified.');
      deps.log(`start_mint simulation passed; ${drop.solanaCluster}; authority ${identity.authority}; mint config ${identity.mintConfig}; fee ${fee} lamports.`);
    };
    const sendSaved = async (attempt: ActivationAttempt) => {
      const transaction = validateMintActivationAttempt(attempt, identity);
      requireJournalUnchanged();
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
      if (signature !== attempt.signature) throw new Error('Activation RPC returned another signature; preserve the saved attempt.');
      const confirmation = await connection.confirmTransaction({ signature, blockhash: attempt.blockhash,
        lastValidBlockHeight: attempt.lastValidBlockHeight }, 'finalized');
      if (!Number.isSafeInteger(confirmation.context.slot) || confirmation.context.slot < state.slot) {
        throw new Error('Activation confirmation is stale; preserve the saved attempt.');
      }
      state = await readState(confirmation.context.slot);
      if (confirmation.value.err) {
        resolveAttempt(attempt, 'failed', confirmation.context.slot);
        throw new Error('Activation failed at finality; the failed attempt was archived. Rerun to review a fresh attempt.');
      }
      if (!state.started) throw new Error('Finalized activation is missing its active mint state.');
      await revalidate();
      resolveAttempt(attempt, 'finalized', confirmation.context.slot);
      recordActive();
      return signature;
    };

    deps.log(`Mint activation: ${drop.dropId}; ${drop.solanaCluster}; RPC host ${scriptSolanaRpcHost(connection.rpcEndpoint)}; program ${program.toBase58()}.`);
    let alreadyActive = state.started;
    let signature: string | undefined;
    const previous = journal.attempts.at(-1);
    if (previous) {
      const transaction = validateMintActivationAttempt(previous, identity);
      const outcome = await inspectMintActivationAttempt(connection, previous, readState, state);
      state = outcome.state;
      if ((previous.status === 'finalized' || previous.status === 'state-verified') && !state.started) {
        throw new Error('Saved activation and finalized mint state disagree; no replacement was signed.');
      }
      if (outcome.status === 'pending' && previous.status !== 'signed') {
        throw new Error('An archived attempt is not definitively resolved; preserve the journal.');
      }
      if (outcome.status !== 'pending') {
        resolveAttempt(previous, outcome.status, outcome.slot);
      } else {
        await revalidate();
        if (state.started) resolveAttempt(previous, 'state-verified', state.slot);
        else {
          await simulate(transaction, true);
          if (!await confirm(`Resend only the saved start_mint transaction ${previous.signature} on ${drop.solanaCluster}? Type y: `)) {
            return { dropId: drop.dropId, cluster: drop.solanaCluster, active: false, alreadyActive: false, activationPath };
          }
          await revalidate();
          const latest = await inspectMintActivationAttempt(connection, previous, readState, state);
          state = latest.state;
          if (latest.status !== 'pending') resolveAttempt(previous, latest.status, latest.slot);
          else signature = await sendSaved(previous);
        }
      }
    }

    await revalidate();
    if (state.started) {
      alreadyActive = signature === undefined;
      recordActive();
      deps.log(signature ? `start_mint finalized: ${signature}` : 'Mint configuration A is already active; no activation transaction was sent.');
    } else {
      if (journal.attempts.some((attempt) => attempt.status === 'signed')) throw new Error('An unresolved activation attempt must be reconciled before fresh signing.');
      if (migrated) persist();
      const previewBlockhash = await latestBlockhash();
      await simulate(buildMintActivationTransaction(identity, previewBlockhash.value.blockhash), false, previewBlockhash.context.slot);
      if (!await confirm(`Permanently enable minting for ${drop.dropId} on ${drop.solanaCluster}? Type y: `)) {
        return { dropId: drop.dropId, cluster: drop.solanaCluster, active: false, alreadyActive: false, activationPath };
      }
      const admin = await getSigner();
      await revalidate();
      if (state.started) {
        alreadyActive = true;
        recordActive();
      } else {
        const blockhashResult = await latestBlockhash();
        const latest = blockhashResult.value;
        const transaction = buildMintActivationTransaction(identity, latest.blockhash);
        await simulate(transaction, false, blockhashResult.context.slot);
        if (await connection.getBlockHeight('finalized') > latest.lastValidBlockHeight) {
          throw new Error('Refreshed activation expired during simulation; no transaction was signed. Rerun to simulate a fresh attempt.');
        }
        transaction.sign([admin]);
        const attempt: ActivationAttempt = { signature: bs58.encode(transaction.signatures[0]), ...latest,
          transactionBase64: Buffer.from(transaction.serialize()).toString('base64'), status: 'signed', signedAt: deps.now().toISOString() };
        validateMintActivationAttempt(attempt, identity);
        if (journal.attempts.some(previous => previous.signature === attempt.signature)) {
          throw new Error('RPC reused a previous activation blockhash; no new attempt was saved or sent. Retry with fresh RPC state.');
        }
        journal.attempts.push(attempt);
        journal.status = 'signed';
        persist();
        signature = await sendSaved(attempt);
        alreadyActive = false;
        deps.log(`start_mint finalized: ${signature}`);
      }
    }

    if (options.smoke) {
      if (journal.smoke) {
        if (journal.smoke.status === 'running' || journal.smoke.status === 'recovery-required') {
          throw new Error(journal.smoke.runId
            ? `Previous smoke requires standalone recovery: npm run smoke:mi-note-devnet -- --recover ${journal.smoke.runId}`
            : 'Previous smoke has an unresolved public record; inspect releases/mi-note-cards-devnet/smoke before retrying.');
        }
        deps.log(`Existing smoke ${journal.smoke.runId || ''}: ${journal.smoke.status}; no new smoke purchase was started.`);
      } else {
        const admin = await getSigner();
        await revalidate();
        if (!state.started) throw new Error('Smoke requires verified active minting.');
        journal.smoke = { status: 'running' };
        persist();
        try {
          const result = await deps.runSmoke({ authority: admin, manifestPath, rpcUrl: connection.rpcEndpoint,
            confirm: async (summary) => {
              const runId = /Recovery ID:\s*([0-9a-f-]{36})/i.exec(summary)?.[1];
              if (runId) { journal.smoke = { status: 'running', runId }; persist(); }
              deps.log(summary);
              return confirm('Run this controlled devnet smoke test? Type y: ');
            },
          });
          const status = result.status === 'passed' || result.status === 'recovered' || result.status === 'cancelled'
            ? result.status : 'recovery-required';
          journal.smoke = { runId: result.runId, status }; persist();
        } catch (error) {
          const runId = /--recover\s+([0-9a-f-]{36})/i.exec(error instanceof Error ? error.message : '')?.[1] || journal.smoke?.runId;
          journal.smoke = { status: 'recovery-required', ...(runId ? { runId } : {}) }; persist();
          throw error;
        }
      }
    }
    return { dropId: drop.dropId, cluster: drop.solanaCluster, active: true, alreadyActive,
      ...(signature ? { signature } : {}), ...(activationPath ? { activationPath } : {}), ...(journal.smoke ? { smoke: journal.smoke } : {}) };
  } finally {
    retainedSecret?.fill(0);
    cleanup.cleanup();
  }
}

async function main() {
  const result = await runStartMint(parseStartMintArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'Mint activation failed.');
    process.exitCode = 1;
  });
}
