import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ARTIST_METADATA_MAX_PAGE_SIZE, parseArtistMetadataRequest, requireArtistMetadataScope, type ArtistMetadataEvidence, type ArtistMetadataPage, type ArtistMetadataRequest,
  type ArtistMetadataScope } from '../../shared/ethereum/artistMetadataMaintenance.ts';
import { MAINNET_111K_ARTISTS_SHA256 } from '../../shared/ethereum/mainnet111kArtists.ts';
import type { EthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { isRevealArtworkTokenId } from '../../shared/ethereum/revealMaintenance.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import { privateHatchPath } from '../ethereum-metadata/privateHatchPath.ts';
import { writeDurableJsonJournalAsync } from '../shared/durableJsonJournal.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';
import { runEthereumRevealControl } from './ethereumRevealControl.ts';

type Counts = { scanned: number; eggs: number; credited: number; published: number };
type Journal = {
  version: 1; scope: ArtistMetadataScope; after: string | null; scanComplete: boolean; pending: string[];
  conflicts: string[]; counts: Counts;
};
type Send = (request: ArtistMetadataRequest) => Promise<ArtistMetadataPage>;
type Dependencies = { deployment?: () => Promise<EthereumRevealDeployment | undefined>; send?: Send };
type ArtworkRequest = ArtistMetadataRequest & { action: 'apply' | 'verify'; limit: number };
type Paging = { limit: number; maxPages: number; parallel: number };
const MAX_PARALLEL = 4;
const usage = 'Usage: ethereum:artist-metadata <inspect|apply|verify> --deployment-id mainnet-v1 --journal PRIVATE_JSON' +
  ` [--write for apply] [--max-pages N] [--page-size 1..${ARTIST_METADATA_MAX_PAGE_SIZE}] [--parallel 1..${MAX_PARALLEL}]` +
  ' [--frozen-through-ms MS] [--later-cutoff] [--evidence PRIVATE_JSONL]';

function blankCounts(): Counts { return { scanned: 0, eggs: 0, credited: 0, published: 0 }; }

function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function parseJournal(source: string): Journal {
  const journal = JSON.parse(source) as Journal;
  if (journal.version !== 1 || typeof journal.scanComplete !== 'boolean' ||
    journal.after !== null && !isRevealArtworkTokenId(journal.after) || !Array.isArray(journal.pending) || !Array.isArray(journal.conflicts) ||
    ![...journal.pending, ...journal.conflicts].every(isRevealArtworkTokenId) ||
    new Set([...journal.pending, ...journal.conflicts]).size !== journal.pending.length + journal.conflicts.length || !journal.counts ||
    !Object.keys(blankCounts()).every(key => count(journal.counts[key as keyof Counts]))) throw new Error('Invalid artist metadata journal.');
  parseArtistMetadataRequest({ action: 'inspect', scope: journal.scope });
  return journal;
}

function optionalInteger(value: string | undefined, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return;
  if (!/^[1-9]\d*$/.test(value) || !count(Number(value)) || Number(value) > max) throw new Error(usage);
  return Number(value);
}

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
}

function loadScope(deployment: EthereumRevealDeployment | undefined, frozenThroughMs: number) {
  if (!deployment) throw new Error('Active 111k mainnet registry record is unavailable.');
  const scope: ArtistMetadataScope = {
    deploymentId: 'mainnet-v1', chainId: 1, contractAddress: deployment.contractAddress, metadataBaseUri: 'https://cdn.mons.shop/111k/',
    deploymentBlock: deployment.deploymentBlock, expectedRevision: deployment.revision, catalogRevision: deployment.catalogRevision!,
    catalogVersion: deployment.effectiveCatalogVersion!, catalogSha256: deployment.effectiveCatalogSha256!,
    mappingSha256: MAINNET_111K_ARTISTS_SHA256, operationId: `artist-${randomUUID().replaceAll('-', '')}`, frozenThroughMs,
  };
  parseArtistMetadataRequest({ action: 'inspect', scope });
  requireArtistMetadataScope(deployment, scope);
  return scope;
}

