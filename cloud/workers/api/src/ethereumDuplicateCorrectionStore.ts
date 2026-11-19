import type { DuplicateCorrectionDefinition } from '../../../../shared/ethereum/duplicateCorrection.js';
import type { DuplicateCorrectionCounts, DuplicateCorrectionLedgerResult } from '../../../../shared/ethereum/duplicateCorrectionLedger.js';
import { mixedAllocationHash } from '../../../../shared/ethereum/revealMixedAllocation.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { REVEAL_ARTWORK_COUNT, REVEAL_CATEGORIES, revealRandomInteger } from './ethereumRevealCatalog.js';
import type { EthereumRevealCatalogUpdateStore } from './ethereumRevealCatalogUpdateStore.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import { initializeDuplicateReplacementReads } from './ethereumRevealSlotOverrides.js';
import type { RevealSql } from './ethereumRevealStore.js';

type Action = 'inspect' | 'apply' | 'verify';
type Pools = DuplicateCorrectionLedgerResult['pools'];
type Receipt = { operation_id: string; definition_sha256: string; source_revision: number; activated_at_ms: number;
  replaced: number; protected_counts: string; mappings_sha256: string; before_json: string };
type State = 'free' | 'revealed' | 'reserved' | 'replaced';
type GroupPlan = { block: string; revealed: number; reserved: number; keptFree: number; toReplace: number[]; replaced: number; conflict: boolean };
type Painting = { id: number; free: number; wrong_origin: number; direct_revealed: number; direct_reserved: number;
  claimed: number; promised: number; replaced: number };
type Aggregate = Pick<DuplicateCorrectionLedgerResult, 'totals' | 'blocks' | 'pools'>;
type Swap = { painting: number; egg: number };
type Snapshot = { groups: GroupPlan[]; totals: DuplicateCorrectionCounts; blocks: DuplicateCorrectionLedgerResult['blocks'] };

const journal = 'reveal_duplicate_corrections';
const replacements = 'reveal_duplicate_replacements';

function counts(): DuplicateCorrectionCounts {
  return { groups: 0, paintings: 0, revealed: 0, reserved: 0, keptFree: 0, toReplace: 0, replaced: 0, conflicts: 0, extraRevealed: 0 };
}

function summarize(target: DuplicateCorrectionCounts, group: GroupPlan, size: number) {
  target.groups++;
  target.paintings += size;
  target.revealed += group.revealed;
  target.reserved += group.reserved;
  target.keptFree += group.keptFree;
  target.toReplace += group.toReplace.length;
  target.replaced += group.replaced;
  target.conflicts += Number(group.conflict);
  target.extraRevealed += Math.max(0, group.revealed - 1);
}

