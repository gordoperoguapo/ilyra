// Ilyra's main process: the window, the tray, and every request the page makes (see preload.js).
// API keys, files and provider calls stay here; the page only ever sees results.
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { default: OpenAI } = require('openai');

const { runAgent } = require('./agent');
const artifactStore = require('./artifacts');
const chatState = require('./chat');
const keystore = require('./keystore');
const location = require('./location');
const mcp = require('./mcp');
const profile = require('./profile');
const { PROVIDERS, errorDetail, friendlyError, isOutOfCredit, pickModel, rankModels, tryAnotherModel } = require('./providers');
const sandbox = require('./sandbox');
const scheduler = require('./scheduler');
const store = require('./store');
const tone = require('./tone');
const { pruneBackups } = require('./tools');
const usage = require('./usage');
const voice = require('./voice');

// ---------- Constants and state ----------

const INDEX = path.join(__dirname, '..', 'web', 'index.html');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const DATA_DIR = app.getPath('userData');
const SPEECH_MODELS = path.join(DATA_DIR, 'models');
const LOG_FILE = path.join(DATA_DIR, 'ilyra.log');
const LOG_MAX = 1024 * 1024;

const PROVIDER_IDS = Object.keys(PROVIDERS);
const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
// OpenAI's text-to-speech voices. 'windows' (the built-in voice, played by the page) is handled there.
const VOICES = ['marin', 'cedar', 'nova', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'sage', 'shimmer', 'verse'];
const MODEL_LIST_TTL = 5 * 60000;

// Artifacts: HTML pages the AI writes, shown live in the preview panel. Each one is served from
// its own ilyra-artifact:// origin inside a sandboxed frame, so it can run its own scripts but
// can't reach Ilyra, its keys or your files.
const ARTIFACT_SCHEME = artifactStore.SCHEME;
protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Providers whose account ran out of credit this session, skipped until a key is saved again.
const outOfCredit = new Set();
const modelListCache = new Map();

let mainWindow = null;
let tray = null;
let quitting = false;

const fail = (err) => ({ error: String((err && err.message) || err).slice(0, 300) });
const connectedProviders = () => PROVIDER_IDS.filter((k) => keystore.getKey(k) && !outOfCredit.has(k));
const modelFor = (id) => keystore.getModel(id) || PROVIDERS[id].defaultModel;

// ---------- Failure log ----------

