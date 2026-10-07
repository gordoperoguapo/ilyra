// Background tasks: hand Ilyra a job, it works on its own and comes back with it done.
//
// - One task runs at a time (one GPU); the rest wait in a queue. Tasks survive a restart: each
//   lives in tasks/<id>/ in the project folder, with task.json (its state), plan.md and
//   progress.md (for people to read) and whatever the task makes.
// - Every task goes plan -> work -> check -> review -> report:
//     plan    the model writes a checklist and what "done" means (task_plan)
//     work    rounds of tool use, ticking steps off (task_check, task_note) until task_done
//     check   the model checks its own result against "done" (task_verify); problems go back to work
//     review  a cloud model (Claude first) reads the result and says PASS or what to fix
//     report  result.md, a chat with the result, and a notification
// - What a task may do without asking is decided when it starts (grants). Anything else is asked
//   in Ilyra, like any reply; with nobody there to answer, it's declined after a while
//   and the task carries on without it.
const fs = require('node:fs');
const path = require('node:path');

const MAX_TASKS_KEPT = 50;
const WORK_ROUNDS = 6;          // rounds of work; each starts fresh from the plan and the log
const STEPS_PER_ROUND = 25;
const FIX_CYCLES = 2;           // times a failed check or review sends the task back to work
const ASK_TIMEOUT_MS = 15 * 60 * 1000;
const LOG_KEEP = 300;
const STATUSES = ['queued', 'planning', 'working', 'checking', 'reviewing', 'done', 'failed', 'stopped'];
const ACTIVE = ['planning', 'working', 'checking', 'reviewing'];

let dir = '';
let host = null;
let running = null;              // { id, controller }
let pumping = false;

const now = () => Date.now();
const newId = () => 'k' + now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const taskDir = (id) => path.join(dir, id);
const jsonFile = (id) => path.join(taskDir(id), 'task.json');

// ---------- Storage ----------

function read(id) {
  if (!/^k[a-z0-9]{4,20}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(jsonFile(id), 'utf8')); } catch { return null; }
}

function write(task) {
  fs.mkdirSync(taskDir(task.id), { recursive: true });
  task.updated = now();
  fs.writeFileSync(jsonFile(task.id), JSON.stringify(task, null, 1));
  fs.writeFileSync(path.join(taskDir(task.id), 'plan.md'), planText(task));
  fs.writeFileSync(path.join(taskDir(task.id), 'progress.md'), `# Progress: ${task.title}\n\n${task.log.map((l) => `- ${new Date(l.at).toLocaleString()} ${l.text}`).join('\n')}\n`);
  if (host && host.changed) host.changed(task.id);
}

function all() {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(read).filter(Boolean).sort((a, b) => b.created - a.created);
}

function planText(task) {
  if (!task.plan) return `# Plan: ${task.title}\n\n(not planned yet)\n`;
  const steps = task.plan.steps.map((s, i) => `- [${s.done ? 'x' : ' '}] ${i + 1}. ${s.text}${s.note ? ` (${s.note})` : ''}`).join('\n');
  return `# Plan: ${task.title}\n\n${steps}\n\n**Done when:** ${task.plan.doneWhen}\n`;
}

function log(task, text) {
  task.log.push({ at: now(), text: clip(String(text).replace(/\s+/g, ' '), 400) });
  if (task.log.length > LOG_KEEP) task.log.splice(0, task.log.length - LOG_KEEP);
}

// ---------- Grants: what a task may do without asking ----------
// files: 'task' (only its own folder), 'read' (also read shared folders), 'write' (also change them)
// web: search and open pages; http: 'off' | 'read' (GET) | 'all'; connectors: use them freely;
// cloud: send questions to cloud models (ask_model) after reading your data; browse: click and type on
// web pages; review: Claude checks the result.
function cleanGrants(g = {}) {
  return {
    files: ['task', 'read', 'write'].includes(g.files) ? g.files : 'task',
    web: g.web !== false,
    http: ['off', 'read', 'all'].includes(g.http) ? g.http : 'off',
    connectors: Boolean(g.connectors),
    cloud: Boolean(g.cloud),
    browse: Boolean(g.browse),
    review: g.review !== false
  };
}

