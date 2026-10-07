// The extras on the page: the artifacts gallery, background tasks, skills, web API keys and the
// Library page, plus the labels for the extra tools. app.js calls in through window.IlyraExtras at
// a few points, so this file loads before it.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var api = function () { return window.ilyra || {}; };
  var ready = false;
  var app = null; // { desktop, renderPaths, isOpen, openArtifact, openChat } from app.js

  // ---------- Library ----------

  var libraryPoll = null;
  function libraryStatusText(st) {
    if (!st.folders.length) return '';
    var counts = st.files + (st.files === 1 ? ' file' : ' files') + ' · ' + st.sections + ' sections';
    if (st.indexing) return 'Indexing… ' + counts;
    if (st.error) return counts + ' · ' + st.error;
    if (st.model && st.embedded === st.sections) return counts + ' · searched by meaning (' + st.model + ')';
    if (st.model) return counts + ' · ' + st.embedded + ' searched by meaning; the rest by words until Ollama is running';
    return counts + ' · searched by words. To search by meaning, run "ollama pull ' + st.suggest + '" and press Re-index.';
  }
  function renderLibrary(st) {
    // The home folder is always in the library: named above the list, with no remove button.
    $('libraryHome').textContent = st.home ? 'Everything in ' + st.home + ' is in your library. Folders starting with _ are skipped.' : '';
    app.renderPaths($('libraryList'), st.folders.filter(function (p) { return p !== st.home; }), 'No other folders.', function (path) { api().library.remove(path).then(renderLibrary); });
    $('libraryStatus').textContent = libraryStatusText(st);
    $('libraryReindex').hidden = !st.folders.length;
    // Indexing runs in the background: keep the count moving while this page is open.
    clearTimeout(libraryPoll);
    if (st.indexing && app.isOpen('library')) libraryPoll = setTimeout(loadLibrary, 1500);
  }
  function loadLibrary() { api().library.status().then(renderLibrary); }

  // ---------- Artifacts gallery ----------
  // Every page Ilyra has made, newest first, found in the saved chats (electron/extras/gallery.js).

  var pages = [];

  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var days = Math.floor((Date.now() - ms) / 86400000);
    if (days < 1 && d.getDate() === new Date().getDate()) return 'Today, ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function renderGallery() {
    var q = $('gallerySearch').value.trim().toLowerCase();
    var shown = pages.filter(function (p) { return !q || (p.title + ' ' + p.chatTitle).toLowerCase().indexOf(q) !== -1; });
    var grid = $('galleryGrid');
    grid.textContent = '';
    $('galleryNote').textContent = !pages.length ? 'No pages yet. When Ilyra makes a web page, a game or a chart, it shows up here.'
      : !shown.length ? 'No pages match that.' : '';
    shown.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'gallery-card';
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'gallery-open';
      open.title = 'Open the preview';
      open.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg><b></b><small></small>';
      open.querySelector('b').textContent = p.title;
      open.querySelector('small').textContent = when(p.at) + (p.offline ? ' · runs offline' : '');
      open.addEventListener('click', function () { openPage(p, false); });
      var chat = document.createElement('button');
      chat.type = 'button';
      chat.className = 'gallery-chat';
      chat.title = 'Go to the chat it was made in';
      chat.textContent = p.chatTitle;
      chat.addEventListener('click', function () { openPage(p, true); });
      li.appendChild(open);
      li.appendChild(chat);
      grid.appendChild(li);
    });
  }

  // Opens a page in the preview panel; withChat also opens the chat it came from.
  function openPage(p, withChat) {
    api().artifacts.get(p.id).then(function (page) {
      if (!page) { $('galleryNote').textContent = 'That page is gone; its chat was changed or deleted.'; return; }
      $('gallerySheet').close();
      if (withChat) app.openChat(p.chatId);
      app.openArtifact(page.html, null, page.offline);
    });
  }

  function openGallery() {
    $('galleryNote').textContent = 'Looking through your chats…';
    $('galleryGrid').textContent = '';
    $('gallerySearch').value = '';
    $('gallerySheet').showModal();
    api().artifacts.list().then(function (list) { pages = Array.isArray(list) ? list : []; renderGallery(); },
      function () { $('galleryNote').textContent = 'Could not read your chats. Try again.'; });
  }

  function initGallery() {
    if (!api().artifacts) { $('artifactsButton').hidden = true; return; }
    $('artifactsButton').addEventListener('click', openGallery);
    $('galleryClose').addEventListener('click', function () { $('gallerySheet').close(); });
    $('gallerySearch').addEventListener('input', renderGallery);
    // A click on the dimmed backdrop closes it.
    $('gallerySheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  // ---------- Background tasks ----------
  // Hand Ilyra a job; it plans, works, checks and reports on its own (electron/extras/tasks.js).

  var STATUS_TEXT = { queued: 'Waiting its turn', planning: 'Planning', working: 'Working', checking: 'Checking its work', reviewing: 'Being reviewed', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
  var ACTIVE_WORK = ['queued', 'planning', 'working', 'checking', 'reviewing'];
  var workItems = [];
  var workSelected = null;

  function workBadge() {
    api().work.list().then(function (list) {
      var n = (list || []).filter(function (t) { return ACTIVE_WORK.indexOf(t.status) !== -1; }).length;
      $('tasksBadge').hidden = !n;
      $('tasksBadge').textContent = n ? String(n) : '';
    }, function () {});
  }

  function renderWorkList() {
    var ul = $('workList');
    ul.textContent = '';
    if (!workItems.length) {
      var empty = document.createElement('li');
      empty.className = 'work-empty';
      empty.textContent = 'No tasks yet. Start one here, or ask Ilyra in a chat to "work on" something in the background.';
      ul.appendChild(empty);
    }
    workItems.forEach(function (t) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'work-item' + (t.id === workSelected ? ' on' : '');
      b.innerHTML = '<span class="work-dot"></span><b></b><small></small>';
      b.querySelector('.work-dot').className = 'work-dot ' + t.status;
      b.querySelector('b').textContent = t.title;
      b.querySelector('small').textContent = (t.waiting ? 'Needs your OK' : STATUS_TEXT[t.status] || t.status) + (t.steps ? ' · ' + t.stepsDone + '/' + t.steps + ' steps' : '') + ' · ' + when(t.updated || t.created);
      b.addEventListener('click', function () { workSelected = t.id; $('workForm').hidden = true; renderWorkList(); showWork(t.id); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function showWork(id) {
    var box = $('workDetail');
    box.hidden = false;
    if (!id) { box.textContent = ''; box.appendChild(el('p', 'work-hint', 'Pick a task to see its plan and progress.')); return; }
    api().work.get(id).then(function (t) {
      if (workSelected !== id) return;
      box.textContent = '';
      if (!t) { box.appendChild(el('p', 'work-hint', 'That task is gone.')); return; }
      var head = el('div', 'work-detail-head');
      head.appendChild(el('h2', '', t.title));
      head.appendChild(el('span', 'work-status ' + t.status, t.waiting ? 'Needs your OK: ' + t.waiting : STATUS_TEXT[t.status] || t.status));
      box.appendChild(head);
      var actions = el('div', 'work-actions');
      function action(label, fn, danger) { var b = el('button', danger ? 'link-btn remove' : 'link-btn', label); b.type = 'button'; b.addEventListener('click', fn); actions.appendChild(b); }
      if (ACTIVE_WORK.indexOf(t.status) !== -1) action('Stop', function () { api().work.stop(id).then(refreshWork); }, true);
      if (t.status === 'failed' || t.status === 'stopped') action('Run again', function () { api().work.retry(id).then(refreshWork); });
      if (t.chatId) action('Open the result chat', function () { $('workSheet').close(); app.openChat(t.chatId); });
      if (api().work.open) action('Open its folder', function () { api().work.open(id); });
      if (ACTIVE_WORK.indexOf(t.status) === -1) action('Remove', function () { if (confirm('Remove this task and its folder?')) api().work.remove(id).then(function () { workSelected = null; refreshWork(); }); }, true);
      box.appendChild(actions);
      if (t.result && t.result.summary) { box.appendChild(el('h3', '', 'Result')); box.appendChild(el('p', 'work-result', t.result.summary)); }
      if (t.review) box.appendChild(el('p', 'work-review ' + (t.review.verdict === 'passed' ? 'good' : 'bad'), 'Checked by ' + t.review.by + ': ' + t.review.verdict + (t.review.notes ? '. ' + t.review.notes : '')));
      if (t.error) box.appendChild(el('p', 'work-review bad', t.error));
      box.appendChild(el('h3', '', 'Task'));
      box.appendChild(el('p', 'work-prompt', t.prompt));
      if (t.plan) {
        box.appendChild(el('h3', '', 'Plan'));
        var ol = el('ol', 'work-plan');
        t.plan.steps.forEach(function (s) { var li = el('li', s.done ? 'done' : '', s.text); if (s.note) li.appendChild(el('small', '', s.note)); ol.appendChild(li); });
        box.appendChild(ol);
        box.appendChild(el('p', 'work-donewhen', 'Done when: ' + t.plan.doneWhen));
      }
      box.appendChild(el('h3', '', 'Progress'));
      var log = el('ul', 'work-log');
      t.log.slice().reverse().slice(0, 60).forEach(function (l) { var li = el('li', '', l.text); li.prepend(el('time', '', new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))); log.appendChild(li); });
      box.appendChild(log);
      box.appendChild(el('p', 'work-hint', t.grantsText + (t.model ? '\nWorked on by ' + t.model + '.' : '') + '\nFolder: ' + t.folder));
    });
  }

  function refreshWork() {
    workBadge();
    if (!$('workSheet').open) return;
    api().work.list().then(function (list) {
      workItems = Array.isArray(list) ? list : [];
      if (!workSelected && workItems.length && $('workForm').hidden) workSelected = workItems[0].id;
      renderWorkList();
      if ($('workForm').hidden) showWork(workSelected);
    });
  }

  function openWork() {
    $('workForm').hidden = true;
    $('workDetail').hidden = false;
    $('workSheet').showModal();
    refreshWork();
  }

  function newWork() {
    workSelected = null;
    renderWorkList();
    $('workDetail').hidden = true;
    $('workForm').hidden = false;
    $('workFormMsg').textContent = '';
    $('workFormTitle').focus();
  }

  function initWork() {
    if (!api().work) { $('tasksButton').hidden = true; return; }
    $('tasksButton').addEventListener('click', openWork);
    $('workClose').addEventListener('click', function () { $('workSheet').close(); });
    $('workNew').addEventListener('click', newWork);
    $('workFormCancel').addEventListener('click', function () { $('workForm').hidden = true; refreshWork(); });
    $('workSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('workForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var prompt = $('workFormPrompt').value.trim();
      if (!prompt) { $('workFormMsg').textContent = 'Say what the task should do.'; $('workFormMsg').className = 'provider-row-msg bad'; return; }
      api().work.start({
        title: $('workFormTitle').value.trim() || prompt.slice(0, 60),
        prompt: prompt,
        grants: { files: $('workFormFiles').value, web: $('workFormWeb').checked, http: $('workFormHttp').value, connectors: $('workFormConnectors').checked, browse: $('workFormBrowse').checked, cloud: $('workFormCloud').checked, review: $('workFormReview').checked }
      }).then(function (t) {
        if (!t || t.error) { $('workFormMsg').textContent = (t && t.error) || 'Could not start it.'; $('workFormMsg').className = 'provider-row-msg bad'; return; }
        $('workFormTitle').value = ''; $('workFormPrompt').value = '';
        $('workForm').hidden = true;
        workSelected = t.id;
        refreshWork();
      });
    });
    if (api().onWorkChanged) api().onWorkChanged(function () { refreshWork(); });
    workBadge();
    setInterval(function () { if ($('workSheet').open) refreshWork(); }, 15000);
  }

  // ---------- Skills ----------
  // Instructions for kinds of work, from GitHub or a folder (electron/extras/skills.js). The ones
  // that are on are listed to Ilyra by name; it reads one in full when a request needs it.

  var skillItems = [];
  var skillSelected = null;
  var skillNote = '';

  function skillsBadge(list) {
    var n = (list || skillItems).filter(function (s) { return s.enabled; }).length;
    $('skillsBadge').hidden = !n;
    $('skillsBadge').textContent = n ? String(n) : '';
  }

  function renderSkillsList() {
    var ul = $('skillsList');
    ul.textContent = '';
    if (!skillItems.length) ul.appendChild(el('li', 'work-empty', 'No skills yet. Press "Add skills" and paste a GitHub link, like https://github.com/Leonxlnx/taste-skill.'));
    skillItems.forEach(function (s) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'work-item' + (s.name === skillSelected ? ' on' : '');
      b.appendChild(el('span', 'work-dot' + (s.enabled ? ' done' : '')));
      b.appendChild(el('b', '', s.name));
      b.appendChild(el('small', '', (s.enabled ? 'On' : 'Off') + (s.description ? ' · ' + s.description : '')));
      b.addEventListener('click', function () { skillSelected = s.name; $('skillsForm').hidden = true; renderSkillsList(); showSkill(s.name); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function showSkill(name) {
    var box = $('skillsDetail');
    box.hidden = false;
    box.textContent = '';
    if (!name) { box.appendChild(el('p', 'work-hint', skillItems.length ? 'Pick a skill to read it and turn it on or off.' : '')); return; }
    api().skills.get(name).then(function (s) {
      if (skillSelected !== name) return;
      box.textContent = '';
      if (!s || s.error) { box.appendChild(el('p', 'work-hint', (s && s.error) || 'That skill is gone.')); return; }
      // What was just added, shown once above the first of them.
      if (skillNote) { box.appendChild(el('p', 'skill-added', skillNote)); skillNote = ''; }
      var head = el('div', 'work-detail-head');
      head.appendChild(el('h2', '', s.name));
      box.appendChild(head);
      var toggle = el('label', 'check skill-toggle');
      var words = el('span', '', 'Use this skill');
      words.appendChild(el('small', '', 'When on, Ilyra knows about it and reads it whenever a request is that kind of work. You can also name it in a message to use it then.'));
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = s.enabled;
      input.addEventListener('change', function () {
        api().skills.setEnabled(name, input.checked).then(function (list) { if (Array.isArray(list)) { skillItems = list; renderSkillsList(); skillsBadge(); } });
      });
      toggle.appendChild(words);
      toggle.appendChild(input);
      box.appendChild(toggle);
      var actions = el('div', 'work-actions');
      var remove = el('button', 'link-btn remove', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        if (!confirm('Remove the ' + name + ' skill?')) return;
        api().skills.remove(name).then(function () { skillSelected = null; refreshSkills(); });
      });
      if (app.desktop) actions.appendChild(remove);
      box.appendChild(actions);
      if (s.description) box.appendChild(el('p', 'work-result', s.description));
      var facts = [];
      if (s.source) facts.push('From ' + s.source);
      facts.push(Math.round(s.size / 1000) + ' KB of instructions' + (s.files ? ', plus ' + s.files + ' other file' + (s.files === 1 ? '' : 's') : ''));
      if (s.hasScripts) facts.push('It includes scripts. Ilyra reads them but never runs them.');
      box.appendChild(el('p', 'work-hint', facts.join('\n')));
      box.appendChild(el('h3', '', 'What it tells Ilyra'));
      box.appendChild(el('pre', 'skill-text', s.content));
    });
  }

  function refreshSkills() {
    api().skills.list().then(function (list) {
      skillItems = Array.isArray(list) ? list : [];
      skillsBadge();
      if (!$('skillsSheet').open) return;
      if (skillSelected && !skillItems.some(function (s) { return s.name === skillSelected; })) skillSelected = null;
      if (!skillSelected && skillItems.length && $('skillsForm').hidden) skillSelected = skillItems[0].name;
      renderSkillsList();
      if (!skillItems.length && $('skillsForm').hidden) addSkills();
      else if ($('skillsForm').hidden) showSkill(skillSelected);
    });
  }

  function addSkills() {
    skillSelected = null;
    renderSkillsList();
    $('skillsDetail').hidden = true;
    $('skillsForm').hidden = false;
    $('skillsMsg').textContent = '';
    $('skillsUrl').focus();
  }

  // After adding: say what came in, and show the first one.
  function skillsAdded(res) {
    var msg = $('skillsMsg');
    $('skillsAdd').disabled = false;
    if (!res || res.error) { msg.textContent = (res && res.error) || 'Could not add that.'; msg.className = 'provider-row-msg bad'; return; }
    if (!res.installed.length) { msg.textContent = ''; return; }
    skillItems = res.skills;
    skillsBadge();
    $('skillsUrl').value = '';
    $('skillsForm').hidden = true;
    skillSelected = res.installed[0];
    if (res.installed.length > 1) skillNote = 'Added ' + res.installed.length + ' skills: ' + res.installed.join(', ') + '. Any that are new start off, since skills in one collection often overlap. Turn on the ones you want.';
    renderSkillsList();
    showSkill(skillSelected);
  }

  function initSkills() {
    if (!api().skills) { $('skillsButton').hidden = true; return; }
    $('skillsButton').addEventListener('click', function () {
      $('skillsForm').hidden = true;
      $('skillsDetail').hidden = false;
      $('skillsSheet').showModal();
      refreshSkills();
    });
    $('skillsClose').addEventListener('click', function () { $('skillsSheet').close(); });
    $('skillsSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('skillsNew').addEventListener('click', addSkills);
    $('skillsCancel').addEventListener('click', function () { $('skillsForm').hidden = true; $('skillsDetail').hidden = false; refreshSkills(); });
    $('skillsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var url = $('skillsUrl').value.trim();
      if (!url) { $('skillsMsg').textContent = 'Paste a GitHub link first.'; $('skillsMsg').className = 'provider-row-msg bad'; return; }
      $('skillsAdd').disabled = true;
      $('skillsMsg').textContent = 'Downloading…';
      $('skillsMsg').className = 'provider-row-msg';
      api().skills.addUrl(url).then(skillsAdded, function (err) { skillsAdded({ error: err && err.message }); });
    });
    // Folders on this PC can be picked only at the PC.
    $('skillsFolder').hidden = !app.desktop || !api().skills.addFolder;
    $('skillsFolder').addEventListener('click', function () { api().skills.addFolder().then(skillsAdded); });
    refreshSkills();
  }

  // ---------- Web API keys (http_request) ----------

  function renderApis(list) {
    list = Array.isArray(list) ? list : [];
    $('apisState').textContent = list.length ? list.length + ' saved' : '';
    var ul = $('apisList');
    ul.textContent = '';
    list.forEach(function (k) {
      var li = el('li', 'api-row');
      li.appendChild(el('b', '', k.name));
      li.appendChild(el('span', '', k.host + ' · ' + k.header + ' · …' + (k.hint || '')));
      if (!k.builtIn) { var rm = el('button', 'link-btn remove', 'Remove'); rm.type = 'button'; rm.addEventListener('click', function () { api().apis.remove(k.name).then(renderApis); }); li.appendChild(rm); }
      ul.appendChild(li);
    });
  }

  function initApis() {
    if (!api().apis || !api().apis.save) { $('apisCard').hidden = true; return; }
    api().apis.list().then(renderApis, function () {});
    $('apisForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = $('apisMsg');
      api().apis.save({ name: $('apisName').value, site: $('apisSite').value, header: $('apisHeader').value || 'Authorization', key: $('apisKey').value }).then(function (res) {
        if (res && res.error) { msg.textContent = res.error; msg.className = 'provider-row-msg bad'; return; }
        ['apisName', 'apisSite', 'apisHeader', 'apisKey'].forEach(function (id) { $(id).value = ''; });
        msg.textContent = 'Saved. Ask Ilyra to call that API, naming the key.';
        msg.className = 'provider-row-msg good';
        renderApis(res);
      });
    });
  }

  // ---------- Setup ----------

  function init(options) {
    app = options;
    initGallery();
    initWork();
    initSkills();
    initApis();
    if (!app.desktop) { $('libraryAdd').disabled = true; return; }
    $('libraryAdd').addEventListener('click', function () { api().library.add().then(renderLibrary); });
    $('libraryReindex').addEventListener('click', function () {
      $('libraryStatus').textContent = 'Indexing…';
      api().library.reindex().then(renderLibrary);
    });

    ready = true;
  }

  // A settings page was opened: bring what it shows up to date.
  function showPage(name) {
    if (!ready) return;
    if (name === 'library') loadLibrary();
  }

  // What each extra tool is called while it runs, and once it has run.
  var toolLabels = {
    search_library: ['Searching your library…', 'Searched your library'],
    use_skill: ['Reading a skill…', 'Read a skill'],
    run_code: ['Running code…', 'Ran code'], web_search: ['Searching the web…', 'Searched the web']
  };

  window.IlyraExtras = { init: init, showPage: showPage, toolLabels: toolLabels };
})();
