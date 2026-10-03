// Talks to each AI provider through its official SDK: Claude, ChatGPT, Gemini and Meta, plus
// models on the user's own computer (see local.js).
// Runs in the main process only; API keys never reach the page.
const Anthropic = require('@anthropic-ai/sdk');
const { default: OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');
const local = require('./local');

// ---------- Shared helpers ----------

// Claude models that reject a forced tool_choice (they get an instruction instead).
const NO_FORCED_TOOL = /^claude-(fable-5-1|mythos-5-1|opus-5-5|sonnet-5-5)/;
// Newer Claude models use the dynamic-filtering web search; older ones the basic one.
const claudeWebTool = (model) => (/^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model) ? 'web_search_20260209' : 'web_search_20250305');
// Pictures made by sandboxed code come back as files; only real images are shown.
function imageFromBytes(buf) {
  const b = Buffer.from(buf);
  const mime = b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
    : b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
    : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  return mime && b.length < 8 * 1024 * 1024 ? { mime, data: b.toString('base64') } : null;
}
const clipRun = (s) => String(s || '').slice(0, 6000);

const cleanSources = (list) => {
  const seen = new Set();
  return list.filter((s) => s.url && /^https?:\/\//.test(s.url) && !seen.has(s.url) && seen.add(s.url)).slice(0, 12);
};

// ---------- Thinking levels ----------

// Thinking levels (off, low, medium, high, max) mapped onto each provider's own knobs.
// Claude: adaptive thinking plus an effort level; models that can't turn thinking
// off get the lowest effort instead, and older ones use a token budget.
function claudeThinking(model, level) {
  const adaptive = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model);
  const alwaysOn = /^claude-(fable|mythos|opus-5|sonnet-5-5)/.test(model);
  if (!adaptive) {
    if (level === 'off') return {};
    return { thinking: { type: 'enabled', budget_tokens: { low: 1500, medium: 4000, high: 10000, max: 14000 }[level] } };
  }
  if (level === 'off') {
    if (alwaysOn) return { output_config: { effort: 'low' } };
    return /^claude-sonnet-5$/.test(model) ? { thinking: { type: 'disabled' } } : {};
  }
  return { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: level } };
}

// OpenAI: candidate reasoning efforts, tried in order (models differ on 'none' and 'xhigh').
const OPENAI_EFFORT = { off: ['none', 'minimal', 'low'], low: ['low'], medium: ['medium'], high: ['high'], max: ['xhigh', 'high'] };

// Meta's Muse models always reason ('none' is refused); 'max' exists only on the standard muse-spark-1.3.
const META_EFFORT = { off: ['minimal', 'low'], low: ['low'], medium: ['medium'], high: ['high'], max: ['max', 'xhigh', 'high'] };
const META_BASE = 'https://api.meta.ai/v1';

// Gemini: newer models take a level, 2.5 models a token budget. Candidates in order;
// the last is no thinking config at all.
function geminiThinkingConfigs(model, level) {
  const newer = /^gemini-(3|[4-9])|-latest$/.test(model);
  const list = newer
    ? [{ thinkingLevel: { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }[level] }]
    : [{ thinkingBudget: { off: 0, low: 1024, medium: 8192, high: 24576, max: 32768 }[level] }];
  if (level === 'off') list.push(newer ? { thinkingLevel: 'low' } : { thinkingBudget: 128 });
  if (level === 'max' && !newer) list.push({ thinkingBudget: 24576 });
  return list.map((c) => Object.assign({ includeThoughts: true }, c)).concat([null]);
}

// ---------- OpenAI Responses API (ChatGPT and Meta) ----------

