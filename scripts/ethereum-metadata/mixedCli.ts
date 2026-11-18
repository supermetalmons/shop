import { parseArgs } from 'node:util';

const usage = `Usage: npm run ethereum:mixed-allocation -- COMMAND [options]

  inspect  --source FILE --policy FILE [--predecessor-source FILE]
  prepare  --source FILE --policy FILE --bundle DIR [--predecessor-source FILE]
  rehearse --bundle DIR
  promote  --bundle DIR --definition-sha256 HASH [--template-file FILE] --write

  status   --batch-id ID [--deployment-id ID] [--expected-revision N] [--journal FILE]
  apply | verify | refresh-scan | refresh-activation | cancel
           --batch-id ID [--deployment-id ID] [--expected-revision N] [--journal FILE] --write

Mainnet requires an explicit deployment ID. See scripts/docs/111k_reveal_ops.md#mixed-allocation.`;

async function run([command, ...args]: string[]) {
  if (command === '--help' || command === 'help') return usage;
  if (!command) throw new Error(usage);
  if (command === 'inspect' || command === 'prepare' || command === 'promote') {
    const { mixedReleaseFileCommand } = await import('./promoteMixedRelease.ts');
    return mixedReleaseFileCommand(command, args);
  }
  if (command === 'rehearse') {
    const { values } = parseArgs({ args, options: { bundle: { type: 'string' } } });
    if (!values.bundle) throw new Error('Usage: ethereum:mixed-allocation rehearse --bundle DIR');
    const { rehearseMixedBundle } = await import('./rehearseMixedAllocation.ts');
    return rehearseMixedBundle(values.bundle);
  }
  const { mixedAllocationControlMain } = await import('../ops/ethereumMixedAllocationControl.ts');
  return mixedAllocationControlMain([command, ...args], {
    onProgress: result => process.stderr.write(JSON.stringify(result) + '\n'),
    onMediaPreflight: mediaPreflight => process.stderr.write(JSON.stringify({ mediaPreflight }) + '\n'),
  });
}

run(process.argv.slice(2)).then(result => process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result)) + '\n'))
  .catch(error => {
    process.stderr.write(`Mixed allocation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
