import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getShipStationShipmentById,
  parseShipStationShipTo,
  validateShipStationShipTo,
  type ShipStationAddress,
} from '../shared/shipstationRates.ts';

function address(locality: string, country: string): string {
  return `Morgan Example\n12 Example Street\n${locality}\n${country}`;
}

for (const [country, locality, city, state, postal] of [
  ['US', 'Pittsburgh, PA 15222-1234', 'Pittsburgh', 'PA', '15222-1234'],
  ['US', 'Pittsburgh PA 15222', 'Pittsburgh', 'PA', '15222'],
  ['CA', 'Toronto, Ontario M5V 3A8', 'Toronto', 'Ontario', 'M5V 3A8'],
  ['CA', 'Vancouver, British Columbia V6B 1A1', 'Vancouver', 'British Columbia', 'V6B 1A1'],
  ['CA', 'V6B 1A1 Vancouver BC', 'Vancouver', 'BC', 'V6B 1A1'],
  ['GB', 'London, Greater London SW1A 1AA', 'London', 'Greater London', 'SW1A 1AA'],
  ['GB', 'London, Greater London, England SW1A 1AA', 'London', 'Greater London, England', 'SW1A 1AA'],
  ['GB', 'London, England SW1A  1AA', 'London', 'England', 'SW1A 1AA'],
  ['GB', 'London, , SW1A  1AA', 'London', '', 'SW1A 1AA'],
  ['GB', 'SW1A  1AA London', 'London', '', 'SW1A 1AA'],
  ['GB', 'London SW1A 1AA', 'London', '', 'SW1A 1AA'],
  ['DE', '10115 Berlin', 'Berlin', '', '10115'],
  ['DE', '61348 Bad Homburg', 'Bad Homburg', '', '61348'],
  ['SE', '111 22 Stockholm', 'Stockholm', '', '111 22'],
  ['FR', 'Paris, Île-de-France 75001', 'Paris', 'Île-de-France', '75001'],
  ['FR', '75001 Paris 1er', 'Paris 1er', '', '75001'],
  ['ES', 'Madrid, Comunidad de Madrid, Madrid 28001', 'Madrid', 'Comunidad de Madrid, Madrid', '28001'],
  ['ES', 'Madrid, Comunidad de Madrid, M 28001', 'Madrid', 'Comunidad de Madrid, M', '28001'],
  ['ES', 'Barcelona, Cataluña, CT 08001', 'Barcelona', 'Cataluña, CT', '08001'],
  ['ES', 'Madrid, Comunidad de Madrid, 28001', 'Madrid', 'Comunidad de Madrid', '28001'],
  ['ES', 'Madrid, Comunidad de Madrid E-28001', 'Madrid', 'Comunidad de Madrid', 'E-28001'],
  ['MX', 'Tijuana, Baja California, BC 22000', 'Tijuana', 'Baja California, BC', '22000'],
  ['PT', 'Lisbon, Lisboa, L 1000-001', 'Lisbon', 'Lisboa, L', '1000-001'],
  ['GR', 'Athens, Attica 105 58', 'Athens', 'Attica', '105 58'],
  ['GR', 'Athens, Attica, Athens 105 58', 'Athens', 'Attica, Athens', '105 58'],
  ['GR', 'Athens, 105 58', 'Athens', '', '105 58'],
  ['GR', 'Athens, Attica 105  \t58', 'Athens', 'Attica', '105 58'],
  ['GR', 'Athens, District 1, 105 58', 'Athens', 'District 1', '105 58'],
  ['TW', 'Taipei, Taipei 100 006', 'Taipei', 'Taipei', '100 006'],
  ['CH', 'Zürich, Zürich, ZH 8001', 'Zürich', 'Zürich, ZH', '8001'],
  ['BR', 'São Paulo, São Paulo, SP 01310-100', 'São Paulo', 'São Paulo, SP', '01310-100'],
  ['AT', 'Wien, Wien, W 1010', 'Wien', 'Wien, W', '1010'],
  ['IT', 'Rome, Lazio, RM 00100', 'Rome', 'Lazio, RM', '00100'],
  ['IT', 'Rome, RM 00100', 'Rome', 'RM', '00100'],
  ['IT', 'Rome, RM, 00100', 'Rome', 'RM', '00100'],
  ['IT', 'Rome, RM I-00100', 'Rome', 'RM', 'I-00100'],
  ['IN', 'New Delhi, Delhi 110 001', 'New Delhi', 'Delhi', '110 001'],
  ['IN', 'Bengaluru, Karnataka, 560 001', 'Bengaluru', 'Karnataka', '560 001'],
  ['TR', 'Istanbul, 34000', 'Istanbul', '', '34000'],
  ['AU', 'Sydney, New South Wales 2000', 'Sydney', 'New South Wales', '2000'],
  ['AU', 'Sydney NSW 2000', 'Sydney', 'NSW', '2000'],
  ['NL', '1012 JS Amsterdam', 'Amsterdam', '', '1012 JS'],
  ['IE', 'Dublin, D02 X285', 'Dublin', '', 'D02 X285'],
  ['IE', 'Dublin, Dublin, Leinster D02 X285', 'Dublin', 'Dublin, Leinster', 'D02 X285'],
  ['IE', 'Dublin, D02  X285', 'Dublin', '', 'D02 X285'],
  ['AR', '9 de Julio, ,', '9 de Julio', '', ''],
  ['AR', '9 de Julio', '9 de Julio', '', ''],
  ['AR', 'Buenos Aires, Buenos Aires C1425 FQB', 'Buenos Aires', 'Buenos Aires', 'C1425 FQB'],
  ['AR', 'Buenos Aires, Buenos Aires C1425FQB', 'Buenos Aires', 'Buenos Aires', 'C1425FQB'],
  ['AR', 'Buenos Aires, Buenos Aires 1425', 'Buenos Aires', 'Buenos Aires', '1425'],
  ['AR', 'Buenos Aires, Buenos Aires, C1425 FQB', 'Buenos Aires', 'Buenos Aires', 'C1425 FQB'],
  ['GH', 'Accra, Greater Accra GA-183', 'Accra', 'Greater Accra', 'GA-183'],
  ['GH', 'Accra, Greater Accra GA-183-8164', 'Accra', 'Greater Accra', 'GA-183-8164'],
  ['GH', 'Accra, Greater Accra, GA-183', 'Accra', 'Greater Accra', 'GA-183'],
  ['GH', 'Accra, Greater Accra, GA-183-8164', 'Accra', 'Greater Accra', 'GA-183-8164'],
  ['KN', 'Basseterre, Saint George Basseterre KN0101', 'Basseterre', 'Saint George Basseterre', 'KN0101'],
  ['KN', 'Basseterre, Saint George Basseterre, KN0101', 'Basseterre', 'Saint George Basseterre', 'KN0101'],
  ['KN', 'Basseterre, Saint George Basseterre,', 'Basseterre', 'Saint George Basseterre', ''],
  ['KN', 'Basseterre, Saint George Basseterre 00000', 'Basseterre', 'Saint George Basseterre', '00000'],
  ['KN', 'Basseterre, District 1', 'Basseterre', 'District 1', ''],
  ['LC', 'Castries, Castries LC03101', 'Castries', 'Castries', 'LC03101'],
  ['LC', 'Castries, Castries LC03 101', 'Castries', 'Castries', 'LC03 101'],
  ['LC', 'Castries, Castries, LC03101', 'Castries', 'Castries', 'LC03101'],
  ['LC', 'Castries, Castries, LC03 101', 'Castries', 'Castries', 'LC03 101'],
  ['LC', 'Castries, ,', 'Castries', '', ''],
  ['LC', 'Castries, Castries 00000', 'Castries', 'Castries', '00000'],
  ['LC', 'Castries, District 1', 'Castries', 'District 1', ''],
  ['EG', '6th of October, ,', '6th of October', '', ''],
  ['IE', 'Dublin 2', 'Dublin 2', '', ''],
  ['HK', 'Hong Kong, Kowloon', 'Hong Kong', 'Kowloon', ''],
  ['HK', 'Hong Kong, Kowloon 00000', 'Hong Kong', 'Kowloon', '00000'],
  ['HK', 'Hong Kong, Kowloon 999077', 'Hong Kong', 'Kowloon', '999077'],
  ['HK', 'Hong Kong, District 1 999077', 'Hong Kong', 'District 1', '999077'],
  ['HK', 'Hong Kong, Kowloon, HK 00000', 'Hong Kong', 'Kowloon, HK', '00000'],
  ['HK', 'Hong Kong, District 1', 'Hong Kong', 'District 1', ''],
  ['HK', 'Hong Kong, District 1 000000', 'Hong Kong', 'District 1', '000000'],
  ['HK', 'Hong Kong, District 1, 000000', 'Hong Kong', 'District 1', '000000'],
  ['AE', 'Dubai, Dubai', 'Dubai', 'Dubai', ''],
  ['AE', 'Dubai, Dubai 00000', 'Dubai', 'Dubai', '00000'],
  ['AE', 'Dubai, Dubai 12345', 'Dubai', 'Dubai', '12345'],
  ['SH', 'Jamestown, Saint Helena, STHL 1ZZ', 'Jamestown', 'Saint Helena', 'STHL 1ZZ'],
  ['BM', 'Hamilton, Pembroke, HM 12', 'Hamilton', 'Pembroke', 'HM 12'],
  ['BM', "Tucker's Town", "Tucker's Town", '', ''],
  ['BN', 'Bandar Seri Begawan, Brunei-Muara, BA 8610', 'Bandar Seri Begawan', 'Brunei-Muara', 'BA 8610'],
  ['OM', 'Muscat, Muscat, PC 133', 'Muscat', 'Muscat', 'PC 133'],
  ['PE', 'Lima, Lima, LIMA 23', 'Lima', 'Lima', 'LIMA 23'],
  ['PE', 'Callao, Callao, CALLAO 2', 'Callao', 'Callao', 'CALLAO 2'],
  ['SO', 'Kismayo, Lower Juba, JH 09010', 'Kismayo', 'Lower Juba', 'JH 09010'],
  ['SZ', 'Mbabane, Hhohho, H 100', 'Mbabane', 'Hhohho', 'H 100'],
  ['AZ', 'Baku, Absheron, AZ 1000', 'Baku', 'Absheron', 'AZ 1000'],
  ['LV', 'Riga, Riga, LV 1050', 'Riga', 'Riga', 'LV 1050'],
  ['LB', 'Beirut, Beirut, 1107 2809', 'Beirut', 'Beirut', '1107 2809'],
  ['LB', 'Beirut, Beirut 1107 2809', 'Beirut', 'Beirut', '1107 2809'],
  ['LB', 'Beirut, Beirut 1107  \t2809', 'Beirut', 'Beirut', '1107 2809'],
  ['LB', 'Beirut, 1107 2809', 'Beirut', '', '1107 2809'],
]) {
  test(`ShipStation parses ${country} locality ${locality}`, () => {
    const result = parseShipStationShipTo(address(locality, country), country);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.shipTo?.city_locality, city);
    assert.equal(result.shipTo?.state_province, state);
    assert.equal(result.shipTo?.postal_code, postal);
    assert.equal(result.shipTo?.country_code, country);
  });
}

