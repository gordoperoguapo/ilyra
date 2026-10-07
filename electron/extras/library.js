// The library: folders of the user's own documents (notes, exported wikis, product docs) that
// Ilyra searches by meaning, so its models can answer from them.
//
// - The library is the library folder in Documents\Ilyra: whatever sits in it
//   is read, with nothing to register. Folders elsewhere can be added in Settings too. Folders whose
//   names start with _ are workspace (raw exports, scripts) and are skipped.
// - Only Markdown and plain text, and never a file that looks like it holds secrets (the same
//   rules as shared folders). Nothing here is ever written.
// - Each document is split at its headings, and each section becomes a vector from an embedding
//   model on this computer's Ollama (a small model, so it runs alongside the chat model).
// - With no embedding model installed, search falls back to matching words, so it still works.
// - The index is a file in Ilyra's data folder. It is not encrypted: it only holds text from files
//   that sit readable on disk anyway, and the models can't read Ilyra's data folder.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../store');
const { sensitive } = require('../tools');
// The Ollama on this computer, for the embedding model.
const ollamaHosts = () => ['http://127.0.0.1:11434'];
const { tokens } = require('./recall');

const EXTS = new Set(['.md', '.markdown', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.next', '__pycache__']);
const MAX_FILES = 2000;
const MAX_FILE = 1024 * 1024;
const CHUNK_MAX = 1800;     // characters in one section; longer ones are split at paragraphs
const CHUNK_MIN = 250;      // shorter sections are joined to the one before
const RESCAN_MS = 30000;    // files are checked for changes at most this often
const BATCH = 16;
// Raise this whenever split() changes, so documents indexed the old way are split again.
const SPLIT_VERSION = 2;
// The first of these that Ollama has installed is used. Qwen3's is the best of them at its size.
const EMBED_MODELS = ['qwen3-embedding:0.6b', 'qwen3-embedding', 'nomic-embed-text', 'embeddinggemma', 'mxbai-embed-large'];
// How close a section must be to count as relevant, measured with qwen3-embedding on a game
// server's docs: real questions about them scored 0.69 to 0.91, unrelated ones mostly under 0.4,
// with one near miss at 0.54 ("my new leads" against a "Hunting Leaderboard" page).
const MATCH = 0.5;          // for search_library, which the model asked for
const INJECT = 0.55;        // for sections added on their own, unasked (unrelated pages score about 0.3-0.4)
// Share of a question's word weight (rare words weigh more) a section must hold to match on words alone.
const EXACT = 0.85;
// Tables of contents (GitBook's SUMMARY.md, generated INDEX.md files) match everything a little.
const CONTENTS = /^(summary|index|toc|contents)\.(md|markdown|txt)$/i;

let hostsFn = ollamaHosts;
let index = null;           // { model, files: { [path]: { root, mtimeMs, size, title, chunks: [{ heading, text, vec }] } } }
let scanning = null;
let lastScan = 0;
let lastError = '';

const indexFile = () => path.join(store.dataDir(), 'library', 'index.json');

// ---------- The folders in the library ----------
// The home folder always comes first (once it holds anything) and can't be removed. Folders added elsewhere are kept in
// library.json in Ilyra's data folder; ones that no longer exist, or sit inside home, are left out.
let home = '';
function setHome(dir) {
  home = dir ? path.resolve(dir) : '';
  if (home) try { fs.mkdirSync(home, { recursive: true }); } catch { /* read-only: the list just skips it */ }
}
const inside = (p, dir) => p.toLowerCase() === dir.toLowerCase() || p.toLowerCase().startsWith(dir.toLowerCase() + path.sep);
const LIBRARY = () => path.join(store.dataDir(), 'library.json');
const folders = {
  saved() { try { const list = JSON.parse(fs.readFileSync(LIBRARY(), 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; } },
  list() {
    const extra = folders.saved().filter((p) => !(home && inside(p, home)) && fs.existsSync(p));
    let filled = false;
    try { filled = Boolean(home) && fs.readdirSync(home).length > 0; } catch { /* not there */ }
    return (filled ? [home] : []).concat(extra);
  },
  save(list) { fs.mkdirSync(path.dirname(LIBRARY()), { recursive: true }); fs.writeFileSync(LIBRARY(), JSON.stringify(list, null, 2)); },
  add(p) { const full = path.resolve(p); if (home && inside(full, home)) return; folders.save(folders.saved().filter((x) => x !== full).concat(full)); },
  remove(p) { folders.save(folders.saved().filter((x) => x !== p)); }
};

// ---------- Splitting a document into sections ----------
function titleFrom(file) {
  return path.basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';
}

// Sections at ## and ### headings, each labelled "Title > Heading > Subheading". Headings inside
// code blocks are left alone. Tiny sections join the one before; huge ones split at blank lines.
function split(text, file) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let title = '';
  const raw = [];
  let cur = { path: [], lines: [] };
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && h[1].length === 1 && !title) { title = h[2]; continue; }
    if (h && h[1].length > 1) {
      raw.push(cur);
      const level = h[1].length;
      const parent = level === 3 && cur.path.length ? [cur.path[0]] : [];
      cur = { path: parent.concat(h[2]), lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  raw.push(cur);
  title = title || titleFrom(file);

  const chunks = [];
  for (const r of raw) {
    const body = r.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body.replace(/^#+\s.*$/gm, '').replace(/[\s*_-]/g, '')) continue; // only a heading or rules
    const heading = [title].concat(r.path).join(' > ');
    const prev = chunks[chunks.length - 1];
    // Only a short section joins the one before (its own heading line stays in the text). A full
    // section never joins a short one, or it would be filed under the wrong heading.
    if (prev && body.length < CHUNK_MIN && prev.text.length + body.length + 2 <= CHUNK_MAX) {
      prev.text += '\n\n' + body;
      continue;
    }
    for (const text of pieces(body)) chunks.push({ heading, text });
  }
  return { title, chunks };
}

// A long section in pieces of at most CHUNK_MAX characters: at blank lines, then at line ends
// (a long list or table has no blank lines), then anywhere. Nothing is dropped.
function pieces(body) {
  if (body.length <= CHUNK_MAX) return [body];
  const out = [];
  let part = '';
  const add = (unit, sep) => {
    if (part && part.length + sep.length + unit.length > CHUNK_MAX) { out.push(part); part = ''; }
    part = part ? part + sep + unit : unit;
  };
  for (const para of body.split(/\n\n+/)) {
    if (para.length <= CHUNK_MAX) { add(para, '\n\n'); continue; }
    para.split('\n').forEach((line, n) => {
      for (let i = 0; i < line.length; i += CHUNK_MAX) add(line.slice(i, i + CHUNK_MAX), i ? '' : n ? '\n' : '\n\n');
    });
  }
  if (part) out.push(part);
  return out;
}

// ---------- Finding files ----------
function walk(root) {
  const out = [];
  (function visit(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.') || sensitive(full)) continue;
      if (e.isDirectory() && e.name.startsWith('_')) continue; // workspace, not documents
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(full); continue; }
      if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase()) && !CONTENTS.test(e.name)) out.push(full);
    }
  })(root);
  return out;
}

// ---------- Embeddings (Ollama) ----------
async function ollama(host, route, body, timeout) {
  const res = await fetch(host + route, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }
    : { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  return res.json();
}

let found = null;   // { host, model, at }
// Where an embedding model is installed: `want` (the index's model) if given, else the best one.
async function embedder(want) {
  if (found && Date.now() - found.at < 60000 && (!want || found.model === want)) return found;
  found = null;
  for (const host of hostsFn()) {
    let names;
    try { names = ((await ollama(host, '/api/tags', null, 2500)).models || []).map((m) => m.name); } catch { continue; }
    for (const name of want ? [want] : EMBED_MODELS) {
      const hit = names.find((n) => n === name || n === `${name}:latest`);
      if (hit) { found = { host, model: hit, at: Date.now() }; return found; }
    }
  }
  return null;
}

function normalize(v) {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

async function embed(emb, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await ollama(emb.host, '/api/embed', { model: emb.model, input: texts.slice(i, i + BATCH), truncate: true, keep_alive: '10m' }, 120000);
    for (const v of res.embeddings || []) out.push(normalize(v));
  }
  if (out.length !== texts.length) throw new Error('Ollama returned the wrong number of embeddings.');
  return out;
}

// Qwen3's embedder finds answers better when a question says what it is for.
const asQuery = (model, q) => (/qwen3-embedding/i.test(model) ? `Instruct: Given a question, retrieve passages from the user's own documents that answer it\nQuery: ${q}` : q);
const forDoc = (c) => `${c.heading}\n\n${c.text}`.slice(0, 4000);

// ---------- The index on disk ----------
function load() {
  if (index) return index;
  index = { model: '', files: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    // Files split by an older version of split() are read again (their vectors are redone too).
    if (saved.version !== SPLIT_VERSION) return index;
    index.model = saved.model || '';
    for (const [file, f] of Object.entries(saved.files || {})) {
      for (const c of f.chunks) {
        // A small Buffer can share a pooled ArrayBuffer, so copy exactly its own bytes.
        const b = c.vec ? Buffer.from(c.vec, 'base64') : null;
        c.vec = b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null;
      }
      index.files[file] = f;
    }
  } catch { /* no index yet */ }
  return index;
}

function save() {
  const files = {};
  for (const [file, f] of Object.entries(index.files)) {
    files[file] = Object.assign({}, f, { chunks: f.chunks.map((c) => ({ heading: c.heading, text: c.text, vec: c.vec ? Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength).toString('base64') : null })) });
  }
  const file = indexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: SPLIT_VERSION, model: index.model, files }));
  fs.renameSync(file + '.tmp', file);
}

