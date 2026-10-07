// Run with: node test/library.test.js  (the library: indexing folders and searching them)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-library-'));
const data = path.join(tmp, 'data');
const docs = path.join(tmp, 'docs');
fs.mkdirSync(path.join(docs, 'guide'), { recursive: true });
fs.mkdirSync(path.join(docs, '.hidden'), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(docs, rel), text);

write('guide/raid.md', [
  '---', 'description: front matter is dropped', '---', '# Raid Boss', '',
  'A boss spawns for the whole server to fight together.', '',
  '## Schedule', '', 'It spawns at 12:00, 18:00 and 21:00 every day and despawns after an hour.', '',
  '## Rewards', '', 'The top damage dealer gets five crate keys. ' + 'Tanks and supports are paid too. '.repeat(10), '',
  '### Tank', '', 'The player who absorbs the most damage wins $3,000 cash and netherite scrap. '.repeat(4), '',
  '```bash', '# not a heading, a comment in code', '```'
].join('\n'));
write('guide/ranks.md', '# Ranks\n\n## Radiant\n\n' + 'Radiant players get /heal, /repair and fifteen homes. '.repeat(8));
write('notes.txt', 'Bakery opening hours are 7 to 3, closed Mondays. The sourdough starter is fed at 6.');
write('.env', 'SECRET=raid boss password');
write('guide/credentials.json', '{"raid": "boss"}');
write('.hidden/raid.md', '# Hidden raid notes');
write('SUMMARY.md', '* [Raid](guide/raid.md)\n* [Ranks](guide/ranks.md)');
write('picture.png', 'raid boss');

const store = require('../electron/store');
store.setDir(data);
const lib = require('../electron/extras/library');

// A fake Ollama: each text becomes counts of a few topic words, so meaning is predictable.
const TOPICS = [['boss', 'raid', 'spawn', 'despawn', 'fight'], ['rank', 'radiant', 'heal', 'repair', 'homes'], ['bakery', 'sourdough', 'bread', 'hours', 'monday'], ['tank', 'absorb', 'damage', 'cash']];
// Text about none of them points somewhere else entirely.
const vector = (text) => {
  const v = TOPICS.map((words) => words.reduce((n, w) => n + (String(text).toLowerCase().split(w).length - 1), 0) + 0.01);
  return v.concat(v.every((x) => x < 1) ? 1 : 0.01);
};
let embedCalls = 0;
let installed = ['qwen3-embedding:0.6b'];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: installed.map((name) => ({ name })) })); return; }
    const j = JSON.parse(body);
    embedCalls += j.input.length;
    res.end(JSON.stringify({ embeddings: j.input.map(vector) }));
  });
});