for (const [country, city, region, postal] of [
  ['DE', 'Berlin', 'Berlin', 'D-10115'],
  ['DE', 'Berlin', 'Berlin', 'DE-10115'],
  ['DE', 'Berlin', 'Berlin', 'D - 10115'],
  ['CH', 'Zürich', 'Zürich', 'CH-8001'],
  ['FR', 'Paris', 'Île-de-France', 'F-75001'],
  ['AT', 'Wien', 'Wien', 'A-1010'],
  ['NL', 'Amsterdam', 'Noord-Holland', 'NL-1012 JS'],
  ['SE', 'Stockholm', 'Stockholm', 'S-111 22'],
]) {
  test(`ShipStation preserves the country prefix in ${postal} across address layouts`, () => {
    for (const [locality, expectedRegion] of [
      [`${city}, ${region} ${postal}`, region],
      [`${city}, ${region}, ${postal}`, region],
      [`${postal} ${city}`, ''],
      [`${city}\n${postal}`, ''],
    ]) {
      const result = parseShipStationShipTo(address(locality, country), country);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.shipTo?.city_locality, city);
      assert.equal(result.shipTo?.state_province, expectedRegion);
      assert.equal(result.shipTo?.postal_code, postal);
      assert.equal(result.shipTo?.address_line1, '12 Example Street');
      assert.equal(result.shipTo?.address_line2, undefined);
    }
  });
}