// The Responses API adapter, shared by every provider that speaks it (OpenAI, Meta).
// It streams, calls tools, searches the web and shows reasoning summaries.
// Stateless (store: false): nothing is kept provider-side, and reasoning travels
// back encrypted so multi-step tool use still works.
function responsesAdapter(effortMap, makeClient, caps = { code: true }) {
  return {
    init(messages) {
      return messages.map((m) => ({
        role: m.role,
        content: m.role === 'user' && m.images && m.images.length
          ? m.images.map((i) => ({ type: 'input_image', image_url: `data:${i.mime};base64,${i.data}` })).concat([{ type: 'input_text', text: m.content || 'What is in this image?' }])
          : m.content
      }));
    },
    async step({ key, model, system, native, tools, toolChoice, web, code, thinking, signal, onText, onThinking, retries, timeout }) {
      const client = makeClient(key, { retries, timeout });
      const request = {
        model,
        instructions: system,
        input: native,
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
        tools: (web ? [{ type: 'web_search' }] : []).concat(code && caps.code ? [{ type: 'code_interpreter', container: { type: 'auto' } }] : []).concat(tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }))),
        ...(toolChoice ? { tool_choice: { type: 'function', name: toolChoice } } : {})
      };
      const notes = [];
      // Reasoning effort: try the level's candidates in order, then give up on it.
      const efforts = (effortMap[thinking || 'medium'] || effortMap.medium).slice();
      request.reasoning = { effort: efforts.shift(), summary: 'auto' };
      let stream;
      // Some 400s just mean "this model can't do that option": drop or adjust it and retry.
      for (let attempt = 0; ; attempt++) {
        try {
          stream = await client.responses.create(request, { signal });
          break;
        } catch (err) {
          const msg = String(err.message);
          if ((err.status || err.code) !== 400 || attempt >= 6) throw err;
          if (web && /web[_ ]search/i.test(msg)) {
            request.tools = request.tools.filter((t) => t.type !== 'web_search');
            notes.push('This ChatGPT model does not support web search, so this answer is from its training data.');
          } else if (code && /code[_ ]interpreter/i.test(msg)) {
            request.tools = request.tools.filter((t) => t.type !== 'code_interpreter');
            notes.push('This model cannot run code, so this answer is written without running any.');
          } else if (request.include && /include|encrypted/i.test(msg)) {
            delete request.include;
          } else if (request.reasoning && /reasoning|effort|summary|thinking/i.test(msg)) {
            if (efforts.length) request.reasoning = { effort: efforts.shift(), summary: 'auto' };
            else if (request.reasoning.summary && /summary/i.test(msg)) request.reasoning = { effort: request.reasoning.effort };
            else delete request.reasoning;
          } else {
            throw err;
          }
        }
      }
      let text = '';
      let final = null;
      for await (const ev of stream) {
        if (ev.type === 'response.output_text.delta') { text += ev.delta; onText(ev.delta); }
        else if (ev.type === 'response.reasoning_summary_text.delta') { if (onThinking) onThinking(ev.delta); }
        else if (ev.type === 'response.reasoning_summary_part.added') { if (onThinking) onThinking('\n\n'); }
        else if (ev.type === 'response.completed') final = ev.response;
        else if (ev.type === 'response.failed' || ev.type === 'response.incomplete') {
          const e = (ev.response && (ev.response.error || ev.response.incomplete_details)) || {};
          throw Object.assign(new Error(e.message || e.reason || 'The response did not finish.'), { status: /server|overload/i.test(e.code || '') ? 503 : undefined });
        } else if (ev.type === 'error') {
          throw Object.assign(new Error(ev.message || 'OpenAI reported an error.'), { status: /server|overload/i.test(ev.code || '') ? 503 : undefined });
        }
      }
      const output = (final && final.output) || [];
      const sources = [];
      const searches = [];
      const runs = [];
      const images = [];
      const fileRefs = [];
      for (const o of output) {
        if (o.type === 'code_interpreter_call') {
          const logs = (o.outputs || []).filter((x) => x.type === 'logs').map((x) => x.logs).join('\n');
          runs.push({ language: 'python', code: clipRun(o.code), output: clipRun(logs), failed: /Traceback \(most recent call last\)/.test(logs) });
          for (const x of o.outputs || []) if (x.type === 'image' && /^data:image\//.test(x.url || '')) images.push({ mime: x.url.slice(5, x.url.indexOf(';')), data: x.url.split(',')[1] });
        }
        if (o.type === 'message') for (const c of o.content || []) for (const a of c.annotations || []) if (a.type === 'container_file_citation') fileRefs.push(a);
        if (o.type === 'web_search_call' && o.action && o.action.query) searches.push(o.action.query);
        if (o.type === 'message') for (const c of o.content || []) for (const a of c.annotations || []) if (a.type === 'url_citation') sources.push({ url: a.url, title: a.title || a.url });
      }
      for (const ref of fileRefs.slice(0, 4)) {
        try {
          const r = await client.containers.files.content.retrieve(ref.file_id, { container_id: ref.container_id });
          const img = imageFromBytes(await r.arrayBuffer());
          if (img) images.push(img);
        } catch { /* not an image or not downloadable: skip */ }
      }
      return {
        text,
        runs,
        images,
        sources: cleanSources(sources),
        searches,
        notes,
        usage: final && final.usage ? { input: final.usage.input_tokens || 0, output: final.usage.output_tokens || 0 } : null,
        calls: output.filter((o) => o.type === 'function_call').map((o) => {
          let args = {};
          try { args = o.arguments ? JSON.parse(o.arguments) : {}; } catch { /* bad JSON: the tool will report the missing fields */ }
          return { id: o.call_id, name: o.name, args };
        }),
        raw: output
      };
    },
    append(native, step, results) {
      for (const item of step.raw) native.push(item);
      for (const r of results) native.push({ type: 'function_call_output', call_id: r.id, output: r.output });
    }
  };
}

