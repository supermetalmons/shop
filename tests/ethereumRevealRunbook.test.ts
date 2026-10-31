import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseEthereumRevealControlArgs } from '../scripts/ops/ethereumRevealControl.ts';

const runbook = readFileSync(new URL('../scripts/docs/111k_reveal_ops.md', import.meta.url), 'utf8');
const replacementGuide = readFileSync(new URL('../scripts/docs/111k_testnet.md', import.meta.url), 'utf8');
const commandPrefix = /^\s*npm\s+run\s+ethereum-reveal-control\s+--\s+(.+)$/gm;

function shellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```(?:sh|bash|shell)\s*\r?\n([\s\S]*?)^```/gm)].map(match => match[1]);
}

function executableSamples(markdown: string): string[] {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  return [...shellBlocks(markdown), ...[...prose.matchAll(/`([^`\n]+)`/g)].map(match => match[1])];
}

function revealCommands(source: string): string[] {
  return [...source.replace(/\\\r?\n\s*/g, ' ').matchAll(commandPrefix)].map(match => match[1].trim());
}

function parseExample(command: string) {
  const args = command.match(/"[^"]*"|'[^']*'|<[^>]*>|[^\s]+/g)!;
  assert.ok(!args.some(arg => arg === '--deployment-id' || arg.startsWith('--deployment-id=')), command);
  const target = args[args.indexOf('--manifest') + 1];
  assert.match(target, /^"\$[a-z][a-z0-9_]*_manifest"$/, `Use a quoted manifest variable: ${command}`);
  const parsed = parseEthereumRevealControlArgs(args.map((arg, index) =>
    arg === target ? '/tmp/reveal target.json' : args[index - 1] === '--expected-revision' ? '2' : arg));
  assert.equal(parsed.manifest, '/tmp/reveal target.json');
  assert.equal(parsed.deploymentId, undefined);
  return { target, parsed };
}

test('operational reveal commands use manifest variables in shell blocks and inline examples', () => {
  for (const [name, markdown] of [['reveal runbook', runbook], ['replacement guide', replacementGuide]]) {
    const commands = executableSamples(markdown).flatMap(revealCommands);
    assert.ok(commands.length > 0, `No executable reveal commands found in ${name}`);
    for (const command of commands) parseExample(command);
  }
});

test('registration, status and activation reuse the same manifest through the documented workflow', () => {
  const workflows = shellBlocks(runbook).map(revealCommands)
    .filter(commands => commands.some(command => command.startsWith('register ')));
  assert.equal(workflows.length, 1, 'Keep the registration workflow in one executable example');
  const steps = workflows[0].map(parseExample);
  assert.deepEqual(steps.map(({ parsed }) => [parsed.command, parsed.write]), [
    ['register', false], ['register', true], ['status', false], ['activate', true],
  ]);
  assert.equal(new Set(steps.map(step => step.target)).size, 1, 'Registration and activation must target the same manifest');
});
