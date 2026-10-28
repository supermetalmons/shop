import assert from 'node:assert/strict';
import test from 'node:test';

import { shipStationErrorDetails } from '../shared/shipstationErrors.ts';
import {
  createShipStationLabelFromRate,
  getShipStationLabelById,
  listShipStationLabelsForShipment,
  ShipStationLabelProviderError,
  voidShipStationLabel,
} from '../shared/shipstationLabels.ts';
import {
  createShipStationShipment,
  getShipStationRateById,
  ShipStationAddressCorrectionProviderError,
  ShipStationRatesProviderError,
} from '../shared/shipstationRates.ts';

test('unspecified ShipStation errors explain recognizable causes without returning provider text', () => {
  for (const [message, expected] of [
    ['Invalid customs declaration for Recipient at 12 Private Street', /customs declaration/],
    ['Phone number for Recipient at 12 Private Street is required', /phone number/],
    ['Rate se-private expired for Recipient at 12 Private Street', /rate expired.*Refresh rates/],
    ['Insufficient funds for Recipient at 12 Private Street', /Insufficient ShipStation funds/],
  ] as const) {
    const result = shipStationErrorDetails({
      request_id: 'req-123',
      errors: [{ error_code: 'unspecified', error_type: 'business_rules', error_source: 'carrier', message }],
    }, 'Request failed', 400);
    assert.match(result.message, expected);
    assert.match(result.message, /type: business_rules, source: carrier/);
    assert.match(result.message, /HTTP 400; request ID: req-123/);
    assert.equal(result.diagnostics.status, 400);
    assert.equal(result.diagnostics.requestId, 'req-123');
    assert.equal(result.diagnostics.errors[0].code, 'unspecified');
    assert.doesNotMatch(JSON.stringify(result), /Recipient|Private|se-private/);
  }
});

test('unspecified ShipStation errors preserve honest fallback and safe support context', () => {
  const result = shipStationErrorDetails({
    request_id: 'req-123',
    errors: [{ error_code: 'unspecified', error_type: 'system', error_source: 'shipengine' }],
  }, 'Request failed', 400);
  assert.match(result.message, /did not provide a specific error code/);
  assert.match(result.message, /type: system, source: shipengine/);
  assert.match(result.message, /HTTP 400; request ID: req-123/);
  assert.notEqual(result.message, 'unspecified');
  assert.doesNotMatch(shipStationErrorDetails({
    errors: [{ error_code: 'UNSPECIFIED' }],
  }, 'Request failed').message, /code: UNSPECIFIED/);
  assert.deepEqual(shipStationErrorDetails({}, 'No explanation provided', 502), {
    message: 'No explanation provided [HTTP 502]',
    diagnostics: { status: 502, errors: [] },
  });
});

test('coded ShipStation errors retain useful safe explanations from the message', () => {
  const result = shipStationErrorDetails({
    errors: [{ error_code: 'validation_error', message: 'Phone number required for Private Recipient' }],
  }, 'Request failed', 400);
  assert.match(result.message, /phone number/);
  assert.match(result.message, /code: validation_error/);
  assert.doesNotMatch(JSON.stringify(result), /Private Recipient/);
});

test('explicit ShipStation codes take priority over misleading message keywords', () => {
  for (const [code, type, message, expected] of [
    ['invalid_status', 'business_rules', 'There was a problem with the request in its current state.', /status does not allow/],
    ['trial_expired', 'account_status', 'Your trial has expired. Upgrade your plan to request a rate.', /account trial has expired/],
    ['carrier_disconnected', 'integrations', 'The postal service account is in an invalid state.', /carrier_disconnected/],
  ] as const) {
    const result = shipStationErrorDetails({ errors: [{ error_code: code, error_type: type, message }] }, 'Request failed', 400);
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /state or province|postal code|Refresh rates/);
  }
});

