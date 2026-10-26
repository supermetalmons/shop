import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { replayD1Migrations, type D1Migration } from './d1MigrationReplay.ts';
import { sqlSchemaFingerprint } from './sqlSchemaFingerprint.ts';

export type D1SchemaObject = {
  type: string;
  name: string;
  tableName: string;
  fingerprint: string;
};

export type D1SchemaManifest<Checkpoint> = {
  formatVersion: 1;
  migrations: { name: string; checksum: string }[];
  checkpoints: Record<string, Checkpoint>;
};

export function readD1SchemaManifest<Checkpoint>(path: string, label: string): D1SchemaManifest<Checkpoint> {
  const manifest: D1SchemaManifest<Checkpoint> = JSON.parse(readFileSync(path, 'utf8'));
  if (!manifest || manifest.formatVersion !== 1 || !Array.isArray(manifest.migrations) ||
    !manifest.checkpoints || typeof manifest.checkpoints !== 'object' || Array.isArray(manifest.checkpoints)) {
    throw new Error(`Invalid ${label} schema manifest.`);
  }
  return manifest;
}

export function captureD1SchemaObjects(database: DatabaseSync): D1SchemaObject[] {
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY type, name`).all().map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.tbl_name),
    fingerprint: sqlSchemaFingerprint(String(row.sql)),
  }));
}

export function buildD1SchemaManifest<Checkpoint>(
  migrations: readonly D1Migration[],
  options: {
    label: string;
    recorded?: D1SchemaManifest<Checkpoint>;
    checkpoint: (database: DatabaseSync, index: number) => Checkpoint | undefined;
  },
): D1SchemaManifest<Checkpoint> {
  for (const [index, migration] of (options.recorded?.migrations ?? []).entries()) {
    if (migration.name !== migrations[index]?.name || migration.checksum !== migrations[index]?.checksum) {
      throw new Error(`Recorded ${options.label} migration changed: ${migration.name}. Append a new migration instead.`);
    }
  }
  const checkpoints: Record<string, Checkpoint> = {};
  const database = replayD1Migrations(migrations, (database, migration, index) => {
    const checkpoint = options.checkpoint(database, index);
    if (checkpoint !== undefined) checkpoints[migration.name] = checkpoint;
  });
  database.close();
  for (const { name } of options.recorded?.migrations ?? []) {
    if (Object.hasOwn(checkpoints, name) && !Object.hasOwn(options.recorded!.checkpoints, name)) {
      throw new Error(`Recorded ${options.label} schema checkpoint changed: ${name}.`);
    }
  }
  for (const [name, checkpoint] of Object.entries(options.recorded?.checkpoints ?? {})) {
    if (JSON.stringify(checkpoint) !== JSON.stringify(checkpoints[name])) {
      throw new Error(`Recorded ${options.label} schema checkpoint changed: ${name}.`);
    }
  }
  return {
    formatVersion: 1,
    migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
    checkpoints,
  };
}

export function generateD1SchemaManifest<Checkpoint>(options: {
  check: boolean;
  manifestPath: string;
  label: string;
  generateCommand: string;
  build: (recorded?: D1SchemaManifest<Checkpoint>) => D1SchemaManifest<Checkpoint>;
}): void {
  const previous = existsSync(options.manifestPath)
    ? readD1SchemaManifest<Checkpoint>(options.manifestPath, options.label) : undefined;
  const manifest = options.build(previous);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.check) {
    if (!previous || readFileSync(options.manifestPath, 'utf8') !== content) {
      throw new Error(`${options.label} schema manifest is stale. Run npm run ${options.generateCommand}.`);
    }
    return;
  }
  if (previous && readFileSync(options.manifestPath, 'utf8') === content) return;
  mkdirSync(dirname(options.manifestPath), { recursive: true });
  writeFileSync(options.manifestPath, content);
}
