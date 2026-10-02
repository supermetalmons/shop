import { generatePreorderCatalog } from './shared/preorderCatalog.ts';

const args = process.argv.slice(2);
try {
  if (args.length !== 1 || (args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('Usage: node --import tsx scripts/generatePreorderCatalog.ts --check|--write');
  }
  const result = generatePreorderCatalog({ write: args[0] === '--write' });
  console.log(`Preorder catalog is current: ${result.cardCount} cards${result.migration ? `; created ${result.migration}` : ''}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
