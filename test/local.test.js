// Run with: node test/local.test.js  (local model servers: Ollama and OpenAI-compatible)
const assert = require('node:assert');
const http = require('node:http');
const local = require('../electron/local');

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

// A fake model server. routes: { 'GET /path': (body) => response } where a response is
// { status, json } or { stream: [lines] }. Every request body is kept in `seen`.
function fakeServer(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ route: `${req.method} ${req.url}`, body });
      const handler = routes[`${req.method} ${req.url}`];
      const out = handler ? handler(body, seen) : { status: 404, json: { error: 'not found' } };
      if (out.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const line of out.stream) res.write(`${line}\n`);
        return res.end();
      }
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, address: `http://127.0.0.1:${server.address().port}` })));
}

const TOOL = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const collect = () => { const c = { text: '', thinking: '' }; c.onText = (t) => { c.text += t; }; c.onThinking = (t) => { c.thinking += t; }; return c; };

(async () => {
  // ---------- Addresses ----------
  ok('a bare host gets http://', local.normalizeAddress('localhost:11434') === 'http://localhost:11434');
  ok('a trailing /v1/ is dropped', local.normalizeAddress('http://127.0.0.1:1234/v1/') === 'http://127.0.0.1:1234');
  ok('other schemes are refused', (() => { try { local.normalizeAddress('file:///etc/passwd'); return false; } catch { return true; } })());
  ok('an empty address is refused', (() => { try { local.normalizeAddress('  '); return false; } catch { return true; } })());

  // ---------- Ollama ----------
  const ollama = await fakeServer({
    'GET /api/tags': () => ({ json: { models: [{ name: 'llama3.2:3b', size: 2e9, details: { parameter_size: '3.2B' } }, { name: 'nomic-embed-text', size: 3e8 }] } }),
    'POST /api/show': () => ({ json: { capabilities: ['completion', 'tools'] } }),
    'POST /api/generate': () => ({ json: { done: true } }),
    'POST /api/chat': (_b, seen) => (seen.filter((s) => s.route === 'POST /api/chat').length === 1
      ? { stream: [JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] } }), JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 2 })] }
      : { stream: [JSON.stringify({ message: { content: 'It says hi.' } }), JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 4 })] })
  });
  ok('Ollama: chat models only, embedders left out', (await local.models(ollama.address)).join() === 'llama3.2:3b');
  ok('Ollama: sizes shown in the list', (await local.listModels(ollama.address))[0].label.includes('2.0 GB'));
  ok('Ollama: parameter count from the server', local.sizeOf(ollama.address, 'llama3.2:3b') === 3.2);
  ok('a size can be read from a model name', local.sizeOf('http://elsewhere', 'Meta-Llama-3.1-70B-Instruct') === 70 && local.sizeOf('http://elsewhere', 'mistral-small') === null);

  const native = local.adapter.init([{ role: 'user', content: 'Read a.txt', images: [{ mime: 'image/png', data: 'AAAA' }] }]);
  let c = collect();
  let step = await local.adapter.step({ key: ollama.address, model: 'llama3.2:3b', system: 'sys', native, tools: [TOOL], thinking: 'medium', onText: c.onText, onThinking: c.onThinking });
  const sent = ollama.seen.find((s) => s.route === 'POST /api/chat').body;
  ok('Ollama: context size is set', sent.options.num_ctx === 8192);
  ok('Ollama: tools are sent to a model that has them', sent.tools && sent.tools[0].function.name === 'read_file');
  ok('Ollama: no thinking flag for a model that cannot think', sent.think === undefined);
  ok('Ollama: a picture is replaced by a note for a model without vision', !sent.messages[1].images && /cannot see/.test(sent.messages[1].content));
  ok('Ollama: the tool call comes back with its arguments', step.calls.length === 1 && step.calls[0].args.path === 'a.txt');
  ok('Ollama: usage is counted', step.usage.input === 10 && step.usage.output === 2);
  local.adapter.append(native, step, [{ id: step.calls[0].id, name: 'read_file', output: 'hi' }]);
  ok('Ollama: tool results use tool_name', native[native.length - 1].role === 'tool' && native[native.length - 1].tool_name === 'read_file');
  c = collect();
  step = await local.adapter.step({ key: ollama.address, model: 'llama3.2:3b', system: 'sys', native, tools: [TOOL], onText: c.onText });
  ok('Ollama: the answer streams after the tool ran', c.text === 'It says hi.' && step.calls.length === 0);
  local.configure({ context: 32768 });
  await local.warm(ollama.address, 'llama3.2:3b');
  const warmed = ollama.seen.find((x) => x.route === 'POST /api/generate');
  ok('Ollama: warming loads the model with the context size from Settings', warmed && warmed.body.model === 'llama3.2:3b' && warmed.body.options.num_ctx === 32768);
  local.configure({ context: 8192 });
  ollama.server.close();

  // ---------- OpenAI-compatible (LM Studio, llama.cpp, ...) ----------
  const compat = await fakeServer({
    'GET /v1/models': () => ({ json: { data: [{ id: 'mistral-small' }, { id: 'text-embedding-small' }] } }),
    'POST /v1/chat/completions': (body) => {
      if (body.tools) return { status: 400, json: { error: { message: 'This model does not support tools' } } };
      const delta = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`;
      return { stream: [delta({ content: '<thi' }), delta({ content: 'nk>pondering</th' }), delta({ content: 'ink>Answer' }), delta({ content: ' here.' }), `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`, 'data: [DONE]'] };
    }
  });
  ok('compatible: found through /v1/models when /api/tags is missing', (await local.models(compat.address)).join() === 'mistral-small');
  c = collect();
  step = await local.adapter.step({ key: compat.address, model: 'mistral-small', system: 'sys', native: local.adapter.init([{ role: 'user', content: 'hi' }]), tools: [TOOL], onText: c.onText, onThinking: c.onThinking });
  ok('compatible: tools refused, so it asks again without them', compat.seen.filter((s) => s.route === 'POST /v1/chat/completions').length === 2);
  ok('compatible: the user is told tools were unavailable', step.notes.some((n) => /can't use tools/.test(n)));
  ok('compatible: <think> text goes to thinking, even split across chunks', c.thinking === 'pondering' && c.text === 'Answer here.');
  ok('compatible: usage is counted', step.usage.input === 7 && step.usage.output === 3);
  compat.server.close();

  const toolServer = await fakeServer({
    'GET /v1/models': () => ({ json: { data: [{ id: 'm' }] } }),
    'POST /v1/chat/completions': () => {
      const delta = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`;
      return { stream: [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] }), delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"b.txt"}' } }] }), 'data: [DONE]'] };
    }
  });
  await local.models(toolServer.address);
  const nat = local.adapter.init([{ role: 'user', content: 'read b' }]);
  step = await local.adapter.step({ key: toolServer.address, model: 'm', system: 'sys', native: nat, tools: [TOOL], onText() {} });
  ok('compatible: a tool call streamed in pieces is put back together', step.calls[0].name === 'read_file' && step.calls[0].args.path === 'b.txt');
  local.adapter.append(nat, step, [{ id: 'c1', name: 'read_file', output: 'x' }]);
  ok('compatible: tool results use tool_call_id', nat[nat.length - 1].tool_call_id === 'c1' && nat[nat.length - 2].tool_calls[0].function.arguments.includes('b.txt'));
  toolServer.server.close();

  // ---------- A tool call written as text ----------
  const texty = await fakeServer({
    'GET /api/tags': () => ({ json: { models: [{ name: 'tiny:1b' }] } }),
    'POST /api/show': () => ({ json: { capabilities: ['completion', 'tools'] } }),
    'POST /api/chat': () => ({ stream: [JSON.stringify({ message: { content: ' {"name": "read_file", ' } }), JSON.stringify({ message: { content: '"parameters": {"path": "c.txt"}}' } }), JSON.stringify({ done: true })] })
  });
  await local.models(texty.address);
  c = collect();
  step = await local.adapter.step({ key: texty.address, model: 'tiny:1b', system: 'sys', native: local.adapter.init([{ role: 'user', content: 'read c.txt' }]), tools: [TOOL], onText: c.onText });
  ok('a call written as text becomes the call, and is not shown', step.calls[0].name === 'read_file' && step.calls[0].args.path === 'c.txt' && c.text === '' && step.text === '');
  c = collect();
  step = await local.adapter.step({ key: texty.address, model: 'tiny:1b', system: 'sys', native: local.adapter.init([{ role: 'user', content: 'hi' }]), tools: [], onText: c.onText });
  ok('without tools offered, the same text is just text', step.calls.length === 0 && /"name": "read_file"/.test(c.text));
  texty.server.close();

  const plainJson = await fakeServer({
    'GET /v1/models': () => ({ json: { data: [{ id: 'm' }] } }),
    'POST /v1/chat/completions': () => ({ stream: [`data: ${JSON.stringify({ choices: [{ delta: { content: '{"colour": "blue"}' } }] })}`, 'data: [DONE]'] })
  });
  await local.models(plainJson.address);
  c = collect();
  step = await local.adapter.step({ key: plainJson.address, model: 'm', system: 'sys', native: local.adapter.init([{ role: 'user', content: 'json please' }]), tools: [TOOL], onText: c.onText });
  ok('other JSON answers are shown as they are', step.calls.length === 0 && c.text === '{"colour": "blue"}');
  plainJson.server.close();

  // ---------- Errors ----------
  await assert.rejects(local.models('http://127.0.0.1:9'), /can't reach a model server/);
  pass++;

  console.log(`local ok (${pass} checks)`);
})().catch((err) => { console.error(err); process.exit(1); });
