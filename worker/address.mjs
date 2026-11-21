import postalOffices from 'lankapost/data' with { type: 'json' };
import { RoutingError } from './routing.mjs';

const simplify = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
const offices = postalOffices.filter(record => /^\d{5}$/u.test(record.postal_code));
const colomboNames = [
  'Fort', 'Slave Island', 'Kollupitiya', 'Bambalapitiya', 'Havelock Town', 'Wellawatta',
  'Cinnamon Gardens', 'Borella', 'Dematagoda', 'Maradana', 'Pettah', 'Hultsdorf',
  'Kotahena', 'Grandpass', 'Modara',
];
for (const [i, place_name] of colomboNames.entries()) {
  const postal_code = String((i + 1) * 100).padStart(5, '0');
  if (!offices.some(office => office.postal_code === postal_code)) {
    offices.push({ postal_code, place_name, district_name: 'Colombo', province: 'Western Province' });
  }
}
const byCode = new Map();
const byName = new Map();
for (const office of offices) {
  if (!byCode.has(office.postal_code)) byCode.set(office.postal_code, []);
  byCode.get(office.postal_code).push(office);
  const name = simplify(office.place_name);
  if (!byName.has(name)) byName.set(name, new Map());
  byName.get(name).set(office.postal_code, office);
}

function value(raw, label, max) {
  if (raw === undefined) return '';
  if (typeof raw !== 'string' || raw.length > max || /[\p{Cc}]/u.test(raw)) {
    throw new RoutingError(400, 'Invalid ' + label + '.');
  }
  return raw.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function validateAddress(body) {
  const countryCode = value(body.countryCode ?? 'LK', 'country code', 2).toUpperCase();
  if (countryCode !== 'LK') throw new RoutingError(400, 'Postal validation covers Sri Lanka only.');
  const input = body.addressLines ?? [];
  if (!Array.isArray(input) || input.length > 4) throw new RoutingError(400, 'Supply at most four address lines.');
  const addressLines = input.map(line => value(line, 'address line', 120)).filter(Boolean);
  const locality = value(body.locality, 'postal town', 100);
  const code = value(body.postalCode, 'postal code', 15).replace(/\s/gu, '');
  const localityKey = simplify(locality);
  const colomboZone = /^colombo0?([1-9]|1[0-5])$/u.exec(localityKey);
  const zoneCode = colomboZone ? String(Number(colomboZone[1]) * 100).padStart(5, '0') : null;
  const towns = zoneCode ? byCode.get(zoneCode) : [...(byName.get(localityKey)?.values() ?? [])];
  const matches = /^\d{5}$/u.test(code) ? byCode.get(code) ?? [] : [];
  const matchedTown = matches.find(office =>
    simplify(office.place_name) === localityKey || code === zoneCode ||
    (localityKey === 'colombo' && Number(code) >= 100 && Number(code) <= 1500 && Number(code) % 100 === 0));
  const issues = [];
  if (!addressLines.length) issues.push('missing_street_address');
  if (!locality) issues.push('missing_postal_town');
  if (!code) issues.push('missing_postal_code');
  else if (!/^\d{5}$/u.test(code)) issues.push('invalid_postal_code_format');
  else if (!matches.length) issues.push('postal_code_not_in_directory');
  else if (locality && !matchedTown) issues.push('postal_town_mismatch');
  const candidates = matches.length ? matches : towns;
  return {
    precision: 'postal-town',
    postalTownVerified: Boolean(matchedTown),
    normalizedAddress: { addressLines, locality: matchedTown?.place_name ?? (locality || null), postalCode: code || null, countryCode },
    suggestions: candidates.slice(0, 8).map(office => ({
      postalCode: office.postal_code, locality: office.place_name, district: office.district_name, province: office.province,
    })),
    issues,
    deliverability: 'unverified',
    propertyType: 'unknown',
    source: 'lankapost postal office directory',
  };
}
