// Models running on the user's own computer (or another one on their network), through Ollama
// or any server that speaks the OpenAI chat completions API: LM Studio, llama.cpp, Jan, vLLM,
// LocalAI. There is no key: what Ilyra stores for this provider is the server's address, and
// requests go to that address only.

// ---------- Servers ----------

// Where the common model servers listen by default, in the order they are offered.
const KNOWN_SERVERS = [
  { name: 'Ollama', address: 'http://127.0.0.1:11434' },
  { name: 'LM Studio', address: 'http://127.0.0.1:1234' },
  { name: 'Jan', address: 'http://127.0.0.1:1337' },
  { name: 'llama.cpp', address: 'http://127.0.0.1:8080' },
  { name: 'vLLM', address: 'http://127.0.0.1:8000' }
];
const PROBE_TIMEOUT = 3000;
const CHAT_TIMEOUT = 600000; // a big model can take minutes to load on the first message
const WARM_TIMEOUT = 300000;
// Embedding, reranking and speech models show up in the lists but can't chat.
const NOT_CHAT = /embed|bge-|nomic|minilm|rerank|whisper|tts/i;

// The context size Ilyra asks Ollama for (Settings, AI models). Ollama's own default is small
// and silently drops the start of a long chat; Ilyra's instructions and tools alone are about 3k
// tokens. Every call uses the same value, or Ollama reloads the model. Other servers set it
// themselves when they load the model.
let contextSize = 8192;
function configure({ context } = {}) {
  if (Number.isFinite(context) && context > 0) contextSize = context;
}

// "localhost:11434", "http://localhost:1234/v1/" and the like, as one canonical address.
function normalizeAddress(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Type the address of your model server, like http://localhost:11434.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error(`"${input}" is not a web address.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://.');
  const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.origin + base;
}

// One HTTP request to the server, with errors a person can act on.
async function request(address, path, { body, signal, timeout = CHAT_TIMEOUT } = {}) {
  const limit = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  let res;
  try {
    res = await fetch(address + path, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: combined }
      : { signal: combined });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (limit.aborted) throw new Error(`The model server at ${address} took too long to answer. A big model can need a minute to load; try again.`);
    throw new Error(`Ilyra can't reach a model server at ${address}. Start it (for Ollama, open the Ollama app) and try again.`);
  }
  if (!res.ok) {
    let msg = '';
    try {
      const j = await res.json();
      msg = typeof j.error === 'string' ? j.error : (j.error && j.error.message) || j.message || '';
    } catch { /* no JSON body */ }
    throw Object.assign(new Error(msg || `The model server returned ${res.status}.`), { status: res.status });
  }
  return res;
}

// Which API the server speaks, and each model's size in billions of parameters, remembered per
// address.
const kinds = new Map();
const sizes = new Map();

// "8.0B" -> 8, "567M" -> 0.567, anything else -> null.
function billions(text) {
  const m = /(\d+(?:\.\d+)?)\s*([bm])\b/i.exec(String(text || ''));
  if (!m) return null;
  return parseFloat(m[1]) / (m[2].toLowerCase() === 'm' ? 1000 : 1);
}

async function ollamaModels(address, timeout) {
  const j = await (await request(address, '/api/tags', { timeout })).json();
  if (!j || !Array.isArray(j.models)) throw new Error('Not an Ollama server.');
  // Newer versions of Ollama say what each model can do; older ones are judged by name.
  const chats = (m) => (Array.isArray(m.capabilities) ? !m.capabilities.includes('embedding') : !NOT_CHAT.test(m.name));
  return j.models.filter((m) => m.name && chats(m))
    .map((m) => ({ id: m.name, bytes: m.size, params: billions(m.details && m.details.parameter_size) }));
}

async function openaiModels(address, timeout) {
  const j = await (await request(address, '/v1/models', { timeout })).json();
  if (!j || !Array.isArray(j.data)) throw new Error('Not an OpenAI-compatible server.');
  return j.data.filter((m) => m.id && !NOT_CHAT.test(m.id)).map((m) => ({ id: m.id, params: null }));
}

