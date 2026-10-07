// run_code for the local model: JavaScript run in a hidden, locked-down window (see sandbox.js)
// with no Node access, no files and no network, stopped after ten seconds. The cloud models run
// code on their providers' side; this gives the local model exact maths, dates and data work.
const { withWindow } = require('../sandbox');

const RUN_TIMEOUT = 10000;

// Runs JavaScript and returns what it printed (console.log) and returned.
function runCode(code) {
  const script = `(async () => {
    const out = [];
    const show = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } })();
    console.log = console.info = console.warn = console.error = (...a) => out.push(a.map(show).join(' '));
    try {
      const result = await new (async () => {}).constructor(${JSON.stringify(String(code))})();
      if (result !== undefined) out.push(show(result));
    } catch (e) { out.push('Error: ' + ((e && e.message) || e)); }
    return out.join('\\n');
  })()`;
  return withWindow('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-eval\'">', (win) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // An endless loop never yields, so the page's process is ended outright.
        win.webContents.forcefullyCrashRenderer();
        reject(new Error(`The code ran longer than ${RUN_TIMEOUT / 1000} seconds and was stopped.`));
      }, RUN_TIMEOUT);
    });
    return Promise.race([win.webContents.executeJavaScript(script), timeout]).finally(() => clearTimeout(timer));
  });
}

module.exports = { runCode };
