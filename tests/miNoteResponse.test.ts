import assert from 'node:assert/strict';
import test from 'node:test';
import { readMiNoteResponse } from '../src/lib/miNoteResponse.ts';

const encoder = new TextEncoder();
const signal = () => new AbortController().signal;

function responseStream(chunks: Uint8Array[], headers: HeadersInit = { 'Content-Type': 'application/json' }, close = true) {
  let cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel() { cancelled += 1; },
  }), { headers });
  return { response, cancellations: () => cancelled };
}

test('bounded Mi Note JSON decodes UTF-8 split across byte chunks at the exact byte limit', async () => {
  const value = { message: 'café 📝', ids: [1, 10] };
  const bytes = encoder.encode(JSON.stringify(value));
  const { response } = responseStream(Array.from(bytes, (byte) => Uint8Array.of(byte)), { 'Content-Type': 'Application/JSON; charset=utf-8' });
  assert.deepEqual(await readMiNoteResponse(response, signal(), bytes.length), value);
  assert.equal(response.body?.locked, false);
});

test('declared and actual byte overflows cancel the response before accepting JSON', async () => {
  const declared = responseStream([], { 'Content-Type': 'application/json', 'Content-Length': '17' }, false);
  await assert.rejects(readMiNoteResponse(declared.response, signal(), 16), /Invalid Mi Note API response/);
  assert.equal(declared.cancellations(), 1);
  const bytes = encoder.encode(JSON.stringify('📝'));
  const actual = responseStream([bytes.subarray(0, 3), bytes.subarray(3)], { 'Content-Type': 'application/json', 'Content-Length': '1' }, false);
  await assert.rejects(readMiNoteResponse(actual.response, signal(), bytes.length - 1), /Invalid Mi Note API response/);
  assert.equal(actual.cancellations(), 1);
  assert.equal(actual.response.body?.locked, false);
});

for (const media of [undefined, 'text/html', 'application/problem+json']) {
  test(`non-JSON media type ${String(media)} is rejected and cancelled`, async () => {
    const streamed = responseStream([encoder.encode('{}')], media ? { 'Content-Type': media } : {}, false);
    await assert.rejects(readMiNoteResponse(streamed.response, signal(), 64), /Invalid Mi Note API response/);
    assert.equal(streamed.cancellations(), 1);
  });
}

test('responses without a body, malformed JSON, and malformed UTF-8 cannot be accepted', async () => {
  await assert.rejects(readMiNoteResponse(new Response(null, { headers: { 'Content-Type': 'application/json' } }), signal(), 64), /Invalid Mi Note API response/);
  for (const bytes of [encoder.encode('{'), Uint8Array.of(0x22, 0xc0, 0xaf, 0x22), Uint8Array.of(0x22, 0xf0, 0x9f)]) {
    const { response } = responseStream([bytes]);
    await assert.rejects(readMiNoteResponse(response, signal(), 64));
    assert.equal(response.body?.locked, false);
  }
});

test('HTTP error JSON is decoded for the calling API to classify', async () => {
  const payload = { error: { code: 'unauthenticated', message: 'Verify your wallet.' } };
  assert.deepEqual(await readMiNoteResponse(Response.json(payload, { status: 401 }), signal(), 512), payload);
});

test('an already aborted read cancels a stale response body and preserves the external reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Superseded wallet');
  controller.abort(reason);
  const streamed = responseStream([encoder.encode('{}')], undefined, false);
  await assert.rejects(readMiNoteResponse(streamed.response, controller.signal, 64), (error: unknown) => error === reason);
  assert.equal(streamed.cancellations(), 1);
  assert.equal(streamed.response.body?.locked, false);
});

test('external abort interrupts a stalled body read without waiting for cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled');
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(encoder.encode('{')); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }), { headers: { 'Content-Type': 'application/json' } });
  const result = readMiNoteResponse(response, controller.signal, 64);
  const rejected = assert.rejects(result, (error: unknown) => error === reason);
  await Promise.resolve();
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test('a failing response stream preserves its error and releases its reader', async () => {
  const failure = new Error('Network interrupted');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(failure); },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(readMiNoteResponse(response, signal(), 64), (error: unknown) => error === failure);
  assert.equal(response.body?.locked, false);
});