// Failures are written to ilyra.log in the data folder: provider, model, status and a short error
// message. Quoted text is stripped (providers sometimes echo part of a request back), and the log
// is kept under about 1 MB.
function logFailure(id, model, err) {
  try {
    const message = errorDetail(err).replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').slice(0, 160);
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE).subarray(LOG_MAX / 2));
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${id} ${model} ${message}\n`);
  } catch { /* logging must never break a reply */ }
}

// ---------- Window, tray and notifications ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#090a0c',
    title: 'Ilyra',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090a0c', symbolColor: '#b4b8bf', height: 36 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Talk mode keeps listening while Ilyra is behind other windows.
      backgroundThrottling: false
    }
  });
  mainWindow = win;
  win.loadFile(INDEX);

  // Started by Windows at sign-in with background mode on: stay in the tray.
  win.once('ready-to-show', () => { if (!(process.argv.includes('--hidden') && store.settings.get().background)) win.show(); });
  win.on('close', (ev) => {
    if (!quitting && store.settings.get().background) { ev.preventDefault(); win.hide(); }
  });

  // Ilyra never navigates away from itself; links open in the real browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // A preview can't wander off to other sites inside its frame either. Opening a link from a
  // preview needs a yes (a page could otherwise open any address, with data in it, by itself).
  // Offline previews can't open links at all.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || e.url.startsWith(`${ARTIFACT_SCHEME}:`) || e.url.startsWith('about:')) return;
    e.preventDefault();
    if (!/^https:\/\//.test(e.url) || artifactStore.isOffline(e.frame && e.frame.url)) return;
    dialog.showMessageBox(win, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: 'Ilyra', message: 'This preview wants to open a link', detail: e.url.slice(0, 400) })
      .then((r) => { if (r.response === 0) shell.openExternal(e.url); }, () => {});
  });

  // ILYRA_DEBUG=1 echoes the page's console to the terminal.
  if (process.env.ILYRA_DEBUG || process.env.ILYRA_SMOKE) win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  // ILYRA_SMOKE=<png path>: load, report the page's state, save a screenshot and quit.
  if (process.env.ILYRA_SMOKE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const state = await win.webContents.executeJavaScript(`({
        desktop: document.body.classList.contains('desktop'),
        markdown: Boolean(window.marked && window.DOMPurify),
        font: document.fonts.check('16px "Chakra Petch"'),
        providers: document.querySelectorAll('.provider-row').length,
        sheetOpen: document.getElementById('settingsSheet').open
      })`);
      console.log('[smoke]', JSON.stringify(state));
      fs.writeFileSync(process.env.ILYRA_SMOKE, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500));
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// A picture of the screen Ilyra's window is on, taken with the window out of the way.
async function captureScreen(win) {
  if (win) win.hide();
  await new Promise((r) => setTimeout(r, 350));
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('Ilyra could not capture the screen. On a Mac, allow Screen Recording for Ilyra in System Settings.');
    let img = src.thumbnail;
    if (img.getSize().width > 1568) img = img.resize({ width: 1568 });
    return { mime: 'image/jpeg', data: img.toJPEG(85).toString('base64') };
  } finally {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  }
}

// Background mode keeps Ilyra in the tray when its window is closed.
function applyBackground() {
  const on = store.settings.get().background;
  if (on && !tray) {
    let icon = nativeImage.createFromPath(ICON);
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Ilyra');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Ilyra', click: showMainWindow },
      { label: 'Ask about my screen', click: async () => {
        try {
          const image = await captureScreen(mainWindow);
          showMainWindow();
          if (mainWindow) mainWindow.webContents.send('app:attachImage', image);
        } catch { showMainWindow(); }
      } },
      { type: 'separator' },
      { label: 'Quit Ilyra', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showMainWindow);
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
  }
}

function notify(title, body, chatId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: String(body || '').slice(0, 180) });
  n.on('click', () => {
    showMainWindow();
    if (chatId && mainWindow) mainWindow.webContents.send('app:openChat', chatId);
  });
  n.show();
}

// ---------- Providers ----------

function describe(id) {
  const p = PROVIDERS[id];
  const s = keystore.summary(id);
  return { id, name: p.name, local: Boolean(p.local), connected: s.connected, outOfCredit: outOfCredit.has(id), hint: s.hint, model: s.model || p.defaultModel, defaultModel: p.defaultModel, pinned: s.pinned };
}

ipcMain.handle('providers:list', () => PROVIDER_IDS.map(describe));

// Saving a key also checks it, by listing the provider's models. For local models the "key" is
// the server's address.
ipcMain.handle('providers:save', async (_e, id, fields) => {
  const p = PROVIDERS[id];
  if (!p) return { error: 'Unknown provider.' };
  let typedKey = String((fields && fields.key) || '').trim();
  if (p.local && typedKey) {
    try { typedKey = p.normalizeAddress(typedKey); } catch (err) { return { error: err.message }; }
  }
  const key = typedKey || keystore.getKey(id);
  if (!key) return { error: p.local ? 'Type the address of your model server first.' : 'Paste an API key first.' };
  let models;
  try {
    models = await p.models(key);
  } catch (err) {
    return { error: friendlyError(err) };
  }
  if (p.local && !models.length) return { error: 'The server is running but has no models yet. Download one first (in Ollama: ollama pull llama3.2), then press Save again.' };
  // No model typed in? Use the best one this key can use. A typed choice is remembered as
  // the user's own (pinned); an automatic pick is not.
  const typed = String((fields && fields.model) || '').trim();
  const typedModel = models.includes(typed) ? typed : '';
  const existing = keystore.summary(id);
  const model = typedModel || (existing.pinned && existing.model) || pickModel(id, models);
  keystore.set(id, { key: typedKey || null, hint: p.local ? typedKey : undefined, model, pinned: typedModel ? true : undefined });
  outOfCredit.delete(id);
  return { provider: describe(id), models };
});

// The models a provider offers this key, for the pickers.
ipcMain.handle('providers:models', async (_e, id, refresh) => {
  const p = PROVIDERS[id];
  const key = p && keystore.getKey(id);
  if (!key) return { error: 'Not connected.' };
  const hit = modelListCache.get(id);
  if (hit && !refresh && Date.now() - hit.at < MODEL_LIST_TTL) return { models: hit.models };
  try {
    const models = await p.listModels(key);
    modelListCache.set(id, { at: Date.now(), models });
    return { models };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle('providers:setModel', (_e, id, model) => {
  if (!PROVIDERS[id]) return { error: 'Unknown provider.' };
  if (keystore.getKey(id) && model) keystore.set(id, { model, pinned: true });
  return describe(id);
});

ipcMain.handle('providers:remove', (_e, id) => {
  if (!PROVIDERS[id]) return { error: 'Unknown provider.' };
  keystore.remove(id);
  return describe(id);
});

// Looks for a model server already running on this computer, to fill in its address.
ipcMain.handle('providers:findLocal', async () => {
  try { return { server: await PROVIDERS.local.find() }; } catch (err) { return fail(err); }
});

ipcMain.handle('providers:keyPage', (_e, id) => {
  if (PROVIDERS[id]) shell.openExternal(PROVIDERS[id].keyUrl);
});

ipcMain.handle('usage:get', () => usage.summary());

// ---------- Connectors (remote MCP servers; see mcp.js) ----------

const connectors = mcp.createManager({
  file: path.join(DATA_DIR, 'connectors.json'),
  secrets: { get: (k) => keystore.getKey(k), set: (k, v) => keystore.set(k, { key: v }), remove: (k) => keystore.remove(k) },
  openExternal: (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); }
});

ipcMain.handle('connectors:list', () => connectors.list());
ipcMain.handle('connectors:add', async (_e, fields) => { try { return (await connectors.add(fields || {})).state; } catch (err) { return fail(err); } });
ipcMain.handle('connectors:remove', async (_e, id) => { await connectors.remove(String(id)); return connectors.list(); });
ipcMain.handle('connectors:set', (_e, id, patch) => connectors.set(String(id), patch || {}));
ipcMain.handle('connectors:refresh', (_e, id) => connectors.refresh(String(id)));
ipcMain.handle('connectors:signin', async (_e, id) => { try { return await connectors.signIn(String(id)); } catch (err) { return fail(err); } });

// ---------- Chat ----------

// Every file change asks first. "Allow edits in this chat" covers up to 10 edits or 30 minutes
// in that one chat, shows a banner, and can be switched off. Only file edits can be approved
// ahead; everything else (memory, clipboard, opening pages, scheduling) is asked each time.
function makeConfirm({ win, chatId, signal, send }) {
  const ask = async (box) => {
    try { return await dialog.showMessageBox(win, Object.assign({ type: 'question', noLink: true, title: 'Ilyra', signal }, box)); } catch { return null; }
  };
  return async (change) => {
    const detail = `${change.path}\n\n${change.detail}`;
    if (change.kind && change.kind !== 'edit') {
      if (change.kind === 'clipboard-read' && chatState.clipboardAllowed(chatId)) return true;
      const res = await ask({ buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, message: change.title, detail });
      if (!res || signal.aborted || res.response !== 0) return false;
      if (change.kind === 'clipboard-read') chatState.allowClipboard(chatId);
      return true;
    }
    const granted = chatState.consume(chatId);
    if (granted) { send('chat:approval', granted); return true; }
    const res = await ask({ buttons: ['Allow', 'Allow edits in this chat for 30 minutes (up to 10)', 'Deny'], defaultId: 2, cancelId: 2, message: change.title, detail });
    if (!res || signal.aborted) return false;
    if (res.response === 1 && chatId) send('chat:approval', chatState.grant(chatId));
    return res.response !== 2;
  };
}

// Plain statements about the user ("I drive a 2016 Corolla") become Memory lines, with no model
// involved. Unless silent saving is on, the user is asked first. Returns a note for the model
// saying exactly what was saved, so it can never claim to remember something that wasn't kept.
async function learnFrom(text, { confirm, signal, send }) {
  const asked = profile.askedToRemember(text);
  try {
    let facts = profile.extract(text);
    // Asked to remember something that isn't a known kind of fact: keep their words.
    if (!facts.length && asked) facts = [profile.note(text)].filter(Boolean);
    const next = profile.apply(store.memory.get(), facts, store.memory.max);
    if (next.added.length) {
      const ok = store.settings.get().autoMemory || await confirm({ kind: 'memory', title: 'Remember this?', path: 'Memory', detail: next.added.map(profile.line).join('\n') });
      if (ok && !signal.aborted) {
        store.memory.set(next.text);
        send('chat:tool', { name: 'memory', summary: `saved to memory: ${next.added.map((f) => `${f.label} ${f.value}`).join(', ').slice(0, 80)}`, isError: false });
        return `Saved to memory just now: ${next.added.map((f) => `${f.label}: ${f.value}`).join('; ')}.`;
      }
      return asked ? 'The user declined to save this to memory. Nothing was saved.' : '';
    }
    if (asked && facts.length) return 'That is already in memory. Nothing new was saved.';
    if (asked) return 'Nothing was saved to memory. Say so, and suggest adding it in Settings, Memory.';
    return '';
  } catch {
    // Memory is a bonus: a failure here must never block the reply.
    return asked ? 'Saving to memory failed. Nothing was saved.' : '';
  }
}

// Picture making uses one provider: the user's choice in Settings, else the one the model asks
// for, else the one being chatted with if it can draw, else the first that can.
function makeImageGenerator({ id, preferred, inputImages, signal, send }) {
  const able = ['gemini', 'chatgpt'].filter((k) => keystore.getKey(k));
  if (!able.length) return null;
  return async ({ prompt, provider }) => {
    const use = [preferred, provider, id].find((k) => able.includes(k)) || able[0];
    send('chat:status', `Making an image with ${PROVIDERS[use].name}…`);
    try {
      return await PROVIDERS[use].images.generate(keystore.getKey(use), prompt, inputImages, signal);
    } catch (err) {
      logFailure(use, 'image', err);
      throw new Error(`${PROVIDERS[use].name} couldn't make the image: ${friendlyError(err)}`);
    }
  };
}

