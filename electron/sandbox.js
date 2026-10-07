// A hidden, locked-down browser window for turning a document into a PDF (the make_pdf tool).
// It is sandboxed with no Node access and no preload, and every network request from it is
// refused, so nothing in it can read your files or send anything out.
const { BrowserWindow, session } = require('electron');

const MAX_PDF_HTML = 2 * 1024 * 1024;
let locked = null;

function lockedSession() {
  if (locked) return locked;
  locked = session.fromPartition('ilyra-sandbox');
  locked.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(data|about):/.test(d.url) }));
  locked.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  return locked;
}

async function withWindow(html, job) {
  const win = new BrowserWindow({
    show: false, width: 816, height: 1056,
    webPreferences: { session: lockedSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await job(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Lays out an HTML document and prints it to PDF bytes.
function makePdf(html) {
  if (html.length > MAX_PDF_HTML) throw new Error('That document is too large to turn into a PDF.');
  return withWindow(html, async (win) => {
    await new Promise((r) => setTimeout(r, 300)); // let inline scripts (charts) draw
    return win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { marginType: 'default' } });
  });
}

// withWindow is also used by extras/runcode.js.
module.exports = { makePdf, withWindow };