function validatePage(page: ArtistMetadataPage, request: ArtistMetadataRequest) {
  const statusIds = [...page.deferred, ...page.conflicts, ...page.records.map(row => row.tokenId)];
  const planned = request.action === 'plan' ? page.plannedTokenIds : undefined;
  const ids = planned ?? statusIds;
  const retryIds = request.retryTokenIds === undefined ? null : new Set(request.retryTokenIds);
  if (page.action !== request.action || Object.entries(request.scope).some(([key, value]) =>
    page.scope[key as keyof ArtistMetadataScope] !== value) || page.frozenThroughMs !== (request.frozenThroughMs ?? request.scope.frozenThroughMs) ||
    typeof page.started !== 'boolean' || ![page.scanned, page.eggs, page.credited, page.published].every(count) ||
    page.scanned > (request.limit ?? 0) || (request.action === 'plan'
      ? !Array.isArray(planned) || page.scanned !== planned.length || page.eggs + page.credited + page.published + statusIds.length !== 0 ||
        planned.some((id, index) => index > 0 && id <= planned[index - 1]) ||
        page.next !== (planned.length === request.limit ? planned.at(-1) : null)
      : page.plannedTokenIds !== undefined || page.scanned !== page.eggs + page.credited + page.published + page.deferred.length + page.conflicts.length) ||
    page.records.length !== (request.action === 'verify' ? page.eggs + page.credited : 0) ||
    page.records.some((row, index) => index > 0 && row.tokenId <= page.records[index - 1].tokenId) ||
    new Set(ids).size !== ids.length || !ids.every(id => isRevealArtworkTokenId(id) && id > (request.after ?? '') &&
      (!page.next || id <= page.next) && (!retryIds || retryIds.has(id))) ||
    page.next !== null && (!isRevealArtworkTokenId(page.next) || retryIds !== null || page.next <= (request.after ?? '') || page.scanned !== request.limit) ||
    retryIds && page.scanned !== retryIds.size ||
    ((request.action === 'start' || request.action === 'apply') && !page.started)) {
    throw new Error('Artist metadata maintenance returned an invalid scope, page, or count.');
  }
  return page;
}

