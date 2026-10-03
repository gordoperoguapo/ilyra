// Everything Ilyra keeps in its data folder: saved chats, memory, briefs, scheduled tasks,
// settings and shared folders. Private data is encrypted with the OS keychain, and every write
// goes to a temp file first so a crash never leaves half a file.
const fs = require('node:fs');
const path = require('node:path');

// ---------- Plain JSON files ----------

let dir = null;
function setDir(d) { dir = d; }
function dataDir() {
  if (!dir) dir = require('electron').app.getPath('userData');
  return dir;
}

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, value) {
  const file = path.join(dataDir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ---------- Encrypted files ----------
// Encrypted with the OS keychain (DPAPI on Windows), the same way API keys are, so the files
// on disk are useless outside this user account.
let crypt = null;
function setCrypto(c) { crypt = c; }
function cryptoImpl() {
  if (crypt) return crypt;
  const { safeStorage } = require('electron');
  crypt = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf)
  };
  return crypt;
}
function writeEncrypted(file, value) {
  const c = cryptoImpl();
  if (!c.available()) throw new Error('Secure storage is not available on this system.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, c.encrypt(JSON.stringify(value)));
  fs.renameSync(tmp, file);
}
function readEncrypted(file, fallback) {
  try { return JSON.parse(cryptoImpl().decrypt(fs.readFileSync(file))); } catch { return fallback; }
}

// ---------- Chats ----------
// One encrypted file per chat plus an encrypted index (titles are private too),
// so saving one chat never rewrites the rest.
const MAX_CHATS = 500;
const chatsDir = () => path.join(dataDir(), 'chats');
const indexFile = () => path.join(chatsDir(), 'index.enc');
function chatFile(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new Error('Bad chat id.');
  return path.join(chatsDir(), id + '.enc');
}

let index = null; // [{ id, title, updated, count, pinned }], newest first
const loaded = new Map();

const summarize = (c) => ({ id: c.id, title: c.title, updated: c.updated, count: c.messages.length, pinned: Boolean(c.pinned) });

function writeIndex() { writeEncrypted(indexFile(), index); }

function loadIndex() {
  if (index) return index;
  index = readEncrypted(indexFile(), null) || [];
  return index;
}

const chats = {
  // Newest first, without the messages, for the sidebar.
  list() { return loadIndex().slice(); },
  get(id) {
    if (loaded.has(id)) return loaded.get(id);
    if (!loadIndex().some((c) => c.id === id)) return null;
    const chat = readEncrypted(chatFile(id), null);
    if (chat) loaded.set(id, chat);
    return chat;
  },
  save(chat) {
    loadIndex();
    // A save from the page doesn't know about pinning: keep what was there.
    if (chat.pinned === undefined) { const prev = chats.get(chat.id); if (prev && prev.pinned) chat.pinned = true; }
    writeEncrypted(chatFile(chat.id), chat);
    loaded.set(chat.id, chat);
    index = [summarize(chat)].concat(index.filter((c) => c.id !== chat.id));
    for (const old of index.slice(MAX_CHATS)) {
      try { fs.unlinkSync(chatFile(old.id)); } catch { /* already gone */ }
      loaded.delete(old.id);
    }
    index = index.slice(0, MAX_CHATS);
    writeIndex();
  },
  setPinned(id, pinned) {
    const chat = chats.get(id);
    if (!chat) return;
    chat.pinned = Boolean(pinned);
    chats.save(chat);
  },
  remove(id) {
    loadIndex();
    try { fs.unlinkSync(chatFile(id)); } catch { /* already gone */ }
    loaded.delete(id);
    index = index.filter((c) => c.id !== id);
    writeIndex();
  },
  // Plain-text search across every saved message.
  search(query, limit = 10) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const hits = [];
    for (const entry of loadIndex()) {
      const c = chats.get(entry.id);
      if (!c) continue;
      const idx = c.messages.findIndex((m) => String(m.content || '').toLowerCase().includes(q));
      if (idx === -1 && !c.title.toLowerCase().includes(q)) continue;
      const m = c.messages[Math.max(0, idx)];
      const text = String(m.content || '');
      const at = Math.max(0, text.toLowerCase().indexOf(q) - 60);
      hits.push({ id: c.id, title: c.title, updated: c.updated, snippet: text.slice(at, at + 220) });
      if (hits.length >= limit) break;
    }
    return hits;
  }
};

// ---------- Memory, briefs, scheduled tasks and settings ----------
const MEMORY_MAX = 6000;
const memory = {
  max: MEMORY_MAX,
  get() { const m = readEncrypted(path.join(dataDir(), 'memory.enc'), null); return (m && typeof m.text === 'string') ? m.text : ''; },
  set(text) { writeEncrypted(path.join(dataDir(), 'memory.enc'), { text: String(text).slice(0, MEMORY_MAX), updated: Date.now() }); }
};
// Briefs: a short page per part of the user's life or work ("## My shop ..."), read at the
// start of every chat like Memory, so Ilyra knows those things exist.
const BRIEFS_MAX = 8000;
const briefs = {
  max: BRIEFS_MAX,
  get() { const b = readEncrypted(path.join(dataDir(), 'briefs.enc'), null); return (b && typeof b.text === 'string') ? b.text : ''; },
  set(text) { writeEncrypted(path.join(dataDir(), 'briefs.enc'), { text: String(text).slice(0, BRIEFS_MAX), updated: Date.now() }); }
};
const tasks = {
  list() { const t = readEncrypted(path.join(dataDir(), 'tasks.enc'), []); return Array.isArray(t) ? t : []; },
  save(list) { writeEncrypted(path.join(dataDir(), 'tasks.enc'), list); }
};
const DEFAULT_SETTINGS = { autoMemory: false, background: false, startAtLogin: false, location: false };
const settings = {
  get() { return Object.assign({}, DEFAULT_SETTINGS, readJson('settings.json', {})); },
  set(patch) {
    const next = Object.assign(settings.get(), ...Object.keys(patch || {}).filter((k) => k in DEFAULT_SETTINGS).map((k) => ({ [k]: Boolean(patch[k]) })));
    writeJson('settings.json', next);
    return next;
  }
};

// ---------- Shared folders (Ilyra may read and edit inside them) ----------
const FOLDERS = 'folders.json';
const folders = {
  list() { return readJson(FOLDERS, []); },
  add(p) {
    const full = path.resolve(p);
    const next = folders.list().filter((f) => f !== full).concat(full);
    writeJson(FOLDERS, next);
    return next;
  },
  remove(p) {
    const next = folders.list().filter((f) => f !== p);
    writeJson(FOLDERS, next);
    return next;
  }
};

module.exports = { setDir, setCrypto, dataDir, chats, folders, memory, briefs, tasks, settings };
