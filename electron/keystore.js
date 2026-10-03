// Provider and connector keys, encrypted with the OS keychain (DPAPI on Windows), so the file on
// disk is useless outside this user account. Each entry also keeps the chosen model and the key's
// last four characters, so the page can show which key is in use without ever seeing it.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'keys.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}

function save(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

function getKey(id) {
  const entry = load()[id];
  if (!entry || !entry.key) return null;
  try { return safeStorage.decryptString(Buffer.from(entry.key, 'base64')); } catch { return null; }
}

function getModel(id) {
  return (load()[id] || {}).model || null;
}

function set(id, { key, model, pinned }) {
  const data = load();
  const entry = data[id] || {};
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.');
    entry.key = safeStorage.encryptString(key).toString('base64');
    entry.hint = key.slice(-4);
  }
  if (model !== undefined) entry.model = model || undefined;
  if (pinned !== undefined) entry.pinned = pinned || undefined;
  data[id] = entry;
  save(data);
}

function remove(id) {
  const data = load();
  delete data[id];
  save(data);
}

function summary(id) {
  const entry = load()[id] || {};
  return { connected: Boolean(entry.key), hint: entry.hint || null, model: entry.model || null, pinned: Boolean(entry.pinned) };
}

module.exports = { getKey, getModel, set, remove, summary };
