// On-device speech to text, so recordings never leave this computer. The model (about 30 MB)
// downloads once into Ilyra's data folder and loads in the background at startup, so it's
// ready by the time you talk.
const path = require('node:path');

// Moonshine (free, MIT licensed) is built for fast on-device use: several times
// quicker than Whisper tiny with comparable accuracy, and it adds punctuation.
const MODEL = 'onnx-community/moonshine-tiny-ONNX';
const SEGMENT = 16000 * 30; // Moonshine is tuned for clips under about a minute
let recognizer = null;

// Only 16-bit PCM WAV, at most 8 MB (a two-minute recording is about 4 MB). The
// page records 16 kHz mono, but a WAV can carry extra chunks (some recorders add
// padding before the audio) and another rate or two channels, so the chunks are
// read properly and the audio converted to 16 kHz mono.
const MAX_WAV = 8 * 1024 * 1024;
function parseWav(b) {
  if (!Buffer.isBuffer(b) || b.length <= 44 || b.length > MAX_WAV) return null;
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = b.subarray(body, Math.min(b.length, body + size));
      break;
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000 || fmt.rate > 48000) return null;
  return Object.assign(fmt, { data });
}
const validWav = (b) => Boolean(parseWav(b));

// 16-bit PCM WAV -> 16 kHz mono Float32 samples.
function wavToFloat32(wav) {
  const { data, channels, rate } = parseWav(wav);
  const frames = Math.floor(data.length / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels / 32768;
  }
  if (rate === 16000) return mono;
  const out = new Float32Array(Math.floor(frames * 16000 / rate));
  for (let i = 0; i < out.length; i++) {
    const pos = i * rate / 16000, j = Math.floor(pos), t = pos - j;
    out[i] = mono[j] * (1 - t) + (mono[Math.min(j + 1, frames - 1)] || 0) * t;
  }
  return out;
}

async function load(cacheDir, onStatus) {
  if (recognizer) return recognizer;
  recognizer = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir || path.join(process.cwd(), '.models');
    return pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (onStatus && p.status === 'progress' && typeof p.progress === 'number') {
          onStatus(`Downloading the speech model… ${Math.round(p.progress)}%`);
        }
      }
    });
  })();
  recognizer.catch(() => { recognizer = null; }); // retry next time if the download failed
  return recognizer;
}

async function transcribe(wav, { cacheDir, onStatus } = {}) {
  const asr = await load(cacheDir, onStatus);
  if (onStatus) onStatus('Transcribing…');
  const samples = wavToFloat32(wav);
  const parts = [];
  for (let at = 0; at < samples.length; at += SEGMENT) {
    const res = await asr(samples.subarray(at, at + SEGMENT));
    parts.push((res.text || '').trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Start loading now; errors (e.g. offline the first time) are retried on use.
function warm(cacheDir) {
  load(cacheDir).catch(() => {});
}

module.exports = { transcribe, warm, validWav };
