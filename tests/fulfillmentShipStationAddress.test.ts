import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentShipStationAddressCanRetry,
  fulfillmentShipStationAddressCorrectionFailure,
  fulfillmentShipStationAddressDraft,
  fulfillmentShipStationAddressOtherFailure,
  fulfillmentShipStationAddressPatch,
} from '../src/lib/fulfillmentShipStationAddress.ts';

function baselineDraft() {
  const draft = fulfillmentShipStationAddressDraft({
    full: 'Ivan\n100 Main St\nSuite 4\nBuilding B\nIstanbul, IST 34000\nTurkey',
    countryCode: 'TR',
  });
  assert.ok(draft);
  return draft;
}

test('visible ShipStation addresses use the shared parser and serialize only normalized changes', () => {
  const baseline = baselineDraft();
  const session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['state_province'], {});
  session.draft = {
    ...session.draft,
    address_line2: '   ',
    state_province: ' PA ',
    country_code: ' us ',
  };
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), {
    address_line2: '',
    state_province: 'PA',
    country_code: 'US',
  });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
  assert.equal(fulfillmentShipStationAddressDraft({ full: 'not enough lines', countryCode: 'TR' }), null);
});

test('masked ShipStation addresses collect requested values without revealing saved address data', () => {
  let session = fulfillmentShipStationAddressCorrectionFailure(null, null, ['state_province'], {});
  assert.equal(session.draft.state_province, '');
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { state_province: '' });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);

  session = { ...session, draft: { ...session.draft, state_province: 'PA' } };
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { state_province: 'PA' });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);

  session = fulfillmentShipStationAddressCorrectionFailure(
    session,
    null,
    ['address_line2'],
    { state_province: 'PA' },
  );
  assert.deepEqual(session.visibleFields, ['address_line2']);
  assert.deepEqual(session.requestedFields, ['address_line2', 'state_province']);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), {
    address_line2: '',
    state_province: 'PA',
  });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
});

test('correction sessions hide fields after unrelated failures and preserve accumulated patches', () => {
  const baseline = baselineDraft();
  let session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['state_province'], {});
  session = { ...session, draft: { ...session.draft, state_province: 'PA' } };
  const patch = fulfillmentShipStationAddressPatch(session);
  session = fulfillmentShipStationAddressOtherFailure(session, patch) ?? session;
  assert.deepEqual(session.visibleFields, []);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { state_province: 'PA' });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);

  session = fulfillmentShipStationAddressCorrectionFailure(session, baseline, ['postal_code'], patch);
  assert.deepEqual(session.visibleFields, ['postal_code']);
  assert.equal(session.draft.state_province, 'PA');
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session = { ...session, draft: { ...session.draft, postal_code: '15222' } };
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), {
    state_province: 'PA',
    postal_code: '15222',
  });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
});
