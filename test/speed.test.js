// The speed log: one entry per reply, numbers only, read back by check_speed.
const assert = require('assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const speed = require('../electron/extras/speed');
const tools = require('../electron/extras/tools');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-speed-'));
  speed.init({ dataDir: dir });
  assert.strictEqual(speed.report(), 'No replies have been timed yet.');

  const t = speed.start({ provider: 'local', model: 'qwen', local: true, from: 'phone', thinking: 'medium', voice: false });
  t.stage('memory'); t.stage('connectors');
  t.first('thinking'); t.first('text'); t.first('text');
  t.step({ ms: 21800, calls: 1, tools: 190, connectorTools: 170, systemChars: 9000, toolChars: 120000,
    timing: { loadMs: 12900, promptMs: 4000, writeMs: 8600, promptTokens: 30000, outputTokens: 173, thinkingChars: 670 } });
  t.tool({ name: 'connector', tool: 'mcp_higgsfield_balance', ms: 1500, isError: false });
  t.tool({ name: 'note', summary: 'no ms' });
  const e = t.end({});
  assert.strictEqual(e.steps.length, 1); assert.strictEqual(e.tools.length, 1, 'only timed tools are kept');
  assert.ok(Number.isFinite(e.firstTextMs) && e.firstTextMs >= e.firstThinkingMs);

  const text = speed.report(5);
  for (const bit of ['local model (qwen)', 'from the phone', 'loading the model 13s', 'reading 30000 prompt tokens', '173 tokens', '20 tokens/s', '190 tools offered (170 from connectors)', 'mcp_higgsfield_balance 1.5s']) {
    assert.ok(text.includes(bit), `report mentions "${bit}":\n${text}`);
  }
  const saved = fs.readFileSync(path.join(dir, 'speed.log'), 'utf8');
  assert.ok(!/hello|answer/i.test(saved) && saved.trim().split('\n').length === 1, 'one line of numbers per reply');

  speed.init({ dataDir: dir });
  assert.ok(speed.report().includes('qwen'), 'the log survives a restart');
  for (let i = 0; i < 40; i++) speed.start({ provider: 'claude', model: 'm' }).end({ error: i === 0 });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'speed.log'), 'utf8').trim().split('\n').length, 30, 'only the last 30 are kept');

  // The tool: live state first, then the report.
  const run = tools.runners({ library: null, speed: { report: speed.report, live: async () => 'No model is loaded.' } });
  const out = await run.check_speed({ count: 2 });
  assert.ok(out.output.startsWith('Right now:\nNo model is loaded.') && out.output.includes('The last 2 replies'));
  assert.ok(tools.DEFINITIONS.some((d) => d.name === 'check_speed') && tools.NOTES.check_speed);
  console.log('speed ok');
})().catch((err) => { console.error(err); process.exit(1); });
