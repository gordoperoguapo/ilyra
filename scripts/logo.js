// Ilyra's mark: a shell of fine gold particles on a sphere, like the orb in the app.
// Every dot is thin and nearly the same size; depth shows in brightness and colour
// (near dots are bright and pale gold, far ones dim to orange), with a soft glow at
// the centre in place of a solid core. One file draws every icon: the app and
// taskbar icon and the in-app mark.
function sphere(count, radius, tilt) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const x = Math.cos(golden * i) * r, z = Math.sin(golden * i) * r;
    pts.push({ x: 50 + x * radius, y: 50 + (y * ct - z * st) * radius, z: y * st + z * ct });
  }
  return pts.sort((a, b) => a.z - b.z);
}

// Far (z = -1) to near (z = 1): deep orange, Ilyra orange, pale gold.
function color(z) {
  const stops = [[-1, [255, 106, 26]], [0, [245, 165, 36]], [1, [255, 226, 160]]];
  const [a, b] = z < 0 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const t = (z - a[0]) / (b[0] - a[0]);
  return '#' + a[1].map((c, i) => Math.round(c + (b[1][i] - c) * t).toString(16).padStart(2, '0')).join('');
}

function mark() {
  const glow = '<defs><radialGradient id="ilyra-core"><stop offset="0" stop-color="#ffd27a" stop-opacity=".55"/>' +
    '<stop offset=".45" stop-color="#f5a524" stop-opacity=".18"/><stop offset="1" stop-color="#f5a524" stop-opacity="0"/></radialGradient></defs>' +
    '<circle cx="50" cy="50" r="30" fill="url(#ilyra-core)"/>';
  const dots = sphere(760, 38, 0.45).map((p) => {
    const k = (p.z + 1) / 2;
    const r = 0.44 + k * 0.2;  // thin and even: the nearest dot is only about 1.4 times the farthest
    return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${color(p.z)}" fill-opacity="${(0.28 + k * 0.72).toFixed(2)}"/>`;
  });
  return glow + dots.join('');
}

// The app icon: the mark alone on a transparent background, filling the frame.
function icon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<g transform="translate(-44 -44) scale(6)">${mark()}</g></svg>`;
}

// The in-app brand mark: the same sphere and framing as the app and tray icon.
function brand() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="7.33 7.33 85.33 85.33">${mark()}</svg>\n`;
}

module.exports = { icon, brand };
