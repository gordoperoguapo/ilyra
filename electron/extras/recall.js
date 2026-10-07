// Memory that works for anything you tell Ilyra, not a fixed list of fact types.
//
// Reading: for every message, Ilyra searches what it has saved about you (Memory)
// and what you said in earlier chats, and hands the most relevant lines to the
// model. Matching is by meaning-ish words ("kids" finds "children"), weighted so
// rare words count more than common ones.
//
// Writing: after you say something lasting about yourself, a small local model
// turns it into short facts ("The user has 3 children") and they are merged into
// Memory, replacing an older fact about the same thing. All of it runs on this
// computer.

const STOP = new Set(('a an and any are about all also am as at be been being but by can could did do does doing done for from get got had has have having he her him his how i if in into is it its just like me more most my no not now of on one or our out please should so some than that the their them then there these they this those to too up us was we were what whats when where which who whom whose why will with would you your yours ' +
  'user many much long tell told say said know knew remember recall mention mentioned ever chat chats conversation conversations earlier before last time previous past other old really very thing things want need make made').split(' '));

// Different words, same idea: they all count as one.
const CLASSES = {
  boy: 'child', boys: 'child', girl: 'child', girls: 'child', twin: 'child', twins: 'child', kid: 'child', kids: 'child', child: 'child', children: 'child', son: 'child', sons: 'child', daughter: 'child', daughters: 'child', baby: 'child', toddler: 'child',
  wife: 'spouse', husband: 'spouse', spouse: 'spouse', partner: 'spouse', married: 'spouse', girlfriend: 'spouse', boyfriend: 'spouse', fiance: 'spouse', fiancee: 'spouse',
  dog: 'pet', dogs: 'pet', cat: 'pet', cats: 'pet', pet: 'pet', pets: 'pet', puppy: 'pet', kitten: 'pet',
  job: 'job', work: 'job', works: 'job', working: 'job', career: 'job', company: 'job', employer: 'job', occupation: 'job', profession: 'job',
  car: 'car', vehicle: 'car', truck: 'car', suv: 'car', drive: 'car', drives: 'car',
  live: 'home', lives: 'home', living: 'home', home: 'home', city: 'home', town: 'home', address: 'home', house: 'home', apartment: 'home', state: 'home',
  allergic: 'allergy', allergy: 'allergy', allergies: 'allergy',
  birthday: 'birth', born: 'birth', birth: 'birth', age: 'birth', old: 'birth',
  mom: 'parent', mother: 'parent', mum: 'parent', dad: 'parent', father: 'parent', parents: 'parent',
  brother: 'sibling', sister: 'sibling', sibling: 'sibling', siblings: 'sibling', brothers: 'sibling', sisters: 'sibling'
};

function stem(word) {
  let w = word.toLowerCase();
  if (CLASSES[w]) return CLASSES[w];
  if (w.length > 4) w = w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '');
  return CLASSES[w] || w;
}

