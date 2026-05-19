import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotifyShippersForDeliveryReadyToShipWrite } from '../functions/src/notifications.ts';

test('shouldNotifyShippersForDeliveryReadyToShipWrite accepts create-ready delivery orders', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: null,
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite accepts transitions into ready_to_ship', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'prepared' },
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'processing' },
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores repeated ready_to_ship writes', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'ready_to_ship' },
      after: { status: 'ready_to_ship' },
    }),
    false,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores non-ready creates', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: null,
      after: { status: 'processing' },
    }),
    false,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores deletes', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'ready_to_ship' },
      after: null,
    }),
    false,
  );
});
