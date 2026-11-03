'use strict';
// Dartboard geometry, drawing, scoring and checkout logic (no DOM needed).
// All board measurements are in millimetres, matching a regulation board.
const DartBoard = (() => {
  const NUMBERS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  // edge = drawn outer edge. A slim number ring (170 to 196) keeps the scoring area big on a phone.
  const MM = { bull: 6.35, outer: 15.9, tIn: 99, tOut: 107, dIn: 162, dOut: 170, edge: 196 };
  const C = {
    black: '#1c1c1c', cream: '#f1e4c4', red: '#d3262d', green: '#16884a',
    wire: 'rgba(200,205,212,0.9)', num: '#f4f4f4',
  };
  const STEP = Math.PI / 10;

  function sector(ctx, r1, r2, a1, a2, fill) {
    ctx.beginPath();
    ctx.arc(0, 0, r2, a1, a2);
    ctx.arc(0, 0, r1, a2, a1, true);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function disc(ctx, r, fill) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // Draw the board centred at (cx, cy). s = pixels per millimetre.
  function draw(ctx, cx, cy, s, opts = {}) {
    const numbers = opts.numbers !== false;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);

    const edge = numbers ? MM.edge : MM.dOut + 10;
    const g = ctx.createRadialGradient(0, 0, MM.dOut, 0, 0, edge);
    g.addColorStop(0, '#1d1d1d');
    g.addColorStop(1, '#070707');
    ctx.beginPath();
    ctx.arc(0, 0, edge, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    for (let i = 0; i < 20; i++) {
      const a = -Math.PI / 2 + i * STEP;
      const a1 = a - STEP / 2, a2 = a + STEP / 2;
      const even = i % 2 === 0;
      const single = even ? C.black : C.cream;
      const ring = even ? C.red : C.green;
      sector(ctx, MM.outer, MM.tIn, a1, a2, single);
      sector(ctx, MM.tIn, MM.tOut, a1, a2, ring);
      sector(ctx, MM.tOut, MM.dIn, a1, a2, single);
      sector(ctx, MM.dIn, MM.dOut, a1, a2, ring);
    }
    disc(ctx, MM.outer, C.green);
    disc(ctx, MM.bull, C.red);

    // Wires
    ctx.strokeStyle = C.wire;
    ctx.lineWidth = Math.max(0.9, 0.7 / s);
    ctx.beginPath();
    for (let i = 0; i < 20; i++) {
      const a = -Math.PI / 2 + i * STEP - STEP / 2;
      const c = Math.cos(a), n = Math.sin(a);
      ctx.moveTo(c * MM.outer, n * MM.outer);
      ctx.lineTo(c * MM.dOut, n * MM.dOut);
    }
    ctx.stroke();
    for (const r of [MM.bull, MM.outer, MM.tIn, MM.tOut, MM.dIn, MM.dOut]) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (numbers) {
      ctx.fillStyle = C.num;
      ctx.font = '700 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 20; i++) {
        const a = -Math.PI / 2 + i * STEP;
        ctx.fillText(String(NUMBERS[i]), Math.cos(a) * 183.5, Math.sin(a) * 183.5 + 0.8);
      }
    }
    ctx.restore();
  }

  // Score for a point in board millimetres (x right, y down, origin at bull).
  function scoreAt(mx, my) {
    const r = Math.hypot(mx, my);
    if (r <= MM.bull) return { value: 50, label: 'Bull', kind: 'bull' };
    if (r <= MM.outer) return { value: 25, label: '25', kind: 'outer' };
    if (r > MM.dOut) return { value: 0, label: 'Miss', kind: 'miss' };
    let deg = Math.atan2(mx, -my) * 180 / Math.PI; // 0 at top, clockwise
    deg = (deg + 369) % 360;
    const num = NUMBERS[Math.floor(deg / 18) % 20];
    if (r >= MM.tIn && r <= MM.tOut) return { value: num * 3, label: 'T' + num, kind: 'treble' };
    if (r >= MM.dIn) return { value: num * 2, label: 'D' + num, kind: 'double' };
    return { value: num, label: String(num), kind: 'single' };
  }

  // Every target a dart can be aimed at. w = how hard it is to hit (lower is easier).
  const TARGETS = (() => {
    const t = [];
    for (let n = 1; n <= 20; n++) {
      t.push({ label: String(n), value: n, w: 1, num: n, kind: 'single' });
      // Classic finishing doubles (they halve down nicely after a miss) are slightly preferred.
      t.push({ label: 'D' + n, value: 2 * n, w: [20, 16, 10, 8].includes(n) ? 2.9 : 3, num: n, kind: 'double' });
      t.push({ label: 'T' + n, value: 3 * n, w: 3, num: n, kind: 'treble' });
    }
    t.push({ label: '25', value: 25, w: 2, kind: 'outer' });
    t.push({ label: 'Bull', value: 50, w: 4, kind: 'bull' });
    return t;
  })();

  const isDouble = (t) => t.kind === 'double' || t.kind === 'bull';

  // Easiest way to score exactly `rem` with up to `darts` darts.
  // doubleOut: the last dart must be a double (the bull counts as a double).
  // Preference: lowest total difficulty, then fewest darts, then biggest first dart.
  const memo = new Map();
  function checkout(rem, darts, doubleOut = false) {
    if (darts <= 0 || rem <= 0 || rem > darts * 60 || (doubleOut && rem < 2)) return null;
    const key = (rem * 4 + darts) * 2 + (doubleOut ? 1 : 0);
    if (memo.has(key)) return memo.get(key);
    let best = null, bestW = Infinity;
    for (const t of TARGETS) {
      if (t.value > rem) continue;
      let path;
      if (t.value === rem) {
        if (doubleOut && !isDouble(t)) continue;
        path = [t];
      } else {
        const rest = checkout(rem - t.value, darts - 1, doubleOut);
        if (!rest) continue;
        path = [t, ...rest];
      }
      const w = path.reduce((s, x) => s + x.w, 0);
      if (w < bestW || (w === bestW && (path.length < best.length ||
          (path.length === best.length && t.value > best[0].value)))) {
        best = path;
        bestW = w;
      }
    }
    memo.set(key, best);
    return best;
  }

  // Aim point (mm) for a target.
  function targetPoint(t) {
    if (t.kind === 'bull') return { x: 0, y: 0 };
    if (t.kind === 'outer') return { x: 0, y: -11 };
    const r = t.kind === 'treble' ? 103 : t.kind === 'double' ? 166 : 134;
    const a = NUMBERS.indexOf(t.num) * STEP;
    return { x: Math.sin(a) * r, y: -Math.cos(a) * r };
  }

  const byLabel = (label) => TARGETS.find((t) => t.label === label);

  return { NUMBERS, MM, TARGETS, draw, scoreAt, checkout, targetPoint, byLabel, isDouble };
})();

if (typeof module !== 'undefined') module.exports = DartBoard;