// An unmistakable "make me a picture" request must call the image tool rather than be answered
// with SVG or code, so the first step is forced to use it.
const ASKED_FOR_IMAGE = /\b(draw|generate|create|make|paint|illustrate|render|design)\b[^.?!]{0,40}\b(image|picture|photo|logo|illustration|icon|poster|wallpaper|drawing|portrait)\b|\b(image|picture|photo|drawing|illustration|logo) of\b/i;
const ASKED_FOR_MARKUP = /\b(svg|html|css|canvas|ascii|code)\b/i;

async function connectorTools() {
  try {
    const defs = await connectors.prepare();
    return defs.length ? { defs, names: connectors.serverNames(), owns: connectors.owns, call: connectors.call } : null;
  } catch {
    return null;
  }
}

ipcMain.handle('chat', async (e, id, messages, options = {}) => {
  const p = PROVIDERS[id];
  const key = p && keystore.getKey(id);
  if (!key) return { error: `${p ? p.name : 'That model'} isn't connected yet. ${p && p.local ? 'Connect it' : 'Add a key'} in Settings, AI models.` };
  const requestId = String(options.requestId || '');
  const chatId = typeof options.chatId === 'string' ? options.chatId.slice(0, 80) : '';
  const model = modelFor(id);

  // One reply at a time: a second request is refused rather than mixed into the first.
  const controller = chatState.begin(e.sender.id, requestId);
  if (!controller) return { error: 'Ilyra is still answering your last message. Wait for it, or press Stop.' };
  const signal = controller.signal;
  const send = (channel, payload) => { if (!e.sender.isDestroyed()) e.sender.send(channel, payload, requestId); };

  // What has been shown so far, so a stopped reply keeps it. The shown text passes through a
  // filter that drops boilerplate disclaimers (see tone.js).
  let partial = '';
  let toneFilter = null;
  let toolRan = false;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
  const toneOptions = { allowIdentity: tone.ASKS_IDENTITY.test(lastText) };
  const reset = () => { partial = ''; toneFilter = null; send('chat:reset'); };
  const cancelled = () => ({ text: partial, model, cancelled: true });
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  // Tokens this reply used, also added to the running tally.
  const used = { input: 0, output: 0 };
  const addUsage = (u) => { if (!u) return; used.input += u.input || 0; used.output += u.output || 0; usage.record(id, u.input, u.output); };

  const confirm = makeConfirm({ win: BrowserWindow.fromWebContents(e.sender), chatId, signal, send });
  const generateImage = makeImageGenerator({ id, preferred: options.imageProvider, inputImages: (lastUser && lastUser.images) || [], signal, send });
  const forceTool = generateImage && ASKED_FOR_IMAGE.test(lastText) && !ASKED_FOR_MARKUP.test(lastText) ? 'generate_image' : null;
  const memoryNote = lastText ? await learnFrom(lastText, { confirm, signal, send }) : '';

  // Where the user is now, refreshed at most every 20 minutes (the very first lookup waits briefly).
  const locationOn = store.settings.get().location;
  if (locationOn) await location.refresh({ wait: 2500 });
  const here = locationOn ? location.current() : null;

  const base = {
    id, key, messages, signal, confirm, generateImage, forceTool,
    roots: store.folders.list(),
    memory: memoryAdapter(), clipboard: clipboardAdapter, scheduler,
    connectors: await connectorTools(),
    makePdf: sandbox.makePdf, downloads: app.getPath('downloads'),
    // Web search and running code happen in the cloud providers' own sandboxes; reading a
    // page (fetch_page) is Ilyra's and works with any model.
    web: options.web !== false && p.canSearch !== false, fetch: options.web !== false,
    code: options.code !== false && p.canRunCode !== false,
    thinking: options.voice ? 'off' : THINKING_LEVELS.includes(options.thinking) ? options.thinking : 'medium',
    voice: Boolean(options.voice),
    memoryNote,
    briefs: store.briefs.get().trim(),
    here,
    hereNote: here ? `${here.label}${here.timezone ? ` (time zone ${here.timezone})` : ''}` : '',
    // /compact: the older part of this chat, summarized, replaces those messages.
    summary: typeof options.summary === 'string' ? options.summary.slice(0, 6000) : '',
    // Any model can answer "how many tokens have I used?" from Ilyra's own tally.
    usageNote: usage.asks(lastText) ? usage.report().text : '',
    onUsage: addUsage,
    onThinking: (t) => send('chat:thinking', t),
    onImage: (images) => send('chat:image', images),
    onSources: (list) => send('chat:sources', list),
    onRun: (run) => send('chat:code', run),
    onTool: (t) => { toolRan = true; send('chat:tool', t); },
    onText: (t) => {
      if (!toneFilter) toneFilter = tone.createToneFilter((shown) => { partial += shown; send('chat:delta', shown); }, toneOptions);
      toneFilter.push(t);
    }
  };

  // One try on one model; resolves to the text as shown (after the tone filter).
  const attempt = async (useModel, extra) => {
    const text = await runAgent(Object.assign({}, base, { model: useModel, retries: 0 }, extra));
    if (!toneFilter) return text;
    toneFilter.flush();
    const shown = toneFilter.result();
    toneFilter = null;
    return shown;
  };

  const run = async () => {
    send('chat:status', `Contacting ${model}…`);
    let err;
    try {
      return { text: await attempt(model), model };
    } catch (first) {
      err = first;
    }
    if (signal.aborted) return cancelled();
    logFailure(id, model, err);

    // "High demand" spikes are usually over in seconds: one more try on the same model first.
    if (!toolRan && (err.status || err.code) === 503) {
      send('chat:status', `${model} is busy. Trying again…`);
      reset();
      await sleep(2000);
      if (signal.aborted) return cancelled();
      try {
        return { text: await attempt(model), model };
      } catch (again) {
        if (signal.aborted) return cancelled();
        logFailure(id, model, again);
        err = again;
      }
    }

    // Some models reject tool definitions outright (a 400): answer as plain chat instead, and say so.
    if (!toolRan && (err.status || err.code) === 400) {
      const note = `Note: ${p.name} (${model}) rejected Ilyra's tools (${errorDetail(err)}). This answer is plain chat, so images, files and chat search are unavailable.\n\n`;
      reset();
      partial = note;
      send('chat:delta', note);
      try {
        return { text: note + await attempt(model, { useTools: false }), model };
      } catch (plainErr) {
        if (signal.aborted) return cancelled();
        logFailure(id, model, plainErr);
        return { error: `${p.name} (${model}): ${friendlyError(plainErr)}` };
      }
    }

    if (isOutOfCredit(err)) {
      outOfCredit.add(id);
      return { error: `${p.name}: ${friendlyError(err)}`, outOfCredit: true };
    }
    // Once a tool has run (a file may have changed), never replay the request on another model.
    // Nor on another local one: loading a second model can take minutes and all its memory.
    if (toolRan || p.local || !tryAnotherModel(err)) return { error: `${p.name} (${model}): ${friendlyError(err)}` };

    // The model was retired, renamed, isn't covered by this key's plan, or is overloaded: walk
    // down the best available ones, one quick try each, and keep whichever answers. Give up
    // after about a minute.
    let lastErr = err;
    let lastModel = model;
    const deadline = Date.now() + 60000;
    try {
      const candidates = rankModels(id, await p.models(key)).filter((m) => m !== model).slice(0, 5);
      for (const next of candidates) {
        if (Date.now() > deadline || signal.aborted) break;
        send('chat:status', `Trying ${next}…`);
        reset();
        try {
          const text = await attempt(next, { timeout: 30000 });
          // Only remember the switch if the user never chose a model themselves.
          if (!keystore.summary(id).pinned) keystore.set(id, { model: next });
          return { text, model: next, switchedTo: next };
        } catch (retryErr) {
          if (signal.aborted) return cancelled();
          logFailure(id, next, retryErr);
          lastErr = retryErr;
          lastModel = next;
          if (toolRan || !tryAnotherModel(retryErr)) break;
        }
      }
    } catch (listErr) {
      lastErr = listErr;
    }
    if (signal.aborted) return cancelled();
    return { error: `${p.name} (${lastModel}): ${friendlyError(lastErr)}` };
  };

  try {
    const out = await run();
    if (used.input || used.output) out.usage = { input: used.input, output: used.output };
    return out;
  } finally {
    chatState.end(e.sender.id, requestId);
  }
});

