// The artifacts gallery: finding the pages Ilyra made in saved chats.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
const ok = (name, cond) => { if (!cond) { console.error('FAIL', name); process.exit(1); } pass++; };

const store = require('../electron/store');
store.setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'ilyra-gallery-')));
store.setCrypto({ available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() });
const gallery = require('../electron/extras/gallery');

const page = (t) => `<!doctype html><html><head><title>${t}</title></head><body>hi</body></html>`;

ok('finds an html block', gallery.pagesIn('Here:\n```html\n' + page('A') + '\n```\nDone.').length === 1);
ok('keeps the code exactly', gallery.pagesIn('```html\n' + page('A') + '\n```')[0] === page('A'));
ok('svg and longer fences count', gallery.pagesIn('````svg\n<svg viewBox="0 0 1 1"></svg>\n````').length === 1);
ok('a four-backtick block holds a three-backtick line', gallery.pagesIn('````html\n<div>\n```\n</div>\n````')[0] === '<div>\n```\n</div>');
ok('an unclosed block runs to the end', gallery.pagesIn('```html\n' + page('Open')).length === 1);
ok('other languages are not pages', gallery.pagesIn('```js\nconsole.log("<div>")\n```').length === 0);
ok('html that is not a page is skipped', gallery.pagesIn('```html\nplain words\n```').length === 0);
ok('two pages in one reply', gallery.pagesIn('```html\n' + page('A') + '\n```\nand\n```html\n' + page('B') + '\n```').length === 2);
ok('the title comes from <title>', gallery.title(page('My game')) === 'My game' && gallery.title('<div></div>') === 'Web page');

store.chats.save({ id: 'c1', title: 'Old chat', updated: 1000, messages: [
  { role: 'user', content: 'make a page', at: 900 },
  { role: 'assistant', content: '```html\n' + page('First') + '\n```', at: 1000, model: 'claude' }
] });
store.chats.save({ id: 'c2', title: 'New chat', updated: 3000, messages: [
  { role: 'user', content: '```html\n' + page('Pasted by me') + '\n```', at: 1900 },
  { role: 'assistant', content: '```html\n' + page('Second') + '\n```', at: 2000, localData: true },
  { role: 'assistant', content: 'again:\n```html\n' + page('First') + '\n```', at: 3000 }
] });

const list = gallery.list();
ok('pages from every chat, newest first, the same page once', list.map((p) => p.title).join(',') === 'First,Second');
ok('a repeated page is listed at its newest', list[0].chatId === 'c2' && list[0].at === 3000);
ok('the user\'s own messages are not listed', !list.some((p) => p.title === 'Pasted by me'));
ok('the list carries no code', list.every((p) => p.code === undefined && p.html === undefined));
ok('pages made after reading local data stay offline', list[1].offline === true && list[0].offline === false);
ok('get returns the page', gallery.get(list[1].id).html === page('Second') && gallery.get(list[1].id).offline === true);
ok('a bad id returns nothing', gallery.get('nope:1:0') === null && gallery.get('c1:0:0') === null && gallery.get('') === null);

console.log(`gallery ok (${pass} checks)`);
