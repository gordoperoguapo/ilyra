// Run with: node test/recall.test.js  (general memory: finding and keeping anything you say)
const assert = require('assert');
const http = require('http');
const R = require('../electron/extras/recall');
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

// A few saved chats, as the store returns them.
const chats = {
  a: { id: 'a', title: 'Dinner', updated: 3, messages: [{ role: 'user', content: 'I have 3 kids and they all hate broccoli' }, { role: 'assistant', content: 'Fun!' }] },
  b: { id: 'b', title: 'Trip', updated: 2, messages: [{ role: 'user', content: 'My wife Amy and I are flying to Lisbon in March' }, { role: 'user', content: 'How many days should I stay?' }] },
  c: { id: 'c', title: 'Code', updated: 1, messages: [{ role: 'user', content: 'Write a python script that parses a csv file' }] },
  now: { id: 'now', title: 'This chat', updated: 4, messages: [{ role: 'user', content: 'I have 9 turtles' }] }
};
const store = { list: () => Object.values(chats).map((c) => ({ id: c.id })), get: (id) => chats[id] };
const find = (q, memoryText = '') => R.relevant(q, { memoryText, store, chatId: 'now' }).map((r) => r.text);

// ---- Reading: anything you said is findable, with different wording
ok('kids found from an earlier chat', find('how many kids do I have?').some((t) => /3 kids/.test(t)));
ok('"children" finds "kids"', find('how many children do I have').some((t) => /3 kids/.test(t)));
ok('wife found', find("what's my wife called?").some((t) => /Amy/.test(t)));
ok('the current chat is not searched', !find('do I have any turtles').some((t) => /turtles/.test(t)));
ok('questions are not treated as facts', !find('how many days should I stay').some((t) => /How many days/.test(t)));
ok('unrelated question finds nothing', find('what is the capital of France').length === 0);
ok('common words alone find nothing', find('what do you think about it').length === 0);
ok('memory lines are searched too', find('where do I work?', '- The user works at a hospital\n- The user has a dog named Max').some((t) => /hospital/.test(t)));
ok('memory ranks above a chat mention', find('how many kids do I have', '- The user has 4 children')[0] === 'The user has 4 children');
ok('at most the limit comes back', R.relevant('kids wife work', { memoryText: Array.from({ length: 20 }, (_, i) => (i < 6 ? `- The user has kid number ${i}` : `- The user likes hobby number ${i}`)).join('\n'), limit: 3 }).length === 3);

// ---- Writing: when to learn, and what comes back
ok('statements about me are learned', R.shouldLearn('I have 3 kids and a dog named Max'));
ok('"my" statements are learned', R.shouldLearn('my daughter Mia turns 7 in May'));
ok('questions are not', !R.shouldLearn('how many kids do I have?'));
ok('any statement about us is considered', R.shouldLearn('We just adopted two rescue greyhounds called Bolt and Dash'));
ok('code is not', !R.shouldLearn('I wrote this:\n```js\nlet a = 1\n```'));
ok('requests with no mention of the user are not', !R.shouldLearn('write a poem about autumn'));
ok('very short text is not', !R.shouldLearn('hi'));

const good = JSON.stringify({ facts: ['The user has 3 children', 'The user has a dog named Max.'] });
ok('facts parse', R.parseFacts(good).length === 2 && R.parseFacts(good)[1] === 'The user has a dog named Max');
ok('a bare array parses too', R.parseFacts(JSON.stringify(['The user lives in Austin'])).length === 1);
ok('secrets are dropped', R.parseFacts(JSON.stringify({ facts: ['The user password is hunter2', 'The user has an API key abc'] })).length === 0);
ok('facts must be about the user', R.parseFacts(JSON.stringify({ facts: ['Paris is in France', 'The sky is blue'] })).length === 0);
ok('junk is survivable', R.parseFacts('not json').length === 0 && R.parseFacts('{"facts": 5}').length === 0 && R.parseFacts(null).length === 0);
ok('at most five facts', R.parseFacts(JSON.stringify({ facts: Array.from({ length: 9 }, (_, i) => `The user likes thing number ${i}`) })).length === 5);

let m = R.merge('', ['The user has 3 children', 'The user has a dog named Max']);
ok('facts are added', m.text === '- The user has 3 children\n- The user has a dog named Max\n' && m.added.length === 2);
m = R.merge(m.text, ['The user has 3 children']);
ok('a repeat is skipped', m.added.length === 0);
m = R.merge(m.text, ['The user has 4 children']);
ok('a changed count replaces the old line', m.text === '- The user has a dog named Max\n- The user has 4 children\n');
m = R.merge('- Children: 3\n- Car: 2016 Corolla\n', ['The user has 4 children']);
ok('it also replaces the older "Label: value" style', m.text === '- Car: 2016 Corolla\n- The user has 4 children\n');
m = R.merge('- Children: 3\n', ['The user has 3 children']);
ok('and does not duplicate it', m.added.length === 0 && m.text === '- Children: 3\n');
m = R.merge('- The user works at a hospital\n', ['The user has 2 cats']);
ok('unrelated facts are kept side by side', m.text.split('\n').filter(Boolean).length === 2);
ok('memory is never cut off silently', R.merge('x'.repeat(5990), ['The user has 3 children'], 6000).added.length === 0);

console.log(`recall ok (${pass} checks)`);
