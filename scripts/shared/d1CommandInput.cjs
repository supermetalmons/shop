const { readFileSync } = require('node:fs');

const commandIndex = process.argv.indexOf('--command');
if (commandIndex < 0 || process.argv[commandIndex + 1] !== 'MONS_D1_SQL_STDIN') {
  throw new Error('Invalid D1 command input.');
}
process.argv[commandIndex + 1] = readFileSync(0, 'utf8');