for (const [country, city, postal] of [
  ['JE', 'Saint Helier', 'JE2 3NG'],
  ['GG', 'Sark', 'GY10 1PB'],
  ['IM', 'Douglas', 'IM1 1AF'],
  ['GI', 'Gibraltar', 'GX11 1AA'],
  ['LC', 'Castries', 'LC03 101'],
]) {
  test(`ShipStation preserves complete ${country} postcodes across address layouts`, () => {
    for (const locality of [`${city}, ${postal}`, `${postal} ${city}`, `${city}\n${postal}`]) {
      const parsed = parseShipStationShipTo(address(locality, country), country);
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      assert.equal(parsed.shipTo?.city_locality, city);
      assert.equal(parsed.shipTo?.state_province, '');
      assert.equal(parsed.shipTo?.postal_code, postal);
      assert.equal(parsed.shipTo?.address_line2, undefined);
    }
    const compactPostal = postal.replace(' ', '').toLowerCase();
    const compact = parseShipStationShipTo(address(`${city}, ${compactPostal}`, country), country);
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.shipTo?.state_province, '');
    assert.equal(compact.shipTo?.postal_code, compactPostal);
  });
}

for (const [city, region, postal] of [
  ['Hamilton', 'Pembroke', 'HM GX'],
  ['Hamilton', 'Pembroke', 'HM BX'],
  ['Hamilton', 'Pembroke', 'HM CX'],
  ['Paget', 'Paget', 'PG BX'],
]) {
  test(`ShipStation preserves alphabetic Bermuda postcode ${postal} across address layouts`, () => {
    for (const value of [postal, postal.replace(' ', ''), postal.replace(' ', '').toLowerCase()]) {
      for (const locality of [
        `${city}, ${value}`, `${city}, , ${value}`, `${value} ${city}`,
        `${city} ${value}`, `${city}\n${value}`,
      ]) {
        const parsed = parseShipStationShipTo(address(locality, 'BM'), 'BM');
        assert.equal(parsed.ok, true, JSON.stringify(parsed));
        assert.equal(parsed.shipTo?.city_locality, city);
        assert.equal(parsed.shipTo?.state_province, '');
        assert.equal(parsed.shipTo?.postal_code, value);
        assert.equal(parsed.shipTo?.address_line2, undefined);
      }
    }
    const compact = postal.replace(' ', '').toLowerCase();
    const explicit = parseShipStationShipTo(address(`${city}, ${region}, ${compact}`, 'BM'), 'BM');
    assert.equal(explicit.ok, true);
    assert.equal(explicit.shipTo?.state_province, region);
    assert.equal(explicit.shipTo?.postal_code, compact);
  });
}