// Bring the index up to date with the folders: read new and changed files, drop removed ones,
// and embed every section that has no vector yet.
async function scan() {
  load();
  let dirty = false;
  const seen = new Set();
  for (const root of folders.list()) {
    for (const file of walk(root)) {
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const old = index.files[file];
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      if (st.size > MAX_FILE) { delete index.files[file]; dirty = true; continue; }
      const raw = fs.readFileSync(file);
      if (raw.includes(0)) continue;
      const { title, chunks } = split(raw.toString('utf8'), file);
      index.files[file] = { root, mtimeMs: st.mtimeMs, size: st.size, title, chunks: chunks.map((c) => Object.assign(c, { vec: null })) };
      dirty = true;
    }
  }
  for (const file of Object.keys(index.files)) if (!seen.has(file)) { delete index.files[file]; dirty = true; }

  const emb = await embedder();
  if (emb) {
    // A different model's vectors can't be compared with this one's: start those over.
    if (index.model !== emb.model) {
      for (const f of Object.values(index.files)) for (const c of f.chunks) c.vec = null;
      index.model = emb.model;
      dirty = true;
    }
    const todo = [];
    for (const f of Object.values(index.files)) for (const c of f.chunks) if (!c.vec) todo.push(c);
    try {
      for (let i = 0; i < todo.length; i += BATCH * 4) {
        const part = todo.slice(i, i + BATCH * 4);
        const vecs = await embed(emb, part.map(forDoc));
        part.forEach((c, j) => { c.vec = vecs[j]; });
        dirty = true;
      }
      lastError = '';
    } catch (err) {
      found = null;
      lastError = `Couldn't finish indexing: ${(err && err.message) || err}`;
    }
  } else {
    lastError = '';
  }
  if (dirty) save();
}

