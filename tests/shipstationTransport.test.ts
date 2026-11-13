import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createShipStationLabelFromRate,
  ShipStationLabelProviderError,
} from '../shared/shipstationLabels.ts';
import {
  getShipStationShipmentByExternalId,
  getShipStationShipmentById,
  ShipStationRatesProviderError,
} from '../shared/shipstationRates.ts';
import type { ShipStationClientOptions } from '../shared/shipstationTransport.ts';

const clients = [
  {
    name: 'rates',
    invoke: (options: ShipStationClientOptions) => getShipStationShipmentById('key', 'shipment-1', options),
    Error: ShipStationRatesProviderError,
    maxBytes: 512 * 1024,
  },
  {
    name: 'labels',
    invoke: (options: ShipStationClientOptions) => createShipStationLabelFromRate('key', 'rate-1', options),
    Error: ShipStationLabelProviderError,
    maxBytes: 256 * 1024,
  },
] as const;

function pendingBody() {
  const reading = Promise.withResolvers<void>();
  const cancellations: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel(reason) { cancellations.push(reason); },
  }, { highWaterMark: 0 });
  return { body, reading: reading.promise, cancellations };
}

function successBody(bytes: number): string {
  const payload = {
    shipment_id: 'shipment-1',
    label_id: 'label-1',
    status: 'completed',
    ship_to: {
      name: 'Test Recipient', address_line1: '123 Main St', city_locality: 'New York',
      state_province: 'NY', postal_code: '10001', country_code: 'US',
      address_residential_indicator: 'yes',
    },
    packages: [],
    padding: '',
  };
  payload.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(payload)));
  return JSON.stringify(payload);
}

for (const client of clients) {
  test(`${client.name} preserves caller cancellation while reading the response body`, async () => {
    const controller = new AbortController();
    const reason = new Error('Caller stopped reading the shipment');
    const stream = pendingBody();
    const rejected = assert.rejects(client.invoke({
      fetch: async () => new Response(stream.body),
      signal: controller.signal,
    }), error => error === reason);
    await stream.reading;
    controller.abort(reason);
    await rejected;
    assert.deepEqual(stream.cancellations, [reason]);
  });

  test(`${client.name} times out and cancels a response body that stops producing data`, async () => {
    const stream = pendingBody();
    let startedReading = false;
    void stream.reading.then(() => { startedReading = true; });
    await assert.rejects(client.invoke({
      fetch: async () => new Response(stream.body),
      timeoutMs: 20,
    }), error => error instanceof client.Error && error.code === 'deadline-exceeded');
    assert.equal(startedReading, true);
    assert.equal(stream.cancellations.length, 1);
    assert.ok(stream.cancellations[0] instanceof DOMException);
    assert.equal(stream.cancellations[0].name, 'TimeoutError');
  });

  for (const announcedLength of [true, false]) {
    test(`${client.name} cancels ${announcedLength ? 'declared' : 'streamed'} oversized responses`, async () => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.enqueue(new Uint8Array(20));
        },
        cancel() { cancellations += 1; },
      });
      await assert.rejects(client.invoke({
        fetch: async () => new Response(body, {
          headers: announcedLength ? { 'Content-Length': '40' } : {},
        }),
        maxResponseBytes: 32,
      }), error => error instanceof client.Error && error.code === 'unavailable' && /oversized/.test(error.message));
      assert.equal(cancellations, 1);
    });
  }

  test(`${client.name} retains its default ${client.maxBytes / 1024} KiB response limit`, async () => {
    await client.invoke({ fetch: async () => new Response(successBody(client.maxBytes)) });
    await assert.rejects(client.invoke({
      fetch: async () => new Response(successBody(client.maxBytes + 1)),
    }), error => error instanceof client.Error && error.code === 'unavailable' && /oversized/.test(error.message));
  });

  test(`${client.name} retains its provider error class for response stream failures`, async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('Upstream stream failed')); },
    });
    await assert.rejects(client.invoke({
      fetch: async () => new Response(body),
    }), error => error instanceof client.Error && error.code === 'unavailable');
  });
}

test('external shipment lookup treats a malformed-JSON 404 as a missing shipment', async () => {
  assert.equal(await getShipStationShipmentByExternalId('key', 'order-1', {
    fetch: async () => new Response('not-json', { status: 404 }),
  }), null);
});

test('malformed success JSON retains each endpoint recovery classification', async () => {
  await assert.rejects(getShipStationShipmentById('key', 'shipment-1', {
    fetch: async () => new Response('not-json'),
  }), error => error instanceof ShipStationRatesProviderError && error.code === 'unavailable');
  await assert.rejects(createShipStationLabelFromRate('key', 'rate-1', {
    fetch: async () => new Response('not-json'),
  }), error => error instanceof ShipStationLabelProviderError && error.code === 'internal');
});
