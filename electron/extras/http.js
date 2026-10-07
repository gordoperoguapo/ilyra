// http_request: call a web API (GET, POST, PUT, PATCH, DELETE) for the user.
//
// Keys: the model never sees one. The user saves a key in Settings with the one website it's for;
// the model names it (auth: "render") and the key is added here, only when the request goes to
// that website. A key can't be sent anywhere else, even if a page talks the model into trying.
// Redirects aren't followed, so a key never travels on to another address.
const fs = require('node:fs');
const path = require('node:path');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_BODY_OUT = 20000;   // characters of the answer handed to the model
const MAX_BODY_IN = 200000;   // characters the model may send
const TIMEOUT_MS = 30000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

let dataDir = null;
let keystore = null;
function init(opts) { dataDir = opts.dataDir; keystore = opts.keystore; }

// ---------- Saved keys ----------
// apis.json holds the names, websites and headers (nothing secret); the keys themselves sit in the
// encrypted key store as "api:<name>". A key saved on a card of its own can be listed in BUILT_IN.
const file = () => path.join(dataDir, 'apis.json');
function entries() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { list = []; }
  return Array.isArray(list) ? list.filter((e) => e && NAME.test(e.name)) : [];
}
const BUILT_IN = []; // { name, host, header, keyId, builtIn: true }

function all() {
  const own = entries().map((e) => Object.assign({}, e, { keyId: `api:${e.name}` }));
  return BUILT_IN.concat(own).filter((e) => keystore.getKey(e.keyId));
}
// For Settings: names, websites, headers and the key's last four characters.
function list() {
  return all().map((e) => ({ name: e.name, host: e.host, header: e.header, hint: keystore.summary(e.keyId).hint, builtIn: Boolean(e.builtIn) }));
}
// For the model: which names it may use, and for which website.
function names() { return all().map((e) => `${e.name} (${e.host})`); }

function hostOf(input) {
  const raw = String(input || '').trim();
  try { return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { return ''; }
}

function save({ name, site, header, key }) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME.test(n)) throw new Error('Give the key a short name: letters, numbers, - or _, like render or supabase.');
  if (BUILT_IN.some((b) => b.name === n)) throw new Error(`"${n}" is taken by the ${n} card. Pick another name.`);
  const host = hostOf(site);
  if (!host || !host.includes('.') && host !== 'localhost') throw new Error('Add the website the key is for, like api.render.com.');
  const h = String(header || 'Authorization').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(h)) throw new Error('The header name can only have letters, numbers and dashes, like Authorization or X-Api-Key.');
  const k = String(key || '').trim();
  const existing = entries().find((e) => e.name === n);
  if (!k && !existing) throw new Error('Paste the key.');
  if (k && (k.length > 4000 || /[\r\n]/.test(k))) throw new Error("That doesn't look like a key.");
  if (k) keystore.set(`api:${n}`, { key: k });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(entries().filter((e) => e.name !== n).concat({ name: n, host, header: h }), null, 2));
  return list();
}
function remove(name) {
  const n = String(name || '').toLowerCase();
  if (BUILT_IN.some((b) => b.name === n)) return list();
  keystore.remove(`api:${n}`);
  try { fs.writeFileSync(file(), JSON.stringify(entries().filter((e) => e.name !== n), null, 2)); } catch { /* nothing saved */ }
  return list();
}

// ---------- Requests ----------

