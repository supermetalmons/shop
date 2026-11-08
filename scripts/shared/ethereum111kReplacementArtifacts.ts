import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ETHEREUM_REVEAL_DEPLOYMENTS_SQL, parseEthereumRevealDeployment } from '../../shared/ethereum/revealDeployment.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';
import { createAsyncD1MaintenanceQuery } from './asyncD1MaintenanceQuery.ts';
import type { CommerceAuthorityQuery } from './commerceD1Maintenance.ts';
import { inspect111kReleaseLocation, read111kReleaseLocation } from './ethereum111kReleaseLocations.ts';

export type ReplacementArtifactScope = { deploymentId: string; chainId: number; contractAddress: string; metadataBaseUri: string };
type Context = { oldDeployment: ReplacementArtifactScope; newDeployment: ReplacementArtifactScope; journalPath: string };
type Options = { write?: boolean; repositoryRoot?: string; homeRoot?: string; queryRetiredDeployments?: CommerceAuthorityQuery };
type Entry = { path: string; kind: 'file' | 'directory'; bytes?: number; sha256?: string };
type Target = { root: 'repository' | 'home' | 'release'; path: string; index: string; files: number; bytes: number; sha256: string };
type ReleaseLocation = { directory: string; manifestSha256: string };
type DocumentChange = { path: string; before: string; after: string; replacements: Array<{ before: string; after: string }> };
type ArtifactPlan = { version: 1; createdAt: string; oldDeployment: ReplacementArtifactScope; newDeployment: ReplacementArtifactScope;
  repositoryRoot: string; homeRoot: string; releaseDirectory: string; sourceRevision: string;
  artifacts: Target[]; documents: DocumentChange[]; preservedShared: string[] };
type ArtifactProgress = { version: 1; planSha256: string; complete: boolean; removed: string[] };
const repositoryDefault = fileURLToPath(new URL('../../', import.meta.url));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const contentHash = (filename: string) => digest(fs.readFileSync(filename));
const json = (filename: string): Record<string, any> => JSON.parse(fs.readFileSync(filename, 'utf8'));
const serialized = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const inside = (filename: string, directory: string) => filename === directory || filename.startsWith(`${directory}${path.sep}`);

function atomicWrite(filename: string, value: string, mode = 0o600) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', mode);
  try { fs.writeFileSync(handle, value); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, filename);
}