// The models the server has, and which API it speaks. Ollama is asked first because its own
// API can set the context size; anything else is treated as OpenAI-compatible.
async function inspect(address, timeout = PROBE_TIMEOUT) {
  let found = null;
  try {
    found = { kind: 'ollama', models: await ollamaModels(address, timeout) };
  } catch (err) {
    if (/can't reach/.test(err.message)) throw err;
  }
  if (!found) {
    try {
      found = { kind: 'openai', models: await openaiModels(address, timeout) };
    } catch (err) {
      if (/can't reach|took too long/.test(err.message)) throw err;
      throw new Error(`Something answered at ${address}, but it isn't a model server Ilyra knows (Ollama, or one with an OpenAI-compatible API).`);
    }
  }
  kinds.set(address, found.kind);
  for (const m of found.models) sizes.set(`${address} ${m.id}`, m.params);
  return found;
}

async function kindOf(address) {
  return kinds.get(address) || (await inspect(address)).kind;
}

// A model's size in billions of parameters: what the server reported, else the number in its
// name ("llama-3.1-70b-instruct"), else null.
function sizeOf(address, model) {
  const known = sizes.get(`${address} ${model}`);
  if (known) return known;
  const named = /(?:^|[^a-z\d.])(\d+(?:\.\d+)?)b\b/i.exec(String(model || '').split('/').pop());
  return named ? parseFloat(named[1]) : null;
}

// Loads the model ahead of a message (when talk mode starts), with the same settings chat
// uses, so the first reply doesn't wait for it. Only Ollama can be asked to.
// Loads the model now, with the same context size as the replies (a different one reloads it).
// How long it stays loaded is the server's own setting.
async function warm(address, model) {
  if (await kindOf(address) !== 'ollama') return;
  await request(address, '/api/generate', { body: { model, options: { num_ctx: contextSize } }, timeout: WARM_TIMEOUT });
}

async function kindOf(address) {
  return kinds.get(address) || (await inspect(address)).kind;
}

// Looks for a running model server at the usual addresses on this computer.
async function find() {
  const found = await Promise.all(KNOWN_SERVERS.map((s) => inspect(s.address).then((r) => ({ ...s, count: r.models.length }), () => null)));
  return found.find((s) => s && s.count) || found.find(Boolean) || null;
}

// ---------- Messages ----------

// What the model can't see is said in words, so it doesn't pretend it saw the picture.
const PICTURE_NOTE = '[The user attached a picture, which this model cannot see. If it matters, say so.]';
const withoutImages = (messages) => messages.map((m) => {
  if (!m.images) return m;
  const { images, ...rest } = m;
  return { ...rest, content: `${rest.content || ''}\n\n${PICTURE_NOTE}`.trim() };
});

const toolDefinitions = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

// Some models write their reasoning inline, between <think> and </think>. This sends that part
// to onThinking and the rest to onText, even when a tag is split across two chunks.
function thinkSplitter(onText, onThinking) {
  let inside = false;
  let held = '';
  let text = '';
  let thought = '';
  const emit = (s) => {
    if (!s) return;
    if (inside) { thought += s; if (onThinking) onThinking(s); } else { text += s; onText(s); }
  };
  return {
    push(chunk) {
      held += chunk;
      for (;;) {
        const tag = inside ? '</think>' : '<think>';
        const at = held.indexOf(tag);
        if (at !== -1) {
          emit(held.slice(0, at));
          held = held.slice(at + tag.length);
          inside = !inside;
          continue;
        }
        // Keep back anything that could be the start of a tag.
        let keep = 0;
        for (let n = Math.min(tag.length - 1, held.length); n > 0; n--) if (tag.startsWith(held.slice(-n))) { keep = n; break; }
        emit(held.slice(0, held.length - keep));
        held = held.slice(held.length - keep);
        return;
      }
    },
    end() { emit(held); held = ''; return { text, thought }; }
  };
}

// Small models sometimes write a tool call as text instead of making it. A reply that is only
// {"name": ..., "parameters": ...} is held back and turned into the call it meant; anything
// else passes straight through. Only used when tools were offered.
function textCallCatcher(onText) {
  let state = 'undecided'; // then 'holding' or 'passing'
  let buffer = '';
  return {
    onText(s) {
      if (state === 'passing') return onText(s);
      buffer += s;
      if (state === 'holding' || !buffer.trim()) return;
      if (buffer.trimStart()[0] === '{') { state = 'holding'; return; }
      state = 'passing';
      onText(buffer);
    },
    // The call, or null after showing whatever was held.
    end() {
      if (state !== 'holding') return null;
      try {
        const j = JSON.parse(buffer);
        const args = j.parameters || j.arguments;
        if (typeof j.name === 'string' && args && typeof args === 'object') return { name: j.name, args };
      } catch { /* not JSON after all */ }
      onText(buffer);
      return null;
    }
  };
}

// Reads a streamed body line by line.
async function eachLine(body, handle) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
  }
  if (buffer) handle(buffer);
}

