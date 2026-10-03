// Renders build/icon.png (512x512) and web/logo.svg from scripts/logo.js using Electron itself.
// Run with: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const logo = require('./logo');
const SVG = logo.icon();

// The in-app mark lives next to the page as a plain file.
fs.writeFileSync(path.join(__dirname, '..', 'web', 'logo.svg'), logo.brand());

app.whenReady().then(async () => {
  // Offscreen rendering paints without a visible window; grab the first frame.
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true }
  });
  win.webContents.setFrameRate(10);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done || image.isEmpty()) return;
    done = true;
    const out = path.join(__dirname, '..', 'build', 'icon.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
    console.log('Wrote', out);
    app.quit();
  });
  setTimeout(() => { if (!done) { console.error('Icon render timed out'); app.exit(1); } }, 15000);
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`
  ));
});