test('non-validation error types do not infer address or rate problems from text', () => {
  for (const type of ['account_status', 'security', 'system', 'integrations']) {
    const result = shipStationErrorDetails({ errors: [{
      error_code: 'unspecified', error_type: type,
      message: 'Your trial has expired. Upgrade your plan to request a rate.',
    }] }, 'Request failed', 400);
    assert.match(result.message, /did not provide a specific error code/);
    assert.doesNotMatch(result.message, /Refresh rates/);
  }
});

test('state and postal messages require geographic context', () => {
  for (const message of ['The request is in an invalid state.', 'US Postal Service account is disabled.']) {
    const result = shipStationErrorDetails({ errors: [{ error_code: 'unspecified', message }] }, 'Request failed');
    assert.doesNotMatch(result.message, /state or province|postal code/);
  }
  for (const message of ['The recipient state is invalid.', 'The state abbreviation is required.']) {
    assert.match(shipStationErrorDetails({ errors: [{ error_code: 'unspecified', message }] }, 'Request failed').message,
      /state or province/);
  }
});

test('USPS full-name rejection explains the exact carrier rule without exposing names', async () => {
  const message = 'A shipping carrier error occurred: If provided, fullname must contain at least 2 alphabetic characters, followed by a space, followed by at least another 2 alphabetic characters. Exception with code 0x00650111; module 101, category 1, item 17';
  await assert.rejects(createShipStationLabelFromRate('key', 'rate', {
    fetch: async () => Response.json({
      request_id: '4456e19c-597c-4650-84bc-e4ffbb01ff1a',
      errors: [{
        error_code: 'unspecified', error_type: 'business_rules', error_source: 'carrier',
        field_name: 'shipment.ship_from.name',
        field_value: 'Private Recipient', message: `${message}. Name supplied: Private Recipient`,
      }],
    }, { status: 400 }),
  }), (error: unknown) => {
    assert.ok(error instanceof ShipStationLabelProviderError);
    assert.equal(error.code, 'failed-precondition');
    assert.match(error.message, /first and last names with at least 2 letters each/);
    assert.match(error.message, /Check both sender and recipient names/);
    assert.match(error.message, /HTTP 400; request ID: 4456e19c-597c-4650-84bc-e4ffbb01ff1a/);
    assert.equal(error.diagnostics?.errors[0].summary,
      'The carrier requires first and last names with at least 2 letters each. Check both sender and recipient names.');
    assert.doesNotMatch(JSON.stringify(error), /Private Recipient|0x00650111|module 101/);
    return true;
  });
  const unrelated = shipStationErrorDetails({
    errors: [{ error_code: 'unspecified', message: 'Unknown error for fullname Private Recipient' }],
  }, 'Request failed');
  assert.match(unrelated.message, /did not provide a specific error code/);
});

test('text-length errors stay distinct from package dimensions', () => {
  for (const [field, message] of [
    ['ship_to.name', 'The length of name must be between 1 and 50 characters.'],
    ['ship_to.address_line1', 'The address exceeds the maximum length of 50 characters.'],
    ['packages[0].content_description', 'Package description length exceeds 50 characters.'],
  ]) {
    const result = shipStationErrorDetails({ errors: [{
      error_code: 'invalid_string_length', field_name: field, message,
    }] }, 'Request failed', 400);
    assert.doesNotMatch(result.message, /package dimensions/);
    assert.ok(result.message.includes(`field: ${field}`));
  }
  for (const message of ['Package length exceeds the limit.', 'The height of the parcel exceeds the limit.']) {
    assert.match(shipStationErrorDetails({ errors: [{ error_code: 'unspecified', message }] }, 'Request failed').message,
      /package dimensions/);
  }
  assert.match(shipStationErrorDetails({ errors: [{ field_name: 'packages[0].length' }] }, 'Request failed').message,
    /package dimensions/);
});