// ---------- Ollama's own API ----------

// What each model can do (vision, tools, thinking), from Ollama itself. Null on old versions
// of Ollama that don't say, in which case Ilyra asks and adjusts when refused.
const capabilityCache = new Map();
async function ollamaCapabilities(address, model) {
  const id = `${address} ${model}`;
  if (!capabilityCache.has(id)) {
    let caps = null;
    try {
      const j = await (await request(address, '/api/show', { body: { model }, timeout: 10000 })).json();
      if (Array.isArray(j.capabilities)) caps = new Set(j.capabilities);
    } catch { /* unknown */ }
    capabilityCache.set(id, caps);
  }
  return capabilityCache.get(id);
}

async function ollamaStep({ address, model, system, native, tools, thinking, signal, onText, onThinking, timeout }) {
  const caps = await ollamaCapabilities(address, model);
  const notes = [];
  let messages = native.map((m) => (m.images ? { ...m, images: m.images.map((i) => i.data) } : m));
  if (caps && !caps.has('vision') && native.some((m) => m.images)) messages = withoutImages(native);
  const body = { model, messages: [{ role: 'system', content: system }].concat(messages), stream: true, options: { num_ctx: contextSize } };
  if (tools.length && (!caps || caps.has('tools'))) body.tools = toolDefinitions(tools);
  else if (tools.length) notes.push(`${model} can't use tools, so this answer can't read files, make images or search your chats.`);
  const level = thinking || 'medium';
  if (!caps || caps.has('thinking')) {
    // gpt-oss takes a level; other thinking models take on or off.
    body.think = /gpt-oss/i.test(model) ? ({ off: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high' }[level]) : level !== 'off';
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await request(address, '/api/chat', { body, signal, timeout: timeout || CHAT_TIMEOUT });
      break;
    } catch (err) {
      if (err.status !== 400 || attempt >= 3) throw err;
      if (body.tools && /tool/i.test(err.message)) {
        delete body.tools;
        notes.push(`${model} can't use tools, so this answer can't read files, make images or search your chats.`);
      } else if (body.think !== undefined && /think/i.test(err.message)) {
        delete body.think;
      } else if (/image|vision|multimodal/i.test(err.message) && body.messages.some((m) => m.images)) {
        body.messages = [body.messages[0]].concat(withoutImages(native));
      } else {
        throw err;
      }
    }
  }

  const catcher = textCallCatcher(onText);
  const split = thinkSplitter(body.tools ? catcher.onText : onText, onThinking);
  let thought = '';
  let usage = null;
  const calls = [];
  await eachLine(res.body, (line) => {
    if (!line.trim()) return;
    const j = JSON.parse(line);
    if (j.error) throw new Error(j.error);
    if (j.done) {
      // Ollama's own timings, for the speed log: loading the model, reading the prompt, writing.
      const ms = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : null);
      usage = { input: j.prompt_eval_count || 0, output: j.eval_count || 0,
        timing: { loadMs: ms(j.load_duration), promptMs: ms(j.prompt_eval_duration), writeMs: ms(j.eval_duration), totalMs: ms(j.total_duration), promptTokens: j.prompt_eval_count || 0, outputTokens: j.eval_count || 0, thinkingChars: thought.length } };
    }
    const m = j.message || {};
    if (m.thinking) { thought += m.thinking; if (onThinking) onThinking(m.thinking); }
    if (m.content) split.push(m.content);
    for (const c of m.tool_calls || []) {
      let args = (c.function && c.function.arguments) || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      calls.push({ id: `call_${calls.length}`, name: c.function && c.function.name, args });
    }
  });
  const out = split.end();
  const textCall = body.tools ? catcher.end() : null;
  if (textCall) {
    if (!calls.length) calls.push({ id: 'call_0', ...textCall });
    out.text = '';
  }
  const raw = { role: 'assistant', content: out.text };
  if (thought || out.thought) raw.thinking = thought || out.thought;
  if (calls.length) raw.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
  return { text: out.text, calls: calls.filter((c) => c.name), raw, usage, notes };
}

// ---------- OpenAI-compatible servers ----------

const asOpenAIContent = (m) => (m.images
  ? { role: m.role, content: m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })).concat([{ type: 'text', text: m.content || 'What is in this image?' }]) }
  : m);

