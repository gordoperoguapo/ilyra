// Particle orb ("Ilyra soul"). States: idle | listening | thinking | speaking.
// A shell of particles on a sphere, tinted with whatever model is active.
// Each state moves the shell differently: idle breathes, listening swells with
// the microphone, thinking swirls in bands, speaking ripples with the voice.
// The large orb tilts toward the pointer and a click sends a pulse through it.
// Particles are drawn in a few brightness batches (one fill each) instead of
// one by one, so thousands of them stay smooth.
window.createOrb = function (canvas) {
  var ctx = canvas.getContext('2d');
  var holder = canvas.parentElement;
  var sweep = holder && holder.querySelector('.ring-sweep');
  var COUNT = 2200;
  var BUCKETS = 7;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MIN_INTERACTIVE = 120; // px: the small header orb ignores the pointer
  var EDGE = 0.47;           // particles never pass this fraction of the canvas from the centre

  // Even spread over the sphere (Fibonacci spiral), with a little depth to the shell.
  var px0 = new Float32Array(COUNT), py0 = new Float32Array(COUNT), pz0 = new Float32Array(COUNT);
  var dot = new Float32Array(COUNT), phase = new Float32Array(COUNT), rate = new Float32Array(COUNT);
  var seed = 741103;
  function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  var GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (var i = 0; i < COUNT; i++) {
    var y = 1 - (i / (COUNT - 1)) * 2;
    var ring = Math.sqrt(1 - y * y);
    var spin = GOLDEN * i;
    var shell = 0.88 + random() * 0.12;
    px0[i] = Math.cos(spin) * ring * shell;
    py0[i] = y * shell;
    pz0[i] = Math.sin(spin) * ring * shell;
    dot[i] = 0.4 + random() * 1.1;
    phase[i] = random() * Math.PI * 2;
    rate[i] = 0.5 + random() * 2.5;
  }
  // The header orb draws an even sample of fewer, bigger dots; any stride of the spiral covers the sphere.
  var order = new Uint16Array(COUNT);
  (function () {
    var k = 0, step = 7;
    for (var s = 0; s < step; s++) for (var j = s; j < COUNT; j += step) order[k++] = j;
  })();

  // Per state: target energy, spin speed, outward spread and wave size (fractions of the radius).
  var STATES = {
    idle:      { energy: 0.15, speed: 0.18, spread: 0,     wave: 0.011, sweep: 12, core: 0.28 },
    listening: { energy: 0.5,  speed: 0.35, spread: 0.075, wave: 0.033, sweep: 8,  core: 0.4 },
    thinking:  { energy: 0.65, speed: 1.1,  spread: 0.022, wave: 0.067, sweep: 2.5, core: 0.5 },
    speaking:  { energy: 1,    speed: 0.5,  spread: 0.033, wave: 0.14,  sweep: 4,  core: 0.65 }
  };

  var size = 0;
  var state = 'idle';
  var energy = 0.15;
  var level = 0;            // live microphone or voice loudness 0..1
  var color = [245, 165, 36];
  var target = color.slice();
  var turn = 0, tiltX = 0.25, tiltY = 0, aimX = 0.25, aimY = 0;
  var sweepAngle = 0;
  var pulses = [];
  var t = 0, last = 0;

  function resize() {
    var next = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
    if (next === size) return;
    size = next;
    pulses.length = 0;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reducedMotion) draw(performance.now());
  }

  function inside(e) {
    var r = canvas.getBoundingClientRect();
    if (r.width < MIN_INTERACTIVE) return false;
    var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    return dx * dx + dy * dy < (r.width / 2) * (r.width / 2);
  }
  if (!reducedMotion) {
    // The big orb leans gently toward the pointer anywhere in the window.
    window.addEventListener('pointermove', function (e) {
      aimY = (e.clientX / window.innerWidth - 0.5) * 0.8;
      aimX = 0.25 + (e.clientY / window.innerHeight - 0.5) * 0.6;
    });
    document.addEventListener('pointerleave', function () { aimX = 0.25; aimY = 0; });
    window.addEventListener('pointerdown', function (e) {
      if (!inside(e)) return;
      pulses.push(0);
      if (pulses.length > 4) pulses.shift();
    });
  }

  // A fake voice envelope for speaking without real audio (cloud voices play
  // in the page and only report loudness when they can).
  function voice(time) {
    return 0.45 + 0.28 * Math.sin(time * 7.3) * Math.sin(time * 3.1 + 1) + 0.18 * Math.sin(time * 13.7 + 0.5) + 0.09 * Math.sin(time * 23);
  }

  // Bucket k of BUCKETS: brighter buckets lean toward white, like light catching the front of the shell.
  function shade(k, lift) {
    var mix = Math.min(0.85, 0.22 + (k / (BUCKETS - 1)) * 0.55 + lift);
    var out = [];
    for (var c = 0; c < 3; c++) out.push(Math.round(color[c] + (255 - color[c]) * mix));
    return out.join(',');
  }

  var paths = [];
  function draw(now) {
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    t += dt;
    var cfg = STATES[state] || STATES.idle;
    energy += (Math.min(1, cfg.energy + level * 0.4) - energy) * Math.min(1, dt * 3);
    for (var c = 0; c < 3; c++) color[c] += (target[c] - color[c]) * Math.min(1, dt * 3);

    var small = size < MIN_INTERACTIVE;
    turn += dt * cfg.speed * (1 + energy * 0.6);
    tiltX += ((small ? 0.25 : aimX) - tiltX) * Math.min(1, dt * 3);
    tiltY += ((small ? 0 : aimY) - tiltY) * Math.min(1, dt * 3);

    var center = size / 2;
    var R = size * 0.46;
    var breathe = 1 + Math.sin(t * 1.4) * 0.022 + (state === 'listening' ? Math.sin(t * 3.2) * 0.018 : 0);
    var v = state === 'speaking' ? Math.max(0.1, level > 0.02 ? 0.35 + level * 0.9 : voice(t)) : 0.2 + energy * 0.3 + (state === 'listening' ? level * 0.6 : 0);
    var cosY = Math.cos(turn + tiltY), sinY = Math.sin(turn + tiltY);
    var cosX = Math.cos(tiltX), sinX = Math.sin(tiltX);
    var fov = 900 / 560 * size; // the same perspective at any size
    var limit = size * EDGE;

    for (var p = pulses.length - 1; p >= 0; p--) { pulses[p] += dt; if (pulses[p] > 1.2) pulses.splice(p, 1); }

    var count = small ? Math.min(COUNT, Math.round(size * size * 0.15)) : COUNT;
    var dotScale = small ? Math.max(0.8, size / 45) : Math.max(0.55, size / 380);
    for (var b = 0; b < BUCKETS; b++) paths[b] = new Path2D();

    for (var n = 0; n < count; n++) {
      var i = small ? order[n] : n;
      var bx = px0[i], by = py0[i], bz = pz0[i];
      var x = bx * cosY - bz * sinY;
      var z = bx * sinY + bz * cosY;
      var y2 = by * cosX - z * sinX;
      var z2 = by * sinX + z * cosX;

      var d;
      if (state === 'speaking') {
        var w = Math.sin(by * 6 + t * 9) * Math.cos(bx * 5 - t * 7.5) + Math.sin((bx + bz) * 8 + t * 11) * 0.6;
        d = (w * cfg.wave + cfg.spread) * v;
      } else if (state === 'thinking') {
        d = Math.sin(by * 9 + t * 4) * 0.5 * cfg.wave + Math.sin(t * 3 + phase[i]) * 0.017 + cfg.spread;
        // Bands near the poles turn faster than the middle: a slow swirl.
        var sw = t * 0.9 * (0.5 + by * 0.5);
        var cs = Math.cos(sw), sn = Math.sin(sw);
        var xx = x * cs - z2 * sn;
        z2 = x * sn + z2 * cs;
        x = xx;
      } else {
        d = Math.sin(t * 2 + phase[i]) * cfg.wave + cfg.spread * (0.6 + v);
      }
      // A click pulse: a bright band that runs from the front of the orb to the back.
      for (var q = 0; q < pulses.length; q++) {
        var front = 1 - pulses[q] * 1.8;
        var off = z2 + front;
        d += Math.exp(-off * off * 18) * 0.12 * (1 - pulses[q] / 1.2);
      }

      var scale = R * breathe * (1 + d * 0.5);
      x *= scale; y2 *= scale; z2 *= scale;
      var s = fov / (fov + z2 + fov / 3);
      var ox = x * s, oy = y2 * s;
      var out = Math.sqrt(ox * ox + oy * oy);
      if (out > limit) { ox *= limit / out; oy *= limit / out; }

      var depth = (z2 / R + 1) / 2;                       // 0 at the back, 1 at the front
      var twinkle = 0.55 + 0.45 * Math.sin(t * rate[i] + phase[i]);
      var alpha = (0.15 + (1 - depth) * 0.85) * twinkle;   // z grows away from the viewer
      var r = Math.max(0.3, dot[i] * s * (0.7 + (1 - depth) * 0.9) * (1 + v * 0.5) * dotScale);
      var k = Math.max(0, Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS)));
      var cx = center + ox, cy = center + oy;
      paths[k].moveTo(cx + r, cy);
      paths[k].arc(cx, cy, r, 0, Math.PI * 2);
    }

    ctx.clearRect(0, 0, size, size);
    // The soft glow at the heart of the orb.
    var glow = (cfg.core + v * 0.2 + Math.sin(t * 2) * 0.03) * (small ? 0.6 : 1);
    var gr = R * 0.6 * (1 + v * 0.25 + Math.sin(t * 1.4) * 0.04);
    var g = ctx.createRadialGradient(center, center, 0, center, center, gr * 1.5);
    g.addColorStop(0, 'rgba(' + shade(1, 0) + ',' + (glow * 0.55).toFixed(3) + ')');
    g.addColorStop(0.45, 'rgba(' + shade(0, 0) + ',' + (glow * 0.2).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + shade(0, 0) + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'lighter';
    var lift = state === 'speaking' ? 0.1 : state === 'listening' ? 0.06 : 0;
    for (var k2 = 0; k2 < BUCKETS; k2++) {
      ctx.fillStyle = 'rgba(' + shade(k2, lift) + ',' + Math.min(1, (k2 + 0.5) / BUCKETS + (state === 'speaking' ? 0.15 : 0)).toFixed(3) + ')';
      ctx.fill(paths[k2]);
    }
    ctx.globalCompositeOperation = 'source-over';

    // The bright arc that circles the orb runs faster as Ilyra works.
    if (sweep && !small) {
      sweepAngle = (sweepAngle + dt * 360 / cfg.sweep) % 360;
      sweep.style.transform = 'rotate(' + sweepAngle.toFixed(1) + 'deg)';
    }
    if (holder) holder.style.setProperty('--orb-rgb', color.map(Math.round).join(','));

    if (!reducedMotion) requestAnimationFrame(draw);
  }

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  resize();
  requestAnimationFrame(draw);

  return {
    setState: function (next) { state = STATES[next] ? next : 'idle'; if (reducedMotion) draw(performance.now()); },
    setLevel: function (value) { level = Math.max(0, Math.min(1, value)); },
    setColor: function (rgb, instant) {
      target = rgb.slice();
      if (instant || reducedMotion) color = rgb.slice();
      if (reducedMotion) draw(performance.now());
    }
  };
};
