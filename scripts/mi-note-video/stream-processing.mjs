const completionTimeoutMilliseconds = 600_000;

export class StreamProcessing {
  constructor(worker, config, { capacity = 2, frameCount = 276, onError = () => {} } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid streaming queue capacity.');
    this.worker = worker;
    this.config = config;
    this.capacity = capacity;
    this.frameCount = frameCount;
    this.onError = onError;
    this.records = new Map();
    this.pending = new Set();
    this.admissions = Promise.resolve();
    this.initialized = worker.request('init', config, { timeoutMilliseconds: completionTimeoutMilliseconds }).catch(error => {
      this.fail(error);
      throw error;
    });
    this.initialized.catch(() => {});
  }

  check() {
    if (this.error) throw this.error;
    if (this.finished) throw new Error('Streaming processing has already finished.');
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.closePromise ||= this.worker.close().catch(() => {});
    this.onError(error);
  }

  enqueue(record) {
    const admission = this.admissions.then(() => this.admit(record));
    this.admissions = admission.catch(error => { this.fail(error); });
    return admission;
  }

  async admit(record) {
    this.check();
    const { frame, path: input, sha256 } = record;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.frameCount
      || typeof input !== 'string' || !input || !/^[a-f0-9]{64}$/.test(sha256 || '')) {
      throw new Error('Invalid committed native frame for streaming.');
    }
    const previous = this.records.get(frame);
    if (previous) {
      if (previous.input !== input || previous.sha256 !== sha256) throw new Error('Committed streaming frame identity changed.');
      return;
    }
    if (frame !== this.records.size) throw new Error('Committed streaming frames must be admitted in order.');
    await this.initialized;
    this.check();
    while (this.pending.size >= this.capacity) {
      await Promise.race(this.pending);
      this.check();
    }
    const request = { frame, input, sha256 };
    this.records.set(frame, request);
    const work = this.worker.request('frame', request).then(result => {
      if (result?.frame !== frame || result.sourceSha256 !== sha256 || !/^[a-f0-9]{64}$/.test(result.preparedSha256 || '')) {
        throw new Error('Streaming frame result does not match its native checkpoint.');
      }
    }).catch(error => {
      this.fail(error);
      throw error;
    }).finally(() => this.pending.delete(work));
    work.catch(() => {});
    this.pending.add(work);
  }

  async finish(args, checkpointQuality = async () => {}) {
    await this.admissions;
    this.check();
    if (this.records.size !== this.frameCount) throw new Error(`Streaming processing requires exactly ${this.frameCount} committed frames.`);
    try {
      await this.initialized;
      await Promise.all(this.pending);
      this.check();
      const quality = await this.worker.request('quality', args, { timeoutMilliseconds: completionTimeoutMilliseconds });
      await checkpointQuality(quality);
      this.check();
      const result = await this.worker.request('finish', {}, { timeoutMilliseconds: completionTimeoutMilliseconds });
      this.finished = true;
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async close() {
    if (!this.finished && !this.error) this.fail(new Error('Streaming processing closed before completion.'));
    await (this.closePromise ||= this.worker.close());
    await Promise.allSettled(this.pending);
  }
}
