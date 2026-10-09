import assert from 'node:assert/strict';
import test from 'node:test';
import { Safari } from '../safari.mjs';

const DRIVER = `
let buffer = '', tabs = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) return;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (!message.id) continue;
    let result;
    if (message.method === 'initialize') result = {serverInfo:{name:'fixture',version:'1'}};
    else {
      const {name, arguments:args} = message.params;
      if (name === 'crash') process.exit(2);
      if (name === 'error') result = {isError:true, content:[{type:'text',text:'fixture failure'}]};
      else {
        const value = name === 'create_tab' ? {handle:'owned-'+(++tabs)} :
          name === 'close_tab' ? 'closed '+args.handle : {name, args};
        result = {content:[{type:'text',text:JSON.stringify(value)}]};
      }
    }
    const response = JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n';
    process.stdout.write(response.slice(0, 9));
    process.stdout.write(response.slice(9));
  }
});
`;

test('stdio MCP preserves arguments and closes only owned tabs', async t => {
  const safari = new Safari(process.execPath, ['-e', DRIVER]);
  t.after(() => safari.close());
  assert.deepEqual(await safari.initialize(), { name: 'fixture', version: '1' });
  assert.deepEqual(await safari.call('screenshot', { savePath: '/tmp/a file.png', full_page: false }),
    { name: 'screenshot', args: { savePath: '/tmp/a file.png', full_page: false } });
  await safari.createTab('http://127.0.0.1:5174/harness');
  await safari.createTab('about:blank');
  const results = await safari.close();
  assert.deepEqual(results, [{ handle: 'owned-2', closed: 'closed owned-2' }, { handle: 'owned-1', closed: 'closed owned-1' }]);
});

test('tool failures reject without being mistaken for successful capture', async t => {
  const safari = new Safari(process.execPath, ['-e', DRIVER]);
  t.after(() => safari.close());
  await safari.initialize();
  await assert.rejects(safari.call('error'), /fixture failure/);
  await assert.rejects(safari.call('crash'), /Safari MCP exited/);
});