export class EthereumDuplicateCorrectionStore {
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T,
    private readonly catalog: EthereumRevealCatalogUpdateStore) {}

  private hasTable(table: string) {
    return this.sql.exec('SELECT 1 FROM sqlite_schema WHERE type=\'table\' AND name=?', table).toArray().length > 0;
  }

  private createSchema() {
    this.sql.exec(`CREATE TABLE ${journal} (
      operation_id TEXT PRIMARY KEY, definition_sha256 TEXT NOT NULL, source_revision INTEGER NOT NULL,
      activated_at_ms INTEGER NOT NULL, replaced INTEGER NOT NULL, protected_counts TEXT NOT NULL, mappings_sha256 TEXT NOT NULL, before_json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE ${replacements} (origin_category TEXT NOT NULL CHECK(origin_category='painting'),
      origin_asset_id INTEGER NOT NULL CHECK(origin_asset_id>0), egg_id INTEGER NOT NULL UNIQUE CHECK(egg_id>0),
      operation_id TEXT NOT NULL REFERENCES ${journal}(operation_id), PRIMARY KEY(origin_category,origin_asset_id))`);
    for (const table of [journal, replacements]) for (const action of ['UPDATE', 'DELETE']) {
      this.sql.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT,'Duplicate correction history is immutable'); END`);
    }
    initializeDuplicateReplacementReads(this.sql);
  }

  private receipt(): Receipt | undefined {
    if (!this.hasTable(journal)) return;
    const rows = this.sql.exec<Receipt>(`SELECT * FROM ${journal} LIMIT 2`).toArray();
    if (rows.length !== 1) throw new Error('Invalid duplicate correction journal.');
    return rows[0];
  }

  private scope(definition: DuplicateCorrectionDefinition, revision: number, committed: boolean) {
    const settings = this.catalog.reader.settings();
    if (!settings?.active_catalog_generation || !settings.allocation_base_generation || settings.catalog_revision < revision) {
      throw new Error('Duplicate correction catalog changed.');
    }
    const historical = committed && settings.catalog_revision > revision;
    if (!historical && (settings.catalog_revision !== revision || settings.effective_catalog_version !== definition.catalogVersion ||
      settings.effective_catalog_sha256 !== definition.manifestSha256)) throw new Error('Duplicate correction catalog changed.');
    const scope: EthereumRevealDeployment = JSON.parse(settings.deployment_json);
    if (scope.deploymentId !== definition.deploymentId || scope.chainId !== definition.chainId ||
      scope.contractAddress.toLowerCase() !== definition.contractAddress.toLowerCase() || scope.metadataBaseUri !== definition.metadataBaseUri ||
      scope.deploymentBlock !== definition.deploymentBlock || scope.catalogVersion !== definition.originCatalogVersion) {
      throw new Error('Duplicate correction deployment mismatch.');
    }
    if (!committed && (settings.candidate_catalog_generation || !this.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length ||
      !this.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE batch_id=? AND phase='complete' AND activated_at_ms IS NOT NULL",
        settings.active_catalog_generation).toArray().length || this.hasTable('owner_hatching_preparations') && this.sql.exec(
        "SELECT 1 FROM owner_hatching_preparations WHERE phase NOT IN ('complete','cancelled') LIMIT 1").toArray().length)) {
      throw new Error('Duplicate correction requires settled catalog operations.');
    }
    return { generation: settings.active_catalog_generation, historical };
  }

  private states(definition: DuplicateCorrectionDefinition, generation: string, applied: boolean) {
    const ids = definition.groups.flat();
    const hasBacking = this.hasTable('owner_hatching_ordinary_backing');
    const corrected = applied ? 'd.egg_id IS NOT NULL' : '0';
    const untouched = `o.token_id IS NULL AND NOT (${corrected})`;
    const activeBacking = hasBacking ? '(b.egg_id IS NOT NULL AND b.claimed_by IS NULL)' : '0';
    const rows = this.sql.exec<Painting>(`SELECT i.value AS id, f.slot IS NOT NULL AS free,
      (f.slot IS NOT NULL AND (f.origin_category!='painting' OR f.origin_asset_id!=i.value)) AS wrong_origin,
      (a.token_id IS NOT NULL AND ${untouched}) AS direct_revealed,
      (a.asset_id IS NOT NULL AND a.token_id IS NULL AND ${untouched}) AS direct_reserved,
      c.token_id IS NOT NULL AS claimed, ((g.asset_id IS NOT NULL AND c.token_id IS NULL) + ${activeBacking}) AS promised,
      ${corrected} AS replaced FROM json_each(?) i
      LEFT JOIN reveal_catalog_free f ON f.generation=? AND f.category='painting' AND f.asset_id=i.value
      LEFT JOIN assignments a ON a.category='painting' AND a.asset_id=i.value
      LEFT JOIN owner_hatching_slot_overrides o ON o.origin_category='painting' AND o.origin_asset_id=i.value
      LEFT JOIN owner_hatching_artwork_claims c ON c.category='painting' AND c.asset_id=i.value
      LEFT JOIN owner_hatching_grails g ON g.category='painting' AND g.asset_id=i.value
      ${hasBacking ? "LEFT JOIN owner_hatching_ordinary_backing b ON b.category='painting' AND b.asset_id=i.value" : ''}
      ${applied ? `LEFT JOIN ${replacements} d ON d.origin_category='painting' AND d.origin_asset_id=i.value` : ''}`,
    JSON.stringify(ids), generation).toArray();
    const states = new Map<number, State>();
    for (const row of rows) {
      if (row.wrong_origin || row.free + row.direct_revealed + row.direct_reserved + row.claimed + row.promised + row.replaced !== 1 ||
        states.has(row.id)) throw new Error('Duplicate painting location is inconsistent.');
      let state: State = 'free';
      if (row.replaced) state = 'replaced';
      else if (row.direct_revealed || row.claimed) state = 'revealed';
      else if (row.direct_reserved || row.promised) state = 'reserved';
      states.set(row.id, state);
    }
    if (states.size !== ids.length) throw new Error('Duplicate painting group inventory is incomplete.');
    return states;
  }

  private snapshot(definition: DuplicateCorrectionDefinition, generation: string, applied: boolean): Snapshot {
    const states = this.states(definition, generation, applied);
    const lookup = revealCollectionBlocks(definition);
    const totals = counts();
    const byBlock = new Map<string, DuplicateCorrectionCounts>();
    const groups = definition.groups.map(ids => {
      const block = lookupRevealCollectionBlock(lookup, 'painting', ids[0]);
      if (ids.length < 2 || !block || ids.some(id => lookupRevealCollectionBlock(lookup, 'painting', id) !== block)) {
        throw new Error('Invalid duplicate collection block.');
      }
      const revealed = ids.filter(id => states.get(id) === 'revealed').length;
      const reserved = ids.filter(id => states.get(id) === 'reserved').length;
      const replaced = ids.filter(id => states.get(id) === 'replaced').length;
      const free = ids.filter(id => states.get(id) === 'free');
      const keptFree = Number(!revealed && !reserved && free.length > 0);
      const group = { block, revealed, reserved, replaced, keptFree, toReplace: free.slice(keptFree),
        conflict: reserved > 0 && revealed + reserved > 1 };
      if (!revealed && !reserved && !free.length) throw new Error('Duplicate painting group lost its final artwork.');
      const blockCounts = byBlock.get(block) ?? counts();
      byBlock.set(block, blockCounts);
      summarize(blockCounts, group, ids.length);
      summarize(totals, group, ids.length);
      return group;
    });
    return { groups, totals, blocks: Array.from(byBlock, ([block, counts]) => ({ block, counts })) };
  }

  private availableEggs(definition: DuplicateCorrectionDefinition, count: number, generation: string) {
    const inventory = this.catalog.reader.requireFreshEggInventory(count);
    const past = this.sql.exec<{ id: number }>(`SELECT i.value AS id FROM json_each(?) i WHERE
      EXISTS(SELECT 1 FROM reveal_catalog_free f WHERE f.generation=? AND f.category='egg' AND f.asset_id=i.value) OR
      EXISTS(SELECT 1 FROM assignments a WHERE a.category='egg' AND a.asset_id=i.value) OR
      EXISTS(SELECT 1 FROM owner_hatching_tokens t WHERE t.egg_id=i.value) OR
      EXISTS(SELECT 1 FROM owner_hatching_slot_overrides o WHERE o.category='egg' AND o.asset_id=i.value) OR
      EXISTS(SELECT 1 FROM reveal_catalog_mappings m WHERE m.egg_id=i.value)`, JSON.stringify(definition.eggCandidates), generation).toArray();
    for (const row of past) inventory.used.add(row.id);
    const candidates = definition.eggCandidates.filter(id => Number.isSafeInteger(id) && id > inventory.lastIssued && id <= inventory.maximum && !inventory.used.has(id));
    if (new Set(candidates).size !== candidates.length || candidates.length < count) throw new Error('Insufficient checked unused egg media.');
    return candidates;
  }

  private pools(): Pools {
    const pools = this.catalog.reader.pools();
    if (pools.length !== REVEAL_CATEGORIES.length || pools.some(p => p.total !== p.seeded || p.available > p.total) ||
      pools.reduce((n, p) => n + p.total, 0) !== REVEAL_ARTWORK_COUNT) throw new Error('Invalid duplicate correction pool totals.');
    return pools.map(({ category, total, available }) => ({ category, total, available }));
  }

  private verifyMappings(receipt: Receipt) {
    const rows = this.sql.exec<Swap>(`SELECT origin_asset_id AS painting,egg_id AS egg FROM ${replacements}
      WHERE operation_id=? ORDER BY origin_asset_id`, receipt.operation_id).toArray();
    if (rows.length !== receipt.replaced || mixedAllocationHash(rows.map(row => [row.painting, row.egg])) !== receipt.mappings_sha256) {
      throw new Error('Duplicate correction mapping proof failed.');
    }
  }

  private verifyReceipt(receipt: Receipt, plan: Snapshot) {
    const baseline: number[] = JSON.parse(receipt.protected_counts);
    if (plan.totals.replaced !== receipt.replaced || plan.totals.toReplace || plan.totals.conflicts ||
      baseline.length !== plan.groups.length || plan.groups.some((g, i) => g.revealed < baseline[i] ||
        g.revealed > Math.max(1, baseline[i]))) throw new Error('Duplicate correction verification failed.');
    this.verifyMappings(receipt);
  }

  private expectedAfter(before: Aggregate): Aggregate {
    const finish = (value: DuplicateCorrectionCounts): DuplicateCorrectionCounts => ({ ...value, toReplace: 0, replaced: value.toReplace });
    const pools = before.pools.map(pool => {
      const delta = pool.category === 'egg' ? before.totals.toReplace : pool.category === 'painting' ? -before.totals.toReplace : 0;
      return { category: pool.category, total: pool.total + delta, available: pool.available + delta };
    });
    return { totals: finish(before.totals), blocks: before.blocks.map(({ block, counts }) => ({ block, counts: finish(counts) })), pools };
  }

  private commit(definition: DuplicateCorrectionDefinition, digest: string, revision: number, generation: string, plan: Snapshot,
    before: Aggregate, eligible: number[]): Receipt {
    if (plan.totals.conflicts) throw new Error('Unrevealed commitments conflict with duplicate correction. Retry after they settle.');
    const swaps: Swap[] = [];
    for (const group of plan.groups) for (const painting of group.toReplace) {
      const index = revealRandomInteger(eligible.length);
      swaps.push({ painting, egg: eligible[index] });
      eligible[index] = eligible[eligible.length - 1];
      eligible.pop();
    }
    swaps.sort((a, b) => a.painting - b.painting);
    const receipt: Receipt = { operation_id: definition.operationId, definition_sha256: digest, source_revision: revision,
      activated_at_ms: Date.now(), replaced: swaps.length, protected_counts: JSON.stringify(plan.groups.map(g => g.revealed)),
      mappings_sha256: mixedAllocationHash(swaps.map(row => [row.painting, row.egg])), before_json: JSON.stringify(before) };
    this.createSchema();
    this.sql.exec(`INSERT INTO ${journal}(operation_id,definition_sha256,source_revision,activated_at_ms,replaced,protected_counts,
      mappings_sha256,before_json) VALUES(?,?,?,?,?,?,?,?)`, receipt.operation_id, digest, revision, receipt.activated_at_ms,
    receipt.replaced, receipt.protected_counts, receipt.mappings_sha256, receipt.before_json);
    for (const { painting, egg } of swaps) {
      this.catalog.replaceFreePaintingWithEgg({ category: 'painting', assetId: painting }, egg, () => {
        this.sql.exec(`INSERT INTO ${replacements}(operation_id,origin_category,origin_asset_id,egg_id) VALUES(?,'painting',?,?)`,
          definition.operationId, painting, egg);
      });
    }
    this.sql.exec('UPDATE settings SET catalog_revision=catalog_revision+1 WHERE id=1 AND catalog_revision=?', revision);
    this.scope(definition, revision + 1, true);
    const post = this.snapshot(definition, generation, true);
    this.verifyReceipt(receipt, post);
    const expected = this.expectedAfter(before);
    const actual = { totals: post.totals, blocks: post.blocks, pools: this.pools() };
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Duplicate correction inventory did not reconcile.');
    this.catalog.reader.verifyGeneration(generation);
    return receipt;
  }

  run(action: Action, definition: DuplicateCorrectionDefinition, definitionSha256: string, sourceCatalogRevision: number): DuplicateCorrectionLedgerResult {
    if (!Number.isSafeInteger(sourceCatalogRevision) || sourceCatalogRevision < 0 || definitionSha256 !== mixedAllocationHash(definition)) {
      throw new Error('Invalid duplicate correction identity.');
    }
    return this.transaction(() => {
      let receipt = this.receipt();
      if (receipt && (receipt.operation_id !== definition.operationId || receipt.definition_sha256 !== definitionSha256 ||
        receipt.source_revision !== sourceCatalogRevision)) throw new Error('Duplicate correction replay changed.');
      const { generation, historical } = this.scope(definition, sourceCatalogRevision + Number(Boolean(receipt)), Boolean(receipt));
      let aggregate: Aggregate;
      if (receipt && historical) {
        this.verifyMappings(receipt);
        aggregate = this.expectedAfter(JSON.parse(receipt.before_json) as Aggregate);
      } else {
        const plan = this.snapshot(definition, generation, Boolean(receipt));
        aggregate = { totals: plan.totals, blocks: plan.blocks, pools: this.pools() };
        if (receipt) {
          this.verifyReceipt(receipt, plan);
        } else {
          if (action === 'verify') throw new Error('Duplicate correction has not been applied.');
          const eligible = this.availableEggs(definition, plan.totals.toReplace, generation);
          const ordinaryCapacity = aggregate.pools.filter(p => p.category !== 'egg').reduce((n, p) => n + p.available, 0);
          if (ordinaryCapacity - plan.totals.toReplace < this.catalog.ownerHatching.reader.unbackedOrdinaryCount()) {
            throw new Error('Duplicate correction would exhaust pending ordinary hatch inventory.');
          }
          if (action === 'apply') {
            receipt = this.commit(definition, definitionSha256, sourceCatalogRevision, generation, plan, aggregate, eligible);
            aggregate = this.expectedAfter(aggregate);
          }
        }
      }
      if (action === 'verify') this.catalog.reader.verifyGeneration(generation);
      return { operationId: definition.operationId, definitionSha256, applied: Boolean(receipt),
        catalogRevision: sourceCatalogRevision + Number(Boolean(receipt)), appliedAtMs: receipt?.activated_at_ms ?? null,
        ...(historical ? { historical: true } : {}), ...aggregate };
    });
  }
}
