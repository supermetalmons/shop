import { spawn } from 'node:child_process';

export class FrameWorker {
  constructor(command, args, { activeChildren = new Set(), timeoutMilliseconds = 120_000, stopMilliseconds = 1000 } = {}) {
    this.command = command;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.stopMilliseconds = stopMilliseconds;
    this.queue = [];
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    activeChildren.add(this.child);
    this.closed = new Promise(resolve => {
      this.child.once('close', () => {
        this.exited = true;
        const confirmStopped = () => {
          if (this.groupRunning()) {
            setTimeout(confirmStopped, 25).unref();
            return;
          }
          clearTimeout(this.killTimer);
          activeChildren.delete(this.child);
          resolve();
        };
        confirmStopped();
      });
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', data => this.receive(data));
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-16000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.once('exit', (code, signal) => {
      this.fail(new Error(`Frame worker exited (${signal || code}): ${this.stderr}`));
    });
    this.child.stdout.once('end', () => this.fail(new Error('Frame worker output ended before it was closed.')));
  }

  request(operation, args, { timeoutMilliseconds = this.timeoutMilliseconds } = {}) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) throw new Error('Invalid frame worker timeout.');
      const id = this.nextId++;
      const line = JSON.stringify({ id, operation, args }) + '\n';
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Frame worker request is too large.');
      this.queue.push({ id, line, resolve, reject, timeoutMilliseconds });
      this.dispatch();
    });
  }

  dispatch() {
    if (this.error || this.pending || !this.queue.length) return;
    this.pending = this.queue.shift();
    this.pending.timer = setTimeout(() => this.fail(new Error('Frame worker request timed out.')), this.pending.timeoutMilliseconds);
    this.child.stdin.write(this.pending.line, error => { if (error) this.fail(error); });
  }

  receive(data) {
    if (this.error) return;
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
      this.fail(new Error('Frame worker response is too large.'));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let response;
      try {
        response = JSON.parse(line);
        if (!response || !this.pending || response.id !== this.pending.id
          || Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')
          || (Object.hasOwn(response, 'error') && typeof response.error?.message !== 'string')) {
          throw new Error('Unexpected response envelope');
        }
      } catch (error) {
        this.fail(new Error(`Invalid frame worker response: ${error.message}`));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(`${this.command} failed (1): ${response.error.message}`));
      else pending.resolve(response.result);
      this.dispatch();
    }
  }

  groupRunning() {
    if (this.groupStopped) return false;
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 0); return true; }
      catch (error) { if (error.code !== 'ESRCH') return true; }
    }
    this.groupStopped = true;
    return false;
  }

  signal(signal) {
    if (!this.groupRunning()) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) {
      if (error.code === 'ESRCH') this.groupStopped = true;
      else this.child.kill(signal);
    }
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    for (const request of this.queue.splice(0)) request.reject(error);
    this.child.stdin.destroy();
    this.signal('SIGTERM');
    if (this.groupRunning()) {
      this.killTimer = setTimeout(() => this.signal('SIGKILL'), this.stopMilliseconds);
    }
  }

  async close() {
    this.fail(new Error('Frame worker closed.'));
    let timer;
    try {
      await Promise.race([this.closed, new Promise((_, reject) => {
        timer = setTimeout(() => {
          this.signal('SIGKILL');
          this.child.stdout.destroy();
          this.child.stderr.destroy();
          reject(new Error('Frame worker did not close after termination.'));
        }, this.stopMilliseconds + 2000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
}
