// Every page Ilyra has made, found in the saved chats: the HTML and SVG code blocks in its
// replies that the chat shows as artifact cards (web/app.js addArtifacts). Nothing extra is
// stored; deleting a chat removes its pages from the gallery too.
const store = require('../store');

// The same test the chat uses to decide a code block is a page.
const LOOKS_LIKE_PAGE = /<(!doctype|html|head|body|svg|div|canvas|main|section|style|script)\b/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(html|htm|svg|xml)\b[^\n]*\n/gim;

function title(code) {
  const m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code);
  return m ? m[1].trim() : 'Web page';
}

// The page code blocks in one message, in order. A block left open runs to the end, as marked shows it.
function pagesIn(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('\n')) return out;
  FENCE.lastIndex = 0;
  let m;
  while ((m = FENCE.exec(text))) {
    const start = m.index + m[0].length;
    const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}[ \\t]*$`, 'm');
    const rest = text.slice(start);
    const end = close.exec(rest);
    const code = end ? rest.slice(0, end.index).replace(/\n$/, '') : rest;
    if (LOOKS_LIKE_PAGE.test(code)) out.push(code);
    FENCE.lastIndex = start + (end ? end.index + end[0].length : rest.length);
  }
  return out;
}

// Newest first. The same page sent again (an unchanged copy in a later reply) is listed once,
// at its newest. ids are "<chat id>:<message index>:<block index>".
function list() {
  const seen = new Set();
  const out = [];
  for (const entry of store.chats.list()) {
    let chat;
    try { chat = store.chats.get(entry.id); } catch { continue; }
    if (!chat || !Array.isArray(chat.messages)) continue;
    chat.messages.forEach((msg, i) => {
      if (!msg || msg.role !== 'assistant') return;
      pagesIn(msg.content).forEach((code, n) => {
        out.push({
          id: `${chat.id}:${i}:${n}`, chatId: chat.id, chatTitle: chat.title || 'Untitled chat',
          title: title(code), at: msg.at || chat.updated || 0, size: code.length,
          offline: Boolean(msg.localData), model: msg.model || '', code
        });
      });
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.filter((p) => !seen.has(p.code) && seen.add(p.code)).map(({ code, ...rest }) => rest);
}

// One page's code, for the preview.
function get(id) {
  const [chatId, i, n] = String(id || '').split(':');
  const chat = chatId && store.chats.get(chatId);
  const msg = chat && Array.isArray(chat.messages) ? chat.messages[Number(i)] : null;
  if (!msg || msg.role !== 'assistant') return null;
  const code = pagesIn(msg.content)[Number(n)];
  return code ? { html: code, offline: Boolean(msg.localData) } : null;
}

module.exports = { list, get, pagesIn, title };
