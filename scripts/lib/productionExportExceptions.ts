export const productionExportReasons = {
  platform: 'Cloudflare discovers this entry point through the recorded Worker configuration.',
  test: 'The recorded test directly exercises this exported seam or contract value.',
  tooling: 'The recorded repository tool consumes this export outside the production entry graph.',
  compatibility: 'The recorded guide explains why this dormant compatibility API remains supported.',
} as const;

type Issue = readonly [file: string, kind: string, name: string];
type Exception = readonly [...Issue, reason: keyof typeof productionExportReasons, evidence: string];

function key(issue: readonly string[]): string {
  return JSON.stringify(issue.slice(0, 3));
}

function parseProductionExportExceptions(value: unknown): Exception[] {
  if (!Array.isArray(value)) throw new Error('Production export exceptions must be an array.');
  const seen = new Set<string>();
  return value.map((entry): Exception => {
    if (!Array.isArray(entry) || entry.length !== 5 || entry.some(field => typeof field !== 'string' || !field.trim())) {
      throw new Error('Each production export exception requires file, kind, name, reason, and evidence.');
    }
    const [file, kind, name, reason, evidence] = entry as [string, string, string, string, string];
    if (!Object.hasOwn(productionExportReasons, reason)) throw new Error(`Unknown production export reason: ${reason}`);
    if (evidence.startsWith('/') || evidence.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Evidence must be a repository-relative path: ${evidence}`);
    }
    const id = key([file, kind, name]);
    if (seen.has(id)) throw new Error(`Duplicate production export exception: ${id}`);
    seen.add(id);
    const testEvidence = evidence.startsWith('tests/') || /\/(?:test|runtime-test)\//.test(evidence) || /\.test\.[cm]?[jt]sx?$/.test(evidence);
    if (reason === 'test' && !testEvidence || reason === 'tooling' && (testEvidence || !/^(?:scripts|onchain\/ethereum\/scripts)\//.test(evidence)) ||
      reason === 'platform' && !/^(?:cloud\/workers\/|scripts\/ops\/).*wrangler\.jsonc$/.test(evidence) || reason === 'compatibility' && !evidence.endsWith('.md')) {
      throw new Error(`Evidence does not match ${reason}: ${evidence}`);
    }
    return [file, kind, name, reason as keyof typeof productionExportReasons, evidence];
  });
}

export function validateProductionExportExceptions(value: unknown, readEvidence: (path: string) => string): Exception[] {
  const baseline = parseProductionExportExceptions(value);
  for (const [, , name, reason, evidence] of baseline) {
    const source = readEvidence(evidence);
    if (reason !== 'compatibility' && name !== 'default' && !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source)) {
      throw new Error(`Evidence no longer references ${name}: ${evidence}`);
    }
  }
  return baseline;
}

export function updateProductionExportExceptions(
  actual: readonly Issue[],
  value: unknown,
  readEvidence: (path: string) => string,
): Exception[] {
  const baseline = parseProductionExportExceptions(value);
  const reviewed = new Set(baseline.map(key));
  const added = actual.filter(issue => !reviewed.has(key(issue)));
  if (added.length) {
    throw new Error(`New production exports need an explicit reason and evidence before updating:\n${added.map(issue => `  ${issue.join(' | ')}`).join('\n')}`);
  }
  const remaining = new Set(actual.map(key));
  return validateProductionExportExceptions(baseline.filter(entry => remaining.has(key(entry))), readEvidence);
}