async function call(send: Send, request: ArtistMetadataRequest) {
  for (let attempt = 0; ; attempt++) {
    try { return validatePage(await send(request), request); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/timed out|failed to fetch|disconnect|page capacity is busy|\b(?:502|503|504)\b/i.test(reason)) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
}

async function explicitPages(send: Send, request: ArtworkRequest, tokenIds: string[]): Promise<ArtistMetadataPage[]> {
  const work: Promise<ArtistMetadataPage>[] = [];
  for (let offset = 0; offset < tokenIds.length; offset += request.limit) {
    work.push(call(send, { ...request, after: null, retryTokenIds: tokenIds.slice(offset, offset + request.limit) }));
  }
  try { return await Promise.all(work); }
  catch (error) {
    await Promise.allSettled(work);
    throw error;
  }
}

async function scanPages(send: Send, request: ArtworkRequest, after: string | null, width: number) {
  if (width === 1) {
    const page = await call(send, { ...request, after });
    return { pages: [page], after: page.next };
  }
  const plan = await call(send, { ...request, action: 'plan', after, limit: request.limit * width });
  return { pages: await explicitPages(send, request, plan.plannedTokenIds!), after: plan.next };
}

function applySummary(journal: Journal) {
  return { scope: journal.scope, frozenThroughMs: journal.scope.frozenThroughMs, ...journal.counts,
    deferred: journal.pending.length, conflicts: journal.conflicts.length, scanComplete: journal.scanComplete,
    complete: journal.scanComplete && !journal.pending.length && !journal.conflicts.length };
}

function accumulate(counts: Counts, page: ArtistMetadataPage) {
  for (const key of Object.keys(counts) as Array<keyof Counts>) counts[key] += page[key];
}

async function apply(journal: Journal, send: Send, path: string, { limit, maxPages, parallel }: Paging) {
  const status = await call(send, { action: 'inspect', scope: journal.scope });
  if (!status.started) await call(send, { action: 'start', scope: journal.scope });
  const save = () => writeDurableJsonJournalAsync({ filePath: path, value: journal, mode: 'replace' });
  const request: ArtworkRequest = { scope: journal.scope, action: 'apply', limit };
  let pages = 0;
  let lastReport = Date.now();
  const report = () => {
    if (Date.now() - lastReport < 30_000) return;
    lastReport = Date.now();
    console.error(JSON.stringify({ event: 'artist_metadata_apply', ...journal.counts,
      deferred: journal.pending.length, conflicts: journal.conflicts.length }));
  };
  while (!journal.scanComplete && pages < maxPages) {
    const burst = await scanPages(send, request, journal.after, Math.min(parallel, maxPages - pages));
    journal.after = burst.after;
    journal.scanComplete = burst.after === null;
    for (const page of burst.pages) {
      journal.pending.push(...page.deferred);
      journal.conflicts.push(...page.conflicts);
      accumulate(journal.counts, page);
    }
    await save();
    pages += burst.pages.length;
    report();
  }
  for (let pass = 0; journal.scanComplete && journal.pending.length + journal.conflicts.length > 0 && pages < maxPages && pass < 5; pass++) {
    if (pass) await delay(Math.min(8_000, 1_000 * 2 ** pass));
    const pending = [...journal.pending, ...journal.conflicts];
    for (let offset = 0; pending.length > offset && pages < maxPages;) {
      const retryTokenIds = pending.slice(offset, offset + limit * Math.min(parallel, maxPages - pages));
      const attempted = new Set(retryTokenIds);
      const burst = await explicitPages(send, request, retryTokenIds);
      journal.pending = [...journal.pending.filter(tokenId => !attempted.has(tokenId)), ...burst.flatMap(page => page.deferred)];
      journal.conflicts = [...journal.conflicts.filter(tokenId => !attempted.has(tokenId)), ...burst.flatMap(page => page.conflicts)];
      for (const page of burst) accumulate(journal.counts, { ...page, scanned: 0 });
      await save();
      offset += retryTokenIds.length;
      pages += burst.length;
      report();
    }
  }
  const summary = { ...applySummary(journal), pages };
  if (!summary.complete && pages < maxPages) {
    throw new Error(`Artist metadata scan has ${summary.deferred} deferred and ${summary.conflicts} conflicted objects. Resume the same private journal.`);
  }
  return summary;
}

async function linkEvidence(temporary: string, evidence: string, recovered: ArtistMetadataEvidence[]) {
  if (!recovered.length) return link(temporary, evidence);
  recovered.sort((left, right) => left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0);
  const merged = `${temporary}.ordered`;
  const output = await open(merged, 'wx', 0o600);
  const input = createReadStream(temporary);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  let previous = '';
  const batch: string[] = [];
  const emit = async (tokenId: string, line: string) => {
    if (tokenId <= previous) throw new Error('Artist verification produced duplicate or unordered evidence.');
    previous = tokenId;
    batch.push(`${line}\n`);
    if (batch.length === 256) await output.writeFile(batch.splice(0).join(''));
  };
  const emitRecovered = async () => {
    const row = recovered[index++];
    await emit(row.tokenId, JSON.stringify(row));
  };
  try {
    for await (const line of lines) {
      const { tokenId } = JSON.parse(line) as ArtistMetadataEvidence;
      while (index < recovered.length && recovered[index].tokenId < tokenId) await emitRecovered();
      await emit(tokenId, line);
    }
    while (index < recovered.length) await emitRecovered();
    if (batch.length) await output.writeFile(batch.join(''));
    await output.sync();
    await link(merged, evidence);
  } finally {
    lines.close();
    input.destroy();
    await output.close();
    await rm(merged, { force: true });
  }
}

async function verify(scope: ArtistMetadataScope, send: Send, { limit, maxPages, parallel }: Paging, cutoff: number, evidence?: string) {
  const temporary = evidence && `${evidence}.${randomUUID()}.tmp`;
  if (evidence) await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
  const output = temporary ? await open(temporary, 'wx', 0o600) : null;
  const counts = blankCounts();
  const request: ArtworkRequest = { scope, action: 'verify', limit, frozenThroughMs: cutoff };
  const recovered: ArtistMetadataEvidence[] = [];
  let pending: string[] = [];
  let conflicts = 0;
  let pages = 0;
  let after: string | null = null;
  let lastReport = Date.now();
  const consume = async (page: ArtistMetadataPage, retry = false) => {
    conflicts += page.conflicts.length;
    pending.push(...page.deferred);
    accumulate(counts, retry ? { ...page, scanned: 0 } : page);
    if (output && page.records.length) {
      if (retry) recovered.push(...page.records);
      else await output.writeFile(page.records.map(row => JSON.stringify(row) + '\n').join(''));
    }
    if (Date.now() - lastReport >= 30_000) {
      lastReport = Date.now();
      console.error(JSON.stringify({ event: 'artist_metadata_verify', ...counts, deferred: pending.length, conflicts }));
    }
  };
  try {
    do {
      const burst = await scanPages(send, request, after, Math.min(parallel, maxPages - pages));
      after = burst.after;
      pages += burst.pages.length;
      for (const page of burst.pages) await consume(page);
    } while (after !== null && pages < maxPages);
    for (let pass = 0; pending.length && pages < maxPages && pass < 5; pass++) {
      if (pass) await delay(1_000 * 2 ** pass);
      const retry = pending;
      pending = [];
      for (let offset = 0; offset < retry.length;) {
        if (pages >= maxPages) { pending.push(...retry.slice(offset)); break; }
        const tokenIds = retry.slice(offset, offset + limit * Math.min(parallel, maxPages - pages));
        const burst = await explicitPages(send, request, tokenIds);
        for (const page of burst) await consume(page, true);
        offset += tokenIds.length;
        pages += burst.length;
      }
    }
    if (conflicts || pending.length) throw new Error(`Artist verification found ${conflicts} conflicts and ${pending.length} deferred objects.`);
    await output?.sync();
    if (temporary && evidence) await linkEvidence(temporary, evidence, recovered);
    return { scope, frozenThroughMs: cutoff, ...counts, deferred: pending.length, conflicts, pages, complete: after === null };
  } finally {
    await output?.close();
    if (temporary) await rm(temporary, { force: true });
  }
}

export async function artistMetadataMain(argv: string[], dependencies: Dependencies = {}) {
  const { positionals, values, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
    'deployment-id': { type: 'string' }, journal: { type: 'string' }, write: { type: 'boolean' }, 'page-size': { type: 'string' },
    'max-pages': { type: 'string' }, parallel: { type: 'string' }, 'later-cutoff': { type: 'boolean' }, 'frozen-through-ms': { type: 'string' },
    evidence: { type: 'string' },
  } });
  const options: string[] = tokens.flatMap(token => token.kind === 'option' ? [token.name] : []);
  const [command] = positionals;
  if (positionals.length !== 1 || !['inspect', 'apply', 'verify'].includes(command) || new Set(options).size !== options.length ||
    values['deployment-id'] !== 'mainnet-v1' || !values.journal?.trim() || Boolean(values.write) !== (command === 'apply') ||
    Boolean(values['later-cutoff'] || values.evidence) && command !== 'verify' ||
    values['frozen-through-ms'] !== undefined && values['later-cutoff'] ||
    command === 'inspect' && ['page-size', 'max-pages', 'parallel', 'frozen-through-ms'].some(key => options.includes(key))) throw new Error(usage);
  const path = privateHatchPath(values.journal);
  const evidence = values.evidence === undefined ? undefined : privateHatchPath(values.evidence);
  if (evidence === path) throw new Error('Use a distinct private path for artist verification evidence.');
  const limit = optionalInteger(values['page-size'], ARTIST_METADATA_MAX_PAGE_SIZE) ??
    (command === 'apply' ? 16 : ARTIST_METADATA_MAX_PAGE_SIZE);
  const paging = { limit, maxPages: optionalInteger(values['max-pages']) ?? Number.MAX_SAFE_INTEGER,
    parallel: optionalInteger(values.parallel, MAX_PARALLEL) ?? 1 };
  const now = Math.max(1, Date.now() - 1);
  const explicitCutoff = optionalInteger(values['frozen-through-ms'], now);
  const run = async () => {
    const source = await readOptional(path);
    if (!source && command === 'verify') throw new Error('Artist verification requires the original private journal.');
    const journal: Journal = source ? parseJournal(source) : {
      version: 1, scope: loadScope(await (dependencies.deployment?.() ??
        runEthereumRevealControl(['status', '--deployment-id', 'mainnet-v1']).then(value => value.deployments?.[0])), explicitCutoff ?? now),
      after: null, scanComplete: false, pending: [], conflicts: [], counts: blankCounts(),
    };
    if (journal.scope.mappingSha256 !== MAINNET_111K_ARTISTS_SHA256 || command === 'apply' &&
      explicitCutoff !== undefined && explicitCutoff !== journal.scope.frozenThroughMs) throw new Error('Resume the pinned artist map and cutoff.');
    if (command === 'apply' && !source) await writeDurableJsonJournalAsync({ filePath: path, value: journal, mode: 'create' });
    const cutoff = values['later-cutoff'] ? now : explicitCutoff ?? journal.scope.frozenThroughMs;
    const execute = async (send: Send) => {
      if (command === 'inspect') {
        const state = await call(send, { action: 'inspect', scope: journal.scope });
        return { ...applySummary(journal), started: state.started };
      }
      if (command === 'apply') return apply(journal, send, path, paging);
      parseArtistMetadataRequest({ scope: journal.scope, action: 'verify', after: null, limit, frozenThroughMs: cutoff });
      return verify(journal.scope, send, paging, cutoff, evidence);
    };
    if (dependencies.send) return execute(dependencies.send);
    return withEthereumRevealMaintenance(transport => {
      if (!transport.artistMetadata) throw new Error('Private artist metadata service is unavailable.');
      return execute(transport.artistMetadata);
    });
  };
  if (command !== 'apply') return run();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withMetadataLock(`${path}.lock`, run);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  artistMetadataMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