(async () => {
  // ---- Splitting
  const parts = lib.split(fs.readFileSync(path.join(docs, 'guide/raid.md'), 'utf8'), 'raid.md');
  ok('title comes from the first # heading', parts.title === 'Raid Boss');
  ok('front matter is dropped', !parts.chunks.some((c) => /front matter/.test(c.text)));
  ok('sections are labelled with their headings', parts.chunks.some((c) => c.heading === 'Raid Boss > Rewards > Tank'));
  ok('a short intro joins the next section', parts.chunks[0].text.includes('whole server') && parts.chunks[0].text.includes('21:00'));
  ok('a # line inside code is not a heading', !parts.chunks.some((c) => /not a heading/.test(c.heading)));
  ok('no section is over the size limit', lib.split('# Big\n\n## One\n\n' + 'word '.repeat(2000), 'big.md').chunks.every((c) => c.text.length <= 1800));
  // A long list or table has no blank lines; every line of it must survive the split.
  const glossary = Array.from({ length: 60 }, (_, i) => `- **Term ${i}** — what term number ${i} means, explained in a sentence.`);
  const listChunks = lib.split('# Doc\n\n## Glossary\n\n' + glossary.join('\n'), 'doc.md').chunks;
  ok('a long list is split, not cut off', listChunks.length > 1 && listChunks.every((c) => c.text.length <= 1800) && glossary.every((l) => listChunks.some((c) => c.text.includes(l))));
  ok('one giant line is kept whole across pieces', lib.split('# Doc\n\n## Blob\n\n' + 'x'.repeat(5000), 'doc.md').chunks.map((c) => c.text).join('').replace(/[^x]/g, '').length === 5000);
  // A section's short last piece must not pull the next section under its heading.
  const twoSections = lib.split('# Doc\n\n## First\n\n' + 'one '.repeat(500) + '\n\nshort tail.\n\n## Second\n\n' + 'two '.repeat(200), 'doc.md').chunks;
  ok('each section keeps its own heading', twoSections.some((c) => c.heading === 'Doc > Second' && c.text.includes('two two')) && !twoSections.some((c) => c.heading === 'Doc > First' && c.text.includes('two two')));
  ok('a file without a heading is titled from its name', lib.split('just text', 'my-notes_2024.md').title === 'my notes 2024');

  // ---- Nothing added: nothing found, nothing indexed
  ok('an empty library finds nothing', (await lib.relevant('raid boss')).length === 0);

  // ---- No Ollama at all: word search still works
  lib.setHostsForTests(() => ['http://127.0.0.1:9']);
  lib.folders.add(docs);
  let st = await lib.refresh({ force: true });
  const files = Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'library', 'index.json'), 'utf8')).files).map((f) => path.relative(docs, f).replace(/\\/g, '/')).sort();
  ok('only text files outside hidden folders are indexed', JSON.stringify(files) === JSON.stringify(['guide/raid.md', 'guide/ranks.md', 'notes.txt']));
  ok('without an embedding model nothing is embedded', st.embedded === 0 && st.model === '' && st.files === 3);
  let hits = await lib.search('when does the raid boss spawn');
  ok('word search finds the right page', hits.length && hits[0].title === 'Raid Boss');
  ok('word search ignores unrelated questions', (await lib.search('what is the capital of France')).length === 0);

  // ---- With an embedding model: search by meaning
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  lib.setHostsForTests(() => ['http://127.0.0.1:9', 'http://127.0.0.1:' + srv.address().port]);
  st = await lib.refresh({ force: true });
  ok('every section is embedded', st.embedded === st.sections && st.model === 'qwen3-embedding:0.6b');
  hits = await lib.search('who absorbs the most damage?');
  ok('meaning finds the tank rewards', hits[0].heading === 'Raid Boss > Rewards > Tank');
  ok('results say where they came from', hits[0].file.endsWith('raid.md') && /\[1\] Raid Boss > Rewards > Tank {2}\(/.test(lib.format(hits)));
  ok('injection skips unrelated questions', (await lib.relevant('tell me a joke')).length === 0);
  ok('injection keeps to the budget', (await lib.relevant('raid boss spawn fight', { budget: 50 })).length === 0);

  // ---- Changes: only what changed is embedded again
  const before = embedCalls;
  await lib.refresh({ force: true });
  ok('an unchanged library is not embedded again', embedCalls === before);
  write('notes.txt', 'Bakery hours changed: 6 to 2. Fresh bread on Monday too.');
  fs.utimesSync(path.join(docs, 'notes.txt'), new Date(), new Date(Date.now() + 5000));
  await lib.refresh({ force: true });
  ok('a changed file is embedded again, alone', embedCalls - before === 1 + 0 && (await lib.search('bakery hours'))[0].text.includes('6 to 2'));
  fs.unlinkSync(path.join(docs, 'notes.txt'));
  st = await lib.refresh({ force: true });
  ok('a deleted file leaves the index', st.files === 2);

  // ---- The index survives a restart, vectors and all
  lib.resetForTests();
  const reloaded = lib.status();
  ok('the index is read back from disk', reloaded.files === 2 && reloaded.embedded === reloaded.sections);
  ok('reloaded vectors still search', (await lib.search('who absorbs the most damage?'))[0].heading === 'Raid Boss > Rewards > Tank');

  // ---- An index made by an older splitter: every file is split and embedded again
  const indexPath = path.join(data, 'library', 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(indexPath, 'utf8')), { version: 1 })));
  lib.resetForTests();
  const old = embedCalls;
  st = await lib.refresh({ force: true });
  ok('an old index is rebuilt with the current splitter', embedCalls - old === st.sections && st.embedded === st.sections);

  // ---- A different embedding model: everything is embedded again with it
  installed = ['nomic-embed-text:latest'];
  const mid = embedCalls;
  st = await lib.refresh({ force: true });
  ok('a new model re-embeds every section', st.model === 'nomic-embed-text:latest' && embedCalls - mid === st.sections);

  // ---- A long list's meaning is vague, but its exact words still find it when the model searches
  write('guide/glossary.md', '# Glossary\n\n## Terms\n\n' + Array.from({ length: 12 }, (_, i) => `- **Raid term ${i}**: the boss fight ${i} spawn rules.`).join('\n') + '\n- **Kiln firing**: heating clay until it hardens.');
  await lib.refresh({ force: true });
  hits = await lib.search('kiln firing');
  ok('a section with the exact words is found by search', hits.length && hits[0].title === 'Glossary');
  ok('exact words alone are not added to a message unasked', !(await lib.relevant('kiln firing')).some((h) => h.title === 'Glossary'));

  // ---- A removed folder is dropped from the index
  lib.folders.remove(docs);
  st = await lib.refresh({ force: true });
  ok('removing the folder empties the index', st.files === 0 && st.folders.length === 0);

  // ---- The home folder: read with nothing registered, can't be removed, _folders skipped
  const homeDir = path.join(tmp, 'home-library');
  fs.mkdirSync(path.join(homeDir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '_raw'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'notes', 'rules.md'), '# Home Notes\n\n## Bins\n\nThe bins go out on Tuesday night.');
  fs.writeFileSync(path.join(homeDir, '_raw', 'export.md'), '# Raw\n\n## Bins\n\nAn unclean copy.');
  lib.folders.save([path.join(tmp, 'gone'), path.join(homeDir, 'notes')]);
  lib.setHome(homeDir);
  st = await lib.refresh({ force: true });
  ok('the home folder is the library, with missing and nested folders left out', JSON.stringify(st.folders) === JSON.stringify([path.resolve(homeDir)]) && st.home === path.resolve(homeDir));
  ok('files in the home folder are read; _ folders are not', st.files === 1);
  lib.folders.remove(homeDir);
  ok('the home folder cannot be removed', lib.folders.list()[0] === path.resolve(homeDir));
  lib.folders.save([]);
  lib.setHome(path.join(tmp, 'empty-home'));
  ok('an empty home folder leaves the library off', lib.folders.list().length === 0);

  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`library: ${pass} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