async function openaiStep({ address, model, system, native, tools, signal, onText, onThinking, timeout }) {
  const notes = [];
  const body = {
    model,
    messages: [{ role: 'system', content: system }].concat(native.map(asOpenAIContent)),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (tools.length) body.tools = toolDefinitions(tools);

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await request(address, '/v1/chat/completions', { body, signal, timeout: timeout || CHAT_TIMEOUT });
      break;
    } catch (err) {
      if (![400, 422, 500].includes(err.status) || attempt >= 3) throw err;
      if (body.stream_options && /stream_options|include_usage/i.test(err.message)) {
        delete body.stream_options;
      } else if (body.tools && /tool|function|jinja/i.test(err.message)) {
        delete body.tools;
        notes.push(`${model} can't use tools on this server, so this answer can't read files, make images or search your chats.`);
      } else if (/image|vision|multimodal/i.test(err.message) && native.some((m) => m.images)) {
        body.messages = [body.messages[0]].concat(withoutImages(native));
      } else {
        throw err;
      }
    }
  }

  const catcher = textCallCatcher(onText);
  const split = thinkSplitter(body.tools ? catcher.onText : onText, onThinking);
  let thought = '';
  let usage = null;
  const pending = []; // tool calls arrive in pieces, keyed by index
  await eachLine(res.body, (line) => {
    const data = line.replace(/^data:\s*/, '').trim();
    if (!data || data === '[DONE]' || line.startsWith(':')) return;
    const j = JSON.parse(data);
    if (j.error) throw new Error(j.error.message || String(j.error));
    if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
    const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
    const reasoning = d.reasoning_content || d.reasoning;
    if (reasoning) { thought += reasoning; if (onThinking) onThinking(reasoning); }
    if (d.content) split.push(d.content);
    for (const t of d.tool_calls || []) {
      const slot = pending[t.index || 0] || (pending[t.index || 0] = { id: '', name: '', args: '' });
      if (t.id) slot.id = t.id;
      if (t.function && t.function.name) slot.name += t.function.name;
      if (t.function && t.function.arguments) slot.args += t.function.arguments;
    }
  });
  const out = split.end();
  const calls = pending.filter((c) => c && c.name).map((c, n) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { /* bad JSON: the tool will report the missing fields */ }
    return { id: c.id || `call_${n}`, name: c.name, args, argsText: c.args || '{}' };
  });
  const textCall = body.tools ? catcher.end() : null;
  if (textCall) {
    if (!calls.length) calls.push({ id: 'call_0', ...textCall, argsText: JSON.stringify(textCall.args) });
    out.text = '';
  }
  const raw = { role: 'assistant', content: out.text || null };
  if (calls.length) raw.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsText } }));
  return { text: out.text, calls, raw, usage, notes };
}

// ---------- Provider ----------

const adapter = {
  // Pictures stay as { mime, data } until a step knows which API it is sending them to.
  init(messages) {
    return messages.map((m) => (m.role === 'user' && m.images && m.images.length
      ? { role: 'user', content: m.content || 'What is in this image?', images: m.images.map((i) => ({ mime: i.mime, data: i.data })) }
      : { role: m.role, content: m.content }));
  },
  async step(opts) {
    const address = opts.key;
    const kind = await kindOf(address);
    const step = await (kind === 'ollama' ? ollamaStep : openaiStep)({ ...opts, address });
    return { sources: [], searches: [], runs: [], images: [], ...step, kind };
  },
  append(native, step, results) {
    native.push(step.raw);
    for (const r of results) {
      native.push(step.kind === 'ollama'
        ? { role: 'tool', tool_name: r.name, content: r.output }
        : { role: 'tool', tool_call_id: r.id, content: r.output });
    }
  }
};

module.exports = {
  name: 'Local',
  local: true,
  defaultModel: '',
  keyUrl: 'https://ollama.com/download',
  // These run in the cloud providers' own sandboxes; a local server has neither.
  canSearch: false,
  canRunCode: false,
  adapter,
  configure,
  normalizeAddress,
  find,
  sizeOf,
  warm,

  async models(address) {
    return (await inspect(address)).models.map((m) => m.id);
  },

  async listModels(address) {
    return (await inspect(address)).models.map((m) => ({ id: m.id, label: m.bytes ? `${m.id}  (${(m.bytes / 1e9).toFixed(1)} GB)` : m.id }));
  }
};