// Checks a request before it's shown for approval. Returns what will be sent (without the key).
function prepare({ method, url, headers, body, auth }) {
  const m = String(method || 'GET').toUpperCase();
  if (!METHODS.includes(m)) throw new Error(`method must be one of ${METHODS.join(', ')}.`);
  let u;
  try { u = new URL(String(url || '')); } catch { throw new Error('That is not a full web address (it should start with https://).'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Only https:// addresses (or http://localhost) can be called.');
  if (u.username || u.password) throw new Error('Put credentials in a saved key, not in the address.');
  if (/^(169\.254\.|0\.)/.test(u.hostname)) throw new Error('That address is not allowed.');
  const sendHeaders = {};
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /^(host|content-length|connection|cookie)$/i.test(k)) continue;
    sendHeaders[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 2000);
  }
  let payload;
  if (body !== undefined && body !== null && body !== '' && m !== 'GET' && m !== 'HEAD') {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (payload.length > MAX_BODY_IN) throw new Error(`The body is ${payload.length} characters; the limit is ${MAX_BODY_IN}.`);
    if (typeof body !== 'string' && !Object.keys(sendHeaders).some((k) => /^content-type$/i.test(k))) sendHeaders['Content-Type'] = 'application/json';
  }
  let key = null;
  if (auth) {
    const name = String(auth).toLowerCase();
    const entry = all().find((e) => e.name === name);
    if (!entry) throw new Error(`No saved key is named "${auth}". Saved keys: ${names().join(', ') || 'none'}. The user adds keys in Settings, AI models.`);
    const h = u.hostname.toLowerCase();
    if (h !== entry.host && !h.endsWith(`.${entry.host}`)) throw new Error(`The "${entry.name}" key is only for ${entry.host}, not ${u.hostname}. It was not sent.`);
    key = { entry, value: keystore.getKey(entry.keyId) };
    // The key's own header wins over anything the model set with that name.
    for (const k of Object.keys(sendHeaders)) if (k.toLowerCase() === entry.header.toLowerCase()) delete sendHeaders[k];
  }
  return { method: m, url: u.toString(), host: u.hostname, headers: sendHeaders, body: payload, key };
}

// What the user is shown before it goes: everything except the key itself.
function describe(req) {
  const lines = [`${req.method} ${req.url}`];
  if (req.key) lines.push(`Uses your saved "${req.key.entry.name}" key (sent only to ${req.key.entry.host}).`);
  const hs = Object.entries(req.headers);
  if (hs.length) lines.push('', 'Headers:', ...hs.map(([k, v]) => `${k}: ${v}`));
  if (req.body) lines.push('', `Body (${req.body.length} characters):`, req.body.length > 3000 ? req.body.slice(0, 3000) + '\n…' : req.body);
  return lines.join('\n');
}

async function send(req, { signal } = {}) {
  const headers = Object.assign({ 'User-Agent': 'Ilyra (personal assistant)', Accept: 'application/json, text/plain;q=0.9, */*;q=0.5' }, req.headers);
  if (req.key) {
    const v = req.key.value;
    headers[req.key.entry.header] = /^authorization$/i.test(req.key.entry.header) && !/^\w+\s/.test(v) ? `Bearer ${v}` : v;
  }
  const signals = [AbortSignal.timeout(TIMEOUT_MS)].concat(signal ? [signal] : []);
  const started = Date.now();
  const res = await fetch(req.url, { method: req.method, headers, body: req.body, redirect: 'manual', signal: AbortSignal.any(signals) });
  const type = res.headers.get('content-type') || '';
  let text = '';
  if (req.method !== 'HEAD') {
    if (/json|text|xml|javascript|html|csv|yaml|x-www-form/i.test(type) || !type) {
      text = await res.text();
      if (/json/i.test(type)) { try { const pretty = JSON.stringify(JSON.parse(text), null, 1); if (pretty.length < text.length * 3) text = pretty; } catch { /* as sent */ } }
    } else {
      const buf = await res.arrayBuffer();
      text = `(${buf.byteLength} bytes of ${type}, not shown)`;
    }
  }
  // A service that echoes the request back must not hand the key to the model.
  if (req.key && req.key.value) text = text.split(req.key.value).join('[your key]');
  const cut = text.length > MAX_BODY_OUT ? `${text.slice(0, MAX_BODY_OUT)}\n… (${text.length - MAX_BODY_OUT} more characters)` : text;
  const where = res.status >= 300 && res.status < 400 && res.headers.get('location') ? `\nRedirects to: ${res.headers.get('location')} (not followed; call it directly if it's expected)` : '';
  return {
    status: res.status,
    output: `${res.status} ${res.statusText}${type ? ` · ${type.split(';')[0]}` : ''} · ${Date.now() - started} ms${where}\n\n${cut || '(empty)'}`
  };
}

module.exports = { init, list, names, save, remove, prepare, describe, send, hostOf, METHODS };
