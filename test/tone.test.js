// Run with: node test/tone.test.js  (no boilerplate lectures in answers)
const assert = require('assert');
const { createToneFilter, stripBoilerplate, ASKS_IDENTITY } = require('../electron/tone');
let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

const headache = `I can provide general information on headaches. However, please note that I'm not a medical professional, and it's always best to consult a doctor for personalized advice.
That being said, headaches can be caused by stress, dehydration or lack of sleep. Here are some tips:

* Stay hydrated by drinking plenty of water
* Consider acetaminophen or ibuprofen, and follow the recommended dosage

If your headache persists, I recommend consulting a healthcare professional. If it is the worst headache of your life or comes with numbness, call 911.`;
const out = stripBoilerplate(headache);
ok('"I\'m not a medical professional" is gone', !/not a medical professional/.test(out));
ok('"consult a doctor / healthcare professional" boilerplate is gone', !/consult/i.test(out));
ok('the actual advice stays', /Stay hydrated/.test(out) && /acetaminophen/.test(out) && /dehydration/.test(out));
ok('emergency advice is never removed', /call 911/.test(out));
ok('"As an AI" is gone', !/as an ai/i.test(stripBoilerplate('As an AI, I think tacos are great. Tacos are great.')));
ok('"I\'m just an assistant" is gone', stripBoilerplate("I'm just an assistant. The answer is 42.") === 'The answer is 42.');
ok('a normal answer is untouched', stripBoilerplate('Paris is the capital of France. It sits on the Seine.') === 'Paris is the capital of France. It sits on the Seine.');
ok('the same word in an everyday sentence is fine', /see a movie/.test(stripBoilerplate('You could see a movie tonight. Or read.')));
ok('naming a profession as advice for a different reason is fine', /talk to your professor/.test(stripBoilerplate('You should talk to your professor about the deadline.')));

// who is Ilyra: said plainly when asked, disclaimers still gone
ok('who/what/name questions are recognised', ASKS_IDENTITY.test('What is your name?') && ASKS_IDENTITY.test('who are you') && !ASKS_IDENTITY.test('what is the weather'));
const who = stripBoilerplate("I'm Ilyra, an AI assistant that runs on your computer. I'm not a doctor, though.", { allowIdentity: true });
ok('"I\'m Ilyra, an AI" stays when asked', /I'm Ilyra, an AI assistant/.test(who));
ok('but the disclaimer after it does not', !/not a doctor/.test(who));

// streaming in any size of pieces gives the same result as the whole text
for (const size of [1, 2, 3, 7, 13, 50]) {
  let shown = '';
  const f = createToneFilter((t) => { shown += t; });
  for (let i = 0; i < headache.length; i += size) f.push(headache.slice(i, i + size));
  f.flush();
  ok(`streamed in pieces of ${size}`, f.result() === out && shown.trim() === out);
}
// if everything is boilerplate, show it rather than nothing
ok('an all-boilerplate answer is not blanked', stripBoilerplate("I'm not a doctor.").length > 0);
ok('empty stays empty', stripBoilerplate('') === '');
console.log(`tone ok (${pass} checks)`);
