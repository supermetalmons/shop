import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShipStationShipTo, validateShipStationShipTo } from '../shared/shipstationRates.ts';

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

test('unresolved legacy countries retain the readable address for correction', () => {
  const baseline = fulfillmentShipStationAddressDraft({
    full: 'Recipient\n100 Main St\nBerlin, Berlin 10115\nOther (International)',
    countryCode: 'INTL',
  });
  assert.ok(baseline);
  assert.equal(baseline.country_code, '');
  assert.equal(baseline.address_line1, '100 Main St');
  const session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['country_code'], {});
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session.draft.country_code = 'ZZ';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session.draft.country_code = 'de';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { country_code: 'DE' });
});

test('address drafts prefer edited country text over a stale fallback country', () => {
  const address = { full: 'Recipient\n1 Example Street\nBerlin, 10115\nDE', country: 'France' };
  for (const countryCode of [undefined, 'INTL']) {
    assert.equal(fulfillmentShipStationAddressDraft({ ...address, countryCode })?.country_code, 'DE');
  }
  assert.equal(fulfillmentShipStationAddressDraft({ ...address, countryCode: 'FR' })?.country_code, 'FR');
});

test('corrections can clear optional region and postcode without clearing required domestic values', () => {
  const baseline = {
    ...baselineDraft(),
    country_code: 'HK',
    state_province: 'Kowloon',
    postal_code: '99999',
  };
  const session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['postal_code'], {});
  session.draft.postal_code = '';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { postal_code: '' });
  session.draft.country_code = 'US';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);

  const german = fulfillmentShipStationAddressCorrectionFailure(null, {
    ...baseline,
    country_code: 'DE',
    state_province: 'Berlin',
    postal_code: '10115',
  }, ['state_province'], {});
  german.draft.state_province = '';
  assert.equal(fulfillmentShipStationAddressCanRetry(german), true);
});

test('hidden-address corrections use the known country without exposing address fields', () => {
  const session = fulfillmentShipStationAddressCorrectionFailure(null, null, ['postal_code'], {}, 'HK');
  assert.equal(session.baseline, null);
  assert.equal(session.draft.country_code, 'HK');
  assert.equal(session.draft.name, '');
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { postal_code: '' });
});

test('country correction failures rebase to the address sent to ShipStation', () => {
  const full = 'Recipient\n1 Example Street\nHong Kong, Kowloon 00000\nOther (International)';
  const baseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'INTL' });
  assert.ok(baseline);
  let session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['country_code'], {});
  session.draft.country_code = 'HK';
  const countryPatch = fulfillmentShipStationAddressPatch(session);
  assert.deepEqual(countryPatch, { country_code: 'HK' });
  const reparsed = parseShipStationShipTo(full, countryPatch.country_code);
  assert.ok(reparsed.shipTo);
  assert.equal(reparsed.shipTo.state_province, 'Kowloon');
  assert.equal(reparsed.shipTo.postal_code, '00000');

  const effectiveBaseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'HK' });
  assert.ok(effectiveBaseline);
  session = fulfillmentShipStationAddressCorrectionFailure(session, effectiveBaseline, ['state_province'], countryPatch);
  assert.equal(session.draft.state_province, 'Kowloon');
  assert.equal(session.draft.postal_code, '00000');
  assert.equal(session.baseline?.country_code, '');
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), countryPatch);
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session.draft.state_province = 'Kowloon';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session.draft.state_province = 'Kowloon City';
  assert.equal(fulfillmentShipStationAddressCanRetry(session), true);
  const regionPatch = fulfillmentShipStationAddressPatch(session);
  assert.deepEqual(regionPatch, { state_province: 'Kowloon City', country_code: 'HK' });
  const corrected = validateShipStationShipTo({ ...reparsed.shipTo, ...regionPatch });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.shipTo?.state_province, 'Kowloon City');
  assert.equal(corrected.shipTo?.postal_code, '00000');

  session = fulfillmentShipStationAddressCorrectionFailure(session, effectiveBaseline, ['state_province'], regionPatch);
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  assert.equal(session.draft.state_province, 'Kowloon City');
  session = fulfillmentShipStationAddressCorrectionFailure(session, effectiveBaseline, ['postal_code'], regionPatch);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), regionPatch);
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
});

