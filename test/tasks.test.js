// Background tasks: plan -> work -> check -> review -> report, with a scripted stand-in for the model.
const assert = require('assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tasks = require('../electron/extras/tasks');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); } throw new Error('timed out'); }

function phaseOf(opts) {
  const g = opts.extras.gate;
  if (g.task_verify) return 'checking';
  if (g.task_done) return 'working';
  if (g.task_plan) return 'planning';
  return '?';
}
const call = (name, args, opts) => tasks.RUNNERS[name](args, { task: opts.task, confirm: opts.confirm });

function makeHost(script, extra = {}) {
  const seen = { notified: [], chats: [], asked: [], phases: [], reviews: 0 };
  const host = Object.assign({
    pick: () => ({ id: 'local', key: 'x', model: 'qwen', name: 'Ilyra', local: true }),
    reviewer: () => ({ id: 'claude', key: 'k', model: 'opus', name: 'Claude' }),
    prepare: async () => {},
    base: async () => ({}),
    connectors: async () => null,
    roots: () => [],
    extras: (gate) => ({ gate, prompt: () => '' }),
    confirm: () => async (change) => { seen.asked.push(change.title); return false; },
    notify: (title, body) => seen.notified.push({ title, body }),
    saveChat: (c) => { seen.chats.push(c); return 'w1'; },
    changed: () => {},
    runAgent: async (opts) => {
      if (opts.systemOverride) { seen.reviews++; return script.review ? script.review(seen.reviews) : 'VERDICT: PASS\nLooks right.'; }
      const phase = phaseOf(opts);
      seen.phases.push(phase);
      await script[phase](opts, seen);
      return '';
    }
  }, extra);
  return { host, seen };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-tasks-'));

  // ---- 1. A task from start to finish ----
  let workRounds = 0;
  const { host, seen } = makeHost({
    planning: (o) => call('task_plan', { steps: ['1. Find the leads', 'Write the call list'], done_when: 'calls.md lists 3 leads' }, o),
    working: async (o) => {
      workRounds++;
      if (workRounds === 1) { await call('task_check', { step: 1, note: 'found 3' }, o); return; } // round ends without finishing
      // Writing inside its own folder needs no OK; outside it asks (and is declined here).
      assert.strictEqual(await o.confirm({ kind: 'edit', path: path.join(o.roots[0], 'calls.md'), title: 'create' }), true);
      assert.strictEqual(await o.confirm({ kind: 'edit', path: path.join(dir, '..', 'elsewhere.md'), title: 'write elsewhere' }), false);
      fs.writeFileSync(path.join(o.roots[0], 'calls.md'), '- A\n- B\n- C\n');
      await assert.rejects(call('task_done', { summary: 'too early' }, o), /Not every step/);
      await call('task_check', { step: 2, done: true }, o);
      await call('task_done', { summary: 'Call list of 3 leads is in calls.md.', files: ['calls.md'] }, o);
    },
    checking: (o) => call('task_verify', { ok: true }, o)
  });
  tasks.init({ dir, host });
  const t = tasks.start({ title: 'News summary', prompt: 'Summarise the tech news', grants: { files: 'task' } });
  const done = await until(() => { const x = tasks.get(t.id); return x && ['done', 'failed'].includes(x.status) && x; });
  assert.strictEqual(done.status, 'done', done.error);
  assert.deepStrictEqual(seen.phases, ['planning', 'working', 'working', 'checking']);
  assert.ok(done.plan.steps.every((s) => s.done));
  assert.strictEqual(done.review.verdict, 'passed');
  assert.deepStrictEqual(seen.asked, ['News summary: write elsewhere'], 'only the write outside its folder was asked');
  for (const f of ['plan.md', 'progress.md', 'result.md', 'calls.md']) assert.ok(fs.existsSync(path.join(dir, t.id, f)), f);
  assert.ok(fs.readFileSync(path.join(dir, t.id, 'plan.md'), 'utf8').includes('- [x] 2. Write the call list'));
  assert.ok(fs.readFileSync(path.join(dir, t.id, 'result.md'), 'utf8').includes('Checked by Claude: passed'));
  assert.strictEqual(seen.chats.length, 1); assert.ok(seen.notified[0].title.startsWith('Done: News summary'));
  assert.strictEqual(tasks.list()[0].stepsDone, 2);

  // ---- 2. A failed check and a review asking for fixes send it back to work ----
  let checks = 0;
  const two = makeHost({
    planning: (o) => call('task_plan', { steps: ['Do it'], done_when: 'done' }, o),
    working: async (o) => { await call('task_check', { step: 1 }, o); await call('task_done', { summary: 'ok' }, o); },
    checking: (o) => call('task_verify', ++checks === 1 ? { ok: false, problems: 'missing a row' } : { ok: true }, o),
    review: (n) => (n === 1 ? 'VERDICT: FIX\nAdd the links.' : 'VERDICT: PASS')
  });
  tasks.init({ dir, host: two.host });
  const t2 = tasks.start({ title: 'Fix me', prompt: 'x' });
  const d2 = await until(() => { const x = tasks.get(t2.id); return x && ['done', 'failed'].includes(x.status) && x; });
  assert.strictEqual(d2.status, 'done');
  assert.deepStrictEqual(two.seen.phases, ['planning', 'working', 'checking', 'working', 'checking', 'working', 'checking']);
  assert.ok(d2.log.some((l) => /missing a row/.test(l.text)) && d2.log.some((l) => /asked for fixes/.test(l.text)));

  // ---- 3. Grants ----
  const rec = { id: t.id, title: 'g', grants: tasks.cleanGrants({ files: 'task', web: true, http: 'read' }), log: [], plan: null };
  const yes = tasks.confirmFor(rec, new AbortController().signal);
  tasks.init({ dir, host: makeHost({}).host });
  assert.strictEqual(await yes({ kind: 'web', title: 'w' }), true);
  assert.strictEqual(await yes({ kind: 'http', readOnly: true, title: 'get' }), true);
  assert.strictEqual(await yes({ kind: 'http', readOnly: false, title: 'post' }), false, 'a POST is asked (and declined here)');
  assert.strictEqual(await yes({ kind: 'memory', title: 'remember' }), false, 'tasks never save memories');
  assert.strictEqual(await yes({ kind: 'connector', title: 'c' }), false);
  assert.strictEqual(await yes({ kind: 'browse', title: 'click' }), false, 'clicking on pages is asked unless granted');
  assert.deepStrictEqual(tasks.cleanGrants({ files: 'everything', http: 'yes' }), { files: 'task', web: true, http: 'off', connectors: false, cloud: false, browse: false, review: true });

  // ---- 4. Stop, restart and gates ----
  let release;
  const slow = makeHost({ planning: () => new Promise((r) => { release = r; }) });
  tasks.init({ dir, host: slow.host });
  const t4 = tasks.start({ title: 'Slow', prompt: 'x' });
  await until(() => release);
  assert.strictEqual(tasks.get(t4.id).status, 'planning');
  // As if Ilyra quit mid-task: the next start queues it again.
  tasks.init({ dir, host: makeHost({ planning: () => new Promise(() => {}) }).host });
  assert.ok(['queued', 'planning'].includes(tasks.get(t4.id).status));
  assert.ok(tasks.get(t4.id).log.some((l) => /restarted/.test(l.text)));
  assert.strictEqual(tasks.gateFor({ inTask: false }).start_task, true);
  assert.strictEqual(tasks.gateFor({ inTask: false }).task_done, false);
  assert.strictEqual(tasks.gateFor({ inTask: true, phase: 'checking' }).task_done, false);
  assert.strictEqual(tasks.gateFor({ inTask: true, phase: 'checking' }).task_verify, true);
  console.log('tasks ok');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
