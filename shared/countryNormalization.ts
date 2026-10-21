import { ISO_COUNTRIES } from './countries.ts';

function countryKey(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
}

const countryCodes = new Set(ISO_COUNTRIES.map(({ code }) => code));
const countryNames = new Map(ISO_COUNTRIES.map(({ code, name }) => [countryKey(name), code]));
const countryAliases: Record<string, string> = {
  USA: 'US',
  UNITEDSTATESOFAMERICA: 'US',
  UK: 'GB',
  GREATBRITAIN: 'GB',
  UNITEDKINGDOMOFGREATBRITAINANDNORTHERNIRELAND: 'GB',
  UAE: 'AE',
  TURKIYE: 'TR',
  CZECHREPUBLIC: 'CZ',
  REPUBLICOFKOREA: 'KR',
  KOREAREPUBLICOF: 'KR',
  KOREASOUTH: 'KR',
  DEMOCRATICPEOPLESREPUBLICOFKOREA: 'KP',
  KOREANORTH: 'KP',
  RUSSIANFEDERATION: 'RU',
  VIETNAM: 'VN',
  REPUBLICOFIRELAND: 'IE',
  HONGKONGSARCHINA: 'HK',
  HONGKONGSAR: 'HK',
  MACAU: 'MO',
  MACAO: 'MO',
  PALESTINE: 'PS',
  STATEOFPALESTINE: 'PS',
  TAIWANPROVINCEOFCHINA: 'TW',
  IRANISLAMICREPUBLICOF: 'IR',
  SYRIANARABREPUBLIC: 'SY',
  LAOPEOPLESDEMOCRATICREPUBLIC: 'LA',
  LAOPDR: 'LA',
  BRUNEIDARUSSALAM: 'BN',
  BOLIVIAPLURINATIONALSTATEOF: 'BO',
  VENEZUELABOLIVARIANREPUBLICOF: 'VE',
  MOLDOVAREPUBLICOF: 'MD',
  TANZANIAUNITEDREPUBLICOF: 'TZ',
  CAPEVERDE: 'CV',
  SWAZILAND: 'SZ',
  EASTTIMOR: 'TL',
  IVORYCOAST: 'CI',
  MYANMAR: 'MM',
  BURMA: 'MM',
  MACEDONIA: 'MK',
  DEMOCRATICREPUBLICOFTHECONGO: 'CD',
  DEMOCRATICREPUBLICOFCONGO: 'CD',
  CONGODEMOCRATICREPUBLICOFTHE: 'CD',
  REPUBLICOFTHECONGO: 'CG',
  REPUBLICOFCONGO: 'CG',
  HOLYSEE: 'VA',
};

// Required fields from https://github.com/google/libaddressinput/blob/master/common/src/main/java/com/google/i18n/addressinput/common/RegionDataConstants.java
const countriesRequiringPostalCode = new Set(
  'AS AT AU AX BE BL BR CA CH CN CZ DE DK EE ES FI FK FM FR GB GF GG GL GP GR GS GU HU IM IN IO IT JE JP KR LI LT LU LV MF MH MP MQ MX MY NC NL NO NZ PF PL PM PN PR PT PW RE RO RU SE SG SH SJ SK SM TC TR TW UA US VI WF YT ZA'.split(' '),
);
const countriesRequiringState = new Set(
  'AE AS AU BR CA CN CO CR ES FM HK HN ID IN IQ IT JM JP KN KR KY MH MP MX NR PF PG PW RU SO SV TW UM US VE VI VN'.split(' '),
);
const countriesUsingPostalCode = new Set(
  'AD AF AI AL AM AR AS AT AU AX AZ BA BB BD BE BG BH BL BM BN BR BT BY CA CC CH CL CN CO CR CU CV CX CY CZ DE DK DO DZ EC EE EG EH ES ET FI FK FM FO FR GB GE GF GG GH GI GL GN GP GR GS GT GU GW HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JO JP KE KG KH KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV MA MC MD ME MF MG MH MK MM MN MP MQ MT MU MV MX MY MZ NA NC NE NF NG NI NL NO NP NZ OM PE PF PG PH PK PL PM PN PR PT PW PY RE RO RS RU SA SD SE SG SH SI SJ SK SM SN SO SV SZ TC TH TJ TM TN TR TT TW TZ UA UM US UY UZ VA VC VE VG VI VN WF YT ZA ZM'.split(' '),
);

export function normalizeCountryCode(country?: string): string {
  const normalized = (country || '').trim().toUpperCase();
  if (countryCodes.has(normalized)) return normalized;
  const key = countryKey(normalized);
  if (countryCodes.has(key)) return key;
  return countryAliases[key] ?? countryNames.get(key) ?? '';
}

export function countryRequiresPostalCode(country?: string): boolean {
  const code = normalizeCountryCode(country);
  return !code || countriesRequiringPostalCode.has(code);
}

export function countryRequiresState(country?: string): boolean {
  const code = normalizeCountryCode(country);
  return !code || countriesRequiringState.has(code);
}

export function countryUsesPostalCode(country?: string): boolean {
  const code = normalizeCountryCode(country);
  return !code || countriesUsingPostalCode.has(code);
}
