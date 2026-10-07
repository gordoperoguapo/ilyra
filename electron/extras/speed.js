// The speed log: how long each step of a reply took, so Ilyra can say why it was slow (the
// check_speed tool). Only numbers and names are kept (which model, which tool, how many ms and
// tokens), never what was asked or answered. The last replies sit in memory and in speed.log in
// Ilyra's data folder, one line each, so they survive a restart.
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 30;
let file = '';
let recent = null;

function init({ dataDir }) { file = dataDir ? path.join(dataDir, 'speed.log') : ''; recent = null; }

function load() {
  if (recent) return recent;
  recent = [];
  try {
    recent = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-KEEP).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no log yet */ }
  return recent;
}

function save(entry) {
  load().push(entry);
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, recent.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch { /* diagnostics only */ }
}

// One reply. info: { provider, model, local, from, thinking, voice }
function start(info) {
  const t0 = Date.now();
  let last = t0;
  const entry = Object.assign({ at: new Date(t0).toISOString(), stages: [], steps: [], tools: [] }, info);
  return {
    // A setup stage finished (memory, location, connectors, lookups...): the time since the last one.
    stage(name) { const now = Date.now(); entry.stages.push({ name, ms: now - last }); last = now; },
    // The first thinking or reply text to arrive, counted from the start.
    first(kind) { const k = kind === 'text' ? 'firstTextMs' : 'firstThinkingMs'; if (entry[k] === undefined) entry[k] = Date.now() - t0; },
    step(s) {
      const t = s.timing || {};
      entry.steps.push({ ms: s.ms, calls: s.calls, tools: s.tools, connectorTools: s.connectorTools, systemChars: s.systemChars, toolChars: s.toolChars,
        loadMs: t.loadMs, promptMs: t.promptMs, writeMs: t.writeMs, promptTokens: t.promptTokens, outputTokens: t.outputTokens, thinkingChars: t.thinkingChars });
    },
    tool(t) { if (Number.isFinite(t.ms)) entry.tools.push({ name: String(t.tool || t.name).slice(0, 80), ms: t.ms, failed: Boolean(t.isError) }); },
    end({ error, cancelled } = {}) {
      entry.totalMs = Date.now() - t0;
      if (error) entry.failed = true;
      if (cancelled) entry.stopped = true;
      save(entry);
      return entry;
    }
  };
}

const round = (ms) => (ms >= 10000 ? `${Math.round(ms / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms || 0)}ms`);

// One reply as a few readable lines, biggest costs named.
function describe(e) {
  const head = `${e.at.slice(11, 16)} UTC, ${e.local ? 'local model' : e.provider} (${e.model}), from the ${e.from || 'PC'}${e.voice ? ', talk mode' : ''}, thinking ${e.thinking || 'medium'}: ${round(e.totalMs)} total${e.failed ? ' (failed)' : ''}${e.stopped ? ' (stopped)' : ''}`;
  const lines = [head];
  const setup = e.stages.filter((s) => s.ms >= 50).map((s) => `${s.name} ${round(s.ms)}`);
  if (setup.length) lines.push(`  before the model: ${setup.join(', ')}`);
  if (e.firstThinkingMs !== undefined || e.firstTextMs !== undefined) {
    lines.push(`  first thinking at ${e.firstThinkingMs === undefined ? '-' : round(e.firstThinkingMs)}, first words of the reply at ${e.firstTextMs === undefined ? '-' : round(e.firstTextMs)}`);
  }
  e.steps.forEach((s, i) => {
    const parts = [`model step ${i + 1}: ${round(s.ms)}`];
    if (s.loadMs >= 500) parts.push(`loading the model ${round(s.loadMs)}`);
    if (s.promptTokens) parts.push(`reading ${s.promptTokens} prompt tokens ${round(s.promptMs)}`);
    if (s.outputTokens) parts.push(`writing ${s.outputTokens} tokens ${round(s.writeMs)}${s.writeMs ? ` (${Math.round(s.outputTokens / (s.writeMs / 1000))} tokens/s)` : ''}`);
    if (s.thinkingChars) parts.push(`of which thinking ~${Math.round(s.thinkingChars / 4)} tokens`);
    parts.push(`${s.tools} tools offered${s.connectorTools ? ` (${s.connectorTools} from connectors)` : ''}, prompt ${Math.round((s.systemChars + s.toolChars) / 1000)}k characters (tools ${Math.round(s.toolChars / 1000)}k)`);
    if (s.calls) parts.push(`asked for ${s.calls} tool call${s.calls === 1 ? '' : 's'}`);
    lines.push(`  ${parts.join('; ')}`);
  });
  if (e.tools.length) lines.push(`  tools: ${e.tools.map((t) => `${t.name} ${round(t.ms)}${t.failed ? ' (failed)' : ''}`).join(', ')}`);
  return lines.join('\n');
}

function report(count = 5) {
  const list = load().slice(-Math.max(1, Math.min(count, KEEP)));
  if (!list.length) return 'No replies have been timed yet.';
  const avg = Math.round(list.reduce((n, e) => n + e.totalMs, 0) / list.length);
  return `The last ${list.length} repl${list.length === 1 ? 'y' : 'ies'}, oldest first (average ${round(avg)}):\n\n${list.map(describe).join('\n\n')}`;
}

module.exports = { init, start, report, describe };