function noSymlinks(filename: string, allowMissing = false): boolean {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { assert.ok(!fs.lstatSync(current).isSymbolicLink(), `Refusing artifact symlink: ${current}`); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  return true;
}

function scope(value: ReplacementArtifactScope): ReplacementArtifactScope {
  assert.equal(value.chainId, 11155111, 'Only Sepolia replacement artifacts can be retired');
  assert.match(value.deploymentId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.match(value.contractAddress, /^0x[0-9a-f]{40}$/);
  assert.notEqual(value.contractAddress, `0x${'0'.repeat(40)}`);
  assert.equal(value.metadataBaseUri, `https://cdn.mons.shop/111k-sepolia/${value.deploymentId}/`);
  return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress, metadataBaseUri: value.metadataBaseUri };
}

function matches(data: Record<string, any>, expected: ReplacementArtifactScope) {
  return data.chainId === expected.chainId && data.contractAddress === expected.contractAddress
    && data.deploymentId === expected.deploymentId && (data.metadataBaseUri ?? data.metadataBaseURI) === expected.metadataBaseUri;
}

function requireScope(filename: string, expected: ReplacementArtifactScope) {
  noSymlinks(filename);
  assert.ok(matches(json(filename), expected), `Artifact identity does not match the retired deployment: ${filename}`);
}

function previousReleaseLocation(manifest: Record<string, any>, old: ReplacementArtifactScope,
  roots: { repository: string; home: string }, verifyContents = true): ReleaseLocation | undefined {
  const options = { repositoryRoot: roots.repository, homeRoot: roots.home };
  const recorded = read111kReleaseLocation(old, options);
  const directory = manifest.previousReleaseDirectory;
  const manifestSha256 = manifest.previousReleaseManifestSha256;
  assert.equal(directory === undefined, manifestSha256 === undefined, 'Previous release location binding is incomplete');
  const location = directory === undefined ? recorded : { directory, manifestSha256 };
  if (!location) return undefined;
  assert.ok(typeof location.directory === 'string' && path.isAbsolute(location.directory)
    && location.directory === path.resolve(location.directory), 'Previous release location must be canonical');
  assert.match(location.manifestSha256, /^[a-f0-9]{64}$/);
  if (recorded && directory !== undefined) {
    assert.equal(recorded.directory, location.directory, 'Recorded predecessor location changed after preparation');
    assert.equal(recorded.manifestSha256, location.manifestSha256, 'Recorded predecessor manifest changed after preparation');
  }
  if (noSymlinks(location.directory, true) && verifyContents) {
    const observed = inspect111kReleaseLocation(location.directory, old, options);
    assert.equal(observed.directory, location.directory, 'Previous release location changed');
    assert.equal(observed.manifestSha256, location.manifestSha256, 'Previous release manifest changed');
  }
  return location;
}

function children(directory: string) {
  if (!noSymlinks(directory, true)) return [];
  return fs.readdirSync(directory).sort().map(name => path.join(directory, name));
}

function publicationEvidence(directory: string): Record<string, any>[] {
  const reports = children(directory).filter(filename => path.basename(filename).startsWith('upload-')).map(filename => {
    assert.match(path.basename(filename), /^upload-(?:sepolia|mainnet)(?:-[a-z0-9]+)?\.json$/, `Unknown publication report: ${filename}`);
    noSymlinks(filename);
    return json(filename);
  });
  for (const filename of children(path.join(directory, 'uploads'))) {
    noSymlinks(filename);
    assert.match(path.basename(filename), /^(?:sepolia|mainnet)(?:-[a-z0-9]+)?\.jsonl$/, `Unknown publication journal: ${filename}`);
    const handle = fs.openSync(filename, 'r');
    const buffer = Buffer.alloc(4096);
    let length: number;
    try { length = fs.readSync(handle, buffer); } finally { fs.closeSync(handle); }
    const end = buffer.subarray(0, length).indexOf('\n');
    assert.ok(end >= 0, `Incomplete publication journal header: ${filename}`);
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    const root = header.network === 'mainnet' ? '111k/' : header.network === 'sepolia' ? '111k-sepolia/' : undefined;
    reports.push({ ...header, prefix: header.prefix ?? root });
  }
  for (const snapshotDirectory of children(path.join(directory, 'snapshots'))) {
    noSymlinks(snapshotDirectory);
    assert.ok(fs.lstatSync(snapshotDirectory).isDirectory(), `Unknown metadata snapshot: ${snapshotDirectory}`);
    const manifest = path.join(snapshotDirectory, 'manifest.json');
    const snapshot = noSymlinks(manifest, true) ? json(manifest) : {};
    reports.push(path.basename(snapshotDirectory) === 'mainnet' ? { network: 'mainnet' }
      : { network: snapshot.network, prefix: snapshot.prefix, bucket: snapshot.destination?.bucket });
  }
  return reports;
}

function retiredMetadataOwners(current: ReplacementArtifactScope, query: CommerceAuthorityQuery) {
  let owners: Promise<ReadonlySet<string>> | undefined;
  return () => owners ??= (async () => {
    const rows = await query(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE retired_at_ms IS NOT NULL`);
    assert.ok(Array.isArray(rows), 'Invalid retired metadata ownership response');
    const retired = new Set<string>();
    for (const row of rows) {
      const deployment = parseEthereumRevealDeployment(row);
      assert.ok(deployment.chainId === 11155111 && deployment.dropId === '111k_devnet'
        && deployment.state === 'paused' && Number.isSafeInteger(deployment.retiredAtMs) && deployment.retiredAtMs! > 0,
      'Metadata cache ownership requires a permanent Sepolia retirement marker');
      if (deployment.deploymentId !== current.deploymentId && deployment.contractAddress !== current.contractAddress
        && deployment.metadataBaseUri !== current.metadataBaseUri) retired.add(deployment.metadataBaseUri);
    }
    return retired;
  })();
}

function checkReplacementPublicationDependencies(roots: { repository: string }, current: ReplacementArtifactScope,
  releaseDirectory: string, targets: string[]) {
  const revealManifests = [path.join(releaseDirectory, 'reveal-manifest.json')];
  if (releaseDirectory === path.join(roots.repository, `.cache/111k-${current.deploymentId}-release/contract`)) {
    revealManifests.push(path.join(path.dirname(releaseDirectory), 'reveal-manifest.json'));
  }
  for (const currentReveal of revealManifests) {
    if (!noSymlinks(currentReveal, true)) continue;
    const data = json(currentReveal);
    assert.ok(matches(data, current), 'Replacement reveal manifest identity changed');
    if (typeof data.publicationDirectory === 'string') {
      const required = path.resolve(path.dirname(currentReveal), data.publicationDirectory);
      noSymlinks(required, true);
      assert.ok(!targets.some(target => inside(required, target)),
        'Replacement still requires an old metadata cache; record its shared publication ownership before retirement');
    }
  }
}

function snapshot(filename: string): Entry[] {
  const entries: Entry[] = [];
  const visit = (current: string, relative: string) => {
    const stat = fs.lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), `Refusing artifact symlink: ${current}`);
    if (stat.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
    } else {
      assert.ok(stat.isFile(), `Refusing special artifact file: ${current}`);
      entries.push({ path: relative, kind: 'file', bytes: stat.size, sha256: contentHash(current) });
    }
  };
  visit(filename, '');
  return entries;
}

function targetPath(target: Pick<Target, 'root' | 'path'>, roots: { repository: string; home: string }, old: ReplacementArtifactScope,
  location?: ReleaseLocation) {
  if (target.root === 'release') {
    assert.ok(location && target.path === location.directory, 'Custom release target is not bound to the frozen predecessor');
    return location.directory;
  }
  assert.ok(target.root === 'repository' || target.root === 'home', 'Invalid artifact root');
  assert.ok(!path.isAbsolute(target.path) && target.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid artifact path');
  const parts = target.path.split('/');
  const id = old.deploymentId;
  const valid = target.root === 'home'
    ? /^\.mons-shop-backups\/ethereum111k(?:-acceptance|-proceeds-acceptance)?\/[^/]+\.json$/.test(target.path)
      || parts.length === 4 && parts[0] === '.mons-shop-backups' && parts[1] === '111k-metadata' && parts[3] === 'sepolia'
    : parts.length === 2 && parts[0] === 'releases' && /^111k-sepolia(?:-[a-z0-9-]+)?$/.test(parts[1])
      || parts.length === 2 && parts[0] === '.cache' && [
        `111k-${id}-release`, `111k-${id}-scenes`, `111k-${id}-live-ui`,
      ].includes(parts[1])
      || parts.length === 2 && parts[0] === '.cache' && parts[1].startsWith(`111k-${id}-live-ui-recheck-`)
        && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(parts[1].slice(`111k-${id}-live-ui-recheck-`.length))
      || parts.length === 3 && parts[0] === '.cache' && parts[1] === '111k-metadata'
      || parts.length === 4 && parts.slice(0, 3).join('/') === 'onchain/ethereum/.local' && parts[3] === `111k-sepolia-${id}`;
  assert.ok(valid, `Artifact is outside known replacement layouts: ${target.path}`);
  return path.join(roots[target.root], target.path);
}

function git(repository: string, args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim();
}

function filesOutsideTargets(repository: string, targets: string[]) {
  return git(repository, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).map(relative => ({ relative, absolute: path.join(repository, relative) }))
    .filter(file => fs.existsSync(file.absolute) && !targets.some(target => inside(file.absolute, target)));
}

export function uses111kMetadataNamespace(source: string, metadataBaseUri: string): boolean {
  for (let index = 0; index < source.length;) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    const quote = source[index++];
    if (!['"', "'", '`'].includes(quote)) continue;
    let value = '';
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\' && index + 1 < source.length) index++;
      value += source[index++];
    }
    if (source[index] === quote) index++;
    if (value === metadataBaseUri) return true;
  }
  return false;
}

function checkDependencies(repository: string, targets: string[], old: ReplacementArtifactScope, current: ReplacementArtifactScope) {
  const referencePaths = targets.map(target => inside(target, repository)
    ? path.relative(repository, target).split(path.sep).join('/') : target);
  const defaultConsumers = new Set(['shared/ethereum/config.ts', 'onchain/ethereum/script/Deploy111K.s.sol']);
  for (const file of filesOutsideTargets(repository, targets)) {
    if (!/\.(?:[cm]?js|tsx?|py|sol|jsonc?)$/.test(file.relative)
      || /^releases\/.*\.jsonc?$/.test(file.relative)
      || /(?:^|\/)(?:test|tests|__tests__|fixtures|migrations?|ops-migrations|commerce-migrations)(?:\/|\.)|\.test\./.test(file.relative)) continue;
    const content = fs.readFileSync(file.absolute, 'utf8');
    const usedPath = referencePaths.find(target => content.includes(target));
    const live = /^(?:src|shared)\//.test(file.relative) || /^cloud\/workers\/[^/]+\/(?:src\/|wrangler\.jsonc$)/.test(file.relative)
      || ['onchain/ethereum/scripts/deploy-local.mjs', 'onchain/ethereum/script/Deploy111K.s.sol'].includes(file.relative);
    assert.ok(!usedPath && !(live && uses111kMetadataNamespace(content, old.metadataBaseUri)),
      `Retired artifact is still required by ${file.relative}; move or update that dependency before retirement`);
    if (defaultConsumers.has(file.relative)) {
      assert.ok(uses111kMetadataNamespace(content, current.metadataBaseUri),
        `Update the supported metadata default in ${file.relative} to ${current.metadataBaseUri} before retirement`);
    }
  }
}

function documentChanges(repository: string, targets: string[], revision: string): DocumentChange[] {
  const changes: DocumentChange[] = [];
  let repositoryUrl: string | undefined;
  for (const file of filesOutsideTargets(repository, targets).filter(file => file.relative.endsWith('.md'))) {
    const before = fs.readFileSync(file.absolute, 'utf8');
    const replacements: DocumentChange['replacements'] = [];
    const after = before.replace(/\]\(([^\s)]+)\)/g, (match, reference: string) => {
      if (/^[a-z]+:/i.test(reference) || reference.startsWith('#')) return match;
      const [pathname, fragment] = reference.split('#', 2);
      const destination = path.resolve(path.dirname(file.absolute), pathname);
      if (!targets.some(target => inside(destination, target))) return match;
      assert.ok(inside(destination, repository), `Cannot pin an external artifact link in ${file.relative}`);
      const relative = path.relative(repository, destination).split(path.sep).join('/');
      let type: string;
      try { type = git(repository, ['cat-file', '-t', `${revision}:${relative}`]); }
      catch { throw new Error(`Cannot remove ${relative}: linked from ${file.relative} but absent from Git history`); }
      assert.ok(type === 'blob' || type === 'tree', `Unsupported Git link target: ${relative}`);
      if (!repositoryUrl) {
        const remote = git(repository, ['remote', 'get-url', 'origin']);
        const matchRemote = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?$/.exec(remote);
        assert.ok(matchRemote, 'Cannot pin historical links without a verified GitHub origin');
        repositoryUrl = `https://github.com/${matchRemote[1]}`;
      }
      const replacement = `](${repositoryUrl}/${type === 'tree' ? 'tree' : 'blob'}/${revision}/${relative}${fragment ? `#${fragment}` : ''})`;
      replacements.push({ before: match, after: replacement });
      return replacement;
    });
    if (replacements.length) changes.push({ path: file.relative, before: digest(before), after: digest(after), replacements });
  }
  return changes;
}

