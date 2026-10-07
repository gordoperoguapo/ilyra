// Run with: node test/chat.test.js
// Runs the real chat handler from electron/main.js with Electron replaced by stand-ins and the
// provider's network call replaced by a fake model, and checks what the user would see.
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-chat-'));
const handlers = {};
const stub = (name) => new Proxy(function () {}, { get: (t, k) => (typeof k === 'symbol' ? (k === Symbol.toPrimitive ? () => name : undefined) : k === 'then' ? undefined : stub(`${name}.${k}`)), apply: () => stub(`${name}()`), construct: () => stub(`new ${name}`) });
const electron = new Proxy({
  app: new Proxy({
    requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), getPath: () => dataDir, isPackaged: false,
    on() {}, once() {}, getVersion: () => '0.0.0', setAppUserModelId() {}, quit() {}, getLoginItemSettings: () => ({})
  }, { get: (t, k) => (k in t ? t[k] : stub(`app.${String(k)}`)) }),
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on() {} },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).map((b) => b ^ 0x5a), decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString() },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: Object.assign(function () {}, { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] }),
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  clipboard: { readText: () => '', writeText() {} }
}, { get: (t, k) => (k in t ? t[k] : stub(String(k))) });
const orig = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : orig.call(this, request, ...rest); };

// The model: Claude's adapter with its network call swapped for a fake that answers from the message.
const { PROVIDERS } = require('../electron/providers');
const asked = [];
const summaries = [];
PROVIDERS.claude.adapter.step = async ({ system, native, onText }) => {
  const last = native[native.length - 1].content;
  asked.push({ last, system, count: native.length });
  let text;
  if (/^You write short, faithful summaries/.test(system)) { summaries.push({ system, prompt: last }); text = `Summary number ${summaries.length}`; }
  else if (/headache/i.test(last)) text = "I can help with that. However, I'm not a medical professional, and it's best to consult a doctor.\nDrink water and rest in a dark room. If it is the worst headache of your life, call 911.";
  else text = 'Okay.';
  onText(text);
  return { text, calls: [], raw: [{ type: 'text', text }], usage: { input: 10, output: 5 }, sources: [], searches: [], runs: [], images: [], notes: [] };
};