test('country reparsing removes stale street lines and canonicalizes the last attempted patch', () => {
  const full = 'Recipient\n1 Example Street\nToronto ON\nM5V 3A8\nOther (International)';
  const baseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'INTL' });
  assert.ok(baseline);
  assert.equal(baseline.address_line2, 'Toronto ON');
  let session = fulfillmentShipStationAddressCorrectionFailure(
    null, baseline, ['city_locality', 'state_province', 'country_code'], {},
  );
  session.draft.city_locality = 'Toronto';
  session.draft.state_province = 'ON';
  session.draft.country_code = 'CA';
  const attemptedPatch = fulfillmentShipStationAddressPatch(session);
  assert.deepEqual(attemptedPatch, { city_locality: 'Toronto', state_province: 'ON', country_code: 'CA' });
  const effectiveBaseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'CA' });
  assert.ok(effectiveBaseline);
  assert.deepEqual(fulfillmentShipStationAddressPatch(session, effectiveBaseline), attemptedPatch);
  session = fulfillmentShipStationAddressCorrectionFailure(
    session, effectiveBaseline,
    ['name', 'address_line1', 'address_line2', 'address_line3', 'city_locality', 'state_province', 'postal_code', 'country_code'],
    attemptedPatch,
  );
  assert.equal(session.draft.address_line2, '');
  assert.equal(session.draft.postal_code, 'M5V 3A8');
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { country_code: 'CA' });
  assert.deepEqual(session.lastAttemptedPatch, { country_code: 'CA' });
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);

  session.draft.address_line1 = '2 Corrected Street';
  const correctedPatch = fulfillmentShipStationAddressPatch(session);
  assert.deepEqual(correctedPatch, { address_line1: '2 Corrected Street', country_code: 'CA' });
  session = fulfillmentShipStationAddressCorrectionFailure(session, effectiveBaseline, ['address_line1'], correctedPatch);
  assert.equal(session.draft.address_line1, '2 Corrected Street');
  assert.equal(session.draft.address_line2, '');
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), correctedPatch);
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
});

test('reverting a corrected country rebases again without discarding explicit edits', () => {
  const full = 'Recipient\n1 Example Street\nHong Kong, Kowloon 00000\nOther (International)';
  const baseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'US' });
  const hongKongBaseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'HK' });
  assert.ok(baseline);
  assert.ok(hongKongBaseline);
  let session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['country_code'], {});
  session.draft.country_code = 'HK';
  session = fulfillmentShipStationAddressCorrectionFailure(
    session, hongKongBaseline, ['state_province'], fulfillmentShipStationAddressPatch(session),
  );
  session.draft.country_code = 'US';
  session.draft.address_line1 = '2 Corrected Street';
  const revertingPatch = fulfillmentShipStationAddressPatch(session);
  assert.deepEqual(revertingPatch, { address_line1: '2 Corrected Street' });
  session = fulfillmentShipStationAddressCorrectionFailure(session, baseline, ['country_code'], revertingPatch);
  assert.equal(session.draft.country_code, 'US');
  assert.equal(session.draft.state_province, 'Kowloon');
  assert.equal(session.draft.postal_code, '00000');
  assert.equal(session.draft.address_line1, '2 Corrected Street');
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), revertingPatch);
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
});

test('unchanged countries and aliases retain changed-field-only corrections', () => {
  const baseline = { ...baselineDraft(), country_code: 'GB' };
  const session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, ['state_province'], {});
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), {});
  assert.equal(fulfillmentShipStationAddressCanRetry(session), false);
  session.draft.country_code = 'UK';
  assert.deepEqual(fulfillmentShipStationAddressPatch(session), { country_code: 'UK' });
});

test('country changes preserve requested empty fields before the next shipment request', () => {
  const full = 'Recipient\n1 Main Street\nToronto ON\nM5V 3A8\nCanada';
  const baseline = fulfillmentShipStationAddressDraft({ full, countryCode: 'CA' });
  assert.ok(baseline);
  const session = fulfillmentShipStationAddressCorrectionFailure(null, baseline, [
    'name', 'address_line1', 'address_line2', 'address_line3',
    'city_locality', 'state_province', 'postal_code', 'country_code',
  ], {});
  session.draft.country_code = 'US';
  session.draft.city_locality = 'Pittsburgh';
  session.draft.state_province = 'PA';
  session.draft.postal_code = '15222';
  const target = fulfillmentShipStationAddressDraft({ full, countryCode: 'US' });
  assert.ok(target);
  assert.equal(session.draft.address_line2, '');
  assert.equal(target.address_line2, 'Toronto ON');
  const patch = fulfillmentShipStationAddressPatch(session, target);
  assert.deepEqual(patch, {
    address_line2: '', city_locality: 'Pittsburgh', state_province: 'PA', postal_code: '15222', country_code: 'US',
  });
  assert.equal(fulfillmentShipStationAddressCanRetry(session, target), true);
  const parsed = parseShipStationShipTo(full, patch.country_code);
  assert.ok(parsed.shipTo);
  const corrected = validateShipStationShipTo({ ...parsed.shipTo, ...patch });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.shipTo?.address_line2, '');

  const failed = fulfillmentShipStationAddressCorrectionFailure(session, target, ['address_line1'], patch);
  assert.equal(fulfillmentShipStationAddressCanRetry(failed, target), false);
});