test('ShipStation preserves an explicitly supplied postal code when region is optional', () => {
  const result = parseShipStationShipTo(address('Accra, , 00000', 'Ghana'));
  assert.equal(result.ok, true);
  assert.equal(result.shipTo?.city_locality, 'Accra');
  assert.equal(result.shipTo?.state_province, '');
  assert.equal(result.shipTo?.postal_code, '00000');
});

for (const [country, city] of [['EG', '6th of October'], ['EG', 'District 1']]) {
  test(`ShipStation does not invent a postcode from freeform city ${city}`, () => {
    const result = parseShipStationShipTo(address(city, country), country);
    assert.equal(result.ok, false);
    assert.equal(result.shipTo?.city_locality, '');
    assert.equal(result.shipTo?.postal_code, '');
    assert.deepEqual(result.correctionFields, ['city_locality']);
  });
}

test('ShipStation asks for both city and region when a required province is ambiguous', () => {
  const result = parseShipStationShipTo(address('Vancouver British Columbia V6B 1A1', 'Canada'));
  assert.equal(result.ok, false);
  assert.equal(result.shipTo?.city_locality, '');
  assert.equal(result.shipTo?.state_province, '');
  assert.equal(result.shipTo?.postal_code, 'V6B 1A1');
  assert.deepEqual(result.correctionFields, ['city_locality', 'state_province']);
});