function describeGrants(g) {
  const files = { task: 'only its own folder', read: 'its own folder, and read your shared folders', write: 'its own folder, and read and change your shared folders' }[g.files];
  return [
    `Files: ${files}.`,
    `Web: ${g.web ? 'search and open pages freely' : 'asks first'}.`,
    `Web APIs: ${{ off: 'asks first', read: 'reads (GET) freely, asks before changing anything', all: 'calls freely' }[g.http]}.`,
    `Connectors: ${g.connectors ? 'used freely' : 'asks first'}.`,
    `Clicking and typing on web pages: ${g.browse ? 'freely' : 'asks first'}.`,
    `Cloud models: ${g.cloud ? 'may ask them freely' : 'asks first once your data has been read'}.`,
    `Result checked by a cloud model: ${g.review ? 'yes' : 'no'}.`
  ].join('\n');
}

const within = (parent, child) => { const rel = path.relative(parent, child); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The approval a task's tools get: yes when the grants cover it, else ask in Ilyra.
function confirmFor(task, signal) {
  const g = task.grants;
  const own = taskDir(task.id);
  return async (change) => {
    const k = change.kind || 'edit';
    const p = String(change.path || '');
    let ok = false;
    if (k === 'edit' && (p === own || within(own, p))) ok = true;
    else if (k === 'edit' && g.files === 'write') ok = true;
    else if (k === 'web' && g.web) ok = true;
    else if (k === 'http' && (g.http === 'all' || (g.http === 'read' && change.readOnly))) ok = true;
    else if (k === 'connector' && g.connectors) ok = true;
    else if (k === 'ask' && g.cloud) ok = true;
    else if (k === 'browse' && g.browse) ok = true;
    if (ok) return true;
    if (k === 'memory' || k === 'clipboard-read' || k === 'clipboard-write' || k === 'schedule' || k === 'task') {
      log(task, `declined on its own: ${change.title} (background tasks don't do that)`);
      return false;
    }
    log(task, `waiting for your OK: ${change.title}`);
    task.waiting = clip(change.title, 120);
    write(task);
    const ask = host.confirm({ signal: AbortSignal.any([signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]), rid: task.id, title: task.title });
    let answer = false;
    try { answer = await ask(Object.assign({}, change, { title: `${task.title}: ${change.title}` })); } catch { answer = false; }
    task.waiting = null;
    log(task, answer ? `you allowed: ${change.title}` : `not allowed (declined or no answer): ${change.title}`);
    write(task);
    return Boolean(answer);
  };
}

// ---------- The task's own tools ----------

const str = (description) => ({ type: 'string', description });
const DEFINITIONS = [
  {
    name: 'task_plan',
    description: 'Background tasks only: set the plan. A short checklist of concrete steps in order, and what "done" means, checkable (a file that exists with what in it, a list with N entries, a question answered with sources).',
    parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' }, description: '3 to 12 concrete steps' }, done_when: str('How to tell the task is finished, in one or two checkable sentences') }, required: ['steps', 'done_when'] }
  },
  {
    name: 'task_check',
    description: 'Background tasks only: mark a plan step done (or not) once you have actually done it, with a short note of what you found or made.',
    parameters: { type: 'object', properties: { step: { type: 'integer', description: 'Step number, from 1' }, done: { type: 'boolean', description: 'true when finished' }, note: str('What was done or found, briefly') }, required: ['step'] }
  },
  {
    name: 'task_note',
    description: 'Background tasks only: write a line to the progress log (a finding, a decision, a problem). The next round of work starts from the plan and this log, so put anything you will need there.',
    parameters: { type: 'object', properties: { text: str('One or two sentences') }, required: ['text'] }
  },
  {
    name: 'task_done',
    description: 'Background tasks only: the work is finished. Give the result for the user: what was done, the answer itself if the task asked a question, and the files made (paths inside the task folder).',
    parameters: { type: 'object', properties: { summary: str('The result, written for the user. Include the actual answer, not just "see the file".'), files: { type: 'array', items: { type: 'string' }, description: 'Files made or changed' } }, required: ['summary'] }
  },
  {
    name: 'task_verify',
    description: 'Background tasks only, when checking: say whether the result really meets "done when", after looking (read the files back, count, test).',
    parameters: { type: 'object', properties: { ok: { type: 'boolean', description: 'true only if every part of "done when" is met' }, problems: str('What is missing or wrong, if anything') }, required: ['ok'] }
  },
  {
    name: 'start_task',
    description: 'Hand the user a job to do in the background: research, writing files, going through leads or documents, anything with several steps. It runs on its own (the user can close the chat), and the result comes back as a notification and a chat. Use it when the user asks for a task to be done, "work on", "go do", "in the background", or for anything too long for one reply.',
    parameters: {
      type: 'object',
      properties: {
        title: str('Short name, like "Weekly news summary"'),
        task: str('The whole job, with everything the user said it needs (the task cannot see this chat)'),
        files: str('task (only its own folder, the default), read (also read shared folders) or write (also change them)'),
        web: { type: 'boolean', description: 'May search and open web pages without asking (default true)' },
        http: str('Web APIs without asking: off (default), read or all'),
        connectors: { type: 'boolean', description: 'May use connectors without asking (default false)' },
        browse: { type: 'boolean', description: 'May click and type on web pages without asking (default false)' }
      },
      required: ['title', 'task']
    }
  },
  {
    name: 'check_tasks',
    description: 'See the background tasks: which are queued, running, done or failed, and their results.',
    parameters: { type: 'object', properties: { id: str('A task id, for its full result') } }
  }
];

// Offered in task runs only, and start_task / check_tasks in chats (see gateFor).
const TASK_ONLY = ['task_plan', 'task_check', 'task_note', 'task_done', 'task_verify'];

function gateFor({ inTask, phase }) {
  const g = {};
  for (const n of TASK_ONLY) g[n] = false;
  g.start_task = !inTask;
  g.check_tasks = !inTask;
  if (inTask) {
    if (phase === 'planning') g.task_plan = true;
    if (phase === 'working') { g.task_check = true; g.task_note = true; g.task_done = true; g.task_plan = true; }
    if (phase === 'checking') { g.task_note = true; g.task_verify = true; }
  }
  return g;
}

const RUNNERS = {
  async task_plan({ steps, done_when }, ctx) {
    const t = ctx.task && ctx.task.record;
    if (!t) throw new Error('Only a background task can do that.');
    const list = (Array.isArray(steps) ? steps : String(steps || '').split('\n')).map((s) => clip(String(s).replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim(), 300)).filter(Boolean).slice(0, 15);
    if (!list.length) throw new Error('Give at least one step.');
    const before = t.plan ? t.plan.steps : [];
    t.plan = { steps: list.map((text) => ({ text, done: Boolean((before.find((b) => b.text === text) || {}).done), note: '' })), doneWhen: clip(done_when || 'Every step is done.', 600) };
    log(t, `plan: ${list.length} steps`);
    write(t);
    return { summary: `planned ${list.length} steps`, output: `Plan saved:\n${planText(t)}` };
  },
  async task_check({ step, done, note }, ctx) {
    const t = ctx.task && ctx.task.record;
    if (!t || !t.plan) throw new Error('Make the plan first with task_plan.');
    const s = t.plan.steps[Number(step) - 1];
    if (!s) throw new Error(`There is no step ${step}; the plan has ${t.plan.steps.length}.`);
    s.done = done !== false;
    if (note) s.note = clip(note, 300);
    log(t, `step ${step} ${s.done ? 'done' : 'not done'}${note ? `: ${note}` : ''}`);
    write(t);
    const left = t.plan.steps.filter((x) => !x.done).length;
    return { summary: `step ${step} ${s.done ? 'done' : 'reopened'}`, output: left ? `${left} step${left === 1 ? '' : 's'} left.` : 'Every step is checked. If the result meets "done when", call task_done.' };
  },
  async task_note({ text }, ctx) {
    const t = ctx.task && ctx.task.record;
    if (!t) throw new Error('Only a background task can do that.');
    log(t, text);
    write(t);
    return { summary: 'noted', output: 'Noted in the progress log.' };
  },
  async task_done({ summary, files }, ctx) {
    const t = ctx.task && ctx.task.record;
    if (!t) throw new Error('Only a background task can do that.');
    const left = t.plan ? t.plan.steps.filter((x) => !x.done) : [];
    if (left.length) throw new Error(`Not every step is checked yet: ${left.map((x) => `"${x.text}"`).join(', ')}. Do them (and task_check each), or change the plan with task_plan if they no longer apply.`);
    t.result = { summary: clip(summary, 6000), files: (Array.isArray(files) ? files : []).map((f) => clip(f, 300)).slice(0, 30) };
    ctx.task.finished = true;
    log(t, 'work finished; checking the result');
    write(t);
    return { summary: 'finished the work', output: 'Recorded. Stop here: the result is checked next.' };
  },
  async task_verify({ ok, problems }, ctx) {
    const t = ctx.task && ctx.task.record;
    if (!t) throw new Error('Only a background task can do that.');
    ctx.task.verdict = { ok: ok === true, problems: clip(problems, 2000) };
    log(t, ok === true ? 'check: the result meets "done when"' : `check found problems: ${problems || '(none given)'}`);
    write(t);
    return { summary: ok === true ? 'checked: done' : 'checked: needs more work', output: 'Recorded. Stop here.' };
  },
  async start_task(args, ctx) {
    const title = clip(String(args.title || '').trim(), 80);
    const prompt = clip(String(args.task || '').trim(), 8000);
    if (!title || !prompt) throw new Error('A task needs a title and the job itself.');
    const grants = cleanGrants({ files: args.files, web: args.web, http: args.http, connectors: args.connectors, browse: args.browse, cloud: false });
    const ok = await ctx.confirm({ kind: 'task', title: 'Ilyra wants to start a background task', path: title, detail: `${prompt}\n\nWhat it may do without asking:\n${describeGrants(grants)}` });
    if (!ok) throw new Error('The user declined to start that task.');
    const t = start({ title, prompt, grants, from: 'chat' });
    return { summary: `started the task "${title}"`, output: `Started background task ${t.id}, "${title}". ${running && running.id !== t.id ? 'It is queued behind the one running now.' : 'It is running now.'} The user gets a notification and a chat with the result when it's done; they can follow it in Tasks.` };
  },
  async check_tasks({ id }) {
    if (id) {
      const t = read(id);
      if (!t) throw new Error(`No task ${id}.`);
      return { summary: `read task "${t.title}"`, output: brief(t, true) };
    }
    const list = all().slice(0, 10);
    return { summary: 'checked the background tasks', output: list.length ? list.map((t) => brief(t, false)).join('\n\n') : 'No background tasks yet.' };
  }
};

function brief(t, full) {
  const steps = t.plan ? `${t.plan.steps.filter((s) => s.done).length}/${t.plan.steps.length} steps` : 'not planned';
  const head = `${t.id} "${t.title}": ${t.status}${t.waiting ? ` (waiting for: ${t.waiting})` : ''}, ${steps}`;
  if (!full) return t.result ? `${head}\nResult: ${clip(t.result.summary, 400)}` : head;
  return [head, `Task: ${t.prompt}`, planText(t), t.result ? `Result:\n${t.result.summary}` : '', t.review ? `Review: ${t.review.verdict}${t.review.notes ? `\n${t.review.notes}` : ''}` : '', t.error ? `Error: ${t.error}` : '', `Folder: ${taskDir(t.id)}`].filter(Boolean).join('\n\n');
}

// ---------- Running ----------

const SYSTEM = (t, phase) => [
  `You are working on a background task on your own: the user is not watching and cannot answer questions mid-task. Make sensible choices, note them with task_note, and keep going.`,
  `The task's folder is ${taskDir(t.id)}. Save everything you make there (write_file with a full path inside it), never elsewhere unless the task says so.`,
  `What you may do without asking:\n${describeGrants(t.grants)}\nAnything else is asked of the user and may be declined; if so, work around it.`,
  {
    planning: 'Now: plan only. Call task_plan once with 3 to 12 concrete steps and a checkable "done when". Don\'t start the work yet.',
    working: 'Now: work. Take the next unchecked step, do it with your tools, then task_check it with a note of what you found or made. Write findings to files in the task folder as you go rather than holding them in your head. Only when every step is checked and the result meets "done when", call task_done with the result written for the user. If the plan turns out wrong, fix it with task_plan.',
    checking: 'Now: check the result, don\'t redo the work. Look at it for real: read the files back, count entries, compare against "done when". Then call task_verify, ok true only if every part is met, else say exactly what is missing.'
  }[phase]
].join('\n\n');

function context(t, extra) {
  const recent = t.log.slice(-40).map((l) => `- ${l.text}`).join('\n');
  return [
    `Task: ${t.title}\n\n${t.prompt}`,
    t.plan ? planText(t) : '',
    recent ? `Progress log so far (latest last):\n${recent}` : '',
    extra || ''
  ].filter(Boolean).join('\n\n');
}

async function round(t, phase, message, controller, maxSteps) {
  const state = { record: t, finished: false, verdict: null };
  const worker = host.pick();
  if (!worker) throw new Error('No AI is connected. Connect one in Settings, AI models.');
  t.model = `${worker.name} (${worker.model})`;
  await host.prepare(worker, controller.signal);
  const roots = [taskDir(t.id)].concat(t.grants.files === 'task' ? [] : host.roots());
  await host.runAgent(Object.assign(await host.base(worker, controller.signal), {
    id: worker.id, key: worker.key, model: worker.model,
    messages: [{ role: 'user', content: message }],
    roots, confirm: confirmFor(t, controller.signal), signal: controller.signal,
    useTools: true, allTools: true, maxSteps, thinking: t.thinking || 'low', retries: 1,
    extraSystem: SYSTEM(t, phase), task: state,
    connectors: await host.connectors(),
    extras: host.extras(gateFor({ inTask: true, phase })),
    onTool: (x) => { if (x && x.summary && !/^task_/.test(x.tool || '')) { log(t, x.summary); write(t); } }
  }));
  return state;
}

async function review(t, signal) {
  const who = host.reviewer();
  if (!who || !t.grants.review) return null;
  t.status = 'reviewing'; log(t, `asking ${who.name} to check the result`); write(t);
  const files = [];
  let budget = 30000;
  for (const f of (t.result && t.result.files) || []) {
    const real = path.isAbsolute(f) ? f : path.join(taskDir(t.id), f);
    if (!(real === taskDir(t.id) || within(taskDir(t.id), real))) continue;
    try { const text = fs.readFileSync(real, 'utf8').slice(0, budget); budget -= text.length; files.push(`--- ${path.basename(real)} ---\n${text}`); } catch { /* not readable */ }
    if (budget <= 0) break;
  }
  const question = `A local AI model did this task on its own. Check its result.\n\nTask: ${t.prompt}\n\n${planText(t)}\nIts result:\n${t.result ? t.result.summary : '(none)'}\n\n${files.join('\n\n')}\n\nDoes the result do what the task asked, correctly and completely? Reply with "VERDICT: PASS" or "VERDICT: FIX" on the first line, then at most 6 short lines: for FIX, exactly what to fix; for PASS, anything the user should know.`;
  const text = await host.runAgent({ id: who.id, key: who.key, model: who.model, messages: [{ role: 'user', content: question }], roots: [], confirm: async () => false, useTools: false, thinking: 'low', retries: 1, timeout: 120000, signal, systemOverride: 'You review work done by another AI model. Be specific and brief.' });
  const pass = /VERDICT:\s*PASS/i.test(text);
  const notes = clip(String(text).replace(/^.*VERDICT:\s*(PASS|FIX)\s*/i, '').trim(), 2000);
  log(t, `${who.name} review: ${pass ? 'passed' : 'asked for fixes'}`);
  return { by: who.name, verdict: pass ? 'passed' : 'needs fixes', notes, pass };
}

async function runTask(t, controller) {
  const signal = controller.signal;
  t.started = t.started || now();
  t.error = null;
  if (!t.plan) {
    t.status = 'planning'; log(t, 'planning'); write(t);
    await round(t, 'planning', context(t, 'Plan this task now with task_plan.'), controller, 6);
    if (!t.plan) { t.plan = { steps: [{ text: t.title, done: false, note: '' }], doneWhen: 'The task is done as asked.' }; log(t, 'no plan given; working from the task itself'); }
  }
  let problems = '';
  for (let cycle = 0; cycle <= FIX_CYCLES; cycle++) {
    // Work rounds until task_done.
    let finished = false;
    for (let r = 0; r < WORK_ROUNDS && !finished; r++) {
      if (signal.aborted) return;
      t.status = 'working'; t.round = (t.round || 0) + 1; write(t);
      const extra = problems ? `The last check found problems to fix first:\n${problems}` : (r ? 'Continue from where the log leaves off.' : 'Start with step 1.');
      const st = await round(t, 'working', context(t, extra), controller, STEPS_PER_ROUND);
      finished = st.finished;
    }
    if (!finished) throw new Error(`It didn't finish within ${WORK_ROUNDS} rounds of work. The plan and progress so far are in the task folder.`);
    // Check its own result.
    t.status = 'checking'; write(t);
    const st = await round(t, 'checking', context(t, `The work was reported finished:\n${t.result.summary}\n\nFiles: ${(t.result.files || []).join(', ') || 'none listed'}\n\nCheck it now.`), controller, 15);
    const verdict = st.verdict || { ok: true, problems: '' };
    if (!verdict.ok && cycle < FIX_CYCLES) { problems = verdict.problems || 'The check said it is not done.'; log(t, 'back to work to fix what the check found'); continue; }
    // A cloud model's look at it.
    let rv = null;
    try { rv = await review(t, signal); } catch (err) { log(t, `review skipped: ${(err && err.message) || err}`); }
    if (rv) { t.review = { by: rv.by, verdict: rv.verdict, notes: rv.notes }; write(t); }
    if (rv && !rv.pass && cycle < FIX_CYCLES) { problems = `${rv.by} reviewed it and asked for fixes:\n${rv.notes}`; continue; }
    return;
  }
}


function report(t) {
  const lines = [`# ${t.title}`, '', t.status === 'done' ? (t.result ? t.result.summary : 'Done.') : `This task ${t.status === 'stopped' ? 'was stopped' : `failed: ${t.error}`}.`];
  if (t.result && t.result.files && t.result.files.length) lines.push('', 'Files:', ...t.result.files.map((f) => `- ${f}`));
  if (t.review) lines.push('', `Checked by ${t.review.by}: ${t.review.verdict}.${t.review.notes ? `\n${t.review.notes}` : ''}`);
  lines.push('', `Folder: ${taskDir(t.id)}`);
  const text = lines.join('\n');
  try { fs.writeFileSync(path.join(taskDir(t.id), 'result.md'), text + '\n'); } catch { /* the folder went away */ }
  return text;
}

async function pump() {
  if (pumping || running || !host) return;
  pumping = true;
  try {
    for (;;) {
      const next = all().filter((t) => t.status === 'queued').sort((a, b) => a.created - b.created)[0];
      if (!next) return;
      const controller = new AbortController();
      running = { id: next.id, controller };
      const t = next;
      try {
        await runTask(t, controller);
        if (controller.signal.aborted) { t.status = 'stopped'; log(t, 'stopped'); }
        else { t.status = 'done'; log(t, 'done'); }
      } catch (err) {
        if (controller.signal.aborted || (err && err.aborted)) { t.status = 'stopped'; log(t, 'stopped'); } else {
          t.status = 'failed';
          t.error = clip((err && err.message) || err, 500);
          log(t, `failed: ${t.error}`);
        }
      }
      t.finished = now();
      t.waiting = null;
      write(t);
      const text = report(t);
      try {
        const chatId = host.saveChat({ title: `Task: ${t.title}`, prompt: t.prompt, text });
        t.chatId = chatId; write(t);
        host.notify(t.status === 'done' ? `Done: ${t.title}` : `Task ${t.status}: ${t.title}`, t.status === 'done' && t.result ? t.result.summary : (t.error || t.status), chatId);
      } catch { /* the result is still in the folder */ }
      running = null;
      prune();
    }
  } finally {
    pumping = false;
    running = null;
  }
}

function prune() {
  const done = all().filter((t) => !ACTIVE.includes(t.status) && t.status !== 'queued');
  for (const t of done.slice(MAX_TASKS_KEPT)) { try { fs.rmSync(taskDir(t.id), { recursive: true, force: true }); } catch { /* keep it */ } }
}

// ---------- The outside ----------

// host: { pick, reviewer, prepare, base, connectors, extras, runAgent, confirm, roots, notify, saveChat, changed }
function init(opts) {
  dir = opts.dir;
  host = opts.host || null;
  fs.mkdirSync(dir, { recursive: true });
  // Tasks cut off by a restart carry on from their plan and log.
  for (const t of all()) if (ACTIVE.includes(t.status)) { t.status = 'queued'; log(t, 'Ilyra restarted; picking up where it left off'); write(t); }
  setTimeout(pump, 3000);
}

function start({ title, prompt, grants, from = 'app', thinking }) {
  const t = {
    id: newId(), title: clip(String(title || '').trim() || 'Task', 80), prompt: clip(String(prompt || '').trim(), 8000),
    status: 'queued', created: now(), grants: cleanGrants(grants || {}), from, thinking: ['off', 'low', 'medium', 'high'].includes(thinking) ? thinking : 'low',
    plan: null, result: null, review: null, log: [], round: 0
  };
  if (!t.prompt) throw new Error('Say what the task should do.');
  log(t, `queued (from the ${from})`);
  write(t);
  setTimeout(pump, 0);
  return t;
}

function stop(id) {
  if (running && running.id === id) { running.controller.abort(); return true; }
  const t = read(id);
  if (t && t.status === 'queued') { t.status = 'stopped'; log(t, 'stopped before it started'); write(t); return true; }
  return false;
}

function remove(id) {
  if (running && running.id === id) return false;
  const t = read(id);
  if (!t) return false;
  fs.rmSync(taskDir(id), { recursive: true, force: true });
  if (host && host.changed) host.changed(id);
  return true;
}

// Runs a stopped or failed task again, from its plan and log.
function retry(id) {
  const t = read(id);
  if (!t || !['failed', 'stopped'].includes(t.status)) return null;
  t.status = 'queued'; t.error = null; log(t, 'queued again'); write(t);
  setTimeout(pump, 0);
  return t;
}

// For the Tasks screens.
function list() {
  return all().map((t) => ({ id: t.id, title: t.title, status: t.status, created: t.created, updated: t.updated, finished: t.finished || null, waiting: t.waiting || null, steps: t.plan ? t.plan.steps.length : 0, stepsDone: t.plan ? t.plan.steps.filter((s) => s.done).length : 0, summary: t.result ? clip(t.result.summary, 200) : '', error: t.error || '', review: t.review ? t.review.verdict : '' }));
}
function get(id) {
  const t = read(id);
  if (!t) return null;
  let files = [];
  try { files = fs.readdirSync(taskDir(id)).filter((f) => !['task.json'].includes(f)); } catch { files = []; }
  return Object.assign({}, t, { folder: taskDir(id), files, grantsText: describeGrants(t.grants), log: t.log.slice(-100) });
}

const folderOf = (id) => (read(id) ? taskDir(id) : null);

module.exports = { init, start, stop, remove, retry, list, get, folderOf, DEFINITIONS, RUNNERS, TASK_ONLY, gateFor, cleanGrants, describeGrants, confirmFor, STATUSES, _pump: pump };