test('ShipStation rate validity errors only claim expiry when the provider reports it', () => {
  const result = shipStationErrorDetails({
    errors: [{ error_code: 'unspecified', message: 'The rate is no longer valid for Private Recipient' }],
  }, 'Request failed', 400);
  assert.match(result.message, /rate is no longer valid.*Refresh rates/);
  assert.doesNotMatch(result.message, /expired|Private Recipient/);
});

test('ShipStation error categories do not mistake parts of words for address fields', () => {
  for (const message of [
    'Service unavailable for shipments to the United States',
    'Carrier capacity exceeded',
    'Regional service unavailable',
  ]) {
    const result = shipStationErrorDetails({
      errors: [{ error_code: 'unspecified', message }],
    }, 'Request failed', 400);
    assert.match(result.message, /did not provide a specific error code/);
    assert.doesNotMatch(result.message, /state or province|problem with the city/);
  }
  assert.match(shipStationErrorDetails({
    errors: [{ error_code: 'unspecified', field_name: 'shipment.ship_to.state_province' }],
  }, 'Request failed').message, /state or province/);
});

test('unrecognized ShipStation response shapes keep honest fallback and support context', async () => {
  await assert.rejects(createShipStationLabelFromRate('key', 'rate', {
    fetch: async () => Response.json({ request_id: 'req-unknown', message: 'Unrecognized private provider explanation' }, { status: 400 }),
  }), (error: unknown) => {
    assert.ok(error instanceof ShipStationLabelProviderError);
    assert.equal(error.code, 'failed-precondition');
    assert.match(error.message, /ShipStation returned an unrecognized error/);
    assert.match(error.message, /HTTP 400; request ID: req-unknown/);
    assert.doesNotMatch(error.message, /did not provide|private provider/);
    return true;
  });
});

