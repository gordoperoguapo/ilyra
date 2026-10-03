// Run with: node test/usage.test.js  (the token tally)
const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../electron/store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-usage-'));
store.setDir(dir);
const usage = require('../electron/usage');

const day = new Date(2026, 9, 1, 12, 0);
usage.record('claude', 100, 40, day);
usage.record('claude', 50, 10, day);
usage.record('meta', 20, 5, day);
usage.record('claude', 7, 3, new Date(2026, 9, 2, 9, 0));   // another day, same month
usage.record('gemini', 9, 9, new Date(2026, 8, 30, 9, 0));  // last month
usage.record('claude', 0, 0, day);                          // nothing to record
usage.record('claude', NaN, -5, day);                       // junk is ignored
usage.record('', 5, 5, day);

const s = usage.summary(day);
assert.deepStrictEqual(s.today.claude, { input: 150, output: 50, replies: 2 }, 'today adds up per model');
assert.deepStrictEqual(s.today.meta, { input: 20, output: 5, replies: 1 });
assert.deepStrictEqual(s.month.claude, { input: 157, output: 53, replies: 3 }, 'month includes other days');
assert.ok(!s.month.gemini && !s.today.gemini, 'last month is not counted');
assert.strictEqual(Object.keys(s.today).length, 2, 'only real records are kept');
// Text is never stored: the file holds counts only.
assert.ok(/^[\d\s{}\[\]",:\-a-z]+$/.test(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')));
// Old days fall off.
usage.record('claude', 1, 1, new Date(2028, 0, 1));
assert.ok(!usage.summary(day).month.claude, 'data older than 400 days is dropped');
console.log('usage ok');

// ---- Ilyra can read the tally
{
  const U = require('../electron/usage');
  assert.ok(U.asks('How much usage do I have right now?'), 'a usage question is recognised');
  assert.ok(U.asks('Do you have access to see the usage?'), 'a yes/no question too');
  assert.ok(U.asks('show me my token count'), 'a request too');
  assert.ok(!U.asks('all good. I built a usage area that shows me how many tokens I am spending.'), 'a remark is not a question');
  assert.ok(!U.asks('what is the capital of France?'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-usage2-'));
  store.setDir(dir2);
  const d = new Date(2026, 9, 1, 12, 0);
  U.record('gemini', 1200, 300, d);
  U.record('claude', 3000, 900, d);
  const rep = U.report(d);
  assert.ok(/Today: 5\.4k tokens in all\./.test(rep.text), rep.text);
  assert.ok(/Claude 3\.9k \(3k in, 900 out\)/.test(rep.text) && /Gemini 1\.5k \(1\.2k in, 300 out\)/.test(rep.text), rep.text);
  assert.ok(/This month: 5\.4k/.test(rep.text));
  console.log('usage report ok');
}