// Throttled: a chat calls this before every search, and it only rescans every 30 seconds.
function refresh({ force = false } = {}) {
  if (scanning) return scanning;
  if (!force && Date.now() - lastScan < RESCAN_MS) return Promise.resolve(status());
  if (force) found = null; // Re-index looks for the embedding model again
  scanning = scan()
    .catch((err) => { lastError = (err && err.message) || String(err); })
    .then(() => { lastScan = Date.now(); scanning = null; return status(); });
  return scanning;
}

function status() {
  load();
  const files = Object.values(index.files);
  const sections = files.reduce((n, f) => n + f.chunks.length, 0);
  const embedded = files.reduce((n, f) => n + f.chunks.filter((c) => c.vec).length, 0);
  return {
    folders: folders.list(), home, files: files.length, sections, embedded,
    model: embedded ? index.model : '', indexing: Boolean(scanning), error: lastError,
    suggest: EMBED_MODELS[0]
  };
}

// ---------- Searching ----------
// Every section, scored by meaning (when an embedding model is available) plus shared rare words.
async function search(query, { limit = 5, min = MATCH, words: byWords = true } = {}) {
  await refresh();
  load();
  const all = [];
  for (const [file, f] of Object.entries(index.files)) for (const c of f.chunks) all.push({ file, title: f.title, c });
  const q = tokens(query);
  if (!all.length || !String(query || '').trim()) return [];

  // Words: what share of the query's weight (rarer words weigh more) a section contains.
  const df = new Map();
  for (const a of all) { if (!a.c.tok) a.c.tok = tokens(`${a.c.heading} ${a.c.text}`); for (const t of a.c.tok) df.set(t, (df.get(t) || 0) + 1); }
  const idf = (t) => Math.log(1 + all.length / (df.get(t) || 0.5));
  const qWeight = [...q].reduce((n, t) => n + idf(t), 0) || 1;
  const words = (a) => [...q].reduce((n, t) => n + (a.c.tok.has(t) ? idf(t) : 0), 0) / qWeight;

  let qv = null;
  if (index.model && all.some((a) => a.c.vec)) {
    try {
      const emb = await embedder(index.model);
      if (emb) qv = (await embed(emb, [asQuery(emb.model, String(query).slice(0, 2000))]))[0];
    } catch { qv = null; }
  }
  const dot = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * qv[i]; return s; };
  const scored = all.map((a) => {
    const w = q.size ? words(a) : 0;
    const meaning = qv && a.c.vec && a.c.vec.length === qv.length ? dot(a.c.vec) : null;
    // With vectors, meaning decides and words nudge; without, words must cover most of the query.
    // A section holding nearly all of the question's distinctive words counts either way: a long
    // list (a glossary) has a vague overall meaning, yet "bounding box" is plainly in it.
    const exact = byWords && w >= EXACT;
    const score = meaning === null ? w : meaning + 0.1 * w + (exact ? 0.15 : 0);
    const pass = meaning === null ? w >= 0.6 : meaning >= min || exact;
    return { a, score, pass };
  }).filter((s) => s.pass).sort((x, y) => y.score - x.score);

  return scored.slice(0, limit).map(({ a, score }) => ({ file: a.file, title: a.title, heading: a.c.heading, text: a.c.text, score: Math.round(score * 1000) / 1000 }));
}

// Sections worth adding to a message without being asked: only clear matches, close to the best
// one, within a size budget (a small model's context is tight).
async function relevant(query, { budget = 6000, limit = 4 } = {}) {
  if (!folders.list().length) return [];
  // Meaning only: "my new sales leads" shares every word with the sales docs but wants the leads.
  const hits = await search(query, { limit, min: INJECT, words: false });
  if (!hits.length) return [];
  const best = hits[0].score;
  const out = [];
  let used = 0;
  for (const h of hits) {
    if (h.score < best - 0.1) break; // a two-part question keeps the match for its second part
    if (used + h.text.length > budget) break;
    used += h.text.length;
    out.push(h);
  }
  return out;
}

// How sections are shown to a model, each with where it came from.
function format(hits) {
  return hits.map((h, i) => `[${i + 1}] ${h.heading}  (${h.file})\n${h.text}`).join('\n\n');
}

function setHostsForTests(fn) { hostsFn = fn; found = null; }
function resetForTests() { home = ''; index = null; scanning = null; lastScan = 0; lastError = ''; found = null; }

module.exports = { folders, setHome, refresh, status, search, relevant, format, split, setHostsForTests, resetForTests, EMBED_MODELS };
