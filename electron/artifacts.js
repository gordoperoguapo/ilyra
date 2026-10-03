// Pages the AI writes, served to the preview frame. A preview normally may load
// fonts, libraries and images from the web. After Ilyra has read your files, chats
// or clipboard in the same reply, the preview runs offline instead, because a page
// can otherwise send what it knows to any website just by loading an image.
const crypto = require('node:crypto');

const SCHEME = 'ilyra-artifact';
const ONLINE_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";
const OFFLINE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const MAX_HTML = 5e6;
const MAX_KEPT = 40;
const pages = new Map(); // id -> { html, offline }

function open(html, offline) {
  if (typeof html !== 'string' || !html || html.length > MAX_HTML) return null;
  const off = Boolean(offline);
  // The mode is part of the id, so the same page opened both ways stays separate.
  const id = crypto.createHash('sha256').update((off ? 'offline:' : 'online:') + html).digest('hex').slice(0, 32);
  pages.delete(id);
  pages.set(id, { html, offline: off });
  while (pages.size > MAX_KEPT) pages.delete(pages.keys().next().value);
  return `${SCHEME}://${id}/`;
}

const get = (id) => pages.get(id) || null;
const cspFor = (entry) => (entry.offline ? OFFLINE_CSP : ONLINE_CSP);

// Is the frame at this address an offline preview? Unknown frames count as offline.
function isOffline(frameUrl) {
  try {
    const entry = pages.get(new URL(frameUrl).hostname);
    return entry ? entry.offline : true;
  } catch { return true; }
}

module.exports = { SCHEME, open, get, cspFor, isOffline, OFFLINE_CSP, ONLINE_CSP };