// Stop a running reply, and the short-lived per-chat approval for file edits.
ipcMain.handle('chat:cancel', (e, requestId) => chatState.cancel(e.sender.id, String(requestId)));
ipcMain.handle('approvals:status', (_e, chatId) => chatState.status(String(chatId || '')));
ipcMain.handle('approvals:revoke', (_e, chatId) => chatState.revoke(String(chatId || '')));

// /compact: a short summary of the older part of a chat, so it can carry on from the summary
// instead of every message. Long chats are summarized in pieces, each building on the last.
const SUMMARY_SYSTEM = 'You write short, faithful summaries of conversations, so that the conversation can carry on from your summary alone. Reply with only the summary, as plain text.';
const SUMMARY_CHUNK = 60000; // characters per request

function summaryChunks(list) {
  const chunks = [];
  let current = '';
  for (const m of list) {
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 1500)}`;
    if (current && current.length + line.length > SUMMARY_CHUNK) { chunks.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

ipcMain.handle('chat:summarize', async (_e, payload = {}) => {
  const list = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-300);
  if (!list.length) return { error: 'There is nothing to summarize.' };
  const id = connectedProviders()[0];
  if (!id) return { error: 'No model is available to write the summary. Connect one in Settings, AI models.' };
  const model = modelFor(id);
  const focus = String(payload.instructions || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  let summary = String(payload.previous || '').slice(0, 4000);
  try {
    for (const chunk of summaryChunks(list).slice(-6)) {
      const prompt = (summary ? `Summary so far:\n${summary}\n\nNew part of the conversation:\n` : 'The conversation:\n') + `${chunk}\n\n` +
        (summary ? 'Update the summary so it also covers the new part.' : 'Write a summary of it.') +
        " Keep the user's goals and requests, facts they shared, decisions made, names, numbers, dates, preferences, any code, commands or file names, and anything still unresolved. Leave out greetings and filler. At most 250 words." +
        (focus ? ` Pay special attention to: ${focus}.` : '');
      summary = (await runAgent({
        id, key: keystore.getKey(id), model, messages: [{ role: 'user', content: prompt }], roots: [],
        useTools: false, thinking: 'off', retries: 0, timeout: 120000, systemOverride: SUMMARY_SYSTEM,
        onUsage: (u) => usage.record(id, u.input, u.output), onText() {}
      })).trim();
    }
  } catch (err) {
    logFailure(id, model, err);
    return { error: `${PROVIDERS[id].name} could not write the summary: ${friendlyError(err)}` };
  }
  if (!summary) return { error: 'The summary came back empty. Try again.' };
  return { text: summary.slice(0, 6000), model: id };
});

// ---------- Voice ----------

// Text to speech for talk mode. With a ChatGPT key, replies are read by OpenAI's voices;
// otherwise the page falls back to the Windows voice.
ipcMain.handle('speak', async (_e, text, name) => {
  const key = keystore.getKey('chatgpt');
  if (!key || name === 'windows' || typeof text !== 'string' || !text.trim()) return { fallback: true };
  try {
    // A slow voice is worse than the Windows one: give up quickly and fall back.
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 10000 });
    const res = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: VOICES.includes(name) ? name : 'marin',
      input: text.slice(0, 4000),
      instructions: 'Speak like a warm, quick, capable personal assistant. Natural pace, conversational.',
      response_format: 'mp3'
    });
    return { audio: Buffer.from(await res.arrayBuffer()).toString('base64') };
  } catch (err) {
    logFailure('voice', 'tts', err);
    return { fallback: true };
  }
});

// Speech to text, on this computer (see voice.js): no recording is ever sent to an AI service.
ipcMain.handle('transcribe', async (e, audio) => {
  if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) return { error: 'That recording was not in the expected format.' };
  const wav = Buffer.from(audio instanceof ArrayBuffer ? audio : audio.buffer, audio.byteOffset || 0, audio.byteLength);
  if (!voice.validWav(wav)) return { error: 'That recording was too large or not in the expected format.' };
  const onStatus = (text) => { if (!e.sender.isDestroyed()) e.sender.send('voice:status', text); };
  try {
    return { text: (await voice.transcribe(wav, { cacheDir: SPEECH_MODELS, onStatus })) || '' };
  } catch (err) {
    return { error: /fetch|network|ENOTFOUND|ECONN/i.test(String(err && err.message))
      ? 'Ilyra needs an internet connection once to download the speech model. Try again when you are online.'
      : `Speech to text failed on this computer: ${(err && err.message) || 'unknown error'}` };
  }
});

// Talk-mode diagnostics: timings and outcomes only, never what was said.
const VOICE_EVENTS = ['heard', 'empty', 'noise', 'sent', 'replied', 'error', 'cap', 'enter'];
ipcMain.handle('voice:log', (_e, event) => {
  const kind = VOICE_EVENTS.includes(event && event.kind) ? event.kind : 'other';
  const nums = ['ms', 'audioMs', 'chars'].filter((k) => Number.isFinite(event && event[k])).map((k) => `${k}=${Math.round(event[k])}`).join(' ');
  logFailure('voice', kind, { message: nums || '-' });
});

// ---------- Saved chats, pages and images ----------

ipcMain.handle('chats:list', () => store.chats.list());
ipcMain.handle('chats:get', (_e, id) => store.chats.get(id));
ipcMain.handle('chats:save', (_e, chat) => { store.chats.save(chat); });
ipcMain.handle('chats:remove', (_e, id) => { store.chats.remove(id); });
ipcMain.handle('chats:pin', (_e, id, pinned) => { store.chats.setPinned(id, pinned); });
ipcMain.handle('chats:search', (_e, query) => store.chats.search(query, 30));

ipcMain.handle('artifact:open', (_e, html, offline) => artifactStore.open(html, offline));

async function saveFile(e, { title, defaultPath, filters, data }) {
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { title, defaultPath, filters });
  if (res.canceled || !res.filePath) return false;
  fs.writeFileSync(res.filePath, data);
  return true;
}

ipcMain.handle('artifact:save', (e, html, title) => {
  if (typeof html !== 'string') return false;
  const name = String(title || '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'ilyra-page';
  return saveFile(e, { title: 'Save page', defaultPath: `${name}.html`, filters: [{ name: 'Web page', extensions: ['html'] }], data: html });
});

ipcMain.handle('image:save', (e, mime, data) => {
  const ext = /jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : 'png';
  return saveFile(e, { title: 'Save image', defaultPath: `ilyra-image.${ext}`, filters: [{ name: 'Image', extensions: [ext] }], data: Buffer.from(String(data), 'base64') });
});

// ---------- Shared folders, memory, briefs, tasks and settings ----------

ipcMain.handle('folders:list', () => store.folders.list());
ipcMain.handle('folders:add', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Share a folder with Ilyra',
    buttonLabel: 'Share this folder',
    properties: ['openDirectory']
  });
  return res.canceled ? store.folders.list() : store.folders.add(res.filePaths[0]);
});
ipcMain.handle('folders:remove', (_e, p) => store.folders.remove(p));

const memoryAdapter = () => ({ get: () => store.memory.get(), set: (t) => store.memory.set(t), max: store.memory.max, autoSave: store.settings.get().autoMemory });
const clipboardAdapter = { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(String(t)) };

ipcMain.handle('memory:get', () => ({ text: store.memory.get(), max: store.memory.max }));
ipcMain.handle('memory:set', (_e, text) => { store.memory.set(String(text || '')); return store.memory.get(); });
ipcMain.handle('briefs:get', () => ({ text: store.briefs.get(), max: store.briefs.max }));
ipcMain.handle('briefs:set', (_e, text) => { store.briefs.set(String(text || '')); return store.briefs.get(); });
ipcMain.handle('tasks:list', () => scheduler.list());
ipcMain.handle('tasks:remove', (_e, id) => scheduler.remove(String(id)));

ipcMain.handle('settings:get', () => store.settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.settings.set(patch);
  if (patch && 'location' in patch) { if (next.location) location.refresh({ force: true }); else location.forget(); }
  applyBackground();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.startAtLogin, args: next.startAtLogin ? ['--hidden'] : [] });
  return next;
});

ipcMain.handle('screen:capture', async (e) => {
  try { return { image: await captureScreen(BrowserWindow.fromWebContents(e.sender)) }; } catch (err) { return { error: err.message }; }
});

// ---------- Scheduled tasks ----------

// A scheduled request runs on its own: web search only, no files, no clipboard, no edits.
async function runScheduledRequest(task) {
  const id = connectedProviders()[0];
  if (!id) return notify(task.title, 'Connect an AI in Settings, AI models, so Ilyra can run this task.');
  try {
    const text = await runAgent({
      id, key: keystore.getKey(id), model: modelFor(id),
      messages: [{ role: 'user', content: task.prompt }], roots: [], confirm: async () => false,
      useTools: false, web: true, code: false, thinking: 'low', retries: 1, timeout: 120000,
      memory: Object.assign(memoryAdapter(), { autoSave: false })
    });
    const at = Date.now();
    const chat = { id: 's' + at.toString(36), title: task.title, updated: at, messages: [{ role: 'user', content: task.prompt, at }, { role: 'assistant', content: text, model: id, at }] };
    store.chats.save(chat);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:chatsChanged');
    notify(task.title, text, chat.id);
  } catch (err) {
    logFailure(id, 'scheduled', err);
    notify(task.title, `Could not run: ${friendlyError(err)}`);
  }
}

let ticking = false;
async function runDueTasks() {
  if (ticking) return;
  ticking = true;
  try {
    for (const task of scheduler.due()) {
      if (task.prompt) await runScheduledRequest(task);
      else notify('Reminder', task.title);
    }
  } catch { /* a bad task must never stop the clock */ } finally { ticking = false; }
}

// ---------- App lifecycle ----------

// One Ilyra at a time: two copies would fight over the same data folder. Launching it again
// brings the open window forward, even from the tray.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(() => {
    // Dictation tools like Wispr Flow find the text box through the system's accessibility
    // layer, which Electron leaves off until it's asked.
    app.setAccessibilitySupportEnabled(true);
    // Windows needs this for notifications.
    app.setAppUserModelId('app.ilyra.hub');
    // The only permission Ilyra grants is the microphone, for talk mode. Previews get nothing.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) =>
      done(permission === 'media' && !String((details && details.requestingUrl) || '').startsWith(`${ARTIFACT_SCHEME}:`)));
    protocol.handle(ARTIFACT_SCHEME, (req) => {
      const entry = artifactStore.get(new URL(req.url).hostname);
      if (!entry) return new Response('This preview has expired. Open it again from the chat.', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(entry.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': artifactStore.cspFor(entry) } });
    });

    createWindow();
    applyBackground();
    location.init({ file: path.join(DATA_DIR, 'location.json') });
    if (store.settings.get().location) location.refresh();
    voice.warm(SPEECH_MODELS);
    pruneBackups();
    setInterval(runDueTasks, 20000);
    setTimeout(runDueTasks, 3000);
  });
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!store.settings.get().background) app.quit(); });
