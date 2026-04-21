import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { NewDropConfig } from './newDropConfig.ts';

const NEW_DROP_CONFIGS_DIR_RELATIVE_PATH = path.join('scripts', 'newDrops');

export function normalizeNewDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function formatKnownNewDropIds(knownDropIds: string[]): string {
  return knownDropIds.length ? knownDropIds.join(', ') : '(none)';
}

export function newDropConfigUsage(scriptName = 'deploy-all-onchain'): string {
  return `Run:\n  npm run ${scriptName} -- <dropId>\n`;
}

export function getNewDropConfigsDir(root: string): string {
  return path.join(root, NEW_DROP_CONFIGS_DIR_RELATIVE_PATH);
}

export function getNewDropConfigPath(root: string, dropId: string): string {
  return path.join(getNewDropConfigsDir(root), `${normalizeNewDropId(dropId)}.ts`);
}

export function listNewDropConfigIds(root: string): string[] {
  const configsDir = getNewDropConfigsDir(root);
  if (!existsSync(configsDir)) return [];
  return readdirSync(configsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.startsWith('.'))
    .map((entry) => normalizeNewDropId(entry.name.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function importModuleFresh(filePath: string): Promise<Record<string, unknown>> {
  const href = pathToFileURL(filePath).href;
  const mtimeMs = existsSync(filePath) ? statSync(filePath).mtimeMs : Date.now();
  return (await import(`${href}?t=${mtimeMs}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)) as Record<
    string,
    unknown
  >;
}

function isNewDropConfig(value: unknown): value is NewDropConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Boolean(
    obj.shared &&
      typeof obj.shared === 'object' &&
      !Array.isArray(obj.shared) &&
      obj.deploy &&
      typeof obj.deploy === 'object' &&
      !Array.isArray(obj.deploy) &&
      obj.onchain &&
      typeof obj.onchain === 'object' &&
      !Array.isArray(obj.onchain),
  );
}

export async function loadNewDropConfigById(args: {
  root: string;
  dropId: string;
}): Promise<{
  config: NewDropConfig;
  configPath: string;
  knownDropIds: string[];
}> {
  const requestedDropId = normalizeNewDropId(args.dropId);
  const knownDropIds = listNewDropConfigIds(args.root);

  if (!requestedDropId) {
    throw new Error(`Missing dropId.\n${newDropConfigUsage()}`);
  }

  const configPath = getNewDropConfigPath(args.root, requestedDropId);
  const relativeConfigPath = path.relative(args.root, configPath) || configPath;

  if (!existsSync(configPath)) {
    throw new Error(
      `Could not find a new drop config for ${requestedDropId}.\n` +
        `Expected file: ${relativeConfigPath}\n` +
        `Known drop configs: ${formatKnownNewDropIds(knownDropIds)}\n` +
        `${newDropConfigUsage()}`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importModuleFresh(configPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load new drop config from ${relativeConfigPath}: ${reason}`);
  }

  const candidate = mod.NEW_DROP ?? mod.default;
  if (!isNewDropConfig(candidate)) {
    throw new Error(
      `Could not read NEW_DROP from ${relativeConfigPath}.\n` +
        `Expected that file to export a NewDropConfig as \`NEW_DROP\`.`,
    );
  }

  const configuredDropId = normalizeNewDropId(
    typeof candidate.onchain.dropId === 'string' ? candidate.onchain.dropId : undefined,
  );
  if (configuredDropId && configuredDropId !== requestedDropId) {
    throw new Error(
      `Drop config file name must match NEW_DROP.onchain.dropId.\n` +
        `- requested dropId : ${requestedDropId}\n` +
        `- config file      : ${relativeConfigPath}\n` +
        `- configured dropId: ${configuredDropId}`,
    );
  }

  return {
    config: candidate,
    configPath,
    knownDropIds,
  };
}