test('ShipStation resolves legacy country names without a saved ISO code', () => {
  assert.equal(parseShipStationShipTo(address('Toronto, Ontario M5V 3A8', 'Canada')).shipTo?.country_code, 'CA');
  assert.equal(parseShipStationShipTo(address('Istanbul, 34000', 'Turkey'), 'INTL').shipTo?.country_code, 'TR');
});

test('ShipStation uses the edited country before a stored country-name fallback', () => {
  for (const countryCode of [undefined, 'INTL']) {
    const result = parseShipStationShipTo(address('Berlin, 10115', 'DE'), countryCode, 'France');
    assert.equal(result.ok, true);
    assert.equal(result.shipTo?.country_code, 'DE');
  }
  assert.equal(parseShipStationShipTo(address('Berlin, 10115', 'Germany'), undefined, 'France').shipTo?.country_code, 'DE');
  assert.equal(parseShipStationShipTo(address('Berlin, 10115', 'DE'), 'FR', 'France').shipTo?.country_code, 'FR');
  const fallback = parseShipStationShipTo(address('Paris, 75001', 'Other (International)'), 'INTL', 'France');
  assert.equal(fallback.ok, true);
  assert.equal(fallback.shipTo?.country_code, 'FR');
});

test('ShipStation accepts a separate postcode line without sending the city as a street', () => {
  const result = parseShipStationShipTo('Morgan Example\n12 Example Street\nLondon\nSW1A 1AA\nUnited Kingdom');
  assert.equal(result.ok, true);
  assert.equal(result.shipTo?.city_locality, 'London');
  assert.equal(result.shipTo?.postal_code, 'SW1A 1AA');
  assert.equal(result.shipTo?.address_line1, '12 Example Street');
  assert.equal(result.shipTo?.address_line2, undefined);
});

for (const [country, locality, city, region, postal] of [
  ['GR', 'Athens\n105 58', 'Athens', '', '105 58'],
  ['GR', 'Athens\n105  \t58', 'Athens', '', '105 58'],
  ['GR', 'Athens, Attica\n105 58', 'Athens', 'Attica', '105 58'],
  ['GR', 'Athens, District 1\n105 58', 'Athens', 'District 1', '105 58'],
  ['CA', 'Toronto ON\nM5V 3A8', 'Toronto', 'ON', 'M5V 3A8'],
]) {
  test(`ShipStation keeps the city and separate ${country} postcode distinct: ${locality}`, () => {
    const result = parseShipStationShipTo(address(locality, country), country);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.shipTo?.city_locality, city);
    assert.equal(result.shipTo?.state_province, region);
    assert.equal(result.shipTo?.postal_code, postal);
    assert.equal(result.shipTo?.address_line1, '12 Example Street');
    assert.equal(result.shipTo?.address_line2, undefined);
  });
}

