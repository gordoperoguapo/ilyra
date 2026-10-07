// The Ilyra window: chat, the model picker, talk mode, the preview panel and Settings.
// Everything that needs a key, a file or the network goes through window.ilyra (see
// electron/preload.js). Opened in a plain browser (npm run preview) it still renders, with
// chats kept in localStorage and no models.
(function () {
  var MODELS = {
    auto:    { name: 'Auto',    rgb: [245, 165, 36], blurb: 'Ilyra picks the best model for each message' },
    claude:  { name: 'Claude',  rgb: [255, 106, 26], blurb: 'Long documents, planning and code' },
    chatgpt: { name: 'ChatGPT', rgb: [255, 214, 140], blurb: 'Writing, ideas and everyday tasks' },
    gemini:  { name: 'Gemini',  rgb: [190, 190, 196], blurb: 'Research and multimodal work' },
    meta:    { name: 'Meta',    rgb: [82, 148, 255],  blurb: 'Muse models: long context, reasoning and images in' },
    local:   { name: 'Local',   rgb: [94, 196, 170],  blurb: 'A model on your own computer: private and free' }
  };
  var PROVIDERS = ['claude', 'chatgpt', 'gemini', 'meta', 'local'];

  var $ = function (id) { return document.getElementById(id); };
  var promptEl = $('prompt');
  var sendButton = $('sendButton');
  var micButton = $('micButton');
  var thread = $('thread');
  var hint = $('hint');
  var orbState = $('orbState');
  var orb = window.createOrb($('orbCanvas'));
  var desktop = Boolean(window.ilyra && window.ilyra.desktop);
  if (desktop) document.body.classList.add('desktop');

  // Settings is one window with pages; the AI models page holds the provider keys.
  var currentPage = 'general';
  var aiModelsPage = {
    get open() { return $('settingsSheet').open && currentPage === 'keys'; },
    show: function () { openSettings('keys'); }
  };

  // ---------- State ----------
  // The conversation
  var selected = 'auto';
  var info = {};          // provider id -> { connected, hint, model, defaultModel, outOfCredit }
  var history = [];       // what is sent to the model
  var log = [];           // the same conversation with models, times and extras, for saving
  var chatSummary = '';   // /compact: the older part of this chat, summarized (those messages are no longer sent)
  var currentId = null;
  var busy = false;
  var attachments = [];   // { mime, data (base64), url }

  // The reply being written
  var pendingReply = null;
  var pendingModel = null;
  var activeRequest = null; // its request id, so stray events from an earlier one are ignored
  var streamText = '';
  var renderQueued = false;
  var thinkText = '';
  var thinkStart = 0;
  var madeImages = [];    // pictures made during it
  var foundSources = [];  // web pages it drew on
  var codeRuns = [];      // code the model ran
  // Did it read the user's own files, chats or clipboard? Then its previews run offline.
  var localDataTouched = false;
  // Tool events that never expose the user's own files, chats or clipboard.
  var OUTSIDE_TOOLS = { connector: 1, web_search: 1, fetch_page: 1, generate_image: 1, ask_model: 1, memory: 1, note: 1 };
  // Sandboxed code reads none of the user's data.
  OUTSIDE_TOOLS.run_code = 1;
  var connectorNames = []; // lower case, for routing messages that mention one

  // Preferences kept between sessions
  var webOn = true;
  var codeOn = true;
  var thinkLevel = 'medium';
  try { webOn = localStorage.getItem('ilyra.web') !== 'off'; } catch (e) {}
  try { codeOn = localStorage.getItem('ilyra.code') !== 'off'; } catch (e) {}

  // While waiting, show what Ilyra is doing and how long it's been.
  var statusText = '';
  var sentAt = 0;
  var statusTimer = null;
  function renderProgress() {
    // The live status line (below) shows what Ilyra is doing; this just keeps it current.
    if (pendingReply && statusText) setRunState(statusText, 'thinking');
  }
  function startProgress() {
    statusText = '';
    sentAt = Date.now();
    clearInterval(statusTimer);
    statusTimer = setInterval(renderProgress, 1000);
  }
  function stopProgress() {
    clearInterval(statusTimer);
    statusText = '';
  }
  // What a tool is called while it runs, and once it has run. Details stay out of the way.
  function toolLabels(tool) {
    var key = (tool && (tool.kind || tool.name)) || '';
    var map = {
      search_chats: ['Searching memory…', 'Searched memory'], list_chats: ['Searching memory…', 'Searched memory'], read_chat: ['Searching memory…', 'Searched memory'],
      web_search: ['Searching the web…', 'Searched the web'], fetch_page: ['Reading a web page…', 'Read a web page'],
      usage: ['Checking usage…', 'Checked usage'],
      read_file: ['Reading files…', 'Read files'], list_files: ['Reading files…', 'Read files'], search_files: ['Reading files…', 'Read files'],
      write_file: ['Editing a file…', 'Edited a file'], edit_file: ['Editing a file…', 'Edited a file'],
      generate_image: ['Making an image…', 'Made an image'], ask_model: ['Asking another model…', 'Asked another model'],
      save_memory: ['Updating memory…', 'Updated memory'], forget_memory: ['Updating memory…', 'Updated memory'], memory: ['Updating memory…', 'Updated memory'],
      read_clipboard: ['Using the clipboard…', 'Used the clipboard'], copy_to_clipboard: ['Using the clipboard…', 'Used the clipboard'],
      schedule_task: ['Scheduling…', 'Scheduled a task'], list_tasks: ['Scheduling…', 'Checked tasks'], cancel_task: ['Scheduling…', 'Cancelled a task'],
      connector: ['Using a connector…', 'Used a connector']
    };
    // The labels for the extras' tools (see extras.js).
    if (window.IlyraExtras) Object.assign(map, window.IlyraExtras.toolLabels);
    return map[key] || ['Using tools…', 'Used tools'];
  }
  if (desktop) {
    window.ilyra.onChatStatus(function (text, rid) {
      if (rid && rid !== activeRequest) return;
      statusText = text;
      renderProgress();
    });
  }

  // 1234 -> "1.2k", 1500000 -> "1.5M"
  function fmtTokens(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e6) return Math.round(n / 1000) + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  // ---------- This chat's token total ----------
  // Everything this chat has used: what each model read and wrote, added up over every reply
  // (the history is read again with each message, so this is what you are actually billed for).
  function chatTotals() {
    var t = { input: 0, output: 0, replies: 0, by: {} };
    log.forEach(function (m) {
      if (m.role !== 'assistant' || !m.usage) return;
      var i = m.usage.input || 0, o = m.usage.output || 0;
      if (!i && !o) return;
      t.input += i; t.output += o; t.replies++;
      var k = m.model || '?';
      t.by[k] = (t.by[k] || 0) + i + o;
    });
    return t;
  }
  // live: tokens the reply being written has produced so far (an estimate, until it finishes).
  function renderChatUsage(live) {
    var chip = $('chatUsage');
    if (!chip) return;
    var t = chatTotals();
    var total = t.input + t.output + (live || 0);
    chip.hidden = !total;
    if (!total) return;
    chip.querySelector('b').textContent = (live ? '~' : '') + fmtTokens(total);
    var parts = Object.keys(t.by).map(function (k) { return (MODELS[k] ? MODELS[k].name : k) + ' ' + fmtTokens(t.by[k]); });
    chip.title = 'Tokens this chat has used: ' + fmtTokens(t.input) + ' read, ' + fmtTokens(t.output) + ' written across ' + t.replies + ' repl' + (t.replies === 1 ? 'y' : 'ies') + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '. Counted on this computer.';
  }

  // The exact count in a finished reply's header: what the model read and wrote.
  function setTokens(el, usage) {
    var span = el && el.querySelector('.msg-tokens');
    if (!span) return;
    if (usage && (usage.input || usage.output)) {
      span.textContent = fmtTokens(usage.input || 0) + ' in · ' + fmtTokens(usage.output || 0) + ' out';
      span.title = 'Tokens this reply read (in) and wrote (out)';
    } else {
      span.textContent = '';
    }
  }

  // ---------- Live status line ----------
  // "1m 1s · ~2.4k tokens · Running tools…" with a small physics orb, shown while a reply is written.
  // The token figure is an estimate (about four characters a token) until the reply ends.
  var runStatus = null;
  function fmtElapsed(ms) {
    var s = Math.floor(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function startRunStatus(reply, model) {
    endRunStatus();
    // The line is a button: click it to read what the model is thinking, live.
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'run-status';
    row.setAttribute('aria-expanded', 'false');
    row.title = 'Show its thinking';
    var canvas = document.createElement('canvas');
    canvas.className = 'mini-orb';
    canvas.setAttribute('aria-hidden', 'true');
    var text = document.createElement('span');
    text.className = 'run-text';
    text.setAttribute('role', 'status');
    row.appendChild(canvas);
    row.appendChild(text);
    row.insertAdjacentHTML('beforeend', '<svg class="run-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>');
    var think = document.createElement('div');
    think.className = 'run-think';
    think.hidden = true;
    row.addEventListener('click', function () {
      var open = think.hidden;
      think.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
      row.title = open ? 'Hide its thinking' : 'Show its thinking';
      renderRunThink();
      follow();
    });
    reply.querySelector('.msg-body').after(row);
    row.after(think);
    var mini = window.createMiniOrb ? window.createMiniOrb(canvas) : null;
    if (mini) mini.setColor(BRAND);
    runStatus = { el: row, think: think, text: text, orb: mini, label: 'Starting…', t0: Date.now(), timer: setInterval(updateRunStatus, 500) };
    updateRunStatus();
  }
  function setRunState(label, mode) {
    if (!runStatus) return;
    runStatus.label = label;
    if (runStatus.orb) runStatus.orb.setState(mode);
  }
  function updateRunStatus() {
    if (!runStatus) return;
    var tokens = Math.ceil((streamText.length + thinkText.length) / 4);
    runStatus.text.textContent = fmtElapsed(Date.now() - runStatus.t0) + (tokens ? ' · ~' + fmtTokens(tokens) + ' tokens' : '') + ' · ' + runStatus.label;
    renderChatUsage(tokens);
  }
  // The thinking panel under the status line: the live text, or a note when there is none.
  function renderRunThink() {
    if (!runStatus || runStatus.think.hidden) return;
    var box = runStatus.think;
    var stuck = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.textContent = thinkText.trim() || 'Nothing to show yet. Some models share their thinking only at the end, and some do not share it at all.';
    box.classList.toggle('empty', !thinkText.trim());
    if (stuck) box.scrollTop = box.scrollHeight;
  }
  function endRunStatus() {
    if (!runStatus) return;
    clearInterval(runStatus.timer);
    if (runStatus.orb) runStatus.orb.stop();
    runStatus.think.remove();
    runStatus.el.remove();
    runStatus = null;
  }

  // Replies arrive in pieces. Show them as they land instead of waiting for the end.
  function renderStream() {
    renderQueued = false;
    if (!pendingReply) return;
    var body = pendingReply.querySelector('.msg-body');
    if (window.marked && window.DOMPurify) {
      body.innerHTML = window.DOMPurify.sanitize(window.marked.parse(streamText));
      body.classList.add('md');
      decorateCode(body);
      pendingReply.dataset.raw = streamText;
    } else {
      body.textContent = streamText;
    }
    follow();
  }
  if (desktop) {
    window.ilyra.onChatDelta(function (text, rid) {
      if (!pendingReply || (rid && rid !== activeRequest)) return;
      if (!streamText) {
        stopProgress();
        pendingReply.classList.remove('working');
        setOrb('speaking', pendingModel);
      }
      streamText += text;
      setRunState('Writing…', 'writing');
      if (runStatus && runStatus.orb) runStatus.orb.kick(Math.min(1, text.length / 24));
      updateRunStatus();
      if (talkMode) talkFeed(false);
      if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderStream); }
    });
    window.ilyra.onChatReset(function (rid) {
      if (rid && rid !== activeRequest) return;
      streamText = '';
      talkSaid = 0;
      thinkText = '';
      thinkStart = 0;
      var t = pendingReply && pendingReply.querySelector('.msg-thinking');
      if (t) t.remove();
    });
    window.ilyra.onChatCode(function (run, rid) {
      if (!pendingReply || (rid && rid !== activeRequest)) return;
      codeRuns.push(run);
      setRunState('Running code…', 'working');
      appendRun(pendingReply, run);
    });
    window.ilyra.onChatThinking(function (text, rid) {
      if (!pendingReply || (rid && rid !== activeRequest)) return;
      if (!thinkStart) thinkStart = Date.now();
      thinkText += text;
      if (!streamText) setRunState('Thinking…', 'thinking');
      if (runStatus && runStatus.orb) runStatus.orb.kick(0.15);
      // While it runs, the thinking lives only under the status line; it folds above the reply when done.
      renderRunThink();
      follow();
    });
    window.ilyra.onChatSources(function (list, rid) {
      if (rid && rid !== activeRequest) return;
      foundSources = list;
      if (pendingReply) renderSources(pendingReply, list);
    });
    window.ilyra.onChatImage(function (images, rid) {
      if (!pendingReply || (rid && rid !== activeRequest)) return;
      var strip = pendingReply.querySelector('.msg-images');
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'msg-images';
        pendingReply.insertBefore(strip, pendingReply.querySelector('.msg-body'));
      }
      images.forEach(function (im) {
        madeImages.push(im);
        strip.appendChild(imageTile(im, true));
      });
      follow();
    });
    window.ilyra.onChatTool(function (tool, rid) {
      if (!pendingReply || (rid && rid !== activeRequest)) return;
      if (tool && tool.name && !OUTSIDE_TOOLS[tool.name]) { localDataTouched = true; pendingReply.dataset.local = '1'; }
      var labels = toolLabels(tool);
      setRunState(labels[0], 'working');
      if (runStatus && runStatus.orb) runStatus.orb.kick(0.5);
      // All the steps fold into one closed row ("3 steps"), like the thinking box.
      var tools = pendingReply.querySelector('.msg-tools');
      if (!tools) {
        tools = document.createElement('details');
        tools.className = 'msg-tools';
        tools.innerHTML = '<summary></summary><div></div>';
        pendingReply.insertBefore(tools, pendingReply.querySelector('.msg-body'));
      }
      var box = tools.lastElementChild;
      tools.dataset.steps = String((Number(tools.dataset.steps) || 0) + 1);
      if (tool.isError) tools.dataset.failed = String((Number(tools.dataset.failed) || 0) + 1);
      var steps = Number(tools.dataset.steps), failed = Number(tools.dataset.failed) || 0;
      tools.firstElementChild.textContent = steps + (steps === 1 ? ' step' : ' steps') + (failed ? ' · ' + failed + " didn't work" : '');
      var line = document.createElement('div');
      line.className = 'tool-line' + (tool.isError ? ' bad' : '');
      // Short on purpose ("Searched memory"); the full detail is in the tooltip. Failures keep their message.
      var text = tool.isError || tool.name === 'note' ? tool.summary : labels[1];
      line.title = tool.summary;
      var prev = box.lastElementChild;
      if (prev && prev.dataset.label === text) {
        prev.dataset.count = String((Number(prev.dataset.count) || 1) + 1);
        prev.textContent = text + ' ×' + prev.dataset.count;
        return;
      }
      line.dataset.label = text;
      line.textContent = text;
      box.appendChild(line);
    });
  }

  // ---------- Model picker ----------
  function rgb(key) { return 'rgb(' + MODELS[key].rgb.join(',') + ')'; }
  // The page and the orb keep Ilyra's gold whatever model is picked; only each model's dot has
  // its own colour.
  var BRAND = [245, 165, 36];

  function renderModels() {
    var wrap = $('models');
    Object.keys(MODELS).forEach(function (key) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'model';
      b.dataset.model = key;
      b.setAttribute('role', 'radio');
      b.style.setProperty('--c', rgb(key));
      b.innerHTML = '<i></i>';
      b.appendChild(document.createTextNode(MODELS[key].name));
      b.addEventListener('click', function () { select(key); promptEl.focus(); });
      wrap.appendChild(b);
    });
  }

  function select(key, instant) {
    selected = key;
    document.querySelectorAll('.model').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.model === key));
    });
    orb.setColor(BRAND, instant);
    hint.textContent = MODELS[key].blurb;
    if (!busy) setOrb('idle');
    try { localStorage.setItem('ilyra.model', key); } catch (e) {}
    refreshPicker();
    $('toolsLabel').textContent = key === 'auto' ? 'Auto' : MODELS[key].name;
  }

  // ---------- Auto routing ----------
  // What a message is about, from its words, decides which model gets it.
  var DRAW = /\b(draw|generate|create|make|design|render|paint|sketch|illustrate|edit|remove|change|turn)\b.*\b(image|picture|photo|logo|illustration|icon|poster|wallpaper|drawing|art|portrait|render)\b|\b(image|picture|photo|logo|illustration|drawing|render) of\b/i;
  // Each kind of request has a default model; "Who handles what" in Settings can change it.
  var TASKS = [
    { id: 'lead', name: 'Lead assistant', desc: 'Everyday chat and quick questions are answered on this computer. Code, building pages and apps, images, live information and long or complex work go to the models you choose below.', options: ['local'], autoLabel: 'Off', note: 'Needs a local model (Settings, AI models). If no cloud model can answer, the local model answers everything.' },
    { id: 'localRole', name: 'What the local model keeps', setting: 'localRole', needs: 'local',
      choices: [{ id: 'auto', label: 'Automatic' }, { id: 'everyday', label: 'Everyday chat' }, { id: 'most', label: 'Everything but images' }] },
    { id: 'image', name: 'Image generation', desc: 'Drawing, logos, illustrations and photo edits', options: ['chatgpt', 'gemini'] },
    { id: 'code', name: 'Code and technical work', desc: 'Programming, debugging, architecture and documents', options: ['claude', 'chatgpt', 'gemini', 'meta', 'local'] },
    { id: 'research', name: 'Research and current events', desc: 'Comparing sources, finding facts and the latest news', options: ['claude', 'chatgpt', 'gemini', 'meta'] },
    { id: 'general', name: 'Everyday writing and questions', desc: 'Drafting, ideas and general conversation', options: ['claude', 'chatgpt', 'gemini', 'meta', 'local'] }
  ];
  var ROUTE_DEFAULTS = { image: 'gemini', code: 'claude', research: 'gemini', general: 'chatgpt' };
  var routing = {};
  try { routing = JSON.parse(localStorage.getItem('ilyra.routing')) || {}; } catch (e) {}

  // Code, builds and long or complex work: what a small local lead hands to the cloud.
  var CODE_RE = /```|\b(code|coding|bugs?|debug|debugging|refactor|script|scripts|regex|sql|api|apis|stack ?trace|python|javascript|typescript|html|css|react|java|c\+\+|rust|algorithm|compile|database|architecture|endpoint|unit tests?)\b|\b(write|fix|explain|review|optimi[sz]e|convert)\b[^.?!]{0,40}\b(function|class|method|query|program|snippet)\b/i;
  var BUILD_RE = /\b(build|make|create|design|develop|generate|write)\b[^.?!]{0,50}\b(page|site|website|web ?app|app|game|dashboard|ui|landing|calculator|widget|mockup|prototype|extension|bot|program)\b/i;
  var LONG_RE = /\b(analy[sz]e|analysis|in[- ]depth|detailed|thorough|essay|report|proposal|business plan|step[- ]by[- ]step plan|summari[sz]e (this|the following)|pros and cons|research paper|\d{3,} words)\b|\bcompare\b[^.?!]{3,80}\b(and|vs|versus|with)\b/i;
  // Live information (weather, news, prices) needs a web search, which only the cloud models have.
  var LIVE_RE = /\b(weather|forecast|rain|snow|temperature|news|headlines|score|stock price|price of|latest|this week|right now|today'?s)\b/i;
  // Words that point back at earlier work in the chat, so it should stay with the model doing it.
  var FOLLOWUP_RE = /\b(it|its|it's|that|this|those|these|them|again|instead|also|now|same|above|previous|your (answer|code|version|page)|change|fix|tweak|update|add|remove|rename|make|set|move|center|centre|bigger|smaller|darker|lighter|bolder|try|still|error|broke|broken|works?|working|doesn'?t|didn'?t|won'?t|line \d+)\b/i;
  function mentionsConnector(text) {
    var t = String(text).toLowerCase();
    return /\bconnectors?\b/.test(t) || connectorNames.some(function (n) { return n && t.indexOf(n) !== -1; });
  }
  // Work a small local model should hand on: code, builds, pictures, long jobs, connectors.
  function needsCloud(text, hasImages) {
    return Boolean(hasImages) || mentionsConnector(text) || DRAW.test(text) || CODE_RE.test(text) || BUILD_RE.test(text) || LONG_RE.test(text) || text.length > 600;
  }

  function classify(text) {
    if (DRAW.test(text)) return 'image';
    var t = text.toLowerCase();
    if (CODE_RE.test(text) || BUILD_RE.test(text) || LONG_RE.test(text) || text.length > 600) return 'code';
    if (/research|compare|source|latest|find|video|photo|weather|forecast|news|today|tonight|tomorrow|this week|price|stock|score|who won|look up|search|current/.test(t)) return 'research';
    return 'general';
  }
  function routeFor(task) {
    var pref = routing[task];
    if (pref && pref !== 'auto' && (!desktop || (info[pref] && info[pref].connected))) return pref;
    return ROUTE_DEFAULTS[task];
  }
  function route(text) { return routeFor(classify(text)); }

  // ---------- Orb ----------
  var STATE_LABEL = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Responding' };
  function setOrb(state, model) {
    orb.setState(state);
    orbState.textContent = STATE_LABEL[state] + (model ? ' · ' + MODELS[model].name : '');
  }

  // ---------- Code the model ran ----------
  // Each run is folded: the code, then what it printed.
  function appendRun(el, run) {
    var box = el.querySelector('.msg-runs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'msg-runs';
      el.insertBefore(box, el.querySelector('.msg-images, .msg-body'));
    }
    var d = document.createElement('details');
    d.className = 'msg-run' + (run.failed ? ' failed' : '');
    var sum = document.createElement('summary');
    sum.textContent = (run.failed ? 'Code failed' : 'Ran code') + ' · ' + (run.language || 'python');
    var code = document.createElement('pre');
    code.textContent = run.code || '';
    d.appendChild(sum);
    d.appendChild(code);
    if (run.output) {
      var out = document.createElement('pre');
      out.className = 'run-output';
      out.textContent = run.output;
      d.appendChild(out);
    }
    box.appendChild(d);
  }

  // The </> button lets the model run code in a private sandbox.
  function setCode(on) {
    codeOn = on;
    var b = $('codeButton');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Run code: on. The model can run Python in a private sandbox to calculate, analyze data and make charts.' : 'Run code: off';
    b.querySelector('.tp-state').textContent = on ? 'On' : 'Off';
    try { localStorage.setItem('ilyra.code', on ? 'on' : 'off'); } catch (e) {}
  }
  $('codeButton').addEventListener('click', function () { setCode(!codeOn); promptEl.focus(); });
  setCode(codeOn);

  // ---------- Thinking ----------
  // The model's own summary of its reasoning, folded above the reply.
  function renderThinking(el, text) {
    if (!text) return;
    var box = document.createElement('details');
    box.className = 'msg-thinking';
    box.innerHTML = '<summary>Thinking</summary><div></div>';
    box.querySelector('div').textContent = text;
    el.insertBefore(box, el.querySelector('.msg-tools, .msg-images, .msg-body'));
  }

  // How hard the model thinks: Off to Max. Remembered between sessions.
  var thinkPick = $('thinkPick');
  try { thinkLevel = localStorage.getItem('ilyra.think') || 'medium'; } catch (e) {}
  if (!/^(off|low|medium|high|max)$/.test(thinkLevel)) thinkLevel = 'medium';
  thinkPick.value = thinkLevel;
  thinkPick.addEventListener('change', function () {
    thinkLevel = thinkPick.value;
    try { localStorage.setItem('ilyra.think', thinkLevel); } catch (e) {}
    promptEl.focus();
  });

  // ---------- Edit approval banner ----------
  // "Allow edits in this chat" is limited (10 edits or 30 minutes) and never silent:
  // a banner shows while it is on, with a way to turn it off.
  var approvalBar = $('approvalBar');
  var approvalUntil = 0;
  function setApproval(status) {
    if (!status || status.left <= 0) { approvalBar.hidden = true; approvalUntil = 0; return; }
    approvalUntil = status.until;
    approvalBar.querySelector('.approval-text').textContent = 'Ilyra is approving file edits in this chat without asking. ' + status.left + (status.left === 1 ? ' edit' : ' edits') + ' left, until ' + new Date(status.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
    approvalBar.hidden = false;
  }
  function refreshApproval() {
    if (!desktop || !currentId) { setApproval(null); return; }
    window.ilyra.approvalStatus(currentId).then(setApproval, function () { setApproval(null); });
  }
  if (desktop) {
    window.ilyra.onChatApproval(function (status) { setApproval(status); });
    $('approvalOff').addEventListener('click', function () {
      if (currentId) window.ilyra.revokeApproval(currentId).then(function () { setApproval(null); });
    });
    setInterval(function () { if (approvalUntil && Date.now() >= approvalUntil) setApproval(null); }, 15000);
  }

  // ---------- Tools pill ----------
  // One small pill holds the model, version, thinking level, web search, code and attachments.
  var toolsPanel = $('toolsPanel');
  var toolsButton = $('toolsButton');
  function closeTools() {
    toolsPanel.hidden = true;
    toolsButton.setAttribute('aria-expanded', 'false');
  }
  toolsButton.addEventListener('click', function () {
    var open = toolsPanel.hidden;
    toolsPanel.hidden = !open;
    toolsButton.setAttribute('aria-expanded', String(open));
    if (open) refreshPicker();
  });
  document.addEventListener('pointerdown', function (e) {
    if (!toolsPanel.hidden && !toolsPanel.contains(e.target) && !toolsButton.contains(e.target)) closeTools();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !toolsPanel.hidden) { closeTools(); toolsButton.focus(); }
  });

  // ---------- Web sources ----------
  // Pages the model read while answering, shown under the reply.
  function renderSources(el, list) {
    var old = el.querySelector('.msg-sources');
    if (old) old.remove();
    var safe = (list || []).filter(function (s) { return /^https?:\/\//.test(s.url); });
    if (!safe.length) return;
    // Folded by default: a small "Sources" line you can open.
    var box = document.createElement('details');
    box.className = 'msg-sources';
    var label = document.createElement('summary');
    label.textContent = 'Sources (' + safe.length + ')';
    box.appendChild(label);
    var links = document.createElement('div');
    links.className = 'msg-sources-list';
    box.appendChild(links);
    safe.forEach(function (s) {
      var a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = s.url;
      var host = '';
      try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch (e) {}
      a.textContent = (s.title && s.title !== s.url ? s.title : host) + (host && s.title && s.title !== host ? '  ' + host : '');
      links.appendChild(a);
    });
    el.appendChild(box);
  }

  // The globe button turns web search on or off for every model.
  function setWeb(on) {
    webOn = on;
    var b = $('webButton');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Web search: on. The model can look things up online.' : 'Web search: off';
    b.querySelector('.tp-state').textContent = on ? 'On' : 'Off';
    try { localStorage.setItem('ilyra.web', on ? 'on' : 'off'); } catch (e) {}
  }
  $('webButton').addEventListener('click', function () { setWeb(!webOn); promptEl.focus(); });
  setWeb(webOn);

  // ---------- Thread ----------
  // A picture in the chat. Pictures Ilyra makes get a Save button.
  function imageTile(im, saveable) {
    var tile = document.createElement('figure');
    tile.className = 'image-tile';
    var img = document.createElement('img');
    img.alt = saveable ? 'Image made by Ilyra' : 'Attached image';
    img.src = im.url || ('data:' + im.mime + ';base64,' + im.data);
    tile.appendChild(img);
    if (saveable && desktop) {
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'link-btn';
      save.textContent = 'Save';
      save.addEventListener('click', function () {
        save.textContent = 'Saving…';
        window.ilyra.saveImage(im.mime, im.data).then(function (ok) { save.textContent = ok ? 'Saved' : 'Save'; });
      });
      tile.appendChild(save);
    }
    return tile;
  }

  function addMessage(role, text, model, at, images) {
    var el = document.createElement('article');
    el.className = 'msg ' + role;
    if (role === 'ai') {
      el.style.setProperty('--c', rgb(model));
      var tag = document.createElement('div');
      tag.className = 'msg-tag';
      tag.innerHTML = '<i></i>';
      tag.appendChild(document.createTextNode(MODELS[model].name));
      var time = document.createElement('time');
      time.textContent = new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      tag.appendChild(time);
      var tokens = document.createElement('span');
      tokens.className = 'msg-tokens';
      tag.appendChild(tokens);
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'msg-copy';
      copy.textContent = 'Copy';
      copy.title = 'Copy this reply';
      tag.appendChild(copy);
      el.appendChild(tag);
    }
    if (images && images.length) {
      var strip = document.createElement('div');
      strip.className = 'msg-images';
      images.forEach(function (im) { strip.appendChild(imageTile(im, role === 'ai')); });
      el.appendChild(strip);
    }
    var body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;
    if (!text && images && images.length) body.hidden = true;
    el.appendChild(body);
    thread.appendChild(el);
    scrollDown();
    return el;
  }

  var main = $('main');
  function scrollDown() {
    pinned = true;
    jumpDown.hidden = true;
    autoScrollUntil = Date.now() + 700;
    main.scrollTo({ top: main.scrollHeight, behavior: 'smooth' });
  }
  // Follow the conversation as it grows (streamed text, status lines, tools, sources, images
  // that load late), unless you've scrolled up to read something. Scrolling up always wins,
  // even mid-stream; scrolling back to the bottom (or the arrow button) follows again.
  var pinned = true, autoScrollUntil = 0, lastTop = 0;
  var jumpDown = $('jumpDown');
  function nearBottom() { return main.scrollHeight - main.scrollTop - main.clientHeight < 80; }
  function showJump() { jumpDown.hidden = pinned || nearBottom(); }
  function follow() {
    if (!pinned) { showJump(); return; }
    autoScrollUntil = Date.now() + 100;
    main.scrollTop = main.scrollHeight;
  }
  function unpin() { if (main.scrollHeight > main.clientHeight + 4) { pinned = false; showJump(); } }
  main.addEventListener('scroll', function () {
    // Moving up is always the user (following only ever moves down).
    if (main.scrollTop < lastTop - 2 && !nearBottom()) pinned = false;
    else if (Date.now() >= autoScrollUntil || nearBottom()) pinned = nearBottom();
    lastTop = main.scrollTop;
    showJump();
  });
  main.addEventListener('wheel', function (e) { if (e.deltaY < 0) unpin(); }, { passive: true });
  main.addEventListener('touchstart', function () { autoScrollUntil = 0; }, { passive: true });
  main.addEventListener('keydown', function (e) { if (/^(PageUp|ArrowUp|Home)$/.test(e.key)) unpin(); });
  jumpDown.addEventListener('click', scrollDown);
  if ('ResizeObserver' in window) {
    new ResizeObserver(follow).observe(thread);
  }

  function renderMarkdown(el, text) {
    var body = el.querySelector('.msg-body');
    if (!window.marked || !window.DOMPurify) return;
    body.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
    body.classList.add('md');
    decorateCode(body);
    el.dataset.raw = text;
    addArtifacts(el, false);
  }

  // ---------- Preview panel (artifacts) ----------
  // HTML the AI writes gets a card that opens it live in the
  // preview panel. The newest page in a fresh reply opens by itself.
  var artifactPanel = $('artifact');
  var artifactFrame = $('artifactFrame');
  var artifactHtml = '';
  var artifactName = '';
  var artifactCard = null;
  var artifactOffline = false;

  function looksLikePage(code) {
    return /<(!doctype|html|head|body|svg|div|canvas|main|section|style|script)\b/i.test(code);
  }

  function pageTitle(code) {
    var m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code);
    return m ? m[1].trim() : 'Web page';
  }

  function addArtifacts(el, autoOpen) {
    var last = null;
    var offline = el.dataset.local === '1';
    el.querySelectorAll('.msg-body pre > code').forEach(function (code) {
      if (!/language-(html|htm|svg|xml)\b/.test(code.className)) return;
      var src = code.textContent;
      if (!looksLikePage(src)) return;
      var pre = code.parentNode;
      if (pre.previousSibling && pre.previousSibling.classList && pre.previousSibling.classList.contains('artifact-card')) return;
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'artifact-card';
      card.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg><span class="artifact-card-text"><b></b><small>Open preview</small></span>';
      card.querySelector('b').textContent = pageTitle(src);
      card.addEventListener('click', function () { openArtifact(src, card, offline); });
      pre.parentNode.insertBefore(card, pre);
      pre.classList.add('artifact-code');
      last = { src: src, card: card };
    });
    // A reply that read local data never opens a preview by itself.
    if (autoOpen && last && !offline) openArtifact(last.src, last.card, false);
  }

  function openArtifact(src, card, offline) {
    artifactHtml = src;
    artifactOffline = Boolean(offline);
    $('artifactNote').hidden = !artifactOffline;
    artifactName = pageTitle(src);
    $('artifactTitle').textContent = artifactName;
    if (artifactCard) artifactCard.classList.remove('open');
    artifactCard = card || null;
    if (artifactCard) artifactCard.classList.add('open');
    artifactPanel.hidden = false;
    document.body.classList.add('artifact-open');
    if (desktop) {
      window.ilyra.openArtifact(src, artifactOffline).then(function (url) {
        if (url) artifactFrame.src = url + '?v=' + Date.now();
      });
    } else {
      artifactFrame.srcdoc = src;
    }
  }

  function closeArtifact() {
    artifactPanel.hidden = true;
    document.body.classList.remove('artifact-open');
    artifactFrame.removeAttribute('srcdoc');
    artifactFrame.src = 'about:blank';
    if (artifactCard) artifactCard.classList.remove('open');
    artifactCard = null;
  }

  // Drag the panel's left edge to choose how much room the preview gets.
  var resizer = $('artifactResize');
  function setArtifactWidth(px, save) {
    var max = Math.max(320, window.innerWidth - (document.body.classList.contains('sidebar-closed') ? 0 : 272) - 360);
    px = Math.round(Math.min(max, Math.max(320, px)));
    artifactPanel.style.flexBasis = px + 'px';
    if (save) { try { localStorage.setItem('ilyra.artifactWidth', px); } catch (e) {} }
  }
  try {
    var savedWidth = parseInt(localStorage.getItem('ilyra.artifactWidth'), 10);
    if (savedWidth) artifactPanel.style.flexBasis = savedWidth + 'px';
  } catch (e) {}
  resizer.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', function (e) {
    if (resizer.hasPointerCapture(e.pointerId)) setArtifactWidth(window.innerWidth - e.clientX, false);
  });
  function endResize(e) {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    setArtifactWidth(artifactPanel.getBoundingClientRect().width, true);
    if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
  }
  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);
  resizer.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setArtifactWidth(artifactPanel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 40 : -40), true);
  });

  $('artifactClose').addEventListener('click', closeArtifact);
  $('artifactReload').addEventListener('click', function () { if (artifactHtml) openArtifact(artifactHtml, artifactCard, artifactOffline); });
  $('artifactOnline').addEventListener('click', function () { if (artifactHtml) openArtifact(artifactHtml, artifactCard, false); });
  $('artifactSave').addEventListener('click', function () {
    if (!artifactHtml) return;
    if (desktop) { window.ilyra.saveArtifact(artifactHtml, artifactName); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([artifactHtml], { type: 'text/html' }));
    a.download = 'ilyra-page.html';
    a.click();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !artifactPanel.hidden && !document.querySelector('dialog[open]')) closeArtifact();
  });

  // ---------- Asking a model ----------
  // The one place that talks to the AI. The desktop app answers through its
  // main process; the browser preview has no keys, so it says so.
  function ask(model, messages, requestId) {
    if (!desktop) {
      return Promise.resolve({
        text: 'This is the browser preview. Open the Ilyra desktop app and add a key in Settings, AI models, to talk to ' + MODELS[model].name + '.',
        offline: true
      });
    }
    var imageProvider = routing.image && routing.image !== 'auto' ? routing.image : undefined;
    return window.ilyra.chat(model, messages, { web: webOn, thinking: thinkLevel, code: codeOn, imageProvider: imageProvider, requestId: requestId, chatId: currentId, voice: talkMode, delegates: delegateOrder(), summary: chatSummary }).then(function (res) {
      if (res.cancelled) return { text: res.text || '', offline: false, cancelled: true, modelId: res.model, usage: res.usage };
      return res.error ? { text: res.error, offline: true, outOfCredit: res.outOfCredit } : { text: res.text, offline: false, switchedTo: res.switchedTo, modelId: res.model, usage: res.usage };
    }, function () {
      return { text: 'Ilyra lost contact with its core. Try again.', offline: true };
    });
  }

  // ---------- Choosing the model in Auto ----------
  // A model that can answer right now (connected, with credit left).
  function usable(k) { return info[k] && info[k].connected && !info[k].outOfCredit; }
  // With a local model connected, it leads unless the user turned that off: it answers, and
  // hands the rest to the cloud. How much it keeps is up to Settings (info.local.strong).
  function leadActive() { return desktop && usable('local') && (routing.lead || 'local') !== 'auto'; }
  function cloudModels() { return PROVIDERS.filter(function (k) { return k !== 'local'; }); }
  // The cloud models the local lead may hand work to: the ones picked in Settings, or every
  // connected one if they were all left on Automatic.
  function delegateOrder() {
    var out = [];
    ['general', 'code', 'research'].forEach(function (t) {
      var v = routing[t];
      if (v && v !== 'auto' && v !== 'local' && out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }
  // Which model answered last in this chat, and which answered first.
  function chatModel() {
    for (var i = log.length - 1; i >= 0; i--) if (log[i].role === 'assistant' && log[i].model) return log[i].model;
    return null;
  }
  function firstModel() {
    for (var i = 0; i < log.length; i++) if (log[i].role === 'assistant' && log[i].model) return log[i].model;
    return null;
  }
  // The cloud model for work the local lead hands on: the routed one, else any that can answer.
  function cloudFor(text) {
    var preferred = route(text);
    if (preferred !== 'local' && usable(preferred)) return preferred;
    return cloudModels().filter(usable)[0] || null;
  }
  function pick(text, hasImages) {
    if (!desktop || selected !== 'auto') return selected === 'auto' ? route(text) : selected;
    if (leadActive()) {
      // A strong local model keeps everything but pictures; a small one keeps everyday chat.
      var heavy = info.local.strong ? DRAW.test(text) : needsCloud(text, hasImages);
      if (heavy || (webOn && LIVE_RE.test(text))) return cloudFor(text) || 'local';
      // A chat that began on a cloud model stays there for follow-ups to that work ("fix it",
      // "now add a button"); anything else comes back to the local model.
      var cur = chatModel();
      var first = firstModel();
      if (first && first !== 'local' && cur && cur !== 'local' && usable(cur) && FOLLOWUP_RE.test(text)) return cur;
      return 'local';
    }
    // Follow-ups like "nice" or "I meant the weather" stay with the model that has the context.
    var current = chatModel();
    if (current && usable(current) && !hasImages && classify(text) !== 'image') return current;
    var preferred = route(text);
    if (usable(preferred)) return preferred;
    return [preferred].concat(PROVIDERS).filter(usable)[0] || preferred;
  }

  // ---------- Notes in the thread ----------
  // A short note in the chat that is not part of the conversation (not saved, not sent to any model).
  function addNote(text, kind) {
    var el = document.createElement('article');
    el.className = 'msg note' + (kind ? ' ' + kind : '');
    var body = document.createElement('div');
    body.className = 'note-body';
    body.textContent = text;
    el.appendChild(body);
    thread.appendChild(el);
    document.body.classList.add('active');
    main.scrollTop = main.scrollHeight;
    return el;
  }

  // ---------- Long chats (compaction) ----------
  var KEEP_RECENT = 4; // the newest messages always sent as they are

  function historyTokens() {
    var chars = chatSummary.length;
    history.forEach(function (m) { chars += (m.content || '').length; });
    return Math.ceil(chars / 4);
  }
  // Messages after the last summary, as indexes into the saved log.
  function liveIndexes() {
    var from = 0;
    for (var i = log.length - 1; i >= 0; i--) if (log[i].role === 'summary') { from = i + 1; break; }
    var idx = [];
    for (var j = from; j < log.length; j++) if (log[j].role === 'user' || log[j].role === 'assistant') idx.push(j);
    return idx;
  }
  // Long chats are summarized before they crowd out the reply.
  // Cloud models have room to spare; a local one has its context size (Settings, AI models),
  // which must also hold Ilyra's instructions and the reply.
  function needsCompact(model) {
    var limit = model === 'local' ? Math.round(((info.local && info.local.context) || 8192) * 0.55) : 80000;
    return historyTokens() > limit && liveIndexes().length > KEEP_RECENT + 1;
  }

  // Replace the older messages (all but the last few) with a summary the model carries on from.
  // The full chat stays saved and searchable; only what is sent to the model gets shorter.
  function compactChat(focus, auto) {
    return new Promise(function (resolve) {
      var idx = liveIndexes();
      if (idx.length <= KEEP_RECENT + 1) {
        if (!auto) addNote('Nothing to compact yet: this chat is still short.');
        resolve(false);
        return;
      }
      if (!desktop) { addNote('Compacting works in the desktop app.'); resolve(false); return; }
      var cut = idx[idx.length - KEEP_RECENT]; // the first message that stays as it is
      var older = idx.filter(function (k) { return k < cut; }).map(function (k) {
        var m = log[k];
        return { role: m.role, content: (m.content || '') + (m.images && m.images.length ? ' [a picture was attached]' : '') };
      });
      var pending = addNote((auto ? 'This chat is getting long. ' : '') + 'Summarizing ' + older.length + ' earlier messages…', 'working');
      window.ilyra.summarize({ previous: chatSummary, messages: older, instructions: focus || '' }).then(function (res) {
        pending.remove();
        if (!res || res.error) { addNote((res && res.error) || 'Could not write the summary.', 'bad'); resolve(false); return; }
        log.splice(cut, 0, { role: 'summary', content: res.text, at: Date.now(), covers: older.length, model: res.model });
        var parts = splitLog(log);
        history = parts.history;
        chatSummary = parts.summary;
        renderLog();
        saveChat();
        addNote('Summarized ' + older.length + ' earlier messages. Your full chat is still saved; the model now continues from the summary and the last ' + (idx.length - older.length) + ' messages.');
        resolve(true);
      }, function () { pending.remove(); addNote('Could not write the summary.', 'bad'); resolve(false); });
    });
  }

  // ---------- Slash commands ----------
  // Type / in the message box for a menu of commands. They run in Ilyra itself and are never sent
  // to a model. A message that starts with / but is not a command is sent as normal text.
  function usageText(data) {
    var keys = Object.keys(MODELS).filter(function (k) { return k !== 'auto'; });
    function line(bucket, label) {
      var total = 0, parts = [];
      keys.forEach(function (k) {
        var r = (bucket || {})[k];
        var n = r ? (r.input || 0) + (r.output || 0) : 0;
        if (!n) return;
        total += n;
        parts.push(MODELS[k].name + ' ' + fmtTokens(n));
      });
      return label + ': ' + (total ? fmtTokens(total) + ' tokens' + (parts.length > 1 || parts.length === 1 ? ' (' + parts.join(', ') + ')' : '') : 'none yet');
    }
    var c = chatTotals();
    var here = c.replies ? 'This chat: ' + fmtTokens(c.input + c.output) + ' tokens (' + fmtTokens(c.input) + ' read, ' + fmtTokens(c.output) + ' written, ' + c.replies + ' repl' + (c.replies === 1 ? 'y' : 'ies') + ')' : 'This chat: none yet';
    return here + '\n' + line(data.today, 'Today') + '\n' + line(data.month, 'This month');
  }

  function memoryLines(text) { return String(text || '').split('\n').filter(function (l) { return l.trim(); }); }
  function needDesktop(what) { addNote(what + ' works in the desktop app.'); }
  function onOff(arg, current) { return arg === 'on' ? true : arg === 'off' ? false : !current; }

  var COMMANDS = [
    { name: 'compact', aliases: ['summarize'], args: '[what to keep]', help: 'Summarize older messages to free up space', run: function (arg) {
      busy = true;
      compactChat(arg, false).then(function () { busy = false; select(selected); });
    } },
    { name: 'clear', aliases: ['new'], help: 'Start a new chat', run: function () { goHome(); } },
    { name: 'context', help: 'How full this chat is', allowBusy: true, run: function () {
      var t = historyTokens();
      addNote('This chat sends about ' + fmtTokens(t) + ' tokens of history with each message (' + history.length + ' messages' + (chatSummary ? ' plus a summary of earlier ones' : '') + ').\n' +
        'Ilyra compacts a chat automatically at about 80k tokens. Type /compact to shrink this chat now.');
    } },
    { name: 'usage', help: 'Tokens used in this chat, today and this month', allowBusy: true, run: function () {
      if (!desktop) { needDesktop('Usage'); return; }
      window.ilyra.usage.get().then(function (d) { addNote(usageText(d)); });
    } },
    { name: 'model', args: '[auto|claude|chatgpt|gemini|meta]', help: 'Switch which model answers', run: function (arg) {
      var want = arg.toLowerCase();
      if (!want) {
        addNote('Using ' + (selected === 'auto' ? 'Auto' : MODELS[selected].name) + '. Choose with /model auto, claude, chatgpt, gemini, meta or local.');
        return;
      }
      if (!MODELS[want]) { addNote('There is no model called "' + arg + '". Try auto, claude, chatgpt, gemini, meta or local.'); return; }
      if (want !== 'auto' && desktop && !(info[want] && info[want].connected)) { addNote(MODELS[want].name + ' is not connected.'); return; }
      select(want);
      addNote('Now using ' + (want === 'auto' ? 'Auto' : MODELS[want].name) + '.');
    } },
    { name: 'think', args: '[off|low|medium|high|max]', help: 'Set how hard the model thinks', run: function (arg) {
      var level = arg.toLowerCase();
      if (!/^(off|low|medium|high|max)$/.test(level)) { addNote('Thinking is ' + thinkLevel + '. Choose with /think off, low, medium, high or max.'); return; }
      thinkLevel = level;
      thinkPick.value = level;
      try { localStorage.setItem('ilyra.think', level); } catch (e) {}
      addNote('Thinking set to ' + level + '.');
    } },
    { name: 'web', args: '[on|off]', help: 'Turn web search on or off', run: function (arg) {
      setWeb(onOff(arg.toLowerCase(), webOn));
      addNote('Web search is ' + (webOn ? 'on' : 'off') + '.');
    } },
    { name: 'code', args: '[on|off]', help: 'Turn code running on or off', run: function (arg) {
      setCode(onOff(arg.toLowerCase(), codeOn));
      addNote('Running code is ' + (codeOn ? 'on' : 'off') + '.');
    } },
    { name: 'memory', help: 'Show what Ilyra remembers about you', allowBusy: true, run: function () {
      if (!desktop) { needDesktop('Memory'); return; }
      window.ilyra.memory.get().then(function (r) {
        addNote(r.text.trim() ? 'What Ilyra remembers about you:\n\n' + r.text.trim() + '\n\nEdit it any time in Settings, Memory.' : 'Nothing is saved yet. Tell Ilyra things about yourself, or use /remember.');
      });
    } },
    { name: 'remember', args: '<something to remember>', required: true, help: 'Save a fact to memory', run: function (arg) {
      if (!desktop) { needDesktop('Memory'); return; }
      var fact = arg.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!fact) { addNote('Say what to remember, like /remember my dog is named Max.'); return; }
      window.ilyra.memory.get().then(function (r) {
        var lines = memoryLines(r.text);
        if (lines.some(function (l) { return l.replace(/^\s*-\s*/, '').toLowerCase() === fact.toLowerCase(); })) { addNote('That is already in memory.'); return; }
        var next = lines.concat(['- ' + fact]).join('\n') + '\n';
        if (next.length > r.max) { addNote('Memory is full. Remove something first with /forget or in Settings.', 'bad'); return; }
        window.ilyra.memory.set(next).then(function () { addNote('Remembered: ' + fact); });
      });
    } },
    { name: 'forget', args: '<text to remove>', required: true, help: 'Remove memory lines that contain the text', run: function (arg) {
      if (!desktop) { needDesktop('Memory'); return; }
      var needle = arg.trim().toLowerCase();
      if (needle.length < 3) { addNote('Say which memory to forget, like /forget Corolla (at least 3 letters).'); return; }
      window.ilyra.memory.get().then(function (r) {
        var lines = memoryLines(r.text);
        var gone = lines.filter(function (l) { return l.toLowerCase().indexOf(needle) !== -1; });
        if (!gone.length) { addNote('No memory contains "' + arg.trim() + '".'); return; }
        var keep = lines.filter(function (l) { return gone.indexOf(l) === -1; });
        window.ilyra.memory.set(keep.length ? keep.join('\n') + '\n' : '').then(function () { addNote('Removed from memory:\n' + gone.join('\n')); });
      });
    } },
    { name: 'copy', help: 'Copy the last reply', allowBusy: true, run: function () {
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i].role === 'assistant' && log[i].content) { copyText(log[i].content, null); addNote('Copied the last reply.'); return; }
      }
      addNote('There is no reply to copy yet.');
    } },
    { name: 'export', help: 'Save this chat as a Markdown file', allowBusy: true, run: function () {
      var rows = log.filter(function (m) { return m.content; });
      if (!rows.length) { addNote('There is nothing to export yet.'); return; }
      var title = (rows[0].content || 'Ilyra chat').replace(/\s+/g, ' ').slice(0, 60);
      var md = '# ' + title + '\n\n' + rows.map(function (m) {
        if (m.role === 'summary') return '> Summary of earlier messages: ' + m.content.replace(/\n+/g, ' ');
        return '**' + (m.role === 'user' ? 'You' : (MODELS[m.model] ? MODELS[m.model].name : 'Ilyra')) + ':** ' + m.content;
      }).join('\n\n') + '\n';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.md';
      a.click();
      addNote('Saved the chat as ' + a.download + '.');
    } },
    { name: 'retry', help: 'Send your last message again', run: function () {
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i].role === 'user' && log[i].content) { promptEl.value = log[i].content; autosize(); send(true); return; }
      }
      addNote('There is no message to send again.');
    } },
    { name: 'help', aliases: ['commands'], help: 'List these commands', allowBusy: true, run: function () {
      addNote(COMMANDS.map(function (c) { return '/' + c.name + (c.args ? ' ' + c.args : '') + '  ' + c.help; }).join('\n'));
    } }
  ];

  function findCommand(name) {
    for (var i = 0; i < COMMANDS.length; i++) {
      if (COMMANDS[i].name === name || (COMMANDS[i].aliases || []).indexOf(name) !== -1) return COMMANDS[i];
    }
    return null;
  }
  // "/compact keep the dates" -> the command and its argument, or null when it is just a message.
  function parseCommand(text) {
    var m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!m) return null;
    var def = findCommand(m[1].toLowerCase());
    return def ? { def: def, arg: (m[2] || '').trim() } : null;
  }
  function runCommand(cmd) {
    promptEl.value = '';
    autosize();
    hideSlash();
    if (busy && !cmd.def.allowBusy) { addNote('Wait for the reply to finish, or press Stop, then try again.'); return; }
    cmd.def.run(cmd.arg);
  }

  // The menu above the message box: arrow keys to move, Enter or Tab to pick, Esc to close.
  var slashMenu = $('slashMenu');
  var slashItems = [];
  var slashActive = 0;
  function hideSlash() { slashMenu.hidden = true; slashItems = []; }
  function pickSlash(def) {
    // Commands that need something after them are completed; the rest run straight away.
    if (def.required) { promptEl.value = '/' + def.name + ' '; autosize(); hideSlash(); promptEl.focus(); return; }
    promptEl.value = '/' + def.name;
    send();
  }
  function updateSlash() {
    var m = /^\/([a-z]*)$/i.exec(promptEl.value);
    if (!m) { hideSlash(); return; }
    var q = m[1].toLowerCase();
    slashItems = COMMANDS.filter(function (c) { return c.name.indexOf(q) === 0 || (c.aliases || []).some(function (a) { return a.indexOf(q) === 0; }); });
    if (!slashItems.length) { hideSlash(); return; }
    slashActive = Math.min(slashActive, slashItems.length - 1);
    slashMenu.textContent = '';
    slashItems.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'slash-item' + (i === slashActive ? ' active' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === slashActive));
      var name = document.createElement('span');
      name.className = 'slash-name';
      name.textContent = '/' + c.name + (c.args ? ' ' + c.args : '');
      var help = document.createElement('span');
      help.className = 'slash-help';
      help.textContent = c.help;
      b.appendChild(name);
      b.appendChild(help);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); pickSlash(c); });
      slashMenu.appendChild(b);
    });
    slashMenu.hidden = false;
  }
  promptEl.addEventListener('input', updateSlash);

  function send(skipChecks) {
    var text = promptEl.value.trim();
    var images = attachments.map(function (a) { return { mime: a.mime, data: a.data }; });
    if (!text && !images.length) return;
    // A slash command runs in Ilyra itself instead of being sent to a model.
    var cmd = images.length ? null : parseCommand(text);
    if (cmd) { runCommand(cmd); return; }
    if (busy) return;
    var model = pick(text, images.length > 0);
    // A long chat is summarized first, so the model is not handed more than it can hold.
    if (skipChecks !== true && desktop && needsCompact(model)) {
      busy = true;
      compactChat('', true).then(function () { busy = false; send(true); });
      return;
    }

    busy = true;
    document.body.classList.add('active');
    promptEl.value = '';
    var shown = attachments;
    attachments = [];
    renderAttachments();
    autosize();

    if (!currentId) currentId = 'c' + Date.now().toString(36);
    var userMsg = { role: 'user', content: text };
    if (images.length) userMsg.images = images;
    history.push(userMsg);
    log.push(Object.assign({ at: Date.now() }, userMsg));
    addMessage('user', text, null, null, shown);
    var reply = addMessage('ai', '', model);
    reply.classList.add('pending');
    pendingReply = reply;
    startRunStatus(reply, model);
    localDataTouched = false;
    pendingModel = model;
    streamText = '';
    madeImages = [];
    foundSources = [];
    thinkText = '';
    thinkStart = 0;
    codeRuns = [];
    startProgress();
    setOrb('thinking', model);
    activeRequest = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    autosize();

    var spoken = '';
    ask(model, history, activeRequest).then(function (res) {
      // That account is out of credit: in Auto, let the next connected model answer.
      if (res.outOfCredit && selected === 'auto' && info[model]) {
        info[model].outOfCredit = true;
        var next = pick(text, images.length > 0);
        if (next && next !== model) { model = next; return ask(next, history, activeRequest); }
      }
      return res;
    }).then(function (res) {
      stopProgress();
      endRunStatus();
      reply.classList.remove('working');
      spoken = res.text || '';
      if (res.cancelled) {
        // Stopped by the user: keep what was written so far.
        streamText = res.text;
        if (res.text) renderStream(); else reply.querySelector('.msg-body').textContent = 'Stopped.';
        reply.querySelector('.msg-tag time').textContent += ' · stopped';
        if (res.text) {
          history.push({ role: 'assistant', content: res.text });
          log.push({ role: 'assistant', content: res.text, model: model, at: Date.now() });
        }
        return;
      }
      if (res.offline) {
        reply.classList.add('offline');
        reply.querySelector('.msg-body').textContent = res.text;
        setTokens(reply, null);
        return;
      }
      streamText = res.text;
      renderStream();
      setTokens(reply, res.usage);
      addArtifacts(reply, true);
      if (res.modelId) reply.querySelector('.msg-tag time').textContent += ' · ' + res.modelId;
      if (res.switchedTo) {
        reply.querySelector('.msg-tag time').textContent += ' (switched: ' + (info[model] ? info[model].model : '') + ' was unavailable)';
        loadProviders();
      }
      var said = res.text || (madeImages.length ? '[Ilyra made an image]' : '');
      history.push({ role: 'assistant', content: said });
      var entry = { role: 'assistant', content: said, model: model, at: Date.now() };
      if (madeImages.length) entry.images = madeImages;
      if (foundSources.length) entry.sources = foundSources;
      if (thinkText.trim()) entry.thinking = thinkText.trim().slice(0, 8000);
      if (codeRuns.length) entry.runs = codeRuns.slice(0, 6);
      if (res.usage) entry.usage = res.usage;
      if (localDataTouched) entry.localData = true;
      log.push(entry);
      renderChatUsage(0);
    }).then(function () {
      if (thinkText.trim() && !reply.querySelector('.msg-thinking')) {
        renderThinking(reply, thinkText.trim());
        if (thinkStart) reply.querySelector('.msg-thinking summary').textContent = 'Thought for ' + Math.max(1, Math.round((Date.now() - thinkStart) / 1000)) + 's';
      }
      saveChat();
      refreshUsage();
      pendingReply = null;
      activeRequest = null;
      reply.classList.remove('pending', 'working');
      busy = false;
      select(selected);
      autosize();
      scrollDown();
      if (talkMode) talkReply(streamText ? '' : spoken);
    });
  }

  // ---------- Home ----------
  // Back to the welcome screen with a fresh conversation.
  function goHome() {
    if (busy) return;
    history = [];
    chatSummary = '';
    log = [];
    currentId = null;
    renderChatUsage(0);
    thread.textContent = '';
    closeArtifact();
    document.body.classList.remove('active');
    select(selected);
    renderChatList();
    refreshApproval();
    promptEl.focus();
  }
  $('homeButton').addEventListener('click', goHome);
  $('stage').addEventListener('click', function () {
    if (document.body.classList.contains('active')) goHome();
  });

  // ---------- Saved chats ----------
  // The desktop app keeps chats in its own data folder (so the AI can search
  // them too); the browser preview falls back to localStorage.
  var CHATS_KEY = 'ilyra.chats';
  function localChats() {
    try { return JSON.parse(localStorage.getItem(CHATS_KEY)) || []; } catch (e) { return []; }
  }
  function summary(c) { return { id: c.id, title: c.title, updated: c.updated, count: c.messages.length, pinned: Boolean(c.pinned) }; }
  function writeLocal(list) {
    try { localStorage.setItem(CHATS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  var chatStore = desktop ? window.ilyra.chats : {
    list: function () { return Promise.resolve(localChats().map(summary)); },
    get: function (id) { return Promise.resolve(localChats().filter(function (c) { return c.id === id; })[0] || null); },
    save: function (chat) {
      var prev = localChats().filter(function (c) { return c.id === chat.id; })[0];
      if (chat.pinned === undefined && prev && prev.pinned) chat.pinned = true;
      var rest = localChats().filter(function (c) { return c.id !== chat.id; });
      rest.unshift(chat);
      rest = rest.slice(0, 200);
      if (!writeLocal(rest)) {
        // Out of room: keep the text, drop the pictures.
        rest.forEach(function (c) { c.messages.forEach(function (m) { delete m.images; }); });
        writeLocal(rest);
      }
      return Promise.resolve();
    },
    remove: function (id) {
      writeLocal(localChats().filter(function (c) { return c.id !== id; }));
      return Promise.resolve();
    },
    pin: function (id, pinned) {
      var list = localChats();
      list.forEach(function (c) { if (c.id === id) c.pinned = pinned; });
      writeLocal(list);
      return Promise.resolve();
    },
    search: function (q) {
      q = q.toLowerCase();
      return Promise.resolve(localChats().filter(function (c) {
        return c.title.toLowerCase().indexOf(q) !== -1 || c.messages.some(function (m) { return String(m.content).toLowerCase().indexOf(q) !== -1; });
      }).map(function (c) { return { id: c.id, title: c.title, updated: c.updated, snippet: '' }; }));
    }
  };
  function saveChat() {
    if (!currentId || !log.length) return;
    var first = log[0].content.replace(/\s+/g, ' ') || 'Image';
    chatStore.save({
      id: currentId,
      title: first.length > 60 ? first.slice(0, 57) + '…' : first,
      updated: Date.now(),
      messages: log
    }).then(refreshChats, function () {});
  }

  // The saved chat as the model should see it: everything after the last summary, plus that summary.
  function splitLog(entries) {
    var start = 0, summary = '';
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === 'summary') { start = i + 1; summary = entries[i].content; break; }
    }
    var hist = [];
    for (var j = start; j < entries.length; j++) {
      var m = entries[j];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      var out = { role: m.role, content: m.content };
      if (m.images && m.images.length) out.images = m.images;
      hist.push(out);
    }
    return { history: hist, summary: summary };
  }

  // Draw the whole saved chat. A summary shows as a folded block where the older messages end.
  function renderLog() {
    thread.textContent = '';
    log.forEach(function (m) {
      if (m.role === 'summary') { addSummaryBlock(m); return; }
      if (m.role === 'user') { addMessage('user', m.content, null, null, m.images); return; }
      var el = addMessage('ai', m.content, m.model, m.at, m.images);
      if (m.localData) el.dataset.local = '1';
      renderMarkdown(el, m.content);
      renderSources(el, m.sources);
      renderThinking(el, m.thinking);
      setTokens(el, m.usage);
      (m.runs || []).forEach(function (r) { appendRun(el, r); });
    });
  }
  function addSummaryBlock(m) {
    var box = document.createElement('details');
    box.className = 'msg-summary';
    var head = document.createElement('summary');
    head.textContent = 'Earlier messages summarized' + (m.covers ? ' (' + m.covers + ')' : '');
    var body = document.createElement('div');
    body.textContent = m.content;
    box.appendChild(head);
    box.appendChild(body);
    thread.appendChild(box);
  }

  function openChat(id) {
    if (busy) return;
    chatStore.get(id).then(function (chat) {
      if (!chat) return;
      currentId = chat.id;
      log = chat.messages.slice();
      var parts = splitLog(log);
      history = parts.history;
      chatSummary = parts.summary;
      renderLog();
      renderChatUsage(0);
      document.body.classList.add('active');
      if (window.innerWidth <= 800) setSidebar(false);
      renderChatList();
      refreshApproval();
      promptEl.focus();
      main.scrollTo({ top: 0 });
    });
  }

  // ---------- Sidebar ----------
  var chatsCache = [];
  var searchHits = null; // null when not searching
  var chatListEl = $('chatList');

  function setSidebar(open) {
    document.body.classList.toggle('sidebar-closed', !open);
    $('sidebarScrim').hidden = !(open && window.innerWidth <= 800);
    try { localStorage.setItem('ilyra.sidebar', open ? 'open' : 'closed'); } catch (e) {}
  }
  function sidebarIsOpen() { return !document.body.classList.contains('sidebar-closed'); }
  $('sidebarOpen').addEventListener('click', function () { setSidebar(true); });
  $('sidebarClose').addEventListener('click', function () { setSidebar(false); });
  // Blur chat titles until you point at one (handy on a shared screen). Remembered between launches.
  function setTitlesHidden(on) {
    document.body.classList.toggle('titles-hidden', on);
    $('titlesToggle').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('ilyra.hideTitles', on ? '1' : '0'); } catch (e) {}
  }
  $('titlesToggle').addEventListener('click', function () { setTitlesHidden(!document.body.classList.contains('titles-hidden')); });
  try { if (localStorage.getItem('ilyra.hideTitles') === '1') setTitlesHidden(true); } catch (e) {}
  $('sidebarScrim').addEventListener('click', function () { setSidebar(false); });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(!sidebarIsOpen()); }
  });
  var savedSidebar = null;
  try { savedSidebar = localStorage.getItem('ilyra.sidebar'); } catch (e) {}
  setSidebar(savedSidebar ? savedSidebar === 'open' : window.innerWidth > 900);

  function groupLabel(ts) {
    var day = 86400000;
    var startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    var age = startOfToday.getTime() - ts;
    if (ts >= startOfToday.getTime()) return 'Today';
    if (age <= day) return 'Yesterday';
    if (age <= 7 * day) return 'Previous 7 days';
    return 'Earlier';
  }

  function icon(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  function chatRow(chat, searching) {
    var row = document.createElement('div');
    row.className = 'chat-item' + (chat.id === currentId ? ' current' : '');
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    open.title = chat.title;
    var title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = chat.title;
    open.appendChild(title);
    if (searching && chat.snippet) {
      var snip = document.createElement('span');
      snip.className = 'chat-snippet';
      snip.textContent = chat.snippet;
      open.appendChild(snip);
    }
    open.addEventListener('click', function () { openChat(chat.id); });
    row.appendChild(open);

    var actions = document.createElement('div');
    actions.className = 'chat-actions';
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'chat-act' + (chat.pinned ? ' on' : '');
    pin.title = chat.pinned ? 'Unpin' : 'Pin to top';
    pin.setAttribute('aria-label', pin.title);
    pin.innerHTML = icon('<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4-1-6z"/>');
    pin.addEventListener('click', function (e) { e.stopPropagation(); chatStore.pin(chat.id, !chat.pinned).then(refreshChats); });
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-act';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete chat');
    del.innerHTML = icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>');
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.title = 'Click again to delete';
        setTimeout(function () { del.classList.remove('armed'); del.title = 'Delete'; }, 3000);
        return;
      }
      if (chat.id === currentId && !busy) goHome();
      chatStore.remove(chat.id).then(refreshChats);
    });
    actions.appendChild(pin);
    actions.appendChild(del);
    row.appendChild(actions);
    return row;
  }

  function renderChatList() {
    chatListEl.textContent = '';
    var searching = searchHits !== null;
    var items = searching ? searchHits : chatsCache;
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = searching ? 'No chats match that.' : 'Your chats will appear here.';
      chatListEl.appendChild(empty);
      return;
    }
    function group(label, list) {
      if (!list.length) return;
      var h = document.createElement('div');
      h.className = 'chat-group';
      h.textContent = label;
      chatListEl.appendChild(h);
      list.forEach(function (c) { chatListEl.appendChild(chatRow(c, searching)); });
    }
    if (searching) { group('Results', items); return; }
    group('Pinned', items.filter(function (c) { return c.pinned; }));
    var rest = items.filter(function (c) { return !c.pinned; });
    ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'].forEach(function (label) {
      group(label, rest.filter(function (c) { return groupLabel(c.updated) === label; }));
    });
  }

  function refreshChats() {
    return chatStore.list().then(function (list) {
      chatsCache = list.slice().sort(function (a, b) { return b.updated - a.updated; });
      if (searchHits === null) renderChatList();
    }, function () {});
  }

  var searchTimer = null;
  $('chatSearch').addEventListener('input', function (e) {
    var q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { searchHits = null; renderChatList(); return; }
    searchTimer = setTimeout(function () {
      chatStore.search(q).then(function (hits) {
        if ($('chatSearch').value.trim() !== q) return;
        searchHits = hits;
        renderChatList();
      });
    }, 200);
  });

  // ---------- Settings: memory, scheduled tasks, background ----------
  function loadSettingsExtras() {
    if (!desktop) return;
    window.ilyra.memory.get().then(function (m) {
      $('memoryText').value = m.text;
      $('memoryCount').textContent = m.text.length + ' / ' + m.max;
    });
    window.ilyra.settings.get().then(function (st) {
      $('autoMemory').checked = st.autoMemory;
      $('useLocation').checked = st.location;
      $('bgMode').checked = st.background;
      $('startLogin').checked = st.startAtLogin;
    });
    renderTasks();
    loadBriefs();
  }
  function renderTasks() {
    var box = $('taskList');
    window.ilyra.tasks.list().then(function (list) {
      box.textContent = '';
      if (!list.length) {
        var none = document.createElement('p');
        none.className = 'folder-empty';
        none.textContent = 'Nothing scheduled.';
        box.appendChild(none);
        return;
      }
      list.forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'task-row';
        var info = document.createElement('div');
        info.className = 'task-info';
        var name = document.createElement('div');
        name.className = 'task-name';
        name.textContent = t.title;
        var when = document.createElement('div');
        when.className = 'route-desc';
        when.textContent = new Date(t.nextRun).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
          (t.repeat ? ' · repeats ' + t.repeat : '') + (t.prompt ? ' · runs a request' : ' · reminder');
        info.appendChild(name);
        info.appendChild(when);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'link-btn remove';
        del.textContent = 'Delete';
        del.addEventListener('click', function () { window.ilyra.tasks.remove(t.id).then(renderTasks); });
        row.appendChild(info);
        row.appendChild(del);
        box.appendChild(row);
      });
    });
  }
  if (desktop) {
    $('memoryText').addEventListener('input', function (e) { $('memoryCount').textContent = e.target.value.length + ' / 6000'; });
    $('memorySave').addEventListener('click', function () {
      window.ilyra.memory.set($('memoryText').value).then(function (text) {
        $('memoryText').value = text;
        $('memoryCount').textContent = 'Saved · ' + text.length + ' / 6000';
      });
    });
    [['autoMemory', 'autoMemory'], ['useLocation', 'location'], ['bgMode', 'background'], ['startLogin', 'startAtLogin']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function (e) {
        var patch = {};
        patch[pair[1]] = e.target.checked;
        window.ilyra.settings.set(patch);
      });
    });
    window.ilyra.onOpenChat(function (id) { refreshChats().then(function () { openChat(id); }); });
    window.ilyra.onChatsChanged(function () { refreshChats(); });
  }

  // ---------- Screen capture ----------
  // A picture of the screen goes into the message box like any attached image, so you see it before sending.
  function attachImageData(image) {
    if (!image || attachments.length >= 4) return;
    attachments.push({ mime: image.mime, data: image.data, url: 'data:' + image.mime + ';base64,' + image.data });
    renderAttachments();
    promptEl.focus();
  }
  $('captureButton').addEventListener('click', function () {
    closeTools();
    if (!desktop) { hint.textContent = 'Screen capture works in the desktop app.'; return; }
    hint.textContent = 'Capturing your screen…';
    window.ilyra.captureScreen().then(function (res) {
      hint.textContent = res.error || MODELS[selected].blurb;
      if (res.image) attachImageData(res.image);
    });
  });
  if (desktop) window.ilyra.onAttachImage(attachImageData);

  // ---------- Copy ----------
  function copyText(text, button) {
    function done() { if (button) { var old = button.textContent; button.textContent = 'Copied'; setTimeout(function () { button.textContent = old; }, 1400); } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    t.remove();
  }
  // Every reply gets a Copy button, and every code block its own.
  function decorateCode(body) {
    body.querySelectorAll('pre').forEach(function (pre) {
      if (pre.querySelector('.code-copy')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'code-copy';
      b.textContent = 'Copy';
      pre.appendChild(b);
    });
  }
  thread.addEventListener('click', function (e) {
    var btn = e.target.closest('.code-copy, .msg-copy');
    if (!btn) return;
    if (btn.classList.contains('code-copy')) {
      var code = btn.parentNode.querySelector('code');
      copyText((code || btn.parentNode).textContent, btn);
    } else {
      var msg = btn.closest('.msg');
      copyText(msg.dataset.raw || msg.querySelector('.msg-body').textContent, btn);
    }
  });

  // ---------- Settings: who handles what ----------
  var settingsSheet = $('settingsSheet');
  function saveRouting() { try { localStorage.setItem('ilyra.routing', JSON.stringify(routing)); } catch (e) {} }

  // A row's buttons: its own choices, or Automatic plus each model it may use.
  function routeChoices(task) {
    if (task.choices) return task.choices.map(function (c) { return { id: c.id, label: c.label, needs: task.needs }; });
    return ['auto'].concat(task.options).map(function (id) {
      return id === 'auto' ? { id: 'auto', label: task.autoLabel || 'Automatic' } : { id: id, label: MODELS[id].name, needs: id };
    });
  }
  function routeChoice(task) {
    if (task.setting) return (info.local && info.local.role) || 'auto';
    if (task.id === 'lead') return routing.lead || (info.local && info.local.connected ? 'local' : 'auto');
    return routing[task.id] || 'auto';
  }
  // Routing lives in this window; a row backed by a setting is kept by the main process.
  function chooseRoute(task, id) {
    if (!task.setting) {
      routing[task.id] = id;
      saveRouting();
      renderRouting();
      return;
    }
    var patch = {};
    patch[task.setting] = id;
    window.ilyra.settings.set(patch).then(function () { lastCheck = 0; refreshProviders(); });
  }
  // What "What the local model keeps" means for the model in use now.
  function localRoleText() {
    var p = info.local || {};
    var keeps = p.strong ? 'everything except making images' : 'everyday chat, and hands code, builds, pictures, live information and long work to the cloud';
    if (!p.connected) return 'How much the local lead answers itself. Automatic decides by the size of the model.';
    if (p.role && p.role !== 'auto') return 'The local model keeps ' + keeps + '.';
    var size = p.params ? p.model + ' has ' + (p.params < 1 ? Math.round(p.params * 1000) + 'M' : p.params + 'B') + ' parameters' : 'Ilyra can\'t tell the size of ' + p.model;
    return 'Automatic: ' + size + ', so it keeps ' + keeps + '. Models of about ' + p.strongAt + 'B parameters and up keep everything except images.';
  }

  function renderRouting() {
    var list = $('routeList');
    list.textContent = '';
    TASKS.forEach(function (task) {
      var row = document.createElement('div');
      row.className = 'route-row';
      var name = document.createElement('div');
      name.className = 'route-name';
      name.textContent = task.name;
      var desc = document.createElement('div');
      desc.className = 'route-desc';
      desc.textContent = task.desc;
      var choices = document.createElement('div');
      choices.className = 'route-choices';
      choices.setAttribute('role', 'radiogroup');
      choices.setAttribute('aria-label', task.name);
      var current = routeChoice(task);
      routeChoices(task).forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'route-choice';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(current === c.id));
        var connected = !c.needs || !desktop || (info[c.needs] && info[c.needs].connected);
        b.disabled = !connected;
        if (!connected) b.title = MODELS[c.needs].name + ' is not connected';
        b.innerHTML = icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
        b.appendChild(document.createTextNode(c.label));
        b.addEventListener('click', function () { chooseRoute(task, c.id); });
        choices.appendChild(b);
      });
      if (task.id === 'localRole') desc.textContent = localRoleText();
      row.appendChild(name);
      row.appendChild(desc);
      row.appendChild(choices);
      if (task.id === 'image' || task.note) {
        var note = document.createElement('div');
        note.className = 'route-desc';
        note.textContent = task.note || 'Claude, Meta and local models cannot make images. Whatever model you chat with, the picture itself is made by your choice here.';
        row.appendChild(note);
      }
      list.appendChild(row);
    });
  }
  function showPage(name) {
    if (!settingsSheet.querySelector('.page[data-page="' + name + '"]')) name = 'general';
    currentPage = name;
    settingsSheet.querySelectorAll('.page').forEach(function (el) { el.hidden = el.dataset.page !== name; });
    settingsSheet.querySelectorAll('.nav-item').forEach(function (el) {
      var on = el.dataset.page === name;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    var main = settingsSheet.querySelector('.prefs-main');
    if (main) main.scrollTop = 0;
    try { localStorage.setItem('ilyra.settingsPage', name); } catch (e) {}
    if (name === 'briefs') loadBriefs();
    if (name === 'routing') renderRouting();
    if (window.IlyraExtras) window.IlyraExtras.showPage(name);
  }
  function openSettings(page) {
    lastCheck = 0; refreshProviders(); renderRouting(); loadSettingsExtras(); loadConnectors();
    if (!page) { try { page = localStorage.getItem('ilyra.settingsPage'); } catch (e) {} }
    showPage(page || 'general');
    if (!settingsSheet.open) settingsSheet.showModal();
  }
  settingsSheet.querySelectorAll('.nav-item').forEach(function (el) { el.addEventListener('click', function () { showPage(el.dataset.page); }); });
  $('settingsButton').addEventListener('click', function () { openSettings(); });
  $('closeSettings').addEventListener('click', function () { settingsSheet.close(); });
  settingsSheet.addEventListener('click', function (e) { if (e.target === settingsSheet) settingsSheet.close(); });
  $('newChat').addEventListener('click', function () { goHome(); if (window.innerWidth <= 800) setSidebar(false); });

  // ---------- Image attachments ----------
  var MAX_IMAGES = 4;
  var MAX_SIDE = 1568; // larger than this gains nothing for the models
  var attachmentsEl = $('attachments');

  function renderAttachments() {
    attachmentsEl.textContent = '';
    attachmentsEl.hidden = !attachments.length;
    attachments.forEach(function (a, i) {
      var box = document.createElement('div');
      box.className = 'attachment';
      var img = document.createElement('img');
      img.src = a.url;
      img.alt = 'Attached image';
      var x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove image');
      x.textContent = '×';
      x.addEventListener('click', function () { attachments.splice(i, 1); renderAttachments(); autosize(); });
      box.appendChild(img);
      box.appendChild(x);
      attachmentsEl.appendChild(box);
    });
    autosize();
  }

  // Shrink to a sensible size and save as JPEG so chats stay small.
  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type) || attachments.length >= MAX_IMAGES) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        var c = canvas.getContext('2d');
        c.fillStyle = '#fff';
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.drawImage(img, 0, 0, canvas.width, canvas.height);
        var url = canvas.toDataURL('image/jpeg', 0.85);
        attachments.push({ mime: 'image/jpeg', data: url.split(',')[1], url: url });
        renderAttachments();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function addImageFiles(files) { Array.prototype.forEach.call(files || [], addImageFile); }

  promptEl.addEventListener('paste', function (e) {
    var files = Array.prototype.filter.call((e.clipboardData && e.clipboardData.files) || [], function (f) { return /^image\//.test(f.type); });
    if (!files.length) return;
    e.preventDefault();
    addImageFiles(files);
  });
  $('attachButton').addEventListener('click', function () { closeTools(); $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) { addImageFiles(e.target.files); e.target.value = ''; });
  var composerEl = $('composer');
  ['dragenter', 'dragover'].forEach(function (name) {
    composerEl.addEventListener(name, function (e) { e.preventDefault(); composerEl.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    composerEl.addEventListener(name, function () { composerEl.classList.remove('dragging'); });
  });
  composerEl.addEventListener('drop', function (e) { e.preventDefault(); addImageFiles(e.dataTransfer && e.dataTransfer.files); });

  // ---------- Composer ----------
  function autosize() {
    promptEl.style.height = 'auto';
    if (promptEl.value) promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
    promptEl.style.overflowY = promptEl.scrollHeight > 180 ? 'auto' : 'hidden';
    if (busy) {
      sendButton.disabled = !activeRequest;
      sendButton.classList.add('stop');
      sendButton.setAttribute('aria-label', 'Stop');
      sendButton.title = 'Stop (Esc)';
      if (!sendButton.dataset.stop) { sendButton.dataset.stop = '1'; sendButton.innerHTML = STOP_ICON; }
    } else {
      sendButton.classList.remove('stop');
      sendButton.setAttribute('aria-label', 'Send');
      sendButton.title = '';
      if (sendButton.dataset.stop) { delete sendButton.dataset.stop; sendButton.innerHTML = SEND_ICON; }
      sendButton.disabled = !promptEl.value.trim() && !attachments.length;
    }
  }

  var SEND_ICON = sendButton.innerHTML;
  var STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  // Stop the reply that is being written. What was written so far stays.
  function stopReply() {
    if (!busy || !activeRequest || !desktop) return;
    sendButton.disabled = true;
    window.ilyra.cancelChat(activeRequest);
  }
  $('composer').addEventListener('submit', function (e) { e.preventDefault(); if (busy) stopReply(); else send(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && busy && !document.querySelector('dialog[open]') && $('toolsPanel').hidden) stopReply();
  });
  promptEl.addEventListener('input', autosize);
  // Typing to the local model loads it while you write (it can take half a minute), at most
  // every few minutes.
  var warmedAt = 0;
  promptEl.addEventListener('input', function () {
    if (!window.ilyra.warmLocal || Date.now() - warmedAt < 300000 || !promptEl.value.trim()) return;
    if (selected !== 'local' && !(selected === 'auto' && leadActive())) return;
    warmedAt = Date.now();
    window.ilyra.warmLocal();
  });
  promptEl.addEventListener('keydown', function (e) {
    if (!slashMenu.hidden && slashItems.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashActive = (slashActive + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length;
        updateSlash();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashActive]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== promptEl && !aiModelsPage.open) {
      e.preventDefault();
      promptEl.focus();
    }
  });

  // ---------- Push-to-talk ----------
  // Hold Ctrl + left Shift (or the mic button) to talk, let go to finish. The orb
  // listens only while the mic is open and follows how loud you are. The clip
  // is turned into text on this computer, with no AI service involved, then
  // put in the message box. Nothing is sent until you press send.
  if (desktop) window.ilyra.onVoiceStatus(function (text) { hint.textContent = text; });
  var TALK_KEY = 'Ctrl + Shift';
  var MAX_TALK_MS = 120000;
  var rec = null; // { stream, recorder, chunks, ctx, timer, raf }
  var talking = false;
  var held = false; // the key or button is still down

  function flashHint(text) {
    hint.textContent = text;
    setTimeout(function () { if (!talking && !busy) hint.textContent = MODELS[selected].blurb; }, 4000);
  }

  // Decode the recording and re-encode as 16 kHz mono WAV, which every speech API accepts.
  // skipSeconds drops the start of the recording; quiet recordings are brought up so the speech model hears them.
  function toWav(blob, skipSeconds) {
    return blob.arrayBuffer().then(function (buf) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx.decodeAudioData(buf).then(function (audio) {
        ctx.close();
        var rate = 16000;
        var off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
        var src = off.createBufferSource();
        src.buffer = audio;
        src.connect(off.destination);
        src.start();
        return off.startRendering();
      });
    }).then(function (rendered) {
      var pcm = rendered.getChannelData(0);
      if (skipSeconds > 0 && pcm.length > skipSeconds * 16000 + 8000) pcm = pcm.subarray(Math.floor(skipSeconds * 16000));
      var peak = 0;
      for (var q = 0; q < pcm.length; q++) peak = Math.max(peak, Math.abs(pcm[q]));
      var gain = peak > 0.001 && peak < 0.3 ? Math.min(8, 0.5 / peak) : 1;
      var out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
      var write = function (at, str) { for (var i = 0; i < str.length; i++) out.setUint8(at + i, str.charCodeAt(i)); };
      write(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
      out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
      out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
      write(36, 'data'); out.setUint32(40, pcm.length * 2, true);
      for (var i = 0; i < pcm.length; i++) {
        var v = Math.max(-1, Math.min(1, pcm[i] * gain));
        out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      return out.buffer;
    });
  }

  function endTalking() {
    talking = false;
    micButton.classList.remove('listening');
    orb.setLevel(0);
    if (rec) {
      clearTimeout(rec.timer);
      cancelAnimationFrame(rec.raf);
      rec.stream.getTracks().forEach(function (t) { t.stop(); });
      rec.ctx.close();
    }
  }

  function startTalking() {
    if (busy || talking || talkMode || !desktop) return;
    held = true;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      // Let go before the mic finished opening: nothing to record.
      if (!held) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      var data = new Uint8Array(analyser.fftSize);
      var recorder = new MediaRecorder(stream);
      var job = rec = { stream: stream, recorder: recorder, chunks: [], ctx: ctx, startedAt: Date.now(), cancelled: false };
      recorder.ondataavailable = function (e) { if (e.data.size) job.chunks.push(e.data); };
      recorder.onstop = function () {
        if (job.cancelled || Date.now() - job.startedAt < 500) { setOrb('idle'); return; }
        setOrb('thinking');
        hint.textContent = 'Transcribing…';
        toWav(new Blob(job.chunks, { type: recorder.mimeType })).then(function (wav) {
          return window.ilyra.transcribe(wav);
        }).then(function (res) {
          if (res.error) { flashHint(res.error); return; }
          if (!res.text) { flashHint("Didn't catch anything. Try again."); return; }
          // Text only: nothing is sent until you press send.
          promptEl.value = (promptEl.value.trim() ? promptEl.value.trim() + ' ' : '') + res.text;
          autosize();
          hint.textContent = MODELS[selected].blurb;
        }).catch(function () {
          flashHint("Couldn't process that recording.");
        }).then(function () {
          if (!busy) setOrb('idle');
          promptEl.focus();
        });
      };
      recorder.start();
      talking = true;
      micButton.classList.add('listening');
      setOrb('listening');
      hint.textContent = 'Listening. Release ' + TALK_KEY + ' to finish, Esc to cancel.';
      job.timer = setTimeout(stopTalking, MAX_TALK_MS);
      (function meter() {
        analyser.getByteTimeDomainData(data);
        var peak = 0;
        for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        orb.setLevel(Math.min(1, peak / 64));
        job.raf = requestAnimationFrame(meter);
      })();
    }, function () {
      flashHint('Ilyra needs microphone access. Check Windows Settings > Privacy > Microphone.');
    });
  }

  function stopTalking(cancel) {
    if (!talking) return;
    rec.cancelled = cancel === true;
    var recorder = rec.recorder;
    endTalking();
    if (recorder.state !== 'inactive') recorder.stop();
  }

  function releaseTalking() { held = false; stopTalking(); }

  // Talk chord: either Ctrl plus left Shift. Ctrl is read from the event's own
  // modifier flags, so a missed key-up can never leave the chord stuck or blocked.
  var leftShift = false;
  var chordTimer = null;
  function chordDown(e) { return leftShift && e.ctrlKey && !e.altKey && !e.metaKey; }

  if (desktop) {
    micButton.hidden = false;
    micButton.title = 'Talk (' + TALK_KEY + ')';
    micButton.addEventListener('pointerdown', function (e) { e.preventDefault(); startTalking(); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (name) {
      micButton.addEventListener(name, releaseTalking);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && talking) { e.preventDefault(); held = false; stopTalking(true); return; }
      if (e.code === 'ShiftLeft') leftShift = true;
      if (chordDown(e)) {
        // Short delay so shortcuts like Ctrl+Shift+Z don't flash the mic on.
        if (!chordTimer && !talking && !held) chordTimer = setTimeout(function () { chordTimer = null; startTalking(); }, 200);
      } else {
        clearTimeout(chordTimer); chordTimer = null;
      }
    });
    document.addEventListener('keyup', function (e) {
      if (e.code === 'ShiftLeft') leftShift = false;
      if (!chordDown(e)) { clearTimeout(chordTimer); chordTimer = null; if (held) releaseTalking(); }
    });
    window.addEventListener('blur', function () { leftShift = false; clearTimeout(chordTimer); chordTimer = null; releaseTalking(); });
  }

  // ---------- Talk mode ----------
  // A hands-free conversation: Ilyra listens, sends what you said once you pause,
  // reads the reply aloud, then listens again. Your voice is still turned into
  // text on this computer. Space interrupts Ilyra; Esc or the button ends it.
  var talkButton = $('talkButton');
  var talkMode = false;
  var talkRec = null;   // the open microphone while listening
  var talkVoice = null; // { stop } while Ilyra is speaking
  var SILENCE_MS = 900;    // this long a pause ends your turn
  var MAX_TURN_MS = 20000;  // a turn ends after this much talking, whatever the room is doing

  function setTalkMode(on) {
    if (on === talkMode) return;
    talkMode = on;
    document.body.classList.toggle('talk-mode', on);
    talkButton.setAttribute('aria-pressed', String(on));
    if (on) {
      stopTalking(true);
      // Load the local model while the user speaks, so the first reply doesn't wait for it.
      if (desktop && usable('local')) window.ilyra.warmLocal();
      talkListen();
    } else {
      talkStopListening();
      talkCut = true;
      talkQueue = [];
      if (talkVoice) talkVoice.stop();
      talkVoice = null;
      orb.setLevel(0);
      if (!busy) setOrb('idle');
      hint.textContent = MODELS[selected].blurb;
    }
  }

  var talkNote = ''; // shown instead of the usual listening hint, once
  // Timings only, never what was said, so problems show up in ilyra.log.
  function talkLog(event) {
    try { if (desktop) window.ilyra.voiceLog(event); } catch (e) { /* diagnostics only */ }
  }

  function talkListen() {
    if (!talkMode || busy || talkRec) return;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } }).then(function (stream) {
      if (!talkMode || talkRec) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      // The speech detector (vad.js) judges each frame on the voice band, how voice-like it
      // sounds, and how far it is above the room's own noise. The recording itself is unfiltered.
      ctx.createMediaStreamSource(stream).connect(analyser);
      var spectrum = new Float32Array(analyser.frequencyBinCount);
      var vad = window.IlyraVad.createVad({ silenceMs: SILENCE_MS, maxTurnMs: MAX_TURN_MS });
      var data = new Uint8Array(analyser.fftSize);
      var recorder = new MediaRecorder(stream);
      var job = talkRec = { recorder: recorder, chunks: [], cancelled: false, restart: false, startedAt: Date.now(), lastFrame: Date.now(), talking: false, finish: false };
      recorder.ondataavailable = function (e) { if (e.data.size) job.chunks.push(e.data); };
      recorder.onstop = function () {
        clearTimeout(job.raf);
        stream.getTracks().forEach(function (t) { t.stop(); });
        ctx.close();
        orb.setLevel(0);
        if (talkRec === job) talkRec = null;
        if (!talkMode || job.cancelled) return;
        if (job.restart) { talkListen(); return; }
        setOrb('thinking');
        hint.textContent = 'Got it…';
        var audioMs = Date.now() - (job.speechStart || job.startedAt);
        var asked = Date.now();
        // Didn't get words: say so, then listen again, instead of silently going back.
        function missed(kind, message) {
          talkLog({ kind: kind, audioMs: audioMs, ms: Date.now() - asked });
          if (!talkMode) return;
          talkNote = message;
          talkListen();
        }
        var speechMs = job.speechMs || (job.talking ? Date.now() - job.speechStart : 0);
        // Pressing Enter with nothing but room noise: don't send noise to the speech model.
        if (!job.talking) { missed('empty', 'Didn\'t catch that. Try again.'); return; }
        // Start a little before the first word, so the room's noise before it isn't transcribed.
        toWav(new Blob(job.chunks, { type: recorder.mimeType }), Math.max(0, job.speechStart - job.startedAt - 250) / 1000).then(function (wav) {
          return window.ilyra.transcribe(wav);
        }).then(function (res) {
          if (!talkMode) return;
          if (!res || res.error) { missed('error', 'Couldn\'t transcribe that. Try again.'); return; }
          var text = (res.text || '').trim();
          if (window.IlyraVad.looksLikeNoise(text, speechMs)) { missed('empty', 'Didn\'t catch that. Try again.'); return; } // noise, not words
          talkLog({ kind: 'heard', audioMs: audioMs, ms: Date.now() - asked, chars: text.length });
          promptEl.value = text;
          autosize();
          talkBegin();
          send();
          if (!busy) talkListen();
        }).catch(function (err) { console.warn('talk mode:', err); missed('error', 'Couldn\'t transcribe that. Try again.'); });
      };
      recorder.start();
      setOrb('listening');
      hint.textContent = talkNote || 'Listening. Just talk, then pause or press Enter. Esc ends talk mode.';
      talkNote = '';
      (function meter() {
        analyser.getByteTimeDomainData(data);
        var peak = 0;
        for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        orb.setLevel(Math.min(1, peak / 64));
        var now = Date.now();
        // Time between checks, capped: if the computer stalls (say, while a model
        // loads), the stall must not count as you having gone quiet.
        var dt = Math.min(50, now - job.lastFrame);
        job.lastFrame = now;
        analyser.getFloatFrequencyData(spectrum);
        var step = vad.push(window.IlyraVad.features(spectrum, ctx.sampleRate), dt);
        if (step.started) { job.talking = true; job.speechStart = now - 300; hint.textContent = 'Listening… pause when you\'re done, or press Enter.'; }
        // Nothing said for a while: start a fresh recording so it doesn't grow forever.
        if (!job.talking && now - job.startedAt > 30000) { job.restart = true; recorder.stop(); return; }
        if (job.finish || step.ended) { job.speechMs = vad.speechMs(); recorder.stop(); return; }
        // A timer, not animation frames: those stop when Ilyra's window is hidden.
        job.raf = setTimeout(meter, 30);
      })();
    }, function () {
      setTalkMode(false);
      flashHint('Ilyra needs microphone access. Check Windows Settings > Privacy > Microphone.');
    });
  }

  function talkStopListening() {
    if (!talkRec) return;
    var job = talkRec;
    talkRec = null;
    job.cancelled = true;
    if (job.recorder.state !== 'inactive') job.recorder.stop();
  }

  // Replies are written for reading; make them sound right out loud.
  function speakable(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' I put the code in the chat. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'the link in the chat')
      .replace(/^\s{0,3}(#+|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/[*_~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Ilyra starts talking as soon as the first sentence of a reply arrives. Each
  // finished sentence is sent off to be voiced right away, so later ones are
  // ready by the time the earlier ones finish playing.
  var talkSaid = 0;        // characters of the reply already queued
  var talkQueue = [];      // [{ say, voiced: Promise }]
  var talkFinished = false; // the whole reply has arrived
  var talkCut = false;     // you cut Ilyra off; skip the rest of this reply

  function talkBegin() {
    talkSaid = 0;
    talkQueue = [];
    talkFinished = false;
    talkCut = false;
  }

  function talkFeed(final) {
    if (!talkMode || talkCut) return;
    var rest = streamText.slice(talkSaid);
    // Hold back an unfinished code block until it closes.
    var fences = rest.split('```').length - 1;
    var usable = fences % 2 ? rest.slice(0, rest.lastIndexOf('```')) : rest;
    var cut = final && !(fences % 2) ? usable.length : -1;
    if (cut < 0) {
      var re = /[.!?]["')\]]*\s|\n/g, m;
      while ((m = re.exec(usable))) cut = m.index + m[0].length;
    }
    if (cut <= 0) return;
    var chunk = rest.slice(0, cut);
    talkSaid += cut;
    var say = speakable(chunk);
    if (!say) return;
    talkQueue.push({ say: say, voiced: window.ilyra.speak(say, talkVoiceName).catch(function () { return { fallback: true }; }) });
    if (!talkVoice) talkNext();
  }

  function talkNext() {
    if (!talkMode || talkCut) return;
    var item = talkQueue.shift();
    if (!item) {
      talkVoice = null;
      if (talkFinished) doneSpeaking();
      return;
    }
    talkVoice = { stop: function () {} }; // claimed while the audio is on its way
    setOrb('speaking');
    hint.textContent = 'Speaking. Press Space to cut in, Esc to end talk mode.';
    item.voiced.then(function (res) {
      if (!talkMode || talkCut) return;
      if (res && res.audio) playVoice(res.audio, item.say, talkNext); else speakWithWindows(item.say, talkNext);
    });
  }

  // Called once the whole reply is in.
  function talkReply(spoken) {
    if (!talkMode) return;
    talkFinished = true;
    // Errors never stream; say them anyway.
    if (!streamText && spoken && !talkCut) { streamText = spoken; talkFeed(true); streamText = ''; }
    if (talkCut) { doneSpeaking(); return; }
    talkFeed(true);
    if (!talkVoice && !talkQueue.length) doneSpeaking();
  }

  function talkInterrupt() {
    talkCut = true;
    talkQueue = [];
    if (talkVoice) talkVoice.stop();
    doneSpeaking();
  }

  function doneSpeaking() {
    talkVoice = null;
    orb.setLevel(0);
    if (talkMode) talkListen(); else if (!busy) setOrb('idle');
  }

  function playVoice(b64, say, then) {
    var audio = new Audio('data:audio/mpeg;base64,' + b64);
    audio.playbackRate = talkSpeed;
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaElementSource(audio).connect(analyser);
    analyser.connect(ctx.destination);
    var data = new Uint8Array(analyser.fftSize);
    var raf, finished = false;
    function end() {
      if (finished) return false;
      finished = true;
      cancelAnimationFrame(raf);
      audio.pause();
      ctx.close();
      orb.setLevel(0);
      return true;
    }
    talkVoice = { stop: end };
    audio.onended = audio.onerror = function () { if (end()) then(); };
    (function meter() {
      analyser.getByteTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      orb.setLevel(Math.min(1, peak / 48));
      raf = requestAnimationFrame(meter);
    })();
    audio.play().catch(function () { if (end()) speakWithWindows(say, then); });
  }

  // No ChatGPT key (or it failed): use the voice built into Windows.
  function speakWithWindows(say, then) {
    if (!window.speechSynthesis) { then(); return; }
    var u = new SpeechSynthesisUtterance(say);
    var voices = window.speechSynthesis.getVoices();
    var voice = voices.filter(function (v) { return /^en/i.test(v.lang) && /natural|aria|jenny|zira/i.test(v.name); })[0] ||
      voices.filter(function (v) { return /^en/i.test(v.lang); })[0];
    if (voice) u.voice = voice;
    u.rate = talkSpeed;
    var raf, t = 0, finished = false;
    function end() {
      if (finished) return false;
      finished = true;
      cancelAnimationFrame(raf);
      window.speechSynthesis.cancel();
      orb.setLevel(0);
      return true;
    }
    talkVoice = { stop: end };
    u.onend = u.onerror = function () { if (end()) then(); };
    (function pulse() { t += 0.25; orb.setLevel(0.3 + 0.25 * Math.sin(t)); raf = requestAnimationFrame(pulse); })();
    window.speechSynthesis.speak(u);
  }

  // The voice is picked in Settings and remembered on this computer.
  var voicePick = $('voicePick');
  var talkVoiceName = 'marin';
  try { talkVoiceName = localStorage.getItem('ilyra.voice') || 'marin'; } catch (e) {}
  voicePick.value = talkVoiceName;
  if (!voicePick.value) { talkVoiceName = 'marin'; voicePick.value = 'marin'; }
  voicePick.addEventListener('change', function () {
    talkVoiceName = voicePick.value;
    try { localStorage.setItem('ilyra.voice', talkVoiceName); } catch (e) {}
  });
  var speedPick = $('speedPick');
  var talkSpeed = 1.15;
  try { talkSpeed = parseFloat(localStorage.getItem('ilyra.voiceSpeed')) || 1.15; } catch (e) {}
  speedPick.value = String(talkSpeed);
  if (!speedPick.value) { talkSpeed = 1.15; speedPick.value = '1.15'; }
  speedPick.addEventListener('change', function () {
    talkSpeed = parseFloat(speedPick.value) || 1;
    try { localStorage.setItem('ilyra.voiceSpeed', String(talkSpeed)); } catch (e) {}
  });
  var sampleVoice = null;
  $('voiceTest').addEventListener('click', function () {
    if (!desktop) return;
    var btn = this;
    if (sampleVoice) sampleVoice.stop();
    btn.disabled = true;
    btn.textContent = 'Loading…';
    var say = "Hi, I'm Ilyra. This is how I'll sound when we talk.";
    var reset = function () { sampleVoice = null; btn.disabled = false; btn.textContent = 'Play sample'; };
    window.ilyra.speak(say, talkVoiceName).then(function (res) {
      var keep = talkVoice;
      var after = function () { talkVoice = keep; reset(); };
      if (res && res.audio) playVoice(res.audio, say, after); else speakWithWindows(say, after);
      sampleVoice = talkVoice;
      talkVoice = keep;
      btn.textContent = 'Playing…';
    }, reset);
  });

  if (desktop) {
    talkButton.hidden = false;
    talkButton.addEventListener('click', function () { setTalkMode(!talkMode); });
    document.addEventListener('keydown', function (e) {
      if (!talkMode) return;
      if (e.key === 'Escape') { e.preventDefault(); setTalkMode(false); return; }
      if (e.code === 'Space' && (talkVoice || talkQueue.length)) { e.preventDefault(); talkInterrupt(); }
      // Enter sends what you've said right away, without waiting for a pause.
      if (e.key === 'Enter' && talkRec && talkRec.talking) { e.preventDefault(); talkRec.finish = true; }
    });
  }

  // ---------- Model versions ----------
  // Each provider offers several models (Opus, Sonnet, Fable...). Pick one here or
  // on the AI models page; it stays your choice until you change it.
  var modelLists = {}; // provider id -> [{ id, label }]

  function loadModelList(key, refresh) {
    if (!desktop || !info[key] || !info[key].connected) return Promise.resolve([]);
    if (modelLists[key] && !refresh) return Promise.resolve(modelLists[key]);
    return window.ilyra.providerModels(key, refresh).then(function (res) {
      modelLists[key] = res.models || [];
      return modelLists[key];
    }, function () { return []; });
  }

  function fillSelect(sel, key) {
    var list = (modelLists[key] || []).slice();
    var current = info[key] && info[key].model;
    if (current && !list.some(function (m) { return m.id === current; })) list.unshift({ id: current, label: current });
    sel.textContent = '';
    if (!info[key] || !info[key].connected) {
      var none = document.createElement('option');
      none.textContent = key === 'local' ? 'Connect to choose a model' : 'Add a key to choose a model';
      none.value = ''; // so a first save picks the best model instead of pinning this text
      sel.appendChild(none);
      sel.disabled = true;
      return;
    }
    list.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label && m.label !== m.id && m.label.indexOf(m.id) === -1 ? m.label + '  (' + m.id + ')' : (m.label || m.id);
      if (m.id === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = false;
  }

  function chooseModel(key, id) {
    return window.ilyra.setModel(key, id).then(function (p) {
      info[key] = p;
      refreshPicker();
      document.querySelectorAll('.provider-row').forEach(function (li) {
        if (li.dataset.key === key) fillSelect(li.querySelector('.model-select'), key);
      });
      hint.textContent = MODELS[key].name + ' will use ' + p.model + '.';
    });
  }

  // The AI models page: fill from the cache now, refresh from the provider after.
  function fillModelSelect(sel, key, first) {
    fillSelect(sel, key);
    if (!sel.dataset.wired) {
      sel.dataset.wired = '1';
      sel.addEventListener('change', function () { chooseModel(key, sel.value); });
    }
    if (first && desktop && info[key] && info[key].connected && !modelLists[key]) {
      loadModelList(key).then(function () { fillSelect(sel, key); });
    }
  }

  // The quick picker beside the model tabs: shown when one provider is selected.
  function refreshPicker() {
    var pick = $('modelPick');
    var row = $('versionRow');
    if (!desktop || selected === 'auto' || !info[selected] || !info[selected].connected) { row.hidden = true; return; }
    var key = selected;
    fillSelect(pick, key);
    row.hidden = false;
    loadModelList(key).then(function () { if (selected === key) fillSelect(pick, key); });
  }
  $('modelPick').addEventListener('change', function (e) { chooseModel(selected, e.target.value); });

  // ---------- AI models (API keys) ----------
  PROVIDERS.forEach(function (k) { info[k] = { connected: false }; });

  function renderStatus() {
    var count = PROVIDERS.filter(function (k) { return info[k].connected; }).length;
    $('statusText').textContent = count ? count + ' connected' : 'Not connected';
    $('statusDot').className = 'status-dot ' + (count ? 'ok' : 'warn');
  }

  // Local models have no key: their row takes the address of the model server instead.
  function renderProviderRow(li, key) {
    var p = info[key];
    var isLocal = key === 'local';
    var state = li.querySelector('.state');
    var hintText = p.hint ? (isLocal ? ' · ' + p.hint : ' · ••' + p.hint) : '';
    state.textContent = p.connected ? 'Connected' + hintText : 'Not connected';
    state.classList.toggle('ok', p.connected);
    li.querySelector('.key').placeholder = isLocal
      ? (p.connected ? 'Change server address (optional)' : 'Server address, like http://localhost:11434')
      : (p.connected ? 'Replace key (optional)' : 'Paste API key');
    fillModelSelect(li.querySelector('.model-select'), key, true);
    li.querySelector('.remove').hidden = !p.connected;
    var find = li.querySelector('.find');
    if (find) find.hidden = p.connected;
    var context = li.querySelector('.context-select');
    if (context && p.context) context.value = String(p.context);
  }

  // How much of the chat the local model can hold at once. Ollama is given this size; other
  // servers set it when they load the model, so the two should match.
  var CONTEXT_SIZES = [4096, 8192, 16384, 32768, 65536, 131072];
  function contextPicker() {
    var row = document.createElement('div');
    row.className = 'provider-row-extra';
    var label = document.createElement('label');
    label.textContent = 'Context size';
    var sel = document.createElement('select');
    sel.className = 'context-select';
    sel.setAttribute('aria-label', 'Context size');
    CONTEXT_SIZES.forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = (n / 1024) + 'k tokens' + (n === 8192 ? ' (common)' : '');
      sel.appendChild(opt);
    });
    var note = document.createElement('span');
    note.textContent = 'Bigger holds longer chats but needs more memory. Ollama uses this; for other servers, load the model with the same size.';
    sel.disabled = !desktop;
    sel.addEventListener('change', function () {
      window.ilyra.settings.set({ localContext: Number(sel.value) }).then(function () { lastCheck = 0; refreshProviders(); });
    });
    label.appendChild(sel);
    row.appendChild(label);
    row.appendChild(note);
    return row;
  }

  // Fills in the address of a model server already running on this computer.
  function findLocalServer(li, quiet) {
    var msg = li.querySelector('.provider-row-msg');
    if (!quiet) { msg.textContent = 'Looking for a model server on this computer…'; msg.className = 'provider-row-msg'; }
    return window.ilyra.findLocalServer().then(function (res) {
      var server = res && res.server;
      if (!server) {
        if (!quiet) { msg.textContent = 'No model server is running here. Install Ollama or LM Studio, download a model, then try again.'; msg.className = 'provider-row-msg bad'; }
        return;
      }
      li.querySelector('.key').value = server.address;
      msg.textContent = server.count
        ? 'Found ' + server.name + ' with ' + server.count + (server.count === 1 ? ' model' : ' models') + '. Press Save to connect.'
        : 'Found ' + server.name + ', but it has no models yet. Download one in ' + server.name + ', then press Save.';
      msg.className = 'provider-row-msg' + (server.count ? ' good' : '');
    });
  }

  function buildProviderRows() {
    var list = $('providerList');
    list.textContent = '';
    PROVIDERS.forEach(function (key) {
      var li = document.createElement('li');
      li.className = 'provider-row';
      li.dataset.key = key;
      li.innerHTML =
        '<div class="provider-row-head"><span class="avatar"></span><span class="name"></span><span class="head-links"><button type="button" class="link-btn get">Get a key</button><button type="button" class="link-btn remove">Remove</button></span><span class="state"></span></div>' +
        '<form class="provider-row-form">' +
          '<input class="key" type="password" autocomplete="off" spellcheck="false" aria-label="API key" />' +
          '<select class="model-select" aria-label="Model"></select>' +
          '<button type="submit" class="save">Save</button>' +
          '<p class="provider-row-msg" role="status"></p>' +
        '</form>';
      li.querySelector('.name').textContent = MODELS[key].name;
      li.querySelector('.avatar').textContent = MODELS[key].name.charAt(0);
      // The providers' real logos (see logos.js).
      if (window.IlyraLogos) window.IlyraLogos.fill(li.querySelector('.avatar'), key);
      var form = li.querySelector('form');
      var msg = li.querySelector('.provider-row-msg');
      var isLocal = key === 'local';
      if (isLocal) {
        var keyField = li.querySelector('.key');
        keyField.type = 'text';
        keyField.setAttribute('aria-label', 'Server address');
        li.querySelector('.get').textContent = 'Get Ollama';
        var find = document.createElement('button');
        find.type = 'button';
        find.className = 'link-btn find';
        find.textContent = 'Find it';
        find.addEventListener('click', function () { findLocalServer(li, false); });
        li.querySelector('.head-links').insertBefore(find, li.querySelector('.get'));
        li.appendChild(contextPicker());
      }

      if (!desktop) {
        form.querySelectorAll('input, select, button').forEach(function (el) { el.disabled = true; });
      }

      li.querySelector('.get').addEventListener('click', function () { window.ilyra.openKeyPage(key); });
      li.querySelector('.remove').addEventListener('click', function () {
        window.ilyra.removeProvider(key).then(function (p) {
          info[key] = p;
          msg.textContent = isLocal ? 'Disconnected.' : 'Key removed from this computer.';
          msg.className = 'provider-row-msg';
          renderProviderRow(li, key);
          renderStatus();
        });
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var keyInput = li.querySelector('.key');
        var save = li.querySelector('.save');
        save.disabled = true;
        msg.textContent = isLocal ? 'Connecting…' : 'Verifying…';
        msg.className = 'provider-row-msg';
        window.ilyra.saveProvider(key, { key: keyInput.value, model: li.querySelector('.model-select').value })
          .then(function (res) {
            save.disabled = false;
            if (res.error) {
              msg.textContent = res.error;
              msg.className = 'provider-row-msg bad';
              return;
            }
            info[key] = res.provider;
            keyInput.value = '';
            delete modelLists[key];
            msg.textContent = 'Linked. Using ' + res.provider.model + '.';
            msg.className = 'provider-row-msg good';
            renderProviderRow(li, key);
            renderStatus();
          });
      });

      list.appendChild(li);
      renderProviderRow(li, key);
      if (isLocal && desktop && !info[key].connected) findLocalServer(li, true);
    });
  }

  // Keys and credit can change while Ilyra is in the background, so look again whenever it comes back into view.
  var lastCheck = 0;
  function refreshProviders() {
    if (!desktop || Date.now() - lastCheck < 5000) return;
    lastCheck = Date.now();
    refreshUsage();
    window.ilyra.providers().then(function (list) {
      list.forEach(function (p) { info[p.id] = p; });
      renderStatus();
      refreshPicker();
      if (!aiModelsPage.open) buildProviderRows();
      if (settingsSheet.open) renderRouting();
    });
  }
  window.addEventListener('focus', refreshProviders);

  function loadProviders() {
    if (!desktop) {
      $('sheetNote').textContent = 'This is the browser preview. Keys can be added in the Ilyra desktop app.';
      buildProviderRows();
      renderStatus();
      return;
    }
    window.ilyra.providers().then(function (list) {
      list.forEach(function (p) { info[p.id] = p; });
      buildProviderRows();
      renderStatus();
      refreshPicker();
      if (!list.some(function (p) { return p.connected; }) && !aiModelsPage.open) aiModelsPage.show();
    });
  }

  // ---------- Shared folders ----------
  // A list of folder paths with a Remove button on each (shared folders).
  function renderPaths(ul, list, emptyText, remove) {
    ul.textContent = '';
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'folder-empty';
      empty.textContent = emptyText;
      ul.appendChild(empty);
    }
    list.forEach(function (path) {
      var li = document.createElement('li');
      li.className = 'folder-item';
      var name = document.createElement('span');
      name.textContent = path;
      name.title = path;
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'link-btn remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', function () { remove(path); });
      li.appendChild(name);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }
  // The extras: their windows and the Library page, which lists its folders the same way (see extras.js).
  if (window.IlyraExtras) window.IlyraExtras.init({ desktop: desktop, renderPaths: renderPaths, openArtifact: openArtifact, openChat: openChat, isOpen: function (page) { return settingsSheet.open && currentPage === page; } });
  function renderFolders(list) {
    renderPaths($('folderList'), list, 'No folders shared yet.', function (path) { window.ilyra.folders.remove(path).then(renderFolders); });
  }

  // ---------- Briefs ----------
  function loadBriefs() {
    if (!desktop) return;
    window.ilyra.briefs.get().then(function (b) {
      if (document.activeElement === $('briefsText')) return; // don't replace what is being typed
      $('briefsText').value = b.text;
      $('briefsCount').textContent = b.text.length + ' / ' + b.max;
    });
  }
  if (desktop) {
    $('briefsText').addEventListener('input', function (e) { $('briefsCount').textContent = e.target.value.length + ' / 8000'; });
    $('briefsSave').addEventListener('click', function () {
      window.ilyra.briefs.set($('briefsText').value).then(function (text) {
        $('briefsText').value = text;
        $('briefsCount').textContent = 'Saved · ' + text.length + ' / 8000';
      });
    });
  } else {
    $('briefsSave').disabled = true;
  }
  if (desktop) {
    $('addFolder').addEventListener('click', function () { window.ilyra.folders.add().then(renderFolders); });
    window.ilyra.folders.list().then(renderFolders);
  } else {
    $('addFolder').disabled = true;
    renderFolders([]);
  }

  $('statusButton').addEventListener('click', function () { aiModelsPage.show(); });

  // ---------- Usage meter (sidebar) ----------
  // Tokens counted on this computer, per day and per model. Click it for the breakdown.
  function renderUsage(data) {
    var box = $('usage');
    if (!data) return;
    var keys = Object.keys(MODELS).filter(function (k) { return k !== 'auto'; });
    function total(bucket, k) { var r = (bucket || {})[k]; return r ? (r.input || 0) + (r.output || 0) : 0; }
    var today = 0, month = 0;
    keys.forEach(function (k) { today += total(data.today, k); month += total(data.month, k); });
    $('usageToday').textContent = fmtTokens(today);
    $('usageMonth').textContent = fmtTokens(month) + ' this month';
    var bar = $('usageBar');
    bar.textContent = '';
    keys.forEach(function (k) {
      var n = total(data.today, k);
      if (!n) return;
      var seg = document.createElement('span');
      seg.style.width = (n / today * 100) + '%';
      seg.style.background = rgb(k);
      bar.appendChild(seg);
    });
    var list = $('usageList');
    list.textContent = '';
    keys.forEach(function (k) {
      var m = total(data.month, k);
      if (!m) return;
      var li = document.createElement('li');
      var dot = document.createElement('i');
      dot.style.background = rgb(k);
      var name = document.createElement('span');
      name.textContent = MODELS[k].name;
      var nums = document.createElement('span');
      nums.className = 'usage-nums';
      nums.textContent = fmtTokens(total(data.today, k)) + ' today · ' + fmtTokens(m);
      nums.title = 'Today · this month (' + fmtTokens(data.month[k].input || 0) + ' in, ' + fmtTokens(data.month[k].output || 0) + ' out this month)';
      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(nums);
      list.appendChild(li);
    });
    if (!list.children.length) {
      var none = document.createElement('li');
      none.className = 'usage-none';
      none.textContent = 'Nothing yet. Tokens are counted as you chat.';
      list.appendChild(none);
    }
    box.hidden = false;
  }
  function refreshUsage() {
    if (desktop) window.ilyra.usage.get().then(renderUsage, function () {});
  }
  $('usageToggle').addEventListener('click', function () {
    var open = $('usage').classList.toggle('open');
    $('usageToggle').setAttribute('aria-expanded', String(open));
  });
  refreshUsage();

  // ---------- Connectors (outside services over MCP) ----------
  function renderConnectors(list) {
    connectorNames = list.map(function (c) { return String(c.name || '').toLowerCase(); });
    var ul = $('connectorList');
    ul.textContent = '';
    $('connectorsCard').hidden = !list.length;
    $('connectorsState').textContent = list.length ? list.filter(function (c) { return c.status === 'connected'; }).length + ' connected' : '';
    list.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'connector';
      var top = document.createElement('div');
      top.className = 'connector-top';
      var name = document.createElement('span');
      name.textContent = c.name;
      var state = document.createElement('span');
      state.className = 'state' + (c.status === 'connected' ? ' ok' : c.status === 'error' ? ' bad' : '');
      state.textContent = c.status === 'connected' ? 'Connected' : c.status === 'needs-auth' ? 'Needs sign-in' : c.status === 'off' ? 'Off' : c.status === 'error' ? 'Problem' : 'Not checked';
      var av = document.createElement('span');
      av.className = 'avatar'; av.textContent = c.name.charAt(0).toUpperCase();
      if (window.IlyraLogos) window.IlyraLogos.fill(av, c.name + ' ' + (c.url || '')); // the service's logo when it's a known one
      top.appendChild(av); top.appendChild(name); top.appendChild(state);
      var meta = document.createElement('div');
      meta.className = 'connector-meta';
      meta.textContent = c.status === 'connected' ? (c.tools.length + ' tool' + (c.tools.length === 1 ? '' : 's') + ': ' + c.tools.slice(0, 6).join(', ') + (c.tools.length > 6 ? '…' : '')) : (c.error || c.url);
      var actions = document.createElement('div');
      actions.className = 'connector-actions';
      function button(label, fn, cls) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'link-btn' + (cls ? ' ' + cls : ''); b.textContent = label;
        b.addEventListener('click', function () { b.disabled = true; fn(b); });
        actions.appendChild(b);
      }
      var msg = $('connectorMsg');
      // A rejected token can't block signing in: "Sign in" shows whenever the service wants one.
      if (c.status === 'needs-auth' || (c.status !== 'off' && !c.hasToken)) button(c.status === 'connected' ? 'Sign in again' : 'Sign in', function () { signInTo(c); }, c.status === 'needs-auth' ? 'primary' : '');
      button('Check again', function () { window.ilyra.connectors.refresh(c.id).then(loadConnectors); });
      var trust = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox'; box.checked = c.trusted;
      box.addEventListener('change', function () { window.ilyra.connectors.set(c.id, { trusted: box.checked }); });
      trust.appendChild(box); trust.appendChild(document.createTextNode(' Don\'t ask before using'));
      actions.appendChild(trust);
      var on = document.createElement('label');
      var onBox = document.createElement('input');
      onBox.type = 'checkbox'; onBox.checked = c.enabled;
      onBox.addEventListener('change', function () { window.ilyra.connectors.set(c.id, { enabled: onBox.checked }).then(loadConnectors); });
      on.appendChild(onBox); on.appendChild(document.createTextNode(' On'));
      actions.appendChild(on);
      button('Remove', function () { window.ilyra.connectors.remove(c.id).then(function (l) { renderConnectors(l); }); }, 'remove');
      li.appendChild(top); li.appendChild(meta); li.appendChild(actions);
      ul.appendChild(li);
    });
  }
  // Opens the service's login page in your browser; this finishes when you've signed in there.
  function signInTo(c) {
    var msg = $('connectorMsg');
    msg.textContent = 'Opening your browser. Sign in to ' + c.name + ' there, then come back (it waits up to 3 minutes)…'; msg.className = 'provider-row-msg';
    return window.ilyra.connectors.signIn(c.id).then(function (r) {
      if (r && r.error) { msg.textContent = 'Sign-in didn\'t finish: ' + r.error; msg.className = 'provider-row-msg bad'; }
      else if (r && r.status === 'connected') { msg.textContent = 'Signed in to ' + c.name + '. Your models can use its ' + r.tools.length + ' tools now.'; msg.className = 'provider-row-msg good'; }
      else { msg.textContent = 'Signed in, but ' + c.name + ' didn\'t connect: ' + ((r && r.error) || 'try Check again.'); msg.className = 'provider-row-msg bad'; }
      loadConnectors();
    });
  }
  function loadConnectors() {
    if (!desktop) { $('connectorsCard').querySelectorAll('input, button').forEach(function (el) { el.disabled = true; }); return; }
    window.ilyra.connectors.list().then(renderConnectors);
  }
  $('connectorForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('connectorMsg');
    var add = $('connectorAdd');
    add.disabled = true;
    msg.textContent = 'Connecting…'; msg.className = 'provider-row-msg';
    window.ilyra.connectors.add({ name: $('connectorName').value, url: $('connectorUrl').value, token: $('connectorToken').value }).then(function (res) {
      add.disabled = false;
      if (res.error) { msg.textContent = res.error; msg.className = 'provider-row-msg bad'; return; }
      $('connectorName').value = ''; $('connectorUrl').value = ''; $('connectorToken').value = '';
      if (res.status === 'connected') { msg.textContent = 'Connected. Your models can use its ' + res.tools.length + ' tools now.'; msg.className = 'provider-row-msg good'; }
      else if (res.status === 'needs-auth' && !res.hasToken) { loadConnectors(); signInTo(res); return; }
      else if (res.status === 'needs-auth') { msg.textContent = 'Added, but the service rejected that token.'; msg.className = 'provider-row-msg bad'; }
      else { msg.textContent = 'Added, but it did not connect: ' + (res.error || 'check the address.'); msg.className = 'provider-row-msg bad'; }
      loadConnectors();
    }, function () { add.disabled = false; msg.textContent = 'Something went wrong. Try again.'; msg.className = 'provider-row-msg bad'; });
  });

  // ---------- Boot ----------
  var hour = new Date().getHours();
  var greeting = hour < 5 ? 'Up late.' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  $('greeting').textContent = greeting;

  renderModels();
  var saved = 'auto';
  try { saved = localStorage.getItem('ilyra.model') || 'auto'; } catch (e) {}
  select(MODELS[saved] ? saved : 'auto', true);

  loadConnectors();
  loadProviders();
  refreshChats();
  autosize();

  // Keep the message box focused so dictation tools (Wispr Flow, etc.) have
  // somewhere to type as soon as Ilyra is in front.
  function focusPrompt() {
    var open = document.querySelector('dialog[open]');
    var a = document.activeElement;
    if (open || (a && a !== document.body && a !== promptEl && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    promptEl.focus();
  }
  window.addEventListener('focus', focusPrompt);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) focusPrompt(); });
  focusPrompt();
})();