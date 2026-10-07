// Skills (electron/extras/skills.js): reading SKILL.md, installing from a folder, turning
// skills on and off, what a reply is told, and refusing paths outside a skill.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

const skills = require('../electron/extras/skills');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-skills-'));
const home = path.join(tmp, 'skills');
skills.init({ home });

// A collection like a GitHub repository: two skills, one with a reference file and a script.
const repo = path.join(tmp, 'repo');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
write('README.md', '# not a skill');
write('skills/taste/SKILL.md', '---\nname: design-taste-frontend\ndescription: Sharper frontend design choices\n---\n# Taste\nUse real fonts.\n');
write('skills/taste/references/fonts.md', 'Inter is overused.');
write('skills/taste/scripts/check.py', 'print(1)');
write('skills/plain/SKILL.md', "---\nname: 'plain-writing'\ndescription: >\n  Write plainly,\n  in short sentences.\n---\nShort words.\n");

(async () => {
  // ---------- Reading SKILL.md ----------
  const p = skills.parse('---\nname: a-b\ndescription: "Quoted: yes"\nlicense: MIT\n---\nBody');
  ok('frontmatter name and quoted description', p.meta.name === 'a-b' && p.meta.description === 'Quoted: yes' && p.body === 'Body');
  ok('folded descriptions are joined', skills.parse('---\nname: x\ndescription: >\n  one\n  two\n---\n').meta.description === 'one two');
  ok('no frontmatter is all body', skills.parse('# Hi').body === '# Hi');

  // ---------- Links ----------
  ok('a repository', JSON.stringify(skills.parseUrl('https://github.com/Leonxlnx/taste-skill')) === JSON.stringify({ kind: 'repo', owner: 'Leonxlnx', repo: 'taste-skill', ref: 'HEAD', sub: '' }));
  const tree = skills.parseUrl('https://github.com/o/r/tree/main/skills/my-skill');
  ok('a folder in a repository', tree.ref === 'main' && tree.sub === 'skills/my-skill');
  ok('a SKILL.md on GitHub means its folder', skills.parseUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md').sub === 'skills/x');
  ok('raw GitHub files too', skills.parseUrl('https://raw.githubusercontent.com/o/r/main/x/SKILL.md').sub === 'x');
  ok('any https SKILL.md', skills.parseUrl('https://example.com/a/SKILL.md').kind === 'file');
  assert.throws(() => skills.parseUrl('http://github.com/o/r'), /https/); pass++;
  assert.throws(() => skills.parseUrl('https://example.com/page'), /GitHub link/); pass++;

  // ---------- Installing ----------
  const res = skills.addFromFolder(repo);
  ok('every skill in a collection is installed, under its own name', res.installed.sort().join() === 'design-taste-frontend,plain-writing');
  ok('kept as skills/<name>/SKILL.md, with its files', fs.existsSync(path.join(home, 'design-taste-frontend', 'SKILL.md')) && fs.existsSync(path.join(home, 'design-taste-frontend', 'references', 'fonts.md')));
  ok('from a collection they start off', res.skills.every((s) => !s.enabled));
  const taste = res.skills.find((s) => s.name === 'design-taste-frontend');
  ok('the list has descriptions and notices scripts', taste.description === 'Sharper frontend design choices' && taste.hasScripts && taste.files === 2);
  ok('folded descriptions in the list', res.skills.find((s) => s.name === 'plain-writing').description === 'Write plainly, in short sentences.');
  const single = path.join(tmp, 'single');
  fs.mkdirSync(single);
  fs.writeFileSync(path.join(single, 'SKILL.md'), '---\nname: Only One!\ndescription: d\n---\nx');
  const one = skills.addFromFolder(single);
  ok('a single skill is turned on, its name made safe', one.installed[0] === 'only-one' && one.skills.find((s) => s.name === 'only-one').enabled);
  assert.throws(() => skills.addFromFolder(path.join(tmp, 'nope')), /doesn't exist/); pass++;
  assert.throws(() => skills.addFromFolder(path.join(repo, 'skills', 'taste', 'references')), /No skills/); pass++;

  // ---------- On and off ----------
  skills.setEnabled('only-one', false);
  ok('nothing on: no tool, nothing in the prompt', skills.forPrompt('hi').offered === false);
  skills.setEnabled('design-taste-frontend', true);
  ok('it stays on (kept in the skills folder)', JSON.parse(fs.readFileSync(path.join(home, 'skills.json'), 'utf8')).enabled['design-taste-frontend'] === true);
  skills.init({ home }); // as after a restart
  const pr = skills.forPrompt('make me a landing page');
  ok('a reply is told the names and descriptions of those on', pr.offered && /design-taste-frontend: Sharper frontend/.test(pr.text) && !/plain-writing/.test(pr.text));
  ok('and not the whole skill', !/Use real fonts/.test(pr.text) && pr.loaded.length === 0);
  const named = skills.forPrompt('use design-taste-frontend for this');
  ok('naming a skill loads it now', named.loaded[0] === 'design-taste-frontend' && /Use real fonts/.test(named.text));
  ok('also with spaces for hyphens', skills.forPrompt('use design taste frontend').loaded.length === 1);
  ok('not part of another word', skills.forPrompt('my-design-taste-frontend-ish').loaded.length === 0);

  // ---------- use_skill ----------
  const loaded = await skills.RUNNER.use_skill({ name: 'design-taste-frontend' });
  ok('use_skill gives the body without frontmatter, and names its other files', /^# Taste/.test(loaded.output) && !/^---/.test(loaded.output) && /references\/fonts\.md/.test(loaded.output));
  ok('a file inside the skill', (await skills.RUNNER.use_skill({ name: 'design-taste-frontend', file: 'references/fonts.md' })).output === 'Inter is overused.');
  await assert.rejects(skills.RUNNER.use_skill({ name: 'plain-writing' }), /no skill on/); pass++;
  await assert.rejects(skills.RUNNER.use_skill({ name: 'design-taste-frontend', file: '../../skills.json' }), /has no file/); pass++;
  await assert.rejects(skills.RUNNER.use_skill({ name: 'design-taste-frontend', file: '..\\plain-writing\\SKILL.md' }), /has no file/); pass++;
  await assert.rejects(skills.RUNNER.use_skill({ name: 'design-taste-frontend', file: path.join(repo, 'README.md') }), /has no file/); pass++;

  // ---------- Names are checked everywhere ----------
  for (const bad of ['../x', '..', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
    assert.throws(() => skills.get(bad), /isn't a skill name/);
    assert.throws(() => skills.remove(bad), /isn't a skill name/);
    assert.throws(() => skills.setEnabled(bad, true), /isn't a skill name/);
  }
  pass++;
  ok('outside folders are untouched', fs.existsSync(path.join(repo, 'README.md')));

  // ---------- Removing ----------
  const left = skills.remove('design-taste-frontend');
  ok('removing deletes its folder and its on/off', !fs.existsSync(path.join(home, 'design-taste-frontend')) && !left.some((s) => s.name === 'design-taste-frontend') && !JSON.parse(fs.readFileSync(path.join(home, 'skills.json'), 'utf8')).enabled['design-taste-frontend']);
  ok('get of a missing skill is null', skills.get('design-taste-frontend') === null);
  ok('folders added by hand show up', (fs.mkdirSync(path.join(home, 'by-hand')), fs.writeFileSync(path.join(home, 'by-hand', 'SKILL.md'), '---\nname: by-hand\ndescription: h\n---\n'), skills.list().some((s) => s.name === 'by-hand')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`skills ok (${pass} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