test('ShipStation does not invent a city from a standalone postcode', () => {
  const result = parseShipStationShipTo(address('105 58', 'GR'), 'GR');
  assert.equal(result.ok, false);
  assert.equal(result.shipTo?.city_locality ?? '', '');
});

test('ShipStation keeps known fields available when a legacy country needs correction', () => {
  const result = parseShipStationShipTo(address('Accra, Greater Accra GA-123-4567', 'Other (International)'), 'INTL');
  assert.equal(result.ok, false);
  assert.equal(result.shipTo?.name, 'Morgan Example');
  assert.equal(result.shipTo?.address_line1, '12 Example Street');
  assert.ok(result.correctionFields?.includes('country_code'));
  assert.equal(result.shipTo?.country_code, '');
});

test('ShipStation requests a missing postcode instead of treating the region as a postcode', () => {
  const result = parseShipStationShipTo(address('Toronto, Ontario', 'Canada'));
  assert.equal(result.ok, false);
  assert.equal(result.shipTo?.city_locality, 'Toronto');
  assert.equal(result.shipTo?.state_province, 'Ontario');
  assert.equal(result.shipTo?.postal_code, '');
  assert.deepEqual(result.correctionFields, ['postal_code']);
});

test('ShipStation requests structured correction for ambiguous locality text', () => {
  const result = parseShipStationShipTo(address('London 123 wrong', 'United Kingdom'));
  assert.equal(result.ok, false);
  assert.equal(result.shipTo?.city_locality, '');
  assert.equal(result.shipTo?.postal_code, '');
  assert.deepEqual(result.correctionFields, ['city_locality', 'postal_code']);
});

test('ShipStation validates corrected countries against their own required fields', () => {
  const parsed = parseShipStationShipTo(address('Dubai, Dubai', 'Other (International)'), 'INTL');
  assert.ok(parsed.shipTo);
  assert.equal(parsed.ok, false);
  const corrected = validateShipStationShipTo({ ...parsed.shipTo, country_code: 'AE' });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.shipTo?.postal_code, '');
  assert.equal(validateShipStationShipTo({ ...parsed.shipTo, country_code: 'ZZ' }).ok, false);
});

test('ShipStation normalizes whitespace in explicitly corrected postal codes', () => {
  const parsed = parseShipStationShipTo(address('London, SW1A 1AA', 'United Kingdom'));
  assert.ok(parsed.shipTo);
  const corrected = validateShipStationShipTo({ ...parsed.shipTo, postal_code: '  SW1A  \t1AA  ' });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.shipTo?.postal_code, 'SW1A 1AA');
  assert.equal(corrected.shipTo?.state_province, '');
});

test('ShipStation keeps unavailable addresses unavailable', () => {
  for (const full of [undefined, null, '', '***', 'one\ntwo\nthree']) {
    const parsed = parseShipStationShipTo(full);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.shipTo, undefined);
  }
});

test('ShipStation shipment responses permit empty postal codes only where optional', async () => {
  const shipTo: ShipStationAddress = {
    name: 'Morgan Example',
    address_line1: '12 Example Street',
    city_locality: 'Hong Kong',
    state_province: 'Kowloon',
    postal_code: '',
    country_code: 'HK',
    address_residential_indicator: 'yes',
  };
  const shipment = await getShipStationShipmentById('api-key', 'shipment-hk', {
    fetch: async () => Response.json({ shipment_id: 'shipment-hk', ship_to: shipTo, packages: [] }),
  });
  assert.equal(shipment.ship_to.postal_code, '');
  await assert.rejects(() => getShipStationShipmentById('api-key', 'shipment-us', {
    fetch: async () => Response.json({
      shipment_id: 'shipment-us',
      ship_to: { ...shipTo, country_code: 'US' },
      packages: [],
    }),
  }));
});