// ---------- Providers ----------

// Which image model each provider will use, looked up once per run.
const imageModelCache = {};

const PROVIDERS = {
  claude: {
    name: 'Claude',
    defaultModel: 'claude-opus-5-5',
    keyUrl: 'https://platform.claude.com/settings/keys',

    // One model turn, streamed. Messages are { role, content, images? }.
    adapter: {
      init(messages) {
        return messages.map((m) => ({
          role: m.role,
          content: m.role === 'user' && m.images && m.images.length
            ? m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })).concat([{ type: 'text', text: m.content || 'What is in this image?' }])
            : m.content
        }));
      },
      async step({ key, model, system, native, tools, toolChoice, web, code, thinking, signal, onText, onThinking, retries, timeout }) {
        const client = new Anthropic({ apiKey: key, maxRetries: retries ?? 2, timeout: timeout ?? 120000 });
        // Server-side fallback: if a request is declined by a safety classifier,
        // the API retries it on a suitable model inside the same call.
        // Thinking can't be combined with a forced tool, so a forced tool becomes an instruction.
        const think = claudeThinking(model, thinking || 'medium');
        const thinkOn = Boolean(think.thinking && think.thinking.type !== 'disabled');
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 16000,
          system: toolChoice && (NO_FORCED_TOOL.test(model) || thinkOn) ? `${system}\n\nFor this request you must call ${toolChoice} now.` : system,
          messages: native,
          // The newer web search runs code on its own, so with code execution on we use the basic one.
          tools: (web ? [{ type: code ? 'web_search_20250305' : claudeWebTool(model), name: 'web_search', max_uses: 5 }] : []).concat(code ? [{ type: 'code_execution_20260521', name: 'code_execution' }] : []).concat(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))),
          ...(toolChoice && !NO_FORCED_TOOL.test(model) && !thinkOn ? { tool_choice: { type: 'tool', name: toolChoice } } : {}),
          ...think,
          betas: code ? ['server-side-fallback-2026-07-01', 'code-execution-2025-08-25'] : ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        }, { signal });
        stream.on('text', (t) => onText(t));
        stream.on('thinking', (t) => onThinking && onThinking(t));
        const res = await stream.finalMessage();
        if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer that one.');
        const sources = [];
        const searches = [];
        const notes = [];
        for (const b of res.content) {
          if (b.type === 'server_tool_use' && b.name === 'web_search' && b.input && b.input.query) searches.push(b.input.query);
          if (b.type === 'web_search_tool_result') {
            if (Array.isArray(b.content)) b.content.forEach((r) => sources.push({ url: r.url, title: r.title || r.url }));
            else if (b.content && b.content.error_code) notes.push(`Web search failed (${b.content.error_code}). If it says the tool is not enabled, an admin has to turn on web search for your Anthropic organization in the Console.`);
          }
          if (b.type === 'text' && b.citations) b.citations.forEach((c) => sources.push({ url: c.url, title: c.title || c.url }));
        }
        // Code the model ran in Anthropic's sandbox, paired with what it printed.
        const runs = [];
        const fileIds = [];
        for (const blk of res.content) {
          if (blk.type !== 'server_tool_use' || !/code_execution/.test(blk.name)) continue;
          const input = blk.input || {};
          const result = res.content.find((r) => r.tool_use_id === blk.id && r.type !== 'server_tool_use');
          const inner = result && result.content;
          let output = '';
          let failed = false;
          if (inner && (inner.stdout !== undefined || inner.stderr !== undefined)) {
            output = [inner.stdout, inner.stderr].filter(Boolean).join('\n');
            failed = inner.return_code !== 0;
            (inner.content || []).forEach((f) => f.file_id && fileIds.push(f.file_id));
          } else if (inner && inner.error_code) { output = `Code execution failed (${inner.error_code}).`; failed = true; }
          runs.push({ language: 'python', code: clipRun(input.command || input.file_text || JSON.stringify(input)), output: clipRun(output), failed });
        }
        const images = [];
        for (const id of fileIds.slice(0, 4)) {
          try {
            const r = await client.files.download(id);
            const img = imageFromBytes(await r.arrayBuffer());
            if (img) images.push(img);
          } catch { /* not downloadable, or not an image: skip */ }
        }
        return {
          runs,
          images,
          text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          calls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
          raw: res.content,
          usage: res.usage ? { input: (res.usage.input_tokens || 0) + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0), output: res.usage.output_tokens || 0 } : null,
          sources: cleanSources(sources),
          searches,
          notes,
          pause: res.stop_reason === 'pause_turn'
        };
      },
      // The server paused a long search turn: send it back as is to continue.
      appendPause(native, step) {
        native.push({ role: 'assistant', content: step.raw });
      },
      append(native, step, results) {
        native.push({ role: 'assistant', content: step.raw });
        native.push({
          role: 'user',
          content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, is_error: r.isError }))
        });
      }
    },

    async models(key) {
      const client = new Anthropic({ apiKey: key });
      const ids = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    },

    // Everything the key can chat with, newest first, with the provider's own names.
    async listModels(key) {
      const client = new Anthropic({ apiKey: key });
      const out = [];
      for await (const m of client.models.list()) out.push({ id: m.id, label: m.display_name || m.id });
      return out;
    }
  },

  chatgpt: {
    name: 'ChatGPT',
    defaultModel: 'gpt-5',
    keyUrl: 'https://platform.openai.com/api-keys',

    // OpenAI's Responses API: current models (gpt-5.x and later) don't allow tools
    // together with reasoning on the older chat completions endpoint.
    adapter: responsesAdapter(OPENAI_EFFORT, (key, o) => new OpenAI({ apiKey: key, maxRetries: o.retries ?? 2, timeout: o.timeout ?? 120000 })),

    // Picture making. With input images it edits them instead of starting fresh.
    images: {
      async generate(key, prompt, inputs, signal) {
        const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 180000 });
        if (!imageModelCache.chatgpt) {
          const ids = [];
          try { for await (const m of client.models.list()) if (/^gpt-image/.test(m.id)) ids.push(m.id); } catch { /* fall back below */ }
          imageModelCache.chatgpt = ids.sort(newer)[0] || 'gpt-image-1';
        }
        const model = imageModelCache.chatgpt;
        const res = inputs && inputs.length
          ? await client.images.edit({
              model,
              prompt,
              image: await Promise.all(inputs.map((i, n) => OpenAI.toFile(Buffer.from(i.data, 'base64'), `input-${n}.jpg`, { type: i.mime })))
            }, { signal })
          : await client.images.generate({ model, prompt, size: 'auto' }, { signal });
        const images = (res.data || []).filter((d) => d.b64_json).map((d) => ({ mime: 'image/png', data: d.b64_json }));
        if (!images.length) throw new Error('OpenAI returned no image.');
        return { images, text: '', model };
      }
    },

    async models(key) {
      const client = new OpenAI({ apiKey: key });
      const ids = [];
      for await (const m of client.models.list()) {
        if (/^(gpt|o\d|chatgpt)/.test(m.id) && !/audio|realtime|image|tts|transcribe|search|embedding/.test(m.id)) ids.push(m.id);
      }
      return ids.sort().reverse();
    },

    async listModels(key) {
      const ids = await PROVIDERS.chatgpt.models(key);
      return ids.map((id) => ({ id, label: id }));
    }
  },

  gemini: {
    name: 'Gemini',
    defaultModel: 'gemini-2.5-pro',
    keyUrl: 'https://aistudio.google.com/apikey',

    adapter: {
      init(messages) {
        return messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: (m.role === 'user' ? m.images || [] : []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })).concat([{ text: m.content || 'What is in this image?' }])
        }));
      },
      async step({ key, model, system, native, tools, toolChoice, web, code, thinking, signal, onText, onThinking, retries, timeout }) {
        const ai = new GoogleGenAI({
          apiKey: key,
          httpOptions: { timeout: timeout ?? 120000, retryOptions: { attempts: (retries ?? 2) + 1 } }
        });
        const declarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
        // Which tools go in, best first. Some Gemini models can't mix built-in tools
        // (search, code) with Ilyra's own function tools, so fall back one step at a time.
        const builtins = (web ? [{ googleSearch: {} }] : []).concat(code ? [{ codeExecution: {} }] : []);
        const functions = declarations.length ? [{ functionDeclarations: declarations }] : [];
        const toolSets = [{ tools: builtins.concat(functions), note: null }];
        if (builtins.length && functions.length) toolSets.push({ tools: builtins, note: 'This Gemini model cannot search or run code and use Ilyra\'s tools (files, images, chats) in the same reply, so this reply can search or run code but not use them.' });
        if (web && code) toolSets.push({ tools: [{ googleSearch: {} }], note: 'This Gemini model cannot search and run code in the same reply, so this reply searches only.' });
        const build = (tools, thinkingConfig, forced) => ({
          model,
          contents: native,
          config: {
            systemInstruction: system,
            abortSignal: signal,
            tools,
            ...(thinkingConfig ? { thinkingConfig } : {}),
            ...(forced && toolChoice ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice] } } } : {})
          }
        });
        const notes = [];
        // Thinking options differ by model: try this level's settings in order, ending with none.
        const openStream = async (set) => {
          const configs = geminiThinkingConfigs(model, thinking || 'medium');
          for (let n = 0; ; n++) {
            try {
              return await ai.models.generateContentStream(build(set.tools, configs[n], set.tools.some((t) => t.functionDeclarations)));
            } catch (err) {
              if ((err.status || err.code) === 400 && n < configs.length - 1 && /think|budget|level|thought/i.test(String(err.message))) continue;
              throw err;
            }
          }
        };
        let stream;
        for (let k = 0; ; k++) {
          try {
            stream = await openStream(toolSets[k]);
            if (toolSets[k].note) notes.push(toolSets[k].note);
            break;
          } catch (err) {
            if (k < toolSets.length - 1 && (err.status || err.code) === 400 && /tool|function|search|code/i.test(String(err.message))) continue;
            throw err;
          }
        }
        let text = '';
        const parts = [];
        const sources = [];
        const searches = [];
        const runs = [];
        const images = [];
        let meta = null;
        for await (const chunk of stream) {
          if (chunk.usageMetadata) meta = chunk.usageMetadata;
          const cand = chunk.candidates && chunk.candidates[0];
          for (const part of (cand && cand.content && cand.content.parts) || []) {
            parts.push(part);
            if (part.text && part.thought) { if (onThinking) onThinking(part.text); }
            else if (part.text) { text += part.text; onText(part.text); }
            if (part.executableCode) runs.push({ language: String(part.executableCode.language || 'python').toLowerCase().replace('language_unspecified', 'python'), code: clipRun(part.executableCode.code), output: '', failed: false });
            if (part.codeExecutionResult && runs.length) {
              const last = runs[runs.length - 1];
              last.output = clipRun(part.codeExecutionResult.output);
              last.failed = Boolean(part.codeExecutionResult.outcome) && part.codeExecutionResult.outcome !== 'OUTCOME_OK';
            }
            if (part.inlineData && part.inlineData.data && /^image\//.test(part.inlineData.mimeType || '') && !part.thought) images.push({ mime: part.inlineData.mimeType, data: part.inlineData.data });
          }
          const g = cand && cand.groundingMetadata;
          if (g) {
            (g.groundingChunks || []).forEach((c) => c.web && sources.push({ url: c.web.uri, title: c.web.title || c.web.uri }));
            (g.webSearchQueries || []).forEach((q) => { if (!searches.includes(q)) searches.push(q); });
          }
        }
        return {
          text,
          calls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id || `call-${i}`, name: p.functionCall.name, args: p.functionCall.args || {}, hasId: Boolean(p.functionCall.id) })),
          raw: parts,
          usage: meta ? { input: meta.promptTokenCount || 0, output: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0) } : null,
          runs,
          images,
          sources: cleanSources(sources),
          searches,
          notes
        };
      },
      append(native, step, results) {
        native.push({ role: 'model', parts: step.raw });
        native.push({
          role: 'user',
          parts: results.map((r) => ({ functionResponse: Object.assign({ name: r.name, response: r.isError ? { error: r.output } : { output: r.output } }, r.hasId ? { id: r.id } : {}) }))
        });
      }
    },

    // Picture making: Gemini's native image models, or Imagen if none is listed.
    images: {
      async generate(key, prompt, inputs, signal) {
        const ai = new GoogleGenAI({ apiKey: key, httpOptions: { timeout: 180000 } });
        if (!imageModelCache.gemini) {
          const native = [];
          const imagen = [];
          try {
            for await (const m of await ai.models.list()) {
              const id = (m.name || '').replace(/^models\//, '');
              const actions = m.supportedActions || [];
              if (/^gemini-.*image/.test(id) && !/tts|live/.test(id) && (!actions.length || actions.includes('generateContent'))) native.push(id);
              else if (/^imagen-/.test(id) && !/ultra|fast/.test(id) && (!actions.length || actions.includes('predict'))) imagen.push(id);
            }
          } catch { /* fall back below */ }
          // Prefer the "pro" image model for quality, then the newest.
          native.sort((a, b) => (/pro/.test(b) - /pro/.test(a)) || newer(a, b));
          imagen.sort(newer);
          imageModelCache.gemini = native[0] ? { kind: 'native', model: native[0] } : imagen[0] ? { kind: 'imagen', model: imagen[0] } : { kind: 'native', model: 'gemini-2.5-flash-image' };
        }
        const { kind, model } = imageModelCache.gemini;
        if (kind === 'imagen') {
          const res = await ai.models.generateImages({ model, prompt, config: { numberOfImages: 1, abortSignal: signal } });
          const images = (res.generatedImages || []).filter((g) => g.image && g.image.imageBytes).map((g) => ({ mime: g.image.mimeType || 'image/png', data: g.image.imageBytes }));
          if (!images.length) throw new Error('Gemini returned no image (the prompt may have been blocked).');
          return { images, text: '', model };
        }
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: (inputs || []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })).concat([{ text: prompt }]) }],
          config: { responseModalities: ['TEXT', 'IMAGE'], abortSignal: signal }
        });
        const parts = (res.candidates && res.candidates[0] && res.candidates[0].content && res.candidates[0].content.parts) || [];
        const images = parts.filter((p) => p.inlineData && p.inlineData.data).map((p) => ({ mime: p.inlineData.mimeType || 'image/png', data: p.inlineData.data }));
        const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
        if (!images.length) throw new Error(text || 'Gemini returned no image (the prompt may have been blocked).');
        return { images, text, model };
      }
    },

    async models(key) {
      const ai = new GoogleGenAI({ apiKey: key });
      const ids = [];
      const pager = await ai.models.list();
      for await (const m of pager) {
        const actions = m.supportedActions || [];
        if (m.name && /gemini/.test(m.name) && (!actions.length || actions.includes('generateContent'))) {
          ids.push(m.name.replace(/^models\//, ''));
        }
      }
      return ids.sort().reverse();
    },

    async listModels(key) {
      const ai = new GoogleGenAI({ apiKey: key });
      const out = [];
      const pager = await ai.models.list();
      for await (const m of pager) {
        const actions = m.supportedActions || [];
        const id = (m.name || '').replace(/^models\//, '');
        if (id && /gemini/.test(id) && !/image|tts|live|embed|robotics|computer-use/.test(id) && (!actions.length || actions.includes('generateContent'))) {
          out.push({ id, label: m.displayName || id });
        }
      }
      return out.sort((a, b) => (a.id < b.id ? 1 : -1));
    }
  },

  // Meta Model API (formerly Llama API): Muse models over an OpenAI-compatible API.
  // The "-contributor" models are cheaper because Meta may train on your prompts, so
  // they are never picked automatically.
  meta: {
    name: 'Meta',
    defaultModel: 'muse-spark-1.3',
    keyUrl: 'https://dev.meta.ai/',

    adapter: responsesAdapter(META_EFFORT, (key, o) => new OpenAI({ apiKey: key, baseURL: META_BASE, maxRetries: o.retries ?? 2, timeout: o.timeout ?? 120000 }), { code: false }),

    async models(key) {
      const client = new OpenAI({ apiKey: key, baseURL: META_BASE });
      const ids = [];
      for await (const m of client.models.list()) if (/^muse-spark/.test(m.id)) ids.push(m.id);
      return ids;
    },

    async listModels(key) {
      const ids = await PROVIDERS.meta.models(key);
      return ids.map((id) => ({ id, label: /contributor/.test(id) ? `${id}  (cheaper: Meta may train on your prompts)` : id }));
    }
  },

  // Ollama, LM Studio and other model servers the user runs themselves.
  local
};

// ---------- Choosing a model ----------

// Compares the version numbers inside two model ids, newest first:
// "gemini-3.1-pro" beats "gemini-3-pro"; "claude-opus-5-5" beats "claude-opus-5".
function newer(a, b) {
  const na = (a.match(/\d+/g) || []).map(Number);
  const nb = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] || 0) - (na[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Picks the newest stable, general-purpose model from what the key can use.
// Hard-coded ids go stale; the provider's own list doesn't.
// Gemini's "-latest" aliases always point at Google's current model, and its
// list keeps showing retired models (e.g. gemini-2.5-pro) that 404 for new keys.
const PREFER = {
  claude: [/^claude-opus-\d/, /^claude-sonnet-\d/, /^claude-haiku-\d/],
  chatgpt: [/^gpt-\d+(\.\d+)?$/, /^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d+(\.\d+)?-nano$/],
  gemini: [/^gemini-pro-latest$/, /^gemini-flash-latest$/, /^gemini-\d+(\.\d+)?-pro$/, /^gemini-\d+(\.\d+)?-pro-preview$/, /^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-flash-lite$/, /^gemini-flash-lite-latest$/],
  meta: [/^muse-spark-\d+(\.\d+)?$/]
};
const AVOID = /exp|tts|image|live|audio|embed|vision|thinking|contributor|transcribe|robotics|computer-use|customtools|\d{4}-\d{2}-\d{2}|\d{8}/;

// Every usable model, best first. Ilyra tries them in order until one answers.
function rankModels(id, ids) {
  // Local models have no "newest stable" order: whatever is installed, in the server's order.
  if (PROVIDERS[id].local) return ids.slice();
  const ranked = [];
  // Claude's default is known-current; the others' defaults are only a fallback.
  if (id === 'claude' && ids.includes(PROVIDERS.claude.defaultModel)) ranked.push(PROVIDERS.claude.defaultModel);
  const usable = ids.filter((m) => !AVOID.test(m));
  for (const pattern of PREFER[id]) {
    usable.filter((m) => pattern.test(m)).sort(newer).forEach((m) => { if (!ranked.includes(m)) ranked.push(m); });
  }
  return ranked.length ? ranked : usable.concat(ids).slice(0, 1);
}

function pickModel(id, ids) {
  return rankModels(id, ids)[0] || PROVIDERS[id].defaultModel;
}

// ---------- Errors ----------

// The provider's own words for what went wrong. SDK errors often carry a JSON
// blob like {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}.
function errorDetail(err) {
  if (!err) return '';
  let msg = String(err.message || err);
  const brace = msg.indexOf('{');
  if (brace !== -1) {
    try {
      const j = JSON.parse(msg.slice(brace));
      if (j && j.error) msg = [j.error.status, j.error.message].filter(Boolean).join(': ');
    } catch { /* not JSON */ }
  }
  const status = err.status || err.code;
  msg = msg.replace(/\s+/g, ' ').trim().slice(0, 300);
  return status && !msg.includes(String(status)) ? `${status} ${msg}` : msg;
}

// Turns SDK errors into something worth showing a person, with the provider's
// own message after it so a failure can actually be diagnosed.
function friendlyError(err) {
  const status = err && (err.status || err.code);
  const detail = errorDetail(err);
  const add = (text) => (detail ? `${text} (${detail})` : text);
  if (/organization (must be|needs to be) verified|verify (your )?organization/i.test(String(err && err.message))) {
    return add('OpenAI only allows its image models for verified organizations. Verify yours at platform.openai.com/settings/organization/general, or use Gemini for images.');
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/.test(String(err && err.message))) {
    return add('That API key was rejected. Check it in Settings, AI models.');
  }
  if (isOutOfCredit(err)) return 'This account is out of credits. Add credits on the provider\'s billing page, or choose another model in Settings.';
  if (isNotFound(err)) return add('That model was not found. Pick another in Settings, AI models.');
  if (status === 429) return add('Rate limited or out of credit. Try again shortly.');
  if ([500, 503, 504, 529].includes(status) || isTimeout(err)) return add('The provider is overloaded right now. Try again in a moment.');
  if (err && /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(String(err.message))) return add('Could not reach the provider. Check your connection.');
  return detail || 'Something went wrong.';
}

// The account itself can't pay: no other model from this provider will work either.
const isOutOfCredit = (err) => Boolean(err) && ((err.status || err.code) === 402 ||
  /insufficient_quota|credit balance is too low|credits are depleted|prepayment credits|billing (is )?(not active|required)|payment required/i.test(String(err.message)));

const isTimeout = (err) => Boolean(err) && /timed? ?out|timeout|AbortError/i.test(`${err.name} ${err.message}`);

const isNotFound = (err) => Boolean(err) && (err.status === 404 || err.code === 404 || /not found|NOT_FOUND/i.test(String(err.message)));

// Worth trying a different model: this one is gone, this key has no quota
// for it (Gemini's free tier doesn't cover Pro), or it's overloaded right now.
const tryAnotherModel = (err) => isNotFound(err) || isTimeout(err) || (Boolean(err) && [429, 500, 503, 504, 529].includes(err.status || err.code));

module.exports = { PROVIDERS, errorDetail, friendlyError, pickModel, rankModels, isNotFound, isOutOfCredit, tryAnotherModel };
