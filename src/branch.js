'use strict';
// Which branch serves a customer, by province (and optional city override).
// Default: Laguna -> San Pablo; Cavite -> Cavite (General Trias); Batangas -> Cavite (ASSUMPTION, confirm with Jm).
// Override with BRANCH_MAP JSON, e.g. {"provinces":{"batangas":"San Pablo"},"cities":{"lipa":"San Pablo"}}.

const DEFAULT_MAP = {
  provinces: { laguna: 'San Pablo', cavite: 'Cavite', batangas: 'Cavite' },
  cities: {},
  fallback: '',
};

const CITIES = {
  cavite: ['imus', 'bacoor', 'dasmarinas', 'dasma', 'general trias', 'gen trias', 'gentri', 'kawit', 'tanza', 'naic', 'silang',
    'tagaytay', 'trece martires', 'trece', 'carmona', 'gma', 'general mariano alvarez', 'noveleta', 'amadeo', 'indang',
    'alfonso', 'mendez', 'cavite city', 'maragondon', 'ternate', 'magallanes', 'general emilio aguinaldo', 'rosario'],
  laguna: ['san pablo', 'calamba', 'santa rosa', 'sta rosa', 'sta. rosa', 'binan', 'san pedro', 'cabuyao', 'los banos',
    'bay', 'calauan', 'alaminos', 'nagcarlan', 'liliw', 'rizal', 'santa cruz', 'sta cruz', 'sta. cruz', 'pagsanjan',
    'victoria', 'pila', 'magdalena', 'majayjay', 'lumban', 'kalayaan', 'paete', 'pakil', 'siniloan', 'famy', 'mabitac',
    'santa maria', 'cavinti', 'luisiana', 'pangil'],
  batangas: ['lipa', 'batangas city', 'tanauan', 'sto tomas', 'santo tomas', 'sto. tomas', 'malvar', 'nasugbu', 'lemery',
    'bauan', 'ibaan', 'padre garcia', 'rosario batangas', 'balayan', 'calaca', 'calatagan', 'taal', 'san juan',
    'mataasnakahoy', 'cuenca', 'alitagtag', 'talisay', 'laurel', 'agoncillo', 'lian', 'tuy', 'mabini', 'san jose',
    'san pascual', 'taysan', 'lobo', 'tingloy', 'balete'],
};

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function branchMap(cfg = {}) {
  let extra = {};
  if (cfg.branchMap) {
    try { extra = typeof cfg.branchMap === 'string' ? JSON.parse(cfg.branchMap) : cfg.branchMap; } catch { extra = {}; }
  }
  return {
    provinces: { ...DEFAULT_MAP.provinces, ...lower(extra.provinces) },
    cities: { ...DEFAULT_MAP.cities, ...lower(extra.cities) },
    fallback: extra.fallback || DEFAULT_MAP.fallback,
  };
}
function lower(o) {
  return Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [norm(k), v]));
}

const has = (t, w) => new RegExp(`(?:^|[^a-z])${w.replace(/[.]/g, '\\.')}(?:$|[^a-z])`).test(t);

// { province: 'Cavite'|'Laguna'|'Batangas'|'', city: '', branch: '' }
function detectLocation(text, cfg) {
  const t = norm(text);
  const map = branchMap(cfg);
  let province = ['cavite', 'laguna', 'batangas'].find((p) => has(t, p) && !(p === 'cavite' && has(t, 'cavite city'))) || '';
  let city = '';
  const order = province ? [province, ...Object.keys(CITIES).filter((p) => p !== province)] : Object.keys(CITIES);
  for (const p of order) {
    const hit = CITIES[p].slice().sort((a, b) => b.length - a.length).find((c) => has(t, c));
    if (hit) { city = hit; if (!province) province = p; break; }
  }
  if (!province && has(t, 'cavite city')) province = 'cavite';
  const branch = (city && map.cities[city]) || (province && map.provinces[province]) || map.fallback || '';
  const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { province: province ? title(province) : '', city: city ? title(city) : '', branch };
}

module.exports = { detectLocation, branchMap, DEFAULT_MAP, CITIES };
