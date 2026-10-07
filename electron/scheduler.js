// Reminders and recurring briefings. Tasks live encrypted on disk; main.js asks
// due() every few seconds and runs whatever is ready. Pure logic lives here so
// it can be tested without Electron.
const store = require('./store');

const MAX_TASKS = 20;
const CATCH_UP_MS = 12 * 60 * 60 * 1000; // a task missed while Ilyra was closed still runs if under 12 hours late
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDay(d) {
  if (typeof d === 'number' && d >= 0 && d <= 6) return d;
  const k = String(d || '').slice(0, 3).toLowerCase();
  return k in DAYS ? DAYS[k] : null;
}

function nextOccurrence(spec, after) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.time || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= after) continue;
    const dow = d.getDay();
    if (spec.repeat === 'daily' || (spec.repeat === 'weekdays' && dow >= 1 && dow <= 5) || (spec.repeat === 'weekly' && dow === spec.day)) return d.getTime();
  }
  return null;
}

// spec: { title, prompt?, when? (local date-time text), repeat?, time?, day?, background? }
function add(spec, now = Date.now()) {
  const list = store.tasks.list();
  if (list.length >= MAX_TASKS) throw new Error(`There are already ${MAX_TASKS} scheduled tasks. Cancel one first.`);
  const title = String(spec.title || '').trim().slice(0, 80);
  if (!title) throw new Error('A scheduled task needs a title.');
  const task = { id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 5), title, prompt: spec.prompt ? String(spec.prompt).slice(0, 1000) : null, createdAt: now };
  // Run the prompt as a background task (extras/tasks.js) instead of one reply.
  if (spec.background && task.prompt) task.background = true;
  if (spec.repeat) {
    if (!['daily', 'weekdays', 'weekly'].includes(spec.repeat)) throw new Error('repeat must be daily, weekdays or weekly.');
    task.repeat = spec.repeat;
    task.time = String(spec.time || '');
    if (spec.repeat === 'weekly') {
      task.day = parseDay(spec.day);
      if (task.day === null) throw new Error('A weekly task needs a day (mon to sun).');
    }
    task.nextRun = nextOccurrence(task, now);
    if (!task.nextRun) throw new Error('time must look like 08:30 (24-hour).');
  } else {
    const at = new Date(String(spec.when || '')).getTime();
    if (!Number.isFinite(at)) throw new Error('when must be a local date and time like 2026-10-01T15:30.');
    if (at <= now) throw new Error('That time has already passed.');
    task.nextRun = at;
  }
  list.push(task);
  store.tasks.save(list);
  return task;
}

const list = () => store.tasks.list().sort((a, b) => a.nextRun - b.nextRun);

function remove(id) {
  const all = store.tasks.list();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  store.tasks.save(next);
  return true;
}

// Tasks ready to run. Ones more than 12 hours late are skipped (repeating ones move on).
function due(now = Date.now()) {
  const all = store.tasks.list();
  const ready = [];
  const keep = [];
  let changed = false;
  for (const t of all) {
    if (t.nextRun > now) { keep.push(t); continue; }
    changed = true;
    if (now - t.nextRun <= CATCH_UP_MS) ready.push(Object.assign({}, t));
    if (t.repeat) {
      const next = nextOccurrence(t, now);
      if (next) keep.push(Object.assign({}, t, { nextRun: next, lastRun: now }));
    }
  }
  if (changed) store.tasks.save(keep);
  return ready;
}

module.exports = { add, list, remove, due, nextOccurrence, MAX_TASKS, CATCH_UP_MS };
