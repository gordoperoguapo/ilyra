// A small version of the orb for the live status line, driven by real physics.
//  - A shell of particles, each on a spring to its place on a rotating sphere.
//  - A few satellites that really orbit: gravity pulls them in, so a kick sends
//    them swinging out and back along stretched orbits.
//  - kick() is called as the reply streams in: every chunk sends a pulse through
//    the shell, so the orb breathes with the text arriving.
//  - States: thinking (slow, calm), writing (livelier), working (fast, swirling).
window.createMiniOrb = function (canvas) {
  var ctx = canvas.getContext('2d');
  var SHELL = 64;
  var SATS = 12;
  var N = SHELL + SATS;
  var GRAVITY = 2.4;
  var REACH = 1.6; // world units from the centre to the canvas edge
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var pos = new Float32Array(N * 3);
  var vel = new Float32Array(N * 3);
  var home = new Float32Array(SHELL * 3);
  var size = 24;
  var color = [245, 158, 11];
  var state = 'thinking';
  var energy = 0.3;   // eased 0..1 from the state
  var pulse = 0;      // extra outward push from kick(), decays quickly
  var turn = 0;
  var last = 0;
  var raf = 0;
  var running = true;
  var seed = 90210;
  function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

  var i;
  for (i = 0; i < SHELL; i++) {
    // Fibonacci lattice: evenly spread points on a sphere.
    var y = 1 - 2 * (i + 0.5) / SHELL;
    var r = Math.sqrt(1 - y * y);
    var th = i * 2.399963;
    home[i * 3] = Math.cos(th) * r * 0.7;
    home[i * 3 + 1] = y * 0.7;
    home[i * 3 + 2] = Math.sin(th) * r * 0.7;
    pos[i * 3] = home[i * 3]; pos[i * 3 + 1] = home[i * 3 + 1]; pos[i * 3 + 2] = home[i * 3 + 2];
  }
  for (i = SHELL; i < N; i++) {
    // Satellites start on circular orbits at different heights and tilts.
    var radius = 1.0 + random() * 0.3;
    // A random spot and a random direction along the surface there: every satellite gets its own orbital plane.
    var pxu = random() * 2 - 1, pyu = random() * 2 - 1, pzu = random() * 2 - 1;
    var pl = Math.sqrt(pxu * pxu + pyu * pyu + pzu * pzu) || 1;
    pxu /= pl; pyu /= pl; pzu /= pl;
    var rx2 = random() * 2 - 1, ry2 = random() * 2 - 1, rz2 = random() * 2 - 1;
    var dotp = rx2 * pxu + ry2 * pyu + rz2 * pzu;
    var tx = rx2 - dotp * pxu, ty = ry2 - dotp * pyu, tz = rz2 - dotp * pzu;
    var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    var speed = Math.sqrt(GRAVITY / radius);
    pos[i * 3] = pxu * radius; pos[i * 3 + 1] = pyu * radius; pos[i * 3 + 2] = pzu * radius;
    vel[i * 3] = tx / tl * speed; vel[i * 3 + 1] = ty / tl * speed; vel[i * 3 + 2] = tz / tl * speed;
  }

  function fit() {
    var w = Math.round(canvas.getBoundingClientRect().width) || size;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = w;
    canvas.width = canvas.height = Math.round(w * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(time) {
    if (!running) return;
    if (!canvas.isConnected) { running = false; return; }
    var dt = Math.min(0.033, (time - last) / 1000 || 0.016);
    last = time;
    var goal = state === 'working' ? 1 : state === 'writing' ? 0.65 : 0.3;
    energy += (goal - energy) * Math.min(1, dt * 3);
    pulse *= Math.exp(-5 * dt);
    turn += dt * (0.6 + energy * 2.4);
    var sy = Math.sin(turn), cy = Math.cos(turn);
    var tilt = -0.35;
    var sx = Math.sin(tilt), cx = Math.cos(tilt);
    var drag = Math.exp(-5.5 * dt);
    var seconds = time * 0.001;
    var swirl = state === 'working' ? 3.2 : 0;
    var k, t;

    for (k = 0; k < SHELL; k++) {
      var o = k * 3;
      var hx = home[o], hy = home[o + 1], hz = home[o + 2];
      var rx = hx * cy - hz * sy;
      var rz = hx * sy + hz * cy;
      var ry = hy * cx - rz * sx;
      rz = hy * sx + rz * cx;
      var x = pos[o], yy = pos[o + 1], z = pos[o + 2];
      var ax = (rx - x) * 42, ay = (ry - yy) * 42, az = (rz - z) * 42;
      // Shimmer that grows with energy, a swirl about the vertical axis while working,
      // and the outward shove from each kick.
      t = seconds * 2.2 + k;
      ax += Math.sin(t * 1.3 + yy * 4) * 2.4 * energy - z * swirl * energy;
      ay += Math.sin(t * 1.1 + z * 4) * 2.4 * energy;
      az += Math.sin(t * 0.9 + x * 4) * 2.4 * energy + x * swirl * energy;
      if (pulse > 0.01) { ax += x * pulse * 60; ay += yy * pulse * 60; az += z * pulse * 60; }
      vel[o] = (vel[o] + ax * dt) * drag;
      vel[o + 1] = (vel[o + 1] + ay * dt) * drag;
      vel[o + 2] = (vel[o + 2] + az * dt) * drag;
      pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
    }

    for (k = SHELL; k < N; k++) {
      var s = k * 3;
      var px = pos[s], py = pos[s + 1], pz = pos[s + 2];
      var d2 = px * px + py * py + pz * pz + 0.05;
      var d = Math.sqrt(d2);
      var g = GRAVITY / (d2 * d);
      var vx = vel[s] - px * g * dt, vy = vel[s + 1] - py * g * dt, vz = vel[s + 2] - pz * g * dt;
      // A kick throws satellites outward; gravity then pulls them back in.
      if (pulse > 0.01) { vx += px / d * pulse * 5 * dt * 60; vy += py / d * pulse * 5 * dt * 60; vz += pz / d * pulse * 5 * dt * 60; }
      // Never leave the canvas: bounce softly off a sphere at the edge.
      if (d > REACH * 0.92) {
        var nx = px / d, ny = py / d, nz = pz / d;
        var vn = vx * nx + vy * ny + vz * nz;
        if (vn > 0) { vx -= 1.6 * vn * nx; vy -= 1.6 * vn * ny; vz -= 1.6 * vn * nz; }
      }
      // Too close to the core: nudge outward so orbits don't collapse into a dot.
      if (d < 0.9) { vx += px / d * dt * 2; vy += py / d * dt * 2; vz += pz / d * dt * 2; }
      vel[s] = vx; vel[s + 1] = vy; vel[s + 2] = vz;
      pos[s] = px + vx * dt; pos[s + 1] = py + vy * dt; pos[s + 2] = pz + vz * dt;
    }
    draw();
    if (!reducedMotion) raf = requestAnimationFrame(frame);
  }

  function draw() {
    var c = size / 2;
    var scale = c / REACH;
    // Fade the last frame instead of clearing it, which leaves short motion trails.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    var rgb = color[0] + ',' + color[1] + ',' + color[2];
    // Satellites are a lighter shade of the model's colour.
    var lift = [Math.round(color[0] + (255 - color[0]) * 0.55), Math.round(color[1] + (255 - color[1]) * 0.55), Math.round(color[2] + (255 - color[2]) * 0.55)];
    for (var k = 0; k < N; k++) {
      var o = k * 3;
      var z = pos[o + 2];
      var persp = 1 + z * 0.12;
      var sx = c + pos[o] * scale * persp;
      var sy = c + pos[o + 1] * scale * persp;
      var depth = (z + REACH) / (2 * REACH); // 0 far .. 1 near
      var sat = k >= SHELL;
      var radius = (sat ? 0.8 : 0.5) * (0.7 + depth * 0.6) * Math.max(1, size / 26);
      ctx.fillStyle = sat ? 'rgba(' + lift[0] + ',' + lift[1] + ',' + lift[2] + ',' + (0.55 + depth * 0.4) + ')' : 'rgba(' + rgb + ',' + (0.18 + depth * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  fit();
  raf = requestAnimationFrame(frame);

  return {
    setState: function (next) { state = next === 'working' || next === 'writing' ? next : 'thinking'; },
    // power 0..1: how strong a pulse to send through the shell
    kick: function (power) { pulse = Math.min(1.2, pulse + Math.max(0, power) * 0.5); },
    setColor: function (rgb) { color = rgb.slice(); },
    stop: function () { running = false; cancelAnimationFrame(raf); }
  };
};
