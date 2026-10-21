import assert from 'node:assert/strict';
import test from 'node:test';
import { ISO_COUNTRIES } from '../shared/countries.ts';
import {
  countryRequiresPostalCode,
  countryRequiresState,
  countryUsesPostalCode,
  normalizeCountryCode,
} from '../shared/countryNormalization.ts';
import { calculateDeliveryLamports } from '../shared/shipping.ts';
import { COUNTRIES, findCountryByCode } from '../src/lib/countries.ts';

test('the country picker includes real ISO destinations and every displayed country can be normalized', () => {
  assert.equal(ISO_COUNTRIES.length, 249);
  assert.equal(new Set(ISO_COUNTRIES.map(({ code }) => code)).size, 249);
  assert.equal(COUNTRIES.length, 249);
  for (const { code, name } of COUNTRIES) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.equal(normalizeCountryCode(code.toLowerCase()), code);
    assert.equal(normalizeCountryCode(name), code);
  }
  assert.equal(findCountryByCode('JM')?.name, 'Jamaica');
  assert.equal(findCountryByCode('INTL'), undefined);
  assert.equal(findCountryByCode('TR')?.name, 'Turkey');
});

test('legacy country names and aliases resolve without guessing an unknown destination', () => {
  const examples = [
    [' Canada ', 'CA'], ['United Kingdom', 'GB'], ['U.K.', 'GB'], ['Türkiye', 'TR'],
    ['South Korea', 'KR'], ['Republic of Korea', 'KR'], ['Czech Republic', 'CZ'],
    ['Hong Kong', 'HK'], ['Hong Kong SAR China', 'HK'], ['United States of America', 'US'],
    ['U.S.A.', 'US'], ['U.S.', 'US'], ['United_States', 'US'], ['Cote d\'Ivoire', 'CI'], ['UAE', 'AE'],
  ];
  for (const [input, expected] of examples) assert.equal(normalizeCountryCode(input), expected);
  for (const input of ['', 'INTL', 'Other (International)', 'ZZ', '12', 'Atlantis']) {
    assert.equal(normalizeCountryCode(input), '');
    assert.equal(countryRequiresPostalCode(input), true);
    assert.equal(countryRequiresState(input), true);
  }
});

test('address requirements distinguish optional fields from countries without postal codes', () => {
  const examples = [
    { code: 'US', state: true, postal: true, usesPostal: true },
    { code: 'CA', state: true, postal: true, usesPostal: true },
    { code: 'GB', state: false, postal: true, usesPostal: true },
    { code: 'DE', state: false, postal: true, usesPostal: true },
    { code: 'TR', state: false, postal: true, usesPostal: true },
    { code: 'HK', state: true, postal: false, usesPostal: false },
    { code: 'AE', state: true, postal: false, usesPostal: false },
    { code: 'IE', state: false, postal: false, usesPostal: true },
    { code: 'GH', state: false, postal: false, usesPostal: true },
    { code: 'KN', state: true, postal: false, usesPostal: true },
    { code: 'LC', state: false, postal: false, usesPostal: true },
  ];
  for (const { code, state, postal, usesPostal } of examples) {
    assert.equal(countryRequiresState(code), state, code);
    assert.equal(countryRequiresPostalCode(code), postal, code);
    assert.equal(countryUsesPostalCode(code), usesPostal, code);
  }
});

test('expanded countries keep domestic and international delivery prices', () => {
  const items = [{ kind: 'dude' as const }];
  assert.equal(calculateDeliveryLamports(items, 'United States of America', 3, 'card_nft_2'), 120_000_000);
  for (const country of ['CA', 'Canada', 'GB', 'United Kingdom', 'JM', 'Jamaica', 'INTL']) {
    assert.equal(calculateDeliveryLamports(items, country, 3, 'card_nft_2'), 240_000_000, country);
  }
});