test('ShipStation diagnostics validate metadata and never retain raw provider payloads', () => {
  const result = shipStationErrorDetails({
    request_id: 'req-private\n12 Private Street',
    message: 'Private recipient',
    errors: [{
      error_code: 'unspecified',
      error_source: 'carrier at Private Street',
      error_type: 'validation Private Street',
      field_name: 'shipment.ship_to.phone',
      field_value: '+1-555-private',
      message: 'Phone value for Private Recipient at 12 Private Street',
    }, {
      error_code: 'invalid Private Street',
      field_name: 'ship_to (12 Private Street)',
      field_value: 'private',
    }],
  }, 'Request failed', 400);
  assert.match(result.message, /phone number/);
  assert.match(result.message, /field: shipment.ship_to.phone/);
  assert.equal(result.diagnostics.requestId, undefined);
  assert.equal(result.diagnostics.errors[0].type, undefined);
  assert.equal(result.diagnostics.errors[0].source, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Private|private|555|field_value|"message":"Phone/);
});

test('bounded ShipStation explanations keep their request ID after long error details', () => {
  const requestId = 'a'.repeat(100);
  const result = shipStationErrorDetails({
    request_id: requestId,
    errors: Array.from({ length: 20 }, () => ({
      error_code: 'a'.repeat(100),
      error_type: 'b'.repeat(100),
      error_source: 'c'.repeat(100),
      field_name: 'd'.repeat(128),
    })),
  }, 'Request failed', 400);
  assert.ok(result.message.length <= 420);
  assert.ok(result.message.endsWith(`[HTTP 400; request ID: ${requestId}]`));
  assert.equal(result.diagnostics.errors.length, 5);
});

test('label failures identify the failed operation and preserve classification', async () => {
  const rejected = async () => Response.json({
    request_id: 'req-label',
    errors: [{ error_code: 'unspecified', error_type: 'validation', error_source: 'carrier', message: 'Phone required for Private Recipient' }],
  }, { status: 400 });
  for (const [operation, invoke] of [
    ['label purchase', () => createShipStationLabelFromRate('key', 'rate', { fetch: rejected })],
    ['label lookup', () => getShipStationLabelById('key', 'label', { fetch: rejected })],
    ['label lookup', () => listShipStationLabelsForShipment('key', 'shipment', { fetch: rejected })],
    ['label void request', () => voidShipStationLabel('key', 'label', { fetch: rejected })],
  ] as const) {
    await assert.rejects(invoke, (error: unknown) => {
      assert.ok(error instanceof ShipStationLabelProviderError);
      assert.equal(error.code, 'failed-precondition');
      assert.ok(error.message.startsWith(`ShipStation rejected the ${operation}:`));
      assert.match(error.message, /phone number/);
      assert.equal(error.diagnostics?.requestId, 'req-label');
      assert.equal(error.diagnostics?.status, 400);
      assert.equal(error.diagnostics?.operation, operation);
      assert.doesNotMatch(JSON.stringify(error), /Private Recipient/);
      return true;
    });
  }
});

test('selected-rate failure reports rate lookup rather than a failed shipment purchase', async () => {
  await assert.rejects(
    getShipStationRateById('key', 'rate', 'shipment', {
      fetch: async () => Response.json({
        request_id: 'req-rate',
        errors: [{ error_code: 'unspecified', message: 'The rate has expired for Private Recipient' }],
      }, { status: 400 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ShipStationRatesProviderError);
      assert.equal(error.code, 'failed-precondition');
      assert.match(error.message, /rejected the selected rate lookup/);
      assert.match(error.message, /rate expired.*Refresh rates/);
      assert.equal(error.diagnostics?.requestId, 'req-rate');
      assert.equal(error.diagnostics?.operation, 'selected rate lookup');
      assert.doesNotMatch(JSON.stringify(error), /Private Recipient/);
      return true;
    },
  );
});

test('embedded shipment errors retain HTTP and request context without changing address correction', async () => {
  const address = { name: 'Test', address_line1: 'Test', city_locality: 'Test', state_province: '', postal_code: '12345', country_code: 'US', address_residential_indicator: 'yes' as const };
  await assert.rejects(createShipStationShipment('key', {
    external_shipment_id: 'order', shipment_number: '1', ship_to: address, ship_from: address, packages: [],
  }, {
    fetch: async () => Response.json({
      request_id: 'req-embedded', has_errors: true,
      shipments: [{ errors: [{ error_code: 'unspecified', field_name: 'shipment.ship_to.postal_code', message: 'Private recipient postal code' }] }],
    }, { status: 200 }),
  }), (error: unknown) => {
    assert.ok(error instanceof ShipStationAddressCorrectionProviderError);
    assert.equal(error.code, 'failed-precondition');
    assert.deepEqual(error.fields, ['postal_code']);
    assert.match(error.message, /postal code/);
    assert.equal(error.diagnostics?.requestId, 'req-embedded');
    assert.equal(error.diagnostics?.status, 200);
    assert.equal(error.diagnostics?.operation, 'shipment creation');
    assert.doesNotMatch(JSON.stringify(error), /Private recipient/);
    return true;
  });
});

test('embedded label errors keep ambiguous purchase classification and diagnostic context', async () => {
  await assert.rejects(createShipStationLabelFromRate('key', 'rate', {
    fetch: async () => Response.json({
      request_id: 'req-embedded',
      errors: [{ error_code: 'unspecified', message: 'Customs declaration rejected for Private Recipient' }],
    }),
  }), (error: unknown) => {
    assert.ok(error instanceof ShipStationLabelProviderError);
    assert.equal(error.code, 'internal');
    assert.match(error.message, /label purchase was not confirmed/);
    assert.match(error.message, /customs declaration/);
    assert.equal(error.diagnostics?.requestId, 'req-embedded');
    assert.equal(error.diagnostics?.status, 200);
    assert.equal(error.diagnostics?.operation, 'label purchase');
    assert.doesNotMatch(JSON.stringify(error), /Private Recipient/);
    return true;
  });
});
