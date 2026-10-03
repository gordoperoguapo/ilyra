// Decides when you are talking, using only what the microphone hears, on this computer.
//
// A plain volume threshold can't tell a voice from a fan, a TV or keyboard clatter, so a
// frame only counts as speech when it looks like a voice:
//  - clearly louder than the room's own noise (measured in dB over a floor that is learned
//    while nobody talks, so it works the same on a quiet laptop mic or a loud headset),
//  - most of its energy in the voice band (about 150 Hz to 3.4 kHz),
//  - and "peaky" rather than flat: voices have harmonics, hiss and rumble are flat.
// A turn starts only after enough speech-like frames inside a short window (one cough or
// click is not a turn) and ends after a real pause. The caller also gets how many
// milliseconds were speech, to drop a recording that was only noise.
(function (root) {
  var VOICE_LO = 150, VOICE_HI = 3400;
  var START_DB = 9;       // louder than the floor by this much to start
  var KEEP_DB = 5;        // and by this much to keep going (a pause between words is quieter)
  var MAX_FLAT = 0.38;    // spectral flatness above this looks like noise
  var MIN_VOICE_SHARE = 0.3;
  var FOLLOW_DB = 12;     // while talking, a frame must be within this of your own peak level

  // dB values per FFT bin (from AnalyserNode.getFloatFrequencyData) -> what a frame sounds like.
  function features(db, sampleRate) {
    var n = db.length;
    var binHz = sampleRate / 2 / n;
    var lo = Math.max(1, Math.floor(VOICE_LO / binHz));
    var hi = Math.min(n - 1, Math.ceil(VOICE_HI / binHz));
    var total = 0, voice = 0, logSum = 0, count = 0;
    var floorBin = Math.max(1, Math.floor(60 / binHz)); // mains rumble below this says nothing about voices
    for (var i = floorBin; i < n; i++) {
      var p = Math.pow(10, Math.max(db[i], -140) / 10);
      total += p;
      if (i >= lo && i <= hi) { voice += p; logSum += Math.log(p + 1e-20); count++; }
    }
    if (!count || voice <= 0) return { voiceDb: -140, flat: 1, share: 0 };
    var arith = voice / count;
    return { voiceDb: 10 * Math.log10(voice), flat: Math.exp(logSum / count) / arith, share: voice / (total || 1) };
  }

  function createVad(opts) {
    opts = opts || {};
    var silenceMs = opts.silenceMs || 900;
    var maxTurnMs = opts.maxTurnMs || 20000;
    var startMs = opts.startMs || 300;      // speech-like time needed inside the window
    var windowMs = opts.windowMs || 600;
    var floor = null;
    var peak = -140;                        // your own level this turn, decaying slowly
    var talking = false;
    var recent = [];                        // [{ ms, speech }] inside the window
    var turnMs = 0, quietMs = 0, speechMs = 0;

    function speechLike(f, margin) {
      var over = f.voiceDb - floor;
      if (over < margin) return false;
      // Once you're talking, only sound close to YOUR level keeps the turn going, so music
      // or chatter in the background can't hold it open through your pauses.
      if (talking && f.voiceDb < peak - FOLLOW_DB) return false;
      return f.share >= MIN_VOICE_SHARE && f.flat <= MAX_FLAT;
    }

    return {
      // One analysed frame lasting `dt` ms. Returns { talking, started, ended }.
      push: function (f, dt) {
        if (floor == null) floor = f.voiceDb;
        var is = speechLike(f, talking ? KEEP_DB : START_DB);
        // The room's noise: learned only from frames that aren't speech. It falls fast
        // to quiet moments and rises slowly, so a TV left on becomes the floor, not a voice.
        if (talking) peak = Math.max(peak - dt / 1000, is ? f.voiceDb : -140);
        // Steady sound before you speak, even music, is the room: it feeds the floor.
        if (!talking) floor = f.voiceDb < floor ? floor * 0.9 + f.voiceDb * 0.1 : floor + (f.voiceDb - floor) * Math.min(1, dt / (is ? 6000 : 3000));
        var out = { talking: talking, started: false, ended: false };
        if (!talking) {
          recent.push({ ms: dt, speech: is });
          var span = 0, hit = 0;
          for (var i = recent.length - 1; i >= 0; i--) { span += recent[i].ms; if (recent[i].speech) hit += recent[i].ms; if (span > windowMs) { recent.splice(0, i); break; } }
          if (hit >= startMs) { talking = true; peak = f.voiceDb; out.talking = out.started = true; turnMs = 0; quietMs = 0; speechMs = hit; recent = []; }
          return out;
        }
        turnMs += dt;
        if (is) { quietMs = 0; speechMs += dt; } else quietMs += dt;
        if (quietMs > silenceMs || turnMs > maxTurnMs) { out.ended = true; out.talking = false; talking = false; }
        return out;
      },
      floor: function () { return floor; },
      speechMs: function () { return speechMs; },
      reset: function () { talking = false; recent = []; turnMs = quietMs = speechMs = 0; }
    };
  }

  // What the speech model says when it was handed noise or near silence.
  var PHANTOM = /^(?:(?:you|the|a|uh|um|hmm+|mm+|ah|oh|so|and|okay|yeah|thanks?(?: you)?(?: for watching)?|thank you|bye|\.+)[\s.,!?]*)+$/i;
  function looksLikeNoise(text, speechMs) {
    var t = String(text || '').trim();
    if (t.replace(/[^\w]/g, '').length < 2) return true;
    if (/^\W*(?:\[.*\]|\(.*\))\W*$/.test(t)) return true;  // "[music]", "(silence)"
    return speechMs < 700 && PHANTOM.test(t);
  }

  var api = { features: features, createVad: createVad, looksLikeNoise: looksLikeNoise };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.IlyraVad = api;
})(typeof window !== 'undefined' ? window : globalThis);
