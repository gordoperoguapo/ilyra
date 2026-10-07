// The extras' wiring (electron/extras/index.js): their IPC calls, which extra tools a reply may
// use, skills in the prompt, and approval once per task.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

const store = require('../electron/store');
store.setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-extras-')));
// An empty library and skills folder, not the user's own.
process.env.ILYRA_LIBRARY = path.join(store.dataDir(), 'empty-library');
process.env.ILYRA_SKILLS = path.join(store.dataDir(), 'skills');
const extras = require('../electron/extras');

const keys = {};
const keystore = {
  getKey: (id) => (keys[id] && keys[id].key) || null,
  set: (id, v) => { keys[id] = Object.assign({}, keys[id], v); },
  remove: (id) => { delete keys[id]; },
  summary: (id) => { const e = keys[id] || {}; return { connected: Boolean(e.key), hint: e.hint || null }; }
};
const registered = {};
const ipcMain = { handle: (channel, fn) => { registered[channel] = fn; } };

(async () => {
  extras.install({ app: { getPath: () => store.dataDir(), on() {} }, ipcMain, dialog: {}, BrowserWindow: {}, keystore, getWindow: () => null });
  extras.start();
  ok('the IPC calls are registered', ['library:status', 'artifacts:list', 'work:list', 'apis:list', 'skills:list'].every((c) => registered[c]));
  ok('nothing personal is registered', !Object.keys(registered).some((c) => /^(integrations|pod|phone|remote):/.test(c)));

  // Which extra tools a reply may use.
  const send = () => {};
  const cloudReply = await extras.forChat({ provider: { local: false }, messages: [{ role: 'user', content: 'hi' }], lastText: 'hi', chatId: 'c', options: {}, send });
  ok('cloud models search and run code on their side', cloudReply.gate.web_search === false && cloudReply.gate.run_code === false);
  ok('the library is off until it has documents', cloudReply.gate.search_library === false);
  const localReply = await extras.forChat({ provider: { local: true }, messages: [{ role: 'user', content: 'hi' }], lastText: 'hi', chatId: 'c', options: { web: true }, send });
  ok('a local model gets web_search and run_code', localReply.gate.web_search && localReply.gate.run_code);
  ok('and is told how to use only the tools it is offered', /web_search/.test(localReply.prompt(['web_search'])) && !/search_library/.test(localReply.prompt(['web_search'])));
  const noWeb = await extras.forChat({ provider: { local: true }, messages: [{ role: 'user', content: 'hi' }], lastText: 'hi', chatId: 'c', options: { web: false, code: false }, send });
  ok('the web and code switches in the chat bar still apply', !noWeb.gate.web_search && !noWeb.gate.run_code);
  ok('tools for tasks, APIs and the browser only when the message is about them', localReply.gate.start_task === false && localReply.gate.http_request === false && localReply.gate.browse === false);
  ok('a message about a background job offers start_task', (await extras.forChat({ provider: { local: true }, messages: [], lastText: 'work on this in the background', chatId: 'c', options: {}, send })).gate.start_task !== false);

  // Skills: none on, no use_skill; one on, its name and description reach the reply, not its text.
  ok('no skills on: no use_skill', cloudReply.gate.use_skill === false);
  const skillDir = path.join(store.dataDir(), 'a-skill');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: page-taste\ndescription: Better looking pages\n---\nNever use purple gradients.');
  extras.skills.addFromFolder(skillDir);
  const skilled = await extras.forChat({ provider: { local: true }, messages: [{ role: 'user', content: 'make a page' }], lastText: 'make a page', chatId: 'c', options: {}, send });
  ok('a skill that is on is offered by name', skilled.gate.use_skill === true && /page-taste: Better looking pages/.test(skilled.prompt(['use_skill'])) && !/purple/.test(skilled.prompt(['use_skill'])));
  extras.skills.setEnabled('page-taste', false);
  ok('and off again, it is gone', (await extras.forChat({ provider: { local: true }, messages: [], lastText: 'make a page', chatId: 'c', options: {}, send })).gate.use_skill === false);

  // Approval once per task: "Allow for this task" covers the rest of that reply, of any kind.
  let asked = 0;
  let reply = true;
  let confirm = extras.forTask(async () => { asked++; return reply; });
  ok('"Allow once" asks again next time', (await confirm({ kind: 'edit' })) === true && (await confirm({ kind: 'web' })) === true && asked === 2);
  reply = 'task';
  ok('"Allow for this task" allows', (await confirm({ kind: 'edit' })) === true && asked === 3);
  ok('then nothing else in the task asks', (await confirm({ kind: 'web' })) === true && (await confirm({ kind: 'connector' })) === true && asked === 3);
  confirm = extras.forTask(async () => { asked++; return reply; });
  reply = false;
  ok('a new task asks again, and Deny denies', (await confirm({ kind: 'edit' })) === false && asked === 4);
  ok("a denial doesn't allow the rest", (await confirm({ kind: 'web' })) === false && asked === 5);

  extras.stop();
  console.log(`extras ok (${pass} checks)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
