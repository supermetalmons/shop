import { createHash } from 'node:crypto';
import { linkSync, readFileSync, unlinkSync } from 'node:fs';

const completionTimeoutMilliseconds = 600_000;

export class NativeProcessing {
  constructor(worker, config, { workers = 2, capacity = workers + 1, frameCount = 276, onError = () => {} } = {}) {
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > 3
      || !Number.isSafeInteger(capacity) || capacity < workers || capacity > 4) {
      throw new Error('Invalid native preparation worker count or capacity.');
    }
    this.worker = worker;
    this.frameCount = frameCount;
    this.onError = onError;
    this.records = new Map();
    this.completed = new Map();
    this.admissions = Promise.resolve();
    this.initialized = worker.request('init', { ...config, workers, capacity }, { timeoutMilliseconds: completionTimeoutMilliseconds }).then(result => {
      if (!result?.ready || result.cardId !== config.cardId || result.workers !== workers || result.capacity !== capacity) {
        throw new Error('Native preparation initialization differs from its configuration.');
      }
    }).catch(error => { this.fail(error); throw error; });
    this.initialized.catch(() => {});
  }

  check() {
    if (this.error) throw this.error;
    if (this.finished) throw new Error('Native processing has already finished.');
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.closePromise ||= this.worker.close().catch(() => {});
    this.onError(error);
  }

  acceptCompletions(results) {
    if (!Array.isArray(results)) throw new Error('Native preparation completion receipts are missing.');
    for (const result of results) {
      const record = this.records.get(result?.frame);
      if (!record || result.frame !== this.completed.size || result.sourceSha256 !== record.sha256
        || !/^[a-f0-9]{64}$/.test(result.preparedSha256 || '') || result.qualityRow?.frame !== result.frame
        || result.qualityRow.sha256 !== record.sha256 || result.preparation?.input !== record.input) {
        throw new Error('Native prepared frame differs from its ordered capture checkpoint.');
      }
      this.completed.set(result.frame, result);
    }
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
      throw new Error('Invalid committed native frame for processing.');
    }
    const previous = this.records.get(frame);
    if (previous) {
      if (previous.input !== input || previous.sha256 !== sha256) throw new Error('Committed native frame identity changed.');
      return;
    }
    if (frame !== this.records.size) throw new Error('Native processing frames must be admitted in order.');
    await this.initialized;
    this.check();
    const request = { frame, input, sha256 };
    const result = await this.worker.request('frame', request);
    if (result?.acceptedFrame !== frame || result.acceptedSha256 !== sha256) {
      throw new Error('Native preparation admission differs from its capture checkpoint.');
    }
    this.records.set(frame, request);
    this.acceptCompletions(result.completed);
  }

  async finish(args, checkpointQuality = async () => {}) {
    await this.admissions;
    this.check();
    if (this.records.size !== this.frameCount) throw new Error(`Native processing requires exactly ${this.frameCount} committed frames.`);
    try {
      const { completed, ...quality } = await this.worker.request('quality', args, { timeoutMilliseconds: completionTimeoutMilliseconds });
      this.acceptCompletions(completed);
      if (this.completed.size !== this.frameCount) throw new Error('Native preparation did not complete every admitted frame.');
      await checkpointQuality(quality);
      this.check();
      const result = await this.worker.request('finish', {}, { timeoutMilliseconds: completionTimeoutMilliseconds });
      this.check();
      this.finished = true;
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async close() {
    if (!this.finished && !this.error) this.fail(new Error('Native processing closed before completion.'));
    await (this.closePromise ||= this.worker.close());
  }
}

export async function finishNativeVideo(processing, args, { stagedPath, output, verify }) {
  verify();
  const result = await processing.finish(args, verify);
  await processing.close();
  verify();
  if (!result.qualityReport?.passed || !result.video?.fullyDecoded || result.video.output !== stagedPath) {
    throw new Error('Native video quality, full decode, or staging path did not pass.');
  }
  const sha256 = createHash('sha256').update(readFileSync(stagedPath)).digest('hex');
  if (sha256 !== result.video.sha256) throw new Error('Staged native video checksum differs.');
  verify();
  linkSync(stagedPath, output);
  unlinkSync(stagedPath);
  return { ...result, video: { ...result.video, output } };
}
