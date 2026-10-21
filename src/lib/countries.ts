import { ISO_COUNTRIES } from '../../shared/countries.ts';
import { normalizeCountryCode } from '../../shared/countryNormalization.ts';

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
}

export const COUNTRIES: CountryOption[] = ISO_COUNTRIES.map(({ code, name }) => ({
  code,
  name,
  flag: String.fromCodePoint(...[...code].map((letter) => letter.charCodeAt(0) + 127397)),
})).sort((a, b) => a.name.localeCompare(b.name));

export function findCountryByCode(code?: string): CountryOption | undefined {
  const normalized = normalizeCountryCode(code);
  return COUNTRIES.find((country) => country.code === normalized);
}

export function countryLabel(option: CountryOption) {
  return `${option.flag} ${option.name}`;
}