async function discover(roots: { repository: string; home: string }, old: ReplacementArtifactScope, current: ReplacementArtifactScope,
  releaseDirectory: string, retiredOwners: () => Promise<ReadonlySet<string>>, location?: ReleaseLocation, requirePrivateLocation = false) {
  const paths: Array<{ root: Target['root']; path: string }> = [];
  const preservedShared: string[] = [];
  let privateLocationKnown = Boolean(location);
  const add = (root: Target['root'], filename: string) => {
    const target = { root, path: root === 'release' ? filename : path.relative(roots[root], filename).split(path.sep).join('/') };
    targetPath(target, roots, old, location);
    noSymlinks(filename);
    assert.ok(!inside(releaseDirectory, filename), `Retired artifact contains the replacement release directory: ${filename}`);
    paths.push(target);
  };
  const publicReleases: string[] = [];
  for (const directory of children(path.join(roots.repository, 'releases'))) {
    if (!/^111k-sepolia(?:-[a-z0-9-]+)?$/.test(path.basename(directory))) continue;
    const identity = path.join(directory, 'deployment.json');
    if (!noSymlinks(identity, true)) continue;
    const data = json(identity);
    if (data.contractAddress === old.contractAddress || path.basename(directory) === `111k-sepolia-${old.deploymentId}`) {
      requireScope(identity, old);
      publicReleases.push(directory);
      add('repository', directory);
    }
  }
  for (const relative of [`.cache/111k-${old.deploymentId}-release`, `onchain/ethereum/.local/111k-sepolia-${old.deploymentId}`]) {
    const directory = path.join(roots.repository, relative);
    if (!noSymlinks(directory, true)) continue;
    const identity = [path.join(directory, 'contract/manifest.json'), path.join(directory, 'manifest.json')].find(filename => noSymlinks(filename, true));
    if (!identity && location && inside(location.directory, directory)) continue;
    assert.ok(identity, `Missing scoped release manifest: ${relative}`);
    requireScope(identity, old);
    privateLocationKnown = true;
    for (const name of ['operation.lock', 'cleanup-finalization.lock', 'cleanup-artifacts.lock']) {
      assert.ok(!noSymlinks(path.join(path.dirname(identity), name), true), `Old release operation lock remains: ${relative}/${name}`);
    }
    add('repository', directory);
  }
  if (location && noSymlinks(location.directory, true)
    && !paths.some(target => inside(location.directory, targetPath(target, roots, old, location)))) {
    for (const name of ['operation.lock', 'cleanup-finalization.lock', 'cleanup-artifacts.lock']) {
      assert.ok(!noSymlinks(path.join(location.directory, name), true), `Old release operation lock remains: ${location.directory}/${name}`);
    }
    add('release', location.directory);
  }
  assert.ok(!requirePrivateLocation || privateLocationKnown,
    'Previous private release location is unknown; record it with --previous-directory before finalizing');
  for (const directory of children(path.join(roots.repository, '.cache/111k-metadata'))) {
    noSymlinks(directory);
    if (!fs.lstatSync(directory).isDirectory()) continue;
    const publications = publicationEvidence(directory);
    const metadataUri = (publication: Record<string, any>) => `https://cdn.mons.shop/${publication.prefix}`;
    const candidates = publications.filter(publication => publication.network === 'sepolia'
      && publication.bucket === 'cdn-mons-shop' && /^111k-sepolia\/(?:[a-z0-9][a-z0-9-]{0,63}\/)?$/.test(publication.prefix)
      && metadataUri(publication) !== current.metadataBaseUri);
    let owned = candidates.filter(publication => metadataUri(publication) === old.metadataBaseUri);
    if (candidates.length === publications.length && candidates.length > owned.length) {
      const retired = await retiredOwners();
      owned = candidates.filter(publication => metadataUri(publication) === old.metadataBaseUri || retired.has(metadataUri(publication)));
    }
    if (!owned.length) {
      assert.notEqual(path.basename(directory), old.deploymentId, `Cannot prove ownership of metadata cache: ${directory}`);
      continue;
    }
    if (owned.length !== publications.length) preservedShared.push(path.relative(roots.repository, directory));
    else {
      for (const child of children(directory)) {
        noSymlinks(child);
        assert.ok(!fs.lstatSync(child).isDirectory() || ['templates', 'uploads', 'snapshots'].includes(path.basename(child)),
          `Unknown metadata cache directory ownership: ${child}`);
      }
      add('repository', directory);
    }
  }
  for (const directory of children(path.join(roots.repository, '.cache'))) {
    const name = path.basename(directory);
    if (name !== `111k-${old.deploymentId}-scenes` && name !== `111k-${old.deploymentId}-live-ui`
      && !name.startsWith(`111k-${old.deploymentId}-live-ui-recheck-`)) continue;
    targetPath({ root: 'repository', path: `.cache/${name}` }, roots, old);
    assert.ok(publicReleases.length, `Cannot prove QA cache ownership without the old public release: ${name}`);
    const pairs = name.endsWith('-scenes')
      ? [['verification.json', 'scene-verification.json'], ['ui-verification.json', 'scene-ui-verification.json'],
        ['interactive-verification.json', 'scene-interactive-verification.json']]
      : [['verification.json', name.includes('-recheck-') ? 'final-live-ui-recheck.json' : 'live-ui-verification.json']];
    for (const [local, published] of pairs) {
      const filename = path.join(directory, local);
      noSymlinks(filename);
      assert.ok(publicReleases.some(release => noSymlinks(path.join(release, published), true)
        && contentHash(filename) === contentHash(path.join(release, published))), `QA cache does not match scoped release evidence: ${name}/${local}`);
    }
    if (!name.endsWith('-scenes')) {
      const report = json(path.join(directory, 'verification.json'));
      assert.equal(report.contractAddress, old.contractAddress, `QA cache contract changed: ${name}`);
      assert.ok(Array.isArray(report.configurations) && report.configurations.length
        && report.configurations.every((config: Record<string, unknown>) => config.metadataBaseUri === old.metadataBaseUri),
      `QA cache metadata scope changed: ${name}`);
    }
    add('repository', directory);
  }
  for (const name of ['ethereum111k', 'ethereum111k-acceptance', 'ethereum111k-proceeds-acceptance']) {
    for (const filename of children(path.join(roots.home, '.mons-shop-backups', name))) {
      noSymlinks(filename);
      assert.ok(fs.lstatSync(filename).isFile() && filename.endsWith('.json'), `Unknown backup entry: ${filename}`);
      const data = json(filename);
      const identity = name === 'ethereum111k' ? data.scope : { chainId: data.chainId, contractAddress: data.oldContract };
      assert.ok(identity && Number.isSafeInteger(identity.chainId) && /^0x[0-9a-f]{40}$/.test(identity.contractAddress), `Unknown backup identity: ${filename}`);
      if (identity.chainId === old.chainId && identity.contractAddress === old.contractAddress) add('home', filename);
    }
  }
  for (const revision of children(path.join(roots.home, '.mons-shop-backups/111k-metadata'))) {
    const directory = path.join(revision, 'sepolia');
    const manifest = path.join(directory, 'manifest.json');
    if (!noSymlinks(manifest, true)) continue;
    const data = json(manifest);
    assert.equal(data.network, 'sepolia', `Wrong network in Sepolia backup: ${manifest}`);
    if (`https://cdn.mons.shop/${data.prefix}` === old.metadataBaseUri) add('home', directory);
  }
  checkReplacementPublicationDependencies(roots, current, releaseDirectory, paths.map(target => targetPath(target, roots, old, location)));
  return { paths, preservedShared };
}

