// Browser preview of the Ilyra UI (no AI calls; the desktop app does those).
// Serves the project root so web/index.html can reach ../node_modules.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/web/index.html' }); return res.end(); }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const file = path.normalize(path.join(ROOT, decoded));
  const allowed = [path.join(ROOT, 'web'), path.join(ROOT, 'node_modules')];
  if (!allowed.some((dir) => file.startsWith(dir + path.sep))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
// Loopback only: the preview must not be reachable from the rest of the network.
server.on('error', (err) => { console.error(err.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`Ilyra UI preview at http://localhost:${PORT}`));
