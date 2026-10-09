import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class Safari {
  constructor(driver = '/usr/bin/safaridriver', args = ['--mcp']) {
    this.child = spawn(driver, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.tabs = [];
    this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => this.receive(data));
    this.child.stderr.on('data', data => process.stderr.write(data));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => this.fail(new Error(`Safari MCP exited (${code}). Check Safari automation permission; see the renderer README.`)));
  }

  receive(data) {
    this.buffer += data;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const job = this.pending.get(message.id);
        if (!job) continue;
        clearTimeout(job.timer);
        this.pending.delete(message.id);
        if (message.error) job.reject(new Error(JSON.stringify(message.error)));
        else job.resolve(message.result);
      } catch (error) {
        this.fail(new Error(`Invalid Safari MCP response: ${error.message}`));
      }
    }
  }

  fail(error) {
    this.error = error;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
  }

  rpc(method, params, timeoutMilliseconds = 65000) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) this.fail(error);
      });
    });
  }

  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Mi Note PNG renderer', version: '1' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result.serverInfo;
  }

  async call(name, args = {}, timeoutMilliseconds = 65000) {
    const body = await this.rpc('tools/call', { name, arguments: args }, timeoutMilliseconds);
    if (body.isError || body.error) throw new Error(JSON.stringify(body));
    const text = body.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }

  async createTab(url) {
    const tab = await this.call('create_tab', { url });
    this.tabs.push(tab);
    return tab;
  }

  evaluate(expression) { return this.call('evaluate_javascript', { expression }); }

  async settle() {
    await this.evaluate('window.__capturePaintReady=false; requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__capturePaintReady=true;})); return true;');
    for (let index = 0; index < 100; index++) {
      if (await this.evaluate('return window.__capturePaintReady')) return;
      await delay(100);
    }
    throw new Error('Paint did not settle');
  }

  async close() {
    const results = [];
    for (const tab of this.tabs.reverse()) {
      try { results.push({ handle: tab.handle, closed: await this.call('close_tab', tab, 5000) }); }
      catch (error) { results.push({ handle: tab.handle, error: String(error) }); }
    }
    this.tabs = [];
    this.child.stdin.end();
    this.child.kill();
    this.fail(new Error('Safari MCP closed'));
    return results;
  }
}