function tokens(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().replace(/'/g, '').match(/[a-z0-9]{3,}/g) || []) {
    if (STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

const numbers = (text) => new Set(String(text || '').match(/\b\d+\b/g) || []);
const QUESTIONISH = /^\s*(what|who|whom|whose|where|when|why|how|which|do|does|did|can|could|would|should|will|is|are|am|was|were|have|has|tell|remind)\b/i;
// A statement worth keeping as a source: not a question, not huge.
const isStatement = (text) => { const t = String(text || '').trim(); return t.length >= 6 && t.length <= 400 && !/\?\s*$/.test(t) && !QUESTIONISH.test(t); };

// The lines from Memory and from earlier chats that best match `query`, best first.
// store: { list(), get(id) } for saved chats; memoryText: the Memory file.
function relevant(query, { memoryText = '', store = null, chatId = '', limit = 5 } = {}) {
  const q = tokens(query);
  if (!q.size) return [];
  const docs = [];
  for (const line of String(memoryText).split('\n')) {
    const text = line.replace(/^\s*-\s*/, '').trim();
    if (text) docs.push({ text, from: 'memory', weight: 1.4, at: Date.now() });
  }
  if (store) {
    for (const entry of store.list()) {
      if (entry.id === chatId) continue;
      const chat = store.get(entry.id);
      if (!chat) continue;
      for (const m of chat.messages || []) {
        if (m.role === 'user' && isStatement(m.content)) docs.push({ text: String(m.content).replace(/\s+/g, ' ').trim(), from: 'chat', weight: 1, at: m.at || chat.updated || 0, title: chat.title });
      }
    }
  }
  if (!docs.length) return [];
  for (const d of docs) d.tokens = tokens(d.text);
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  // Any shared word counts, rarer ones more. In a large history, a word that is in over
  // half of everything is noise; with only a few lines saved, nothing is skipped.
  const weight = (t) => (docs.length >= 20 && (df.get(t) || 0) > docs.length / 2 ? 0 : 1 + Math.log(1 + docs.length / (df.get(t) || 1)));
  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const t of q) if (d.tokens.has(t)) score += weight(t);
    if (score >= 1) scored.push({ d, score: score * d.weight });
  }
  scored.sort((a, b) => b.score - a.score || b.d.at - a.d.at);
  const out = [];
  for (const { d } of scored) {
    if (out.some((o) => o.text.toLowerCase() === d.text.toLowerCase())) continue;
    out.push({ text: d.text.slice(0, 300), from: d.from, at: d.at, title: d.title });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- Writing: turn what you said into lasting facts ----------
// Cheap check first, so the model only runs on messages that could be about the user: a
// statement (not a question) that mentions them, short enough to be personal, and not code.
// The model, not a pattern list, decides whether anything in it is worth keeping.
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|me|mine|we|we're|we've|our|ours|us)\b/i;
function shouldLearn(text) {
  const t = String(text || '').trim();
  return t.length >= 8 && t.length <= 800 && !/\?\s*$/.test(t) && !t.includes('```') && FIRST_PERSON.test(t);
}

const LEARN_SYSTEM = `You pull lasting personal facts out of one message that a user sent to their assistant.
Reply with a JSON object: {"facts": [...]}. Each fact is one short sentence starting with "The user".
Keep only things that stay true for a long time about the user: their family, children, pets, home, work, health, preferences, habits and plans. Include names and numbers exactly as said.
Also use the everyday word for the thing (dogs, kids, wife, car, job, home) next to any specific word, so the fact is easy to find later when the user asks about it in different words.
Skip questions, requests, instructions for the assistant, opinions about the task, one-off events, and anything secret (passwords, keys, card or ID numbers).
If the message has no lasting facts, reply {"facts": []}.
Examples:
Message: I have 3 kids and a dog named Max
{"facts": ["The user has 3 children", "The user has a dog named Max"]}
Message: write me a poem about autumn
{"facts": []}
Message: my daughter Mia turns 7 in May
{"facts": ["The user has a daughter named Mia who turns 7 in May"]}
Message: we just adopted two rescue greyhounds called Bolt and Dash
{"facts": ["The user has two dogs, rescue greyhounds, named Bolt and Dash"]}
Message: I moved to Austin last year and work nights at a hospital
{"facts": ["The user lives in Austin", "The user works nights at a hospital"]}`;

const LEARN_SCHEMA = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] };
const SECRET = /\b(password|passcode|passphrase|api[- ]?key|secret|token|ssn|social security|credit card|card number|cvv|pin)\b/i;

function parseFacts(raw) {
  let list;
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    list = Array.isArray(j) ? j : j && j.facts;
  } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let f of list) {
    if (typeof f !== 'string') continue;
    f = f.replace(/\s+/g, ' ').replace(/[\s.]+$/, '').trim();
    if (f.length < 12 || f.length > 160 || !/^the user\b/i.test(f) || SECRET.test(f)) continue;
    f = 'The user' + f.slice(8);
    if (!out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
    if (out.length >= 5) break;
  }
  return out;
}

// Memory text with the new facts folded in. A fact about the same thing as an old
// line replaces it (so "4 children" replaces "3 children"); an identical one is skipped.
function merge(memoryText, facts, max = 6000) {
  let lines = String(memoryText || '').split('\n').filter((l) => l.trim());
  const added = [];
  for (const fact of facts) {
    const a = tokens(fact);
    const an = numbers(fact);
    let same = -1;
    let dup = false;
    lines.forEach((l, i) => {
      const body = l.replace(/^\s*-\s*/, '');
      const b = tokens(body);
      const union = new Set([...a, ...b]).size || 1;
      const sim = [...a].filter((t) => b.has(t)).length / union;
      const bn = numbers(body);
      const sameNumbers = an.size === bn.size && [...an].every((n) => bn.has(n));
      if (sim >= 0.8 && sameNumbers) dup = true;
      else if (sim >= 0.5 && same < 0) same = i;
    });
    if (dup) continue;
    const next = same >= 0 ? lines.filter((_, i) => i !== same) : lines.slice();
    next.push(`- ${fact}`);
    // Never cut memory off silently: if it won't fit, skip the fact.
    if (next.join('\n').length + 1 > max) continue;
    lines = next;
    added.push(`- ${fact}`);
  }
  return { text: lines.length ? lines.join('\n') + '\n' : '', added };
}

module.exports = { relevant, shouldLearn, parseFacts, merge, tokens, LEARN_SYSTEM, LEARN_SCHEMA };