(async () => {
  const store = require('../electron/store');
  store.setDir(dataDir);
  try { require('../electron/main'); } catch (e) { console.log(e.stack); process.exit(1); }
  assert.ok(handlers.chat, 'the chat handler is registered');
  const sent = [];
  const event = { sender: { id: 1, isDestroyed: () => false, send: (ch, payload) => sent.push([ch, payload]) } };

  // ---- nothing connected yet
  const none0 = await handlers.chat(event, 'claude', [{ role: 'user', content: 'hi' }], { requestId: 'r0', chatId: 'c0' });
  assert.ok(/isn't connected yet/.test(none0.error), 'a model with no key says so: ' + none0.error);
  const list = await handlers['providers:list'](event);
  assert.deepStrictEqual(list.map((p) => p.id).sort(), ['chatgpt', 'claude', 'gemini', 'local', 'meta'], 'the cloud providers and local models are offered');

  // ---- connect a key (checked by listing models); it is never stored in plain text
  const KEY = 'sk-ant-test-' + 'a1'.repeat(20);
  PROVIDERS.claude.models = async (key) => { if (key !== KEY) throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); return ['claude-test-1']; };
  assert.ok((await handlers['providers:save'](event, 'claude', { key: 'wrong' })).error, 'a rejected key is not saved');
  const saved = await handlers['providers:save'](event, 'claude', { key: KEY, model: 'Add a key to choose a model' });
  assert.ok(saved.provider.model === 'claude-test-1' && !saved.provider.pinned, 'placeholder text is never saved as the model');
  assert.ok(saved.provider && saved.provider.connected, 'the right key connects');
  for (const f of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, f);
    if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'utf8').includes(KEY), `the key is not in plain text in ${f}`);
  }

  // ---- a local model server: its address is the key
  assert.ok(/http/.test((await handlers['providers:save'](event, 'local', { key: 'ftp://x' })).error), 'a bad address is refused');
  PROVIDERS.local.models = async () => [];
  assert.ok(/no models yet/.test((await handlers['providers:save'](event, 'local', { key: 'localhost:11434' })).error), 'a server without models says so');
  PROVIDERS.local.models = async (address) => { assert.strictEqual(address, 'http://localhost:11434'); return ['llama3.2:3b']; };
  const localSaved = await handlers['providers:save'](event, 'local', { key: 'localhost:11434/' });
  assert.ok(localSaved.provider.connected && localSaved.provider.local, 'a local server connects');
  assert.strictEqual(localSaved.provider.hint, 'http://localhost:11434', 'its address is shown');
  assert.strictEqual(localSaved.provider.model, 'llama3.2:3b', 'its first model is used');
  const realStep = PROVIDERS.local.adapter.step;
  let localAsk = null;
  PROVIDERS.local.adapter.step = async (o) => { localAsk = o; o.onText('Hi.'); return { text: 'Hi.', calls: [], raw: {}, usage: null }; };
  const localRes = await handlers.chat(event, 'local', [{ role: 'user', content: 'hi' }], { requestId: 'rl', chatId: 'cl', web: true, code: true });
  assert.ok(!localRes.error && localAsk.key === 'http://localhost:11434', 'a local reply goes to that server');
  assert.ok(!localAsk.web && !localAsk.code, 'a local server is not asked to search or run code itself');
  // The local model searches and runs code through Ilyra's own tools instead (extras/tools.js).
  const localTools = localAsk.tools.map((t) => t.name);
  assert.ok(localTools.includes('web_search') && localTools.includes('run_code') && /web_search/.test(localAsk.system), 'a local model gets web_search and run_code as its own tools');
  assert.ok(!localAsk.tools.some((t) => ['save_memory', 'write_file', 'schedule_task', 'read_file', 'search_chats'].includes(t.name)), 'a small local model gets tools only when the message is about them');

  // ---- how much the local model keeps: by its size, or as Settings say
  assert.ok(/Never make up facts/.test(localAsk.system) && !/live preview panel/.test(localAsk.system), 'a small local model gets the short prompt');
  assert.ok(localAsk.tools.some((t) => t.name === 'ask_model') && /ask_model: claude/.test(localAsk.system), 'it can hand work to the connected cloud model');
  const small = (await handlers['providers:list'](event)).find((p) => p.id === 'local');
  assert.ok(small.params === 3 && !small.strong && small.context === 8192 && small.role === 'auto', 'a 3B model keeps everyday chat, with 8k of context by default');
  await handlers['settings:set'](event, { localRole: 'most', localContext: 12345 });
  const strong = (await handlers['providers:list'](event)).find((p) => p.id === 'local');
  assert.ok(strong.strong && strong.context === 8192, 'the role can be raised, and an unknown context size is ignored');
  await handlers.chat(event, 'local', [{ role: 'user', content: 'hi' }], { requestId: 'rl2', chatId: 'cl', delegates: ['gemini'] });
  assert.ok(/live preview panel/.test(localAsk.system) && !/Never make up facts/.test(localAsk.system), 'a strong local model gets the full prompt');
  assert.ok(!localAsk.tools.some((t) => t.name === 'ask_model'), 'only the cloud models chosen in Settings are asked (Gemini is not connected)');
  await handlers['settings:set'](event, { localRole: 'auto', localContext: 16384 });
  assert.strictEqual((await handlers['providers:list'](event)).find((p) => p.id === 'local').context, 16384, 'the context size can be changed');
  PROVIDERS.local.adapter.step = realStep;

  // ---- ask_model: once local data was read, the question is shown in full before it leaves
  const tools = require('../electron/tools');
  let shown = null;
  const reading = { localDataRead: true, confirm: async (c) => { shown = c; return false; }, askModel: async () => ({ text: 'x', name: 'Claude', model: 'm' }) };
  await assert.rejects(tools.runTool('ask_model', { provider: 'claude', question: 'what does notes.txt say: the secret plan' }, reading), /declined/);
  assert.ok(shown && shown.detail.includes('the secret plan'), 'the question is shown to the user');
  const answered = await tools.runTool('ask_model', { provider: 'claude', question: 'hi' }, { askModel: async () => ({ text: 'Hello', name: 'Claude', model: 'm' }) });
  assert.ok(/Claude answered:\n\nHello/.test(answered.output), 'without local data read, it just asks');
  await handlers['providers:remove'](event, 'local');
  sent.length = 0;

  // ---- a plain reply
  const res = await handlers.chat(event, 'claude', [{ role: 'user', content: 'hello there' }], { requestId: 'r1', chatId: 'c1' });
  assert.ok(!res.error, 'no error: ' + res.error);
  assert.strictEqual(res.text, 'Okay.');
  assert.deepStrictEqual(res.usage, { input: 10, output: 5 }, 'usage is reported');
  const streamed = sent.filter((s) => s[0] === 'chat:delta').map((s) => s[1]).join('');
  assert.strictEqual(streamed.trim(), res.text.trim(), 'what was shown matches what was saved');
  assert.ok(/You are Ilyra/.test(asked[0].system), 'the Ilyra persona');

  // ---- /compact: the summary writer and carrying a summary into the next message
  asked.length = 0;
  const long = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'word '.repeat(300) }));
  const sum = await handlers['chat:summarize'](event, { messages: long, previous: 'Earlier: the user has a dog.', instructions: 'keep the dog' });
  assert.ok(!sum.error, 'summarize works: ' + sum.error);
  assert.strictEqual(sum.model, 'claude', 'a connected model writes it');
  assert.ok(summaries.every((x) => x.system.startsWith('You write short, faithful summaries')), 'its own system prompt, not the Ilyra persona');
  assert.ok(/Summary so far:\nEarlier: the user has a dog\./.test(summaries[0].prompt), 'it builds on the previous summary');
  assert.ok(/Pay special attention to: keep the dog/.test(summaries[0].prompt), 'the focus is passed on');
  assert.strictEqual(sum.text, `Summary number ${summaries.length}`, 'the last summary is the result');
  assert.ok((await handlers['chat:summarize'](event, { messages: [] })).error, 'nothing to summarize is an error, not a crash');

  asked.length = 0;
  const after = await handlers.chat(event, 'claude', [{ role: 'user', content: 'what is for dinner' }], { requestId: 'r2', chatId: 'c1', summary: 'The user is planning a dinner party and has a dog named Max.' });
  assert.ok(!after.error, after.error);
  assert.ok(/Earlier in this conversation[\s\S]*planning a dinner party/.test(asked[0].system), 'the summary reaches the model');
  assert.strictEqual(asked[0].count, 1, 'only the recent messages are sent');

  // ---- "stop telling me what you are ... save that to your memory": kept as a standing rule, and followed
  asked.length = 0;
  const said = "wrong. also stop telling me what you are. you have said you're not a doctor, you're not a restaurant guide, etc. - I know what you are and are not. please save that to your memory because I don't want to keep hearing it.";
  const kept = await handlers.chat(event, 'claude', [{ role: 'user', content: said }], { requestId: 'r4', chatId: 'c4' });
  assert.ok(!kept.error, kept.error);
  const mem = store.memory.get();
  assert.ok(/^- Preference: stop telling me what you are$/m.test(mem), 'the instruction itself is saved, not the tail of the sentence: ' + mem);
  assert.ok(!/keep hearing it/.test(mem), 'no junk saved');
  assert.ok(/saved to memory just now/i.test(asked[0].system), 'the model is told it was saved');
  asked.length = 0;
  await handlers.chat(event, 'claude', [{ role: 'user', content: 'what is the capital of France' }], { requestId: 'r5', chatId: 'c5' });
  assert.ok(/standing preferences[\s\S]*stop telling me what you are/i.test(asked[0].system), 'later messages carry it as a rule');
  assert.ok(!/Facts about the USER[\s\S]*Preference/.test(asked[0].system), 'and not as a fact about the user');
  assert.ok(/no unprompted disclaimers or lectures/.test(asked[0].system), 'and the no-lectures rule is always there');
  assert.ok(/You are an AI named Ilyra\. If you are asked who or what you are, or what your name is, answer plainly/.test(asked[0].system), 'while it still knows what it is and says so when asked');

  // ---- no lectures, in what is shown and what is saved
  sent.length = 0;
  const head = await handlers.chat(event, 'claude', [{ role: 'user', content: 'Can you give me health advice about a headache?' }], { requestId: 'r7', chatId: 'c7' });
  assert.ok(!head.error, head.error);
  assert.ok(!/not a medical professional|consult a doctor/i.test(head.text), 'the saved reply has no disclaimer: ' + head.text);
  assert.ok(/Drink water/.test(head.text) && /call 911/.test(head.text), 'the advice and the emergency line stay');
  const shownText = sent.filter((x) => x[0] === 'chat:delta').map((x) => x[1]).join('');
  assert.strictEqual(shownText.trim(), head.text.trim(), 'and the same is what was shown');

  console.log('chat ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
