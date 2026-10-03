// Token usage, counted on this computer. Every reply reports how many tokens it
// read and wrote; they are added up per day and per model here. Only counts are
// kept (never any text), and the file stays on this PC. Providers offer no way
// to read your remaining credit with a normal key, so this is Ilyra's own tally.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const KEEP_DAYS = 400;
const file = () => path.join(store.dataDir(), 'usage.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

// Adds one model call to today's tally for that provider.
function record(provider, input, output, now = new Date()) {
  input = count(input);
  output = count(output);
  if (!provider || !(input || output)) return;
  const data = load();
  const key = dayKey(now);
  const slot = (data[key] = data[key] || {});
  const row = (slot[provider] = slot[provider] || { input: 0, output: 0, replies: 0 });
  row.input += input;
  row.output += output;
  row.replies += 1;
  // Old days fall off so the file never grows without limit.
  const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 864e5));
  for (const k of Object.keys(data)) if (k < cutoff) delete data[k];
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(data));
  } catch { /* the tally is a convenience: never break a reply over it */ }
}

// { today: { claude: { input, output, replies } }, month: { ... } }
function summary(now = new Date()) {
  const data = load();
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const out = { today: {}, month: {} };
  for (const [day, slot] of Object.entries(data)) {
    const into = [];
    if (day === today) into.push(out.today);
    if (day.startsWith(month)) into.push(out.month);
    for (const bucket of into) {
      for (const [provider, row] of Object.entries(slot || {})) {
        const t = (bucket[provider] = bucket[provider] || { input: 0, output: 0, replies: 0 });
        t.input += count(row.input);
        t.output += count(row.output);
        t.replies += count(row.replies);
      }
    }
  }
  return out;
}

const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', meta: 'Meta' };
const short = (n) => (n < 1000 ? String(n) : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : n < 1e6 ? Math.round(n / 1000) + 'k' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');

// Is the user asking about their token usage?
const ASKS = /\b(usage|tokens?|token count|how much (?:have i|did i|am i|i(?:'ve)?) (?:used|using|spent|spending|burn\w*))\b/i;
// A question or request about it, not a remark ("I built a usage area").
const asks = (text) => { const t = String(text || '').trim(); return ASKS.test(t) && (/\?/.test(t) || /^(show|tell|what|how|check|give|display|pull|list|read)\b/i.test(t)); };

// The tally in words, for the models to quote: today and this month, per model, in and out.
function report(now = new Date()) {
  const s = summary(now);
  const line = (bucket, label) => {
    const rows = Object.entries(bucket).map(([k, r]) => ({ k, total: r.input + r.output, r })).filter((x) => x.total > 0);
    if (!rows.length) return `${label}: no tokens used yet.`;
    const total = rows.reduce((a, x) => a + x.total, 0);
    const each = rows.sort((a, b) => b.total - a.total).map((x) => `${NAMES[x.k] || x.k} ${short(x.total)} (${short(x.r.input)} in, ${short(x.r.output)} out)`).join('; ');
    return `${label}: ${short(total)} tokens in all. ${each}.`;
  };
  const text = `${line(s.today, 'Today')}\n${line(s.month, 'This month')}`;
  return { text, fixed: text };
}

module.exports = { record, summary, report, asks };