function indexRows(target: Target, directory: string): Entry[] {
  assert.match(target.index, /^cleanup-artifacts-[a-f0-9]{16}\.jsonl$/);
  const filename = path.join(directory, target.index);
  noSymlinks(filename);
  const content = fs.readFileSync(filename, 'utf8');
  assert.equal(digest(content), target.sha256, `Artifact checksum index changed: ${target.path}`);
  const entries = content.trimEnd().split('\n').map(line => JSON.parse(line) as Entry);
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, 'Duplicate artifact index paths');
  for (const entry of entries) assert.ok(entry.path === '' || !path.isAbsolute(entry.path)
    && entry.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid artifact checksum path');
  return entries;
}

function verifyRemaining(filename: string, expected: Entry[]) {
  if (!noSymlinks(filename, true)) return;
  const approved = new Map(expected.map(entry => [entry.path, entry]));
  for (const entry of snapshot(filename)) assert.deepEqual(entry, approved.get(entry.path), `Unapproved or changed artifact remains: ${filename}/${entry.path}`);
}

export async function cleanup111kReplacementArtifacts(context: Context, options: Options = {}) {
  const old = scope(context.oldDeployment);
  const current = scope(context.newDeployment);
  assert.notEqual(old.contractAddress, current.contractAddress, 'Current deployment artifacts are protected');
  assert.notEqual(old.deploymentId, current.deploymentId, 'Replacement must have a fresh deployment identity');
  const roots = { repository: fs.realpathSync(path.resolve(options.repositoryRoot ?? repositoryDefault)),
    home: fs.realpathSync(path.resolve(options.homeRoot ?? homedir())) };
  noSymlinks(roots.repository); noSymlinks(roots.home);
  const releaseDirectory = fs.realpathSync(path.dirname(path.resolve(context.journalPath)));
  const journalPath = path.join(releaseDirectory, path.basename(context.journalPath));
  noSymlinks(releaseDirectory);
  requireScope(path.join(releaseDirectory, 'manifest.json'), current);
  const frozenManifest = json(path.join(releaseDirectory, 'manifest.json'));
  assert.equal(frozenManifest.previousContract, old.contractAddress, 'Frozen predecessor changed');
  const planPath = path.join(releaseDirectory, 'cleanup-artifacts.json');
  const progressPath = path.join(releaseDirectory, 'cleanup-artifacts-progress.json');
  const retiredOwners = retiredMetadataOwners(current, options.queryRetiredDeployments ?? createAsyncD1MaintenanceQuery('ops'));
  return withMetadataLock(path.join(releaseDirectory, 'cleanup-artifacts.lock'), async () => {
    const existingPlan = noSymlinks(planPath, true);
    const location = previousReleaseLocation(frozenManifest, old, roots, !existingPlan);
    let plan: ArtifactPlan;
    if (existingPlan) {
      plan = json(planPath) as ArtifactPlan;
      assert.equal(plan.version, 1);
      assert.deepEqual(plan.oldDeployment, old); assert.deepEqual(plan.newDeployment, current);
      assert.equal(plan.repositoryRoot, roots.repository); assert.equal(plan.homeRoot, roots.home);
      assert.equal(plan.releaseDirectory, releaseDirectory);
    } else {
      const found = await discover(roots, old, current, releaseDirectory, retiredOwners, location, true);
      const targets = found.paths.map(target => targetPath(target, roots, old, location));
      checkDependencies(roots.repository, targets, old, current);
      const sourceRevision = git(roots.repository, ['rev-parse', 'HEAD']);
      const documents = documentChanges(roots.repository, targets, sourceRevision);
      const artifacts = found.paths.map(target => {
        const filename = targetPath(target, roots, old, location);
        const entries = snapshot(filename);
        const content = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        const index = `cleanup-artifacts-${digest(`${target.root}:${target.path}`).slice(0, 16)}.jsonl`;
        const indexPath = path.join(releaseDirectory, index);
        noSymlinks(indexPath, true);
        atomicWrite(indexPath, content);
        return { ...target, index, sha256: digest(content), files: entries.filter(entry => entry.kind === 'file').length,
          bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) };
      });
      plan = { version: 1, createdAt: new Date().toISOString(), oldDeployment: old, newDeployment: current,
        repositoryRoot: roots.repository, homeRoot: roots.home, releaseDirectory, sourceRevision,
        artifacts, documents, preservedShared: found.preservedShared };
      atomicWrite(planPath, serialized(plan));
    }
    const planSha256 = contentHash(planPath);
    if (options.write) {
      assert.ok(noSymlinks(journalPath, true), 'Backend verification journal is required before artifact deletion');
      const verified = json(journalPath);
      assert.equal(verified.version, 2);
      assert.equal(verified.kind, '111k-replacement-cleanup');
      assert.ok(Number.isSafeInteger(verified.backendVerifiedAtMs) && verified.backendVerifiedAtMs > 0,
        'Backend verification is required before artifact deletion');
      assert.ok(matches(verified.oldDeployment, old) && matches(verified.newDeployment, current), 'Backend cleanup scope changed');
      assert.equal(fs.realpathSync(verified.release?.releaseDirectory), releaseDirectory);
      assert.equal(verified.release?.manifestSha256, digest(serialized(frozenManifest)), 'Verified replacement manifest changed');
      assert.equal(verified.artifacts?.planPath, planPath, 'Backend cleanup is bound to a different artifact plan');
      assert.equal(verified.artifacts?.planSha256, planSha256, 'Artifact plan changed after backend verification');
    }
    let progress: ArtifactProgress = noSymlinks(progressPath, true) ? json(progressPath) as ArtifactProgress
      : { version: 1, planSha256, complete: false, removed: [] };
    assert.equal(progress.version, 1);
    assert.equal(typeof progress.complete, 'boolean');
    assert.ok(Array.isArray(progress.removed), 'Invalid artifact cleanup progress');
    assert.equal(progress.planSha256, planSha256, 'Artifact plan changed after cleanup started');
    assert.ok(location || plan.artifacts.some(target => target.root === 'repository' && [
      `.cache/111k-${old.deploymentId}-release`, `onchain/ethereum/.local/111k-sepolia-${old.deploymentId}`,
    ].includes(target.path)), 'Previous private release location is unknown; record it with --previous-directory before finalizing');
    const targets = plan.artifacts.map(target => targetPath(target, roots, old, location));
    assert.equal(new Set(targets).size, targets.length, 'Duplicate artifact targets');
    const protectedPaths = [releaseDirectory, path.join(roots.repository, `releases/111k-sepolia-${current.deploymentId}`),
      path.join(roots.repository, `.cache/111k-${current.deploymentId}-release`),
      path.join(roots.repository, `.cache/111k-metadata/${current.deploymentId}`),
      path.join(roots.repository, `onchain/ethereum/.local/111k-sepolia-${current.deploymentId}`)];
    for (const target of targets) assert.ok(!protectedPaths.some(protectedPath => inside(protectedPath, target) || inside(target, protectedPath)),
      'Retired target contains current release state or required artifacts');
    checkReplacementPublicationDependencies(roots, current, releaseDirectory, targets);
    const removeIndexes = () => {
      for (const target of plan.artifacts) {
        assert.match(target.index, /^cleanup-artifacts-[a-f0-9]{16}\.jsonl$/);
        const filename = path.join(releaseDirectory, target.index);
        if (!noSymlinks(filename, true)) continue;
        assert.equal(contentHash(filename), target.sha256, 'Artifact checksum index changed before removal');
        fs.unlinkSync(filename);
      }
    };
    const result = { planPath, planSha256, planned: true, complete: progress.complete,
      targets: targets.length, files: plan.artifacts.reduce((sum, target) => sum + target.files, 0),
      bytes: plan.artifacts.reduce((sum, target) => sum + target.bytes, 0), preservedShared: plan.preservedShared };
    if (progress.complete) {
      assert.ok(targets.every(target => !noSymlinks(target, true)), 'Retired artifacts reappeared after completion');
      assert.equal((await discover(roots, old, current, releaseDirectory, retiredOwners, location)).paths.length, 0, 'Additional retired artifacts remain');
      if (options.write) removeIndexes();
      return result;
    }
    checkDependencies(roots.repository, targets, old, current);
    const indexes = plan.artifacts.map(target => indexRows(target, releaseDirectory));
    for (const [index, target] of targets.entries()) verifyRemaining(target, indexes[index]);
    for (const change of plan.documents) {
      const filename = path.join(roots.repository, change.path);
      assert.ok(inside(filename, roots.repository), 'Document escapes repository');
      noSymlinks(filename);
      assert.ok([change.before, change.after].includes(contentHash(filename)), `Linked document changed after artifact planning: ${change.path}`);
    }
    if (!options.write) return { ...result, complete: false };
    atomicWrite(progressPath, serialized(progress));
    for (const change of plan.documents) {
      const filename = path.join(roots.repository, change.path);
      if (contentHash(filename) === change.after) continue;
      let content = fs.readFileSync(filename, 'utf8');
      for (const replacement of change.replacements) content = content.replaceAll(replacement.before, replacement.after);
      assert.equal(digest(content), change.after, 'Pinned document content changed');
      atomicWrite(filename, content, fs.statSync(filename).mode & 0o777);
    }
    for (const [index, filename] of targets.entries()) {
      verifyRemaining(filename, indexes[index]);
      for (const entry of indexes[index].filter(entry => entry.kind === 'file')) {
        const target = entry.path ? path.join(filename, entry.path) : filename;
        if (!noSymlinks(target, true)) continue;
        assert.equal(contentHash(target), entry.sha256, `Artifact changed before deletion: ${target}`);
        fs.unlinkSync(target);
      }
      for (const entry of [...indexes[index]].reverse().filter(entry => entry.kind === 'directory')) {
        const target = entry.path ? path.join(filename, entry.path) : filename;
        if (noSymlinks(target, true)) fs.rmdirSync(target);
      }
      assert.ok(!noSymlinks(filename, true), `Retired artifact remains: ${filename}`);
      if (!progress.removed.includes(filename)) progress.removed.push(filename);
      atomicWrite(progressPath, serialized(progress));
    }
    assert.ok(targets.every(target => !noSymlinks(target, true)), 'Retired artifacts remain');
    assert.equal((await discover(roots, old, current, releaseDirectory, retiredOwners, location)).paths.length, 0, 'Additional retired artifacts remain outside the approved plan');
    progress = { ...progress, complete: true };
    atomicWrite(progressPath, serialized(progress));
    removeIndexes();
    return { ...result, complete: true };
  });
}
