// Where in the world you are right now, so Ilyra can answer "weather", "what's nearby" and
// "where am I" without being told, and keeps up when you travel.
//
// It is worked out from your internet address (city-level, no GPS, no permission prompt) by
// asking a free lookup service, at most every 20 minutes and only while this is switched on in
// Settings. The service sees your IP address, as any website does. A VPN shows the VPN's city;
// if you say you are somewhere else, Ilyra believes you.
const fs = require('node:fs');

const TTL_MS = 20 * 60 * 1000;
const SERVICES = [
  { url: 'https://ipwho.is/', read: (j) => (j && j.success !== false && j.city ? { city: j.city, region: j.region, country: j.country, countryCode: j.country_code, lat: j.latitude, lon: j.longitude, timezone: j.timezone && j.timezone.id } : null) },
  { url: 'https://ipapi.co/json/', read: (j) => (j && !j.error && j.city ? { city: j.city, region: j.region, country: j.country_name, countryCode: j.country_code, lat: j.latitude, lon: j.longitude, timezone: j.timezone } : null) }
];

let file = '';
let cached = null;
let inflight = null;
let doFetch = (...a) => fetch(...a);

function init(opts) {
  file = (opts && opts.file) || '';
  if (opts && opts.fetch) doFetch = opts.fetch;
  cached = null; inflight = null;
  try { if (file) cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cached = null; }
}

// "Plano, Texas" for the US, "Lyon, France" elsewhere.
function label(l) {
  if (!l) return '';
  return [l.city, l.countryCode === 'US' || l.countryCode === 'CA' ? l.region : l.country].filter(Boolean).join(', ');
}

async function fetchOnce() {
  for (const s of SERVICES) {
    try {
      const res = await doFetch(s.url, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const got = s.read(await res.json());
      if (got) return Object.assign(got, { label: label(got), at: Date.now() });
    } catch { /* try the next service */ }
  }
  return null;
}

// Look up now if the saved answer is old. Never throws; on failure the last known place stays.
// wait: the most ms to hold up the caller (the first lookup of a session), then carry on in the background.
function refresh({ wait = 0, force = false } = {}) {
  const fresh = cached && Date.now() - cached.at < TTL_MS;
  if (fresh && !force) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetchOnce().then((got) => {
      if (got) { cached = got; try { if (file) fs.writeFileSync(file, JSON.stringify(got)); } catch { /* optional */ } }
      return cached;
    }).finally(() => { inflight = null; });
  }
  if (force) return inflight;
  if (cached || !wait) return Promise.resolve(cached);
  return Promise.race([inflight, new Promise((r) => setTimeout(() => r(null), wait))]);
}

const current = () => cached;
const forget = () => { cached = null; try { if (file) fs.unlinkSync(file); } catch { /* none */ } };

module.exports = { init, refresh, current, forget, label, TTL_MS };
