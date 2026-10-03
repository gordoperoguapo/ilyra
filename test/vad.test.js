// The talk-mode voice detector, on synthetic sound: voices are harmonic and move, noise is not.
const assert = require('assert');
const { features, createVad, looksLikeNoise } = require('../web/vad.js');
const RATE = 16000, N = 512, FRAME_MS = 32;
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };

// Naive DFT of one frame -> dB per bin (what an AnalyserNode reports), Hann-windowed.
function spectrum(x) {
  const bins = N / 2, out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N); const a = 2 * Math.PI * k * n / N; re += x[n] * w * Math.cos(a); im -= x[n] * w * Math.sin(a); }
    out[k] = 20 * Math.log10(Math.sqrt(re * re + im * im) / N + 1e-9);
  }
  return out;
}
const frameAt = (t, gen) => { const x = new Float32Array(N); for (let n = 0; n < N; n++) x[n] = gen(t + n / RATE); return x; };
const hum = (t) => 0.02 * Math.sin(2 * Math.PI * 60 * t) + 0.01 * rnd();
const hiss = () => 0.03 * rnd();
const voice = (amp) => (t) => { const f0 = 130 + 20 * Math.sin(t * 3); let s = 0; for (let h = 1; h <= 14; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h; return amp * s * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + 0.002 * rnd(); };
const tv = (t) => { let s = 0; for (const f of [180, 340, 520, 700, 910]) s += Math.sin(2 * Math.PI * f * t + 1) / 3; return 0.02 * s; };

function run(segments, opts) {
  const vad = createVad(opts); let t = 0, started = 0, ended = 0;
  for (const [sec, gen] of segments) for (let i = 0; i < sec * 1000 / FRAME_MS; i++) {
    const r = vad.push(features(spectrum(frameAt(t, gen)), RATE), FRAME_MS); t += FRAME_MS / 1000;
    if (r.started) started++; if (r.ended) ended++;
  }
  return { started, ended, vad };
}
const silence = () => 0.0004 * rnd();

const music = (t) => { let s = 0; for (const [f, a] of [[220, 1], [440, .8], [660, .6], [880, .5], [1320, .3], [330, .7]]) s += a * Math.sin(2 * Math.PI * f * t) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 2 * t)); return 0.012 * s; };
let r = run([[3, silence], [3, hiss], [3, hum]]);
assert.strictEqual(r.started, 0, 'room noise alone never starts a turn');
r = run([[2, hiss], [3, tv]]);
assert.strictEqual(r.started, 0, 'a steady TV left on becomes the floor, not your voice');
r = run([[2, silence], [2, voice(0.08)], [1.5, silence]]);
assert.strictEqual(r.started, 1, 'a voice starts a turn'); assert.strictEqual(r.ended, 1, 'and a pause ends it');
r = run([[3, hiss], [2, voice(0.15)], [1.5, hiss]]);
assert.strictEqual(r.started, 1, 'a voice over hiss starts a turn'); assert.strictEqual(r.ended, 1);
r = run([[3, hum], [2, voice(0.1)], [1.5, hum]]);
assert.strictEqual(r.started, 1, 'a voice over a fan hum starts a turn');
r = run([[2, silence], [2, voice(0.012)], [1.5, silence]]);
assert.strictEqual(r.started, 1, 'a quiet voice is still picked up, because it is judged against the room');
r = run([[2, silence], [0.1, voice(0.2)], [2, silence]]);
assert.strictEqual(r.started, 0, 'a click or cough is not a turn');
r = run([[2, silence], [1.5, voice(0.08)], [0.5, silence], [1.5, voice(0.08)], [1.5, silence]]);
assert.strictEqual(r.started, 1, 'a short pause mid-sentence does not split the turn'); assert.strictEqual(r.ended, 1);
r = run([[2, silence], [30, voice(0.08)]], { maxTurnMs: 5000 });
assert.ok(r.ended >= 1, 'a turn ends at the time cap');

r = run([[4, music], [0.001, music]]);
assert.strictEqual(r.started, 0, 'music already playing is the floor, not a turn');
r = run([[4, music], [2, (t) => voice(0.12)(t) + music(t)], [2.5, music]]);
assert.strictEqual(r.started, 1, 'a voice over music starts a turn'); assert.strictEqual(r.ended, 1, 'and it ends when you stop, though the music goes on');
assert.ok(looksLikeNoise('', 2000)); assert.ok(looksLikeNoise('[music]', 3000)); assert.ok(looksLikeNoise('you', 300)); assert.ok(looksLikeNoise('Thank you.', 400));
assert.ok(!looksLikeNoise('Thank you.', 1500), 'a longer real recording keeps short words');
assert.ok(!looksLikeNoise('what is the weather', 300));
console.log('vad tests passed');
