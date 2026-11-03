'use strict';
(() => {
  const { MM, TARGETS, scoreAt, checkout, targetPoint, byLabel, isDouble } = DartBoard;

  // ---------- Tuning ----------
  // Ideal flick speed, in screen heights per second, for each strength setting.
  const FLICK = { gentle: 1.7, normal: 2.5, strong: 3.5 };
  // Computer accuracy: spread of its darts around the aim point, in millimetres.
  const CPU = { easy: { sigma: 42, label: 'Easy' }, medium: { sigma: 24, label: 'Medium' }, hard: { sigma: 12, label: 'Hard' } };
  const COLORS = ['#3da5ff', '#ff7a45'];
  const TURN_PAUSE = 1300;
  const DEBUG = /[?&]debug/.test(location.search);

  // ---------- Helpers ----------
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('darts.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('darts.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // ---------- Settings ----------
  const DEFAULTS = { mode: 'cpu', diff: 'easy', start: 301, legs: 1, flick: 'normal', doubleOut: 'off', p1: '', p2: '' };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ---------- Game state ----------
  const game = {
    players: [], cur: 0, legNo: 0, legsToWin: 1, bestOf: 1, start: 301, diff: 'easy',
    turn: null, stuck: [], state: 'idle', token: 0, throwsThisMatch: 0,
  };
  let paused = false;
  const curP = () => game.players[game.cur];

  // ---------- Canvas + render loop ----------
  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  const bg = document.createElement('canvas');
  let W = 0, H = 0, dpr = 1, G = null;
  let tip = { x: 0, y: 0 };      // where the dart in hand currently is (its point)
  let tipTween = null;
  let flight = null;
  let popups = [];
  let meter = null;
  let drag = null;
  let rafId = 0;

  function requestRender() { if (!rafId) rafId = requestAnimationFrame(frame); }

  function layout() {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    W = r.width; H = r.height;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const top = $('#turnbar').getBoundingClientRect().bottom - r.top + 8;
    const zoneH = clamp(H * 0.27, 150, 250);
    const availH = Math.max(120, H - top - zoneH);
    const edge = Math.max(60, Math.min(W * 0.47, availH * 0.5 - 4));
    G = { top, zoneH, edge, scale: edge / MM.edge, cx: W / 2, cy: top + availH / 2 };
    G.R = MM.dOut * G.scale;
    G.dartS = clamp(H / 760, 0.75, 1.25);
    G.stuckS = G.scale * 0.5;
    G.tipMinY = H - zoneH + 6;
    G.tipMaxY = H - 62 * G.dartS;
    G.tipMinX = W * 0.07;
    G.tipMaxX = W * 0.93;
    G.restX = W / 2;
    G.restY = (G.tipMinY + G.tipMaxY) / 2;
    G.gx = (edge * 1.05) / (W * 0.43);
    G.gy = (G.R * 1.15) / Math.max(30, (G.tipMaxY - G.tipMinY) / 2);
    buildBg();
    if (game.players.length) setTipForPlayer(curP());
    requestRender();
  }

  function buildBg() {
    bg.width = cv.width;
    bg.height = cv.height;
    const b = bg.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = b.createRadialGradient(G.cx, G.cy, G.edge * 0.6, G.cx, G.cy, Math.max(W, H));
    g.addColorStop(0, '#2b3d52');
    g.addColorStop(1, '#0b1118');
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
    const fy = H - G.zoneH;
    const fg = b.createLinearGradient(0, fy, 0, H);
    fg.addColorStop(0, 'rgba(0,0,0,0)');
    fg.addColorStop(1, 'rgba(0,0,0,0.5)');
    b.fillStyle = fg;
    b.fillRect(0, fy, W, G.zoneH);
    b.strokeStyle = 'rgba(255,255,255,0.12)';
    b.lineWidth = 2;
    b.setLineDash([8, 10]);
    b.beginPath();
    b.moveTo(16, fy);
    b.lineTo(W - 16, fy);
    b.stroke();
    b.setLineDash([]);
    b.save();
    b.shadowColor = 'rgba(0,0,0,0.65)';
    b.shadowBlur = 26;
    b.shadowOffsetY = 10;
    b.beginPath();
    b.arc(G.cx, G.cy, G.edge, 0, Math.PI * 2);
    b.fillStyle = '#000';
    b.fill();
    b.restore();
    DartBoard.draw(b, G.cx, G.cy, G.scale);
  }

  // Map the dart-in-hand position to where a perfect flick lands.
  const aimPoint = (t) => ({ x: G.cx + (t.x - G.restX) * G.gx, y: G.cy + (t.y - G.restY) * G.gy });
  const tipForAim = (p) => ({
    x: clamp(G.restX + (p.x - G.cx) / G.gx, G.tipMinX, G.tipMaxX),
    y: clamp(G.restY + (p.y - G.cy) / G.gy, G.tipMinY, G.tipMaxY),
  });
  const mmToPx = (mx, my) => ({ x: G.cx + mx * G.scale, y: G.cy + my * G.scale });

  function setTipForPlayer(p) {
    const o = p.lastTip || { x: 0, y: 0 };
    tip = { x: clamp(G.restX + o.x, G.tipMinX, G.tipMaxX), y: clamp(G.restY + o.y, G.tipMinY, G.tipMaxY) };
  }

  function drawDart(c, x, y, s, k, lean, color, alpha) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(x, y);
    c.rotate(lean);
    c.scale(s, s * k);
    // point
    c.fillStyle = '#d9dde2';
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(1.7, 18); c.lineTo(-1.7, 18);
    c.closePath();
    c.fill();
    // barrel
    const g = c.createLinearGradient(-5, 0, 5, 0);
    g.addColorStop(0, '#59626c');
    g.addColorStop(0.45, '#eef1f4');
    g.addColorStop(1, '#454d56');
    c.fillStyle = g;
    c.beginPath();
    if (c.roundRect) c.roundRect(-4.6, 17, 9.2, 32, 4); else c.rect(-4.6, 17, 9.2, 32);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 0.9;
    c.beginPath();
    for (let yy = 24; yy < 45; yy += 4) { c.moveTo(-4.6, yy); c.lineTo(4.6, yy); }
    c.stroke();
    // shaft
    c.fillStyle = '#222';
    c.fillRect(-1.7, 48, 3.4, 26);
    // flights
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, 62); c.lineTo(-16, 86); c.lineTo(-13, 100); c.lineTo(0, 93); c.lineTo(13, 100); c.lineTo(16, 86);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.beginPath();
    c.moveTo(0, 62); c.lineTo(-16, 86); c.lineTo(-8, 88);
    c.closePath();
    c.fill();
    c.restore();
  }

  function frame(now) {
    rafId = 0;
    if (!G) return;
    let active = false;

    if (tipTween) {
      const p = clamp((now - tipTween.t0) / tipTween.dur, 0, 1);
      const e = p * p * (3 - 2 * p);
      tip = { x: lerp(tipTween.from.x, tipTween.to.x, e), y: lerp(tipTween.from.y, tipTween.to.y, e) };
      if (p >= 1) { const done = tipTween.resolve; tipTween = null; done(); } else active = true;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const d of game.stuck) {
      const p = mmToPx(d.mx, d.my);
      drawDart(ctx, p.x, p.y, G.stuckS, 0.6, d.lean, d.color, 1);
    }

    const human = game.players.length && !curP().cpu;
    const holding = (game.state === 'aim' && human && !flight) || game.state === 'cpuAim';
    if (game.state === 'aim' && human && !flight) {
      const a = aimPoint(tip);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
      ctx.moveTo(a.x - 14, a.y); ctx.lineTo(a.x - 5, a.y);
      ctx.moveTo(a.x + 5, a.y); ctx.lineTo(a.x + 14, a.y);
      ctx.moveTo(a.x, a.y - 14); ctx.lineTo(a.x, a.y - 5);
      ctx.moveTo(a.x, a.y + 5); ctx.lineTo(a.x, a.y + 14);
      ctx.stroke();
      ctx.fillStyle = curP().color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (flight) {
      active = true;
      const f = flight;
      const p = clamp((now - f.t0) / (f.T * 1000), 0, 1);
      const x = lerp(f.from.x, f.to.x, p);
      const y = lerp(f.from.y, f.to.y, p) - f.arcH * 4 * p * (1 - p);
      const s = 1 / lerp(1 / G.dartS, 1 / G.stuckS, p);       // perspective shrink
      const k = lerp(1, 0.6, p);
      const lean = lerp(0, f.lean, p);
      const alpha = f.fade ? 1 - clamp((p - 0.65) / 0.35, 0, 1) : 1;
      drawDart(ctx, x, y, s, k, lean, f.color, alpha);
      if (p >= 1) { flight = null; f.resolve(); }
    } else if (holding) {
      drawDart(ctx, tip.x, tip.y, G.dartS, 1, 0, curP().color, 1);
    }

    if (popups.length) {
      active = true;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      popups = popups.filter((pp) => now - pp.t0 < pp.dur);
      for (const pp of popups) {
        const a = clamp((now - pp.t0) / pp.dur, 0, 1);
        ctx.globalAlpha = a < 0.7 ? 1 : 1 - (a - 0.7) / 0.3;
        const y = pp.y - 22 * a;
        ctx.font = '800 24px system-ui, -apple-system, sans-serif';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(pp.text, pp.x, y);
        ctx.fillStyle = pp.color;
        ctx.fillText(pp.text, pp.x, y);
        if (pp.sub) {
          ctx.font = '700 14px system-ui, -apple-system, sans-serif';
          ctx.lineWidth = 4;
          ctx.strokeText(pp.sub, pp.x, y + 20);
          ctx.fillStyle = '#e8eef3';
          ctx.fillText(pp.sub, pp.x, y + 20);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (meter) {
      const a = (now - meter.t0) / 1700;
      if (a >= 1) meter = null;
      else {
        active = true;
        ctx.globalAlpha = a < 0.75 ? 1 : 1 - (a - 0.75) / 0.25;
        const x = W - 22, y0 = H - G.zoneH + 22, y1 = H - 30, h = y1 - y0;
        const yAt = (v) => y1 - clamp(v / 2, 0, 1) * h;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x - 6, y0, 12, h);
        ctx.fillStyle = 'rgba(61,220,132,0.75)';
        ctx.fillRect(x - 6, yAt(1.12), 12, yAt(0.88) - yAt(1.12));
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 10, yAt(meter.v) - 1.5, 20, 3);
        ctx.font = '700 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#9fb0c0';
        ctx.fillText('POWER', x - 4, y0 - 10);
        ctx.globalAlpha = 1;
      }
    }

    if (active) requestRender();
  }

  const tweenTip = (to, dur) => new Promise((resolve) => {
    tipTween = { from: { ...tip }, to, t0: performance.now(), dur, resolve };
    requestRender();
  });
  const launch = (opts) => new Promise((resolve) => {
    flight = { ...opts, t0: performance.now(), resolve };
    requestRender();
  });

  // Wait, but hold while the game is paused.
  async function wait(ms) {
    await new Promise((r) => setTimeout(r, ms));
    while (paused) await new Promise((r) => setTimeout(r, 150));
  }

  // ---------- Throwing ----------
  async function throwDart(land, arcH, T, f) {
    const p = curP();
    const tk = game.token;
    game.state = 'fly';
    updateHelpTip();
    const mx = (land.x - G.cx) / G.scale;
    const my = (land.y - G.cy) / G.scale;
    const r = Math.hypot(mx, my);
    const res = withNum(scoreAt(mx, my));
    let outcome = 'stick';
    if (r > MM.edge && land.y > G.cy + G.edge * 0.6) outcome = 'short';
    else if (land.y < G.top + 6 || land.x < -10 || land.x > W + 10) outcome = 'over';
    const to = { x: land.x, y: land.y };
    if (outcome === 'short') to.y = Math.min(land.y, H - G.zoneH + 30);
    if (outcome === 'over') to.y = Math.max(G.top - 40, land.y);
    const lean = clamp((land.x - G.cx) / G.edge, -1, 1) * 0.12 + gauss() * 0.05;
    await launch({ from: { ...tip }, to, arcH, T, lean, fade: outcome !== 'stick', color: p.color });
    if (tk !== game.token) return;
    if (outcome === 'stick') game.stuck.push({ mx, my, lean, color: p.color });

    let text = res.value ? String(res.value) : 'Miss';
    let sub = res.value && res.kind !== 'single' ? labelLong(res) : '';
    if (!res.value && f != null) {
      if (outcome === 'short' || (f > 0.2 && my > 0)) sub = 'Too soft';
      else if (outcome === 'over' || (f < -0.2 && my < 0)) sub = 'Too hard';
    }
    const color = !res.value ? '#9fb0c0' : res.kind === 'single' ? '#ffffff' : '#ffb020';
    popups.push({ x: clamp(to.x, 50, W - 50), y: clamp(to.y - 30, G.top + 34, H - 40), text, sub, color, t0: performance.now(), dur: 1100 });
    onLanded(res);
  }

  const labelLong = (t) => (t.kind === 'treble' ? 'Treble ' + t.num : t.kind === 'double' ? 'Double ' + t.num
    : t.kind === 'bull' ? 'Bullseye' : t.kind === 'outer' ? 'Outer bull' : t.label);
  // Labels from scoreAt don't carry num; derive it.
  function withNum(res) { if (res.num == null && /^[TD]\d+$/.test(res.label)) res.num = Number(res.label.slice(1)); return res; }

  function humanFlick(aim, vx, vyUp) {
    curP().lastTip = { x: aim.x - G.restX, y: aim.y - G.restY };
    const S0 = FLICK[settings.flick] || FLICK.normal;
    const sn = vyUp / H;
    const ratio = S0 / sn;
    const a = aimPoint(aim);
    const f = (S0 - sn) / S0;              // positive = too soft, negative = too hard
    const lx = a.x + clamp(vx / vyUp, -1.2, 1.2) * G.R * 0.6 + gauss() * G.R * 0.012;
    const fc = clamp(f, -1.5, 1);
    // Small errors move the dart a little; a really weak flick drops well short.
    const ly = a.y + (fc * 1.3 + Math.max(0, fc - 0.3) * 2.5) * G.R + gauss() * G.R * 0.012;
    const arcH = clamp(H * 0.18 * ratio * ratio, H * 0.035, H * 0.3);
    const T = clamp(0.55 * Math.sqrt(ratio), 0.35, 0.85);
    meter = { v: sn / S0, t0: performance.now() };
    if (DEBUG) console.log('flick', JSON.stringify({ sn: +sn.toFixed(2), f: +f.toFixed(2), aim: [Math.round(a.x), Math.round(a.y)], land: [Math.round(lx), Math.round(ly)], centre: [Math.round(G.cx), Math.round(G.cy)] }));
    throwDart({ x: lx, y: ly }, arcH, T, f);
  }

  // ---------- Turn flow ----------
  function startLeg() {
    game.legNo++;
    for (const p of game.players) { p.rem = game.start; p.lastTip = null; }
    game.cur = (game.legNo - 1) % 2;
    startTurn();
  }

  function startTurn() {
    const p = curP();
    game.turn = { startRem: p.rem, darts: [], points: 0 };
    game.stuck = [];
    setTipForPlayer(p);
    game.state = 'aim';
    updateHud();
    requestRender();
    if (p.cpu) cpuTurn(game.token);
  }

  function onLanded(res) {
    withNum(res);
    const p = curP(), t = game.turn;
    p.darts++;
    game.throwsThisMatch++;
    t.darts.push(res);
    const after = p.rem - res.value;
    const dbl = game.doubleOut;
    // Bust: below zero, or with "double to win", left on 1 or reaching zero without a double.
    if (after < 0 || (dbl && after === 1) || (dbl && after === 0 && !isDouble(res))) {
      p.points -= t.points;
      t.points = 0;
      t.bust = true;
      p.rem = t.startRem;
      updateHud();
      toast(after === 0 ? 'Bust! Finish on a double' : after === 1 ? 'Bust! Can\'t finish on 1' : 'Bust!', 'bad');
      endTurn();
      return;
    }
    p.rem = after;
    p.points += res.value;
    t.points += res.value;
    if (after === 0 || t.darts.length >= 3) {
      p.best = Math.max(p.best, t.points);
      if (t.points >= 100) p.tons++;
    }
    if (after === 0) { updateHud(); legWon(); return; }
    if (t.darts.length >= 3) {
      updateHud();
      toast(t.points === 180 ? 'One hundred and eighty!' : `${p.name} scored ${t.points}`, t.points >= 100 ? 'good' : '');
      endTurn();
      return;
    }
    game.state = 'aim';
    if (!p.cpu) setTipForPlayer(p);   // next dart back in hand where the last one was aimed
    updateHud();
    requestRender();
  }

  async function endTurn() {
    game.state = 'wait';
    const tk = game.token;
    updateHelpTip();
    await wait(TURN_PAUSE);
    if (tk !== game.token) return;
    game.cur = 1 - game.cur;
    startTurn();
  }

  async function legWon() {
    const p = curP();
    const tk = game.token;
    game.state = 'wait';
    p.legs++;
    updateHud();
    toast(`${p.name} checks out!`, 'good');
    await wait(1400);
    if (tk !== game.token) return;
    if (p.legs >= game.legsToWin) { showMatchOver(p); return; }
    const [a, b] = game.players;
    showModal({
      title: `${p.name} wins leg ${game.legNo}`,
      body: `<p class="muted">Legs: <span class="c0">${esc(a.name)} ${a.legs}</span> &nbsp;|&nbsp; <span class="c1">${esc(b.name)} ${b.legs}</span></p>
             <p class="muted">${esc(game.players[game.legNo % 2].name)} throws first next leg.</p>`,
      buttons: [{ label: 'Next leg', primary: true, onClick: () => { closeModal(); startLeg(); } }],
    });
  }

  // ---------- Computer player ----------
  // Nice doubles to leave yourself on (they halve down well after a miss).
  const GOOD_LEAVE = { 32: 20, 40: 15, 16: 12, 24: 8, 20: 8, 8: 6, 36: 5, 12: 4 };

  function cpuTarget(rem, dartsLeft) {
    const dbl = game.doubleOut;
    const path = checkout(rem, dartsLeft, dbl);
    if (path) return path[0];
    const big = game.diff === 'easy' ? byLabel('20') : byLabel('T20');
    if (!dbl) return rem > 60 ? big : byLabel('20');
    if (rem > 100) return big;
    // Double to win and no finish this turn: set up a double for next time.
    let best = byLabel('20'), bestScore = -Infinity;
    for (const t of TARGETS) {
      if (t.kind !== 'single' && t.kind !== 'treble') continue;
      const leave = rem - t.value;
      if (leave < 2) continue;
      let score = t.value * 0.01 - (t.kind === 'treble' ? 10 : 0);
      if (leave <= 40 && leave % 2 === 0) score += 100 + (GOOD_LEAVE[leave] || 0);
      else if (checkout(leave, 2, true)) score += 50;
      else if (checkout(leave, 3, true)) score += 30;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  async function cpuTurn(tk) {
    const sigma = CPU[game.diff].sigma;
    while (tk === game.token && game.state === 'aim' && curP().cpu) {
      await wait(game.turn.darts.length ? 350 : 650);
      if (tk !== game.token) return;
      const p = curP();
      const tgt = cpuTarget(p.rem, 3 - game.turn.darts.length);
      const aim = targetPoint(tgt);
      const ap = mmToPx(aim.x, aim.y);
      game.state = 'cpuAim';
      await tweenTip(tipForAim(ap), 380);
      await wait(150);
      if (tk !== game.token) return;
      const land = mmToPx(aim.x + gauss() * sigma, aim.y + gauss() * sigma);
      await throwDart(land, H * (0.16 + Math.random() * 0.06), 0.55, null);
    }
  }

  // ---------- Input ----------
  const canHumanThrow = () => game.state === 'aim' && game.players.length && !curP().cpu && !paused && !flight;

  function addSample(e) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const evs = list.length ? list : [e];
    for (const ev of evs) {
      tip = {
        x: clamp(drag.tx0 + (ev.clientX - drag.sx), G.tipMinX, G.tipMaxX),
        y: clamp(drag.ty0 + (ev.clientY - drag.sy), G.tipMinY, G.tipMaxY),
      };
      drag.samples.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp, tx: tip.x, ty: tip.y });
    }
    const cutoff = drag.samples[drag.samples.length - 1].t - 500;
    while (drag.samples.length > 2 && drag.samples[0].t < cutoff) drag.samples.shift();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (!canHumanThrow() || drag) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, tx0: tip.x, ty0: tip.y, samples: [] };
    drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp, tx: tip.x, ty: tip.y });
  });

  cv.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    addSample(e);
    requestRender();
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (cancelled || !canHumanThrow()) { requestRender(); return; }
    d.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp, tx: tip.x, ty: tip.y });
    const s = d.samples;
    // The release often repeats the last move's position; drop such duplicates.
    while (s.length > 2 && s[s.length - 1].x === s[s.length - 2].x && s[s.length - 1].y === s[s.length - 2].y &&
      s[s.length - 1].t - s[s.length - 2].t < 40) s.pop();
    const end = s[s.length - 1];
    // Release velocity, measured over roughly the last 80 ms.
    let i = s.length - 1;
    while (i > 0 && end.t - s[i - 1].t <= 80) i--;
    if (i === s.length - 1 && i > 0) i--;
    const a = s[i];
    const dt = (end.t - a.t) / 1000;
    if (dt <= 0.001) { requestRender(); return; }
    const vx = (end.x - a.x) / dt;
    const vyUp = (a.y - end.y) / dt;
    if (vyUp / H < 0.6) { requestRender(); return; }  // not a flick: just a reposition
    // Aim is where the dart was just before the flick started: find the fastest
    // upward moment of the flick, then walk back to where that movement began.
    const segUp = (q) => {
      // A resting finger sends no events, so cap the gap: movement after a pause
      // happened within the last frame or so, not spread across the whole pause.
      const sdt = Math.min(0.025, (s[q].t - s[q - 1].t) / 1000);
      return sdt > 0 ? (s[q - 1].y - s[q].y) / sdt : 0;
    };
    let m = s.length - 1, best = -Infinity;
    for (let q = s.length - 1; q > 0 && end.t - s[q].t < 350; q--) {
      const u = segUp(q);
      if (u > best) { best = u; m = q; }
    }
    let k = m;
    while (k > 1 && end.t - s[k - 1].t < 450 && segUp(k - 1) >= Math.max(0.45 * H, 0.35 * best)) k--;
    const k0 = k - 1;   // last sample before the fast movement began
    const aim = { x: s[k0].tx, y: s[k0].ty };
    humanFlick(aim, vx, vyUp);
  }
  cv.addEventListener('pointerup', (e) => endDrag(e, false));
  cv.addEventListener('pointercancel', (e) => endDrag(e, true));
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- HUD ----------
  const avg = (p) => (p.darts ? (p.points / p.darts) * 3 : 0).toFixed(1);

  function updateHud() {
    game.players.forEach((p, i) => {
      const el = $('#pc' + i);
      el.classList.toggle('active', i === game.cur);
      el.querySelector('.pname').textContent = p.cpu ? `${p.name} (${CPU[game.diff].label})` : p.name;
      el.querySelector('.prem').textContent = p.rem;
      el.querySelector('.pmeta').textContent = `Avg ${avg(p)}` + (game.bestOf > 1 ? `  ·  Legs ${p.legs}` : '');
    });
    const t = game.turn;
    const slots = document.querySelectorAll('.slot');
    slots.forEach((el, i) => {
      const d = t && t.darts[i];
      el.textContent = d ? (d.value ? d.label : '0') : '';
      el.classList.toggle('miss', !!d && !d.value);
      el.classList.toggle('next', !!t && !t.bust && i === t.darts.length && game.state === 'aim');
    });
    const hint = $('#hint');
    const p = curP();
    if (!t) hint.textContent = '';
    else if (p.cpu && game.state !== 'wait') hint.textContent = `${p.name} is throwing...`;
    else {
      const left = 3 - t.darts.length;
      const path = left > 0 && !t.bust && p.rem > 0 ? checkout(p.rem, left, game.doubleOut) : null;
      if (path && !p.cpu) hint.innerHTML = 'Finish: <b>' + path.map((x) => esc(x.label)).join('  ') + '</b>';
      else {
        const bits = [];
        if (game.bestOf > 1) bits.push(`Leg ${game.legNo}  ·  first to ${game.legsToWin}`);
        if (game.doubleOut) bits.push('Double to win');
        hint.textContent = bits.join('  ·  ');
      }
    }
    updateHelpTip();
  }

  function updateHelpTip() {
    const show = game.state === 'aim' && game.players.length && !curP().cpu && game.throwsThisMatch < 3;
    $('#helpTip').classList.toggle('show', !!show);
  }

  let toastTimer = 0;
  function toast(text, cls) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'show ' + (cls || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = cls || ''; }, 1200);
  }

  // ---------- Modals ----------
  function showModal({ title, body, buttons }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const wrap = $('#modalBtns');
    wrap.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.className = b.primary ? 'primary' : 'secondary';
      el.addEventListener('click', b.onClick);
      wrap.appendChild(el);
    }
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }

  const HOW = () => `
    <ul>
      <li><b>Aim:</b> touch anywhere low on the screen and drag. The dart moves with your finger and the circle on the board shows where a perfect throw will land.</li>
      <li><b>Throw:</b> flick your finger up. A gentle flick lobs the dart and drops low, a hard flick flies flat and high. The power bar shows how you went: green is just right.</li>
      <li><b>Score:</b> everyone starts on ${game.players.length ? game.start : settings.start}. Each turn is three darts and your score comes off your total.</li>
      ${(game.players.length ? game.doubleOut : settings.doubleOut === 'on')
        ? `<li><b>Finish (double to win):</b> your last dart must land on exactly zero <b>and</b> be a double or the bullseye (50). Going below zero, being left on 1, or reaching zero without a double is a <b>bust</b>: your score goes back to where it was at the start of that turn.</li>`
        : `<li><b>Finish:</b> land on exactly zero to win the leg. Go below zero and it's a <b>bust</b>: your score goes back to where it was at the start of that turn.</li>`}
      <li><b>The board:</b> the thin outer ring is a <b>double</b> (D), the thin inner ring is a <b>treble</b> (T, three times). The centre is the Bull (50), with 25 just around it.</li>
      <li>Flick feeling too touchy or too stiff? Change <b>Flick strength</b>.</li>
    </ul>`;

  function showHow(back) {
    showModal({ title: 'How to play', body: HOW(), buttons: [{ label: 'Got it', primary: true, onClick: back || closeModal }] });
  }

  function flickSeg() {
    return `<div class="field"><div class="flabel">Flick strength</div><div class="seg" id="pauseFlick">
      ${['gentle', 'normal', 'strong'].map((v) => `<button data-v="${v}" class="${settings.flick === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
      </div></div>`;
  }

  function showPause() {
    if (!game.players.length) return;
    paused = true;
    const resume = () => { paused = false; closeModal(); requestRender(); };
    showModal({
      title: 'Paused',
      body: flickSeg(),
      buttons: [
        { label: 'Resume', primary: true, onClick: resume },
        { label: 'How to play', onClick: () => showHow(showPause) },
        { label: 'Restart match', onClick: () => { paused = false; startMatch(); } },
        { label: 'Quit to menu', onClick: quitToMenu },
      ],
    });
    $('#pauseFlick').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings.flick = b.dataset.v;
      saveSettings();
      syncMenu();
      $('#pauseFlick').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  function showMatchOver(w) {
    game.state = 'over';
    const [a, b] = game.players;
    const row = (label, fa, fb) => `<tr><td>${label}</td><td>${fa}</td><td>${fb}</td></tr>`;
    const body = `
      <p class="winner">${game.bestOf > 1 ? `Wins the match ${w.legs} legs to ${game.players[1 - game.players.indexOf(w)].legs}` : 'Wins the game'}</p>
      <table class="stats">
        <tr><th></th><th class="c0">${esc(a.name)}</th><th class="c1">${esc(b.name)}</th></tr>
        ${row('3-dart average', avg(a), avg(b))}
        ${row('Best turn', a.best, b.best)}
        ${row('100+ turns', a.tons, b.tons)}
        ${row('Darts thrown', a.darts, b.darts)}
        ${game.bestOf > 1 ? row('Legs won', a.legs, b.legs) : ''}
      </table>`;
    showModal({
      title: `${w.name} wins!`,
      body,
      buttons: [
        { label: 'Rematch', primary: true, onClick: startMatch },
        { label: 'Menu', onClick: quitToMenu },
      ],
    });
  }

  // ---------- Screens ----------
  function showScreen(id) {
    $('#menu').classList.toggle('hidden', id !== 'menu');
    $('#game').classList.toggle('hidden', id !== 'game');
  }

  function newPlayer(name, cpu, color) {
    return { name, cpu, color, rem: 0, legs: 0, points: 0, darts: 0, best: 0, tons: 0, lastTip: null };
  }

  function resetTransient() {
    flight = null; tipTween = null; popups = []; meter = null; drag = null;
    game.stuck = [];
  }

  function startMatch() {
    if (pendingReload && reloadForUpdate()) return;
    game.token++;
    paused = false;
    resetTransient();
    closeModal();
    const vsCpu = settings.mode === 'cpu';
    const n1 = (settings.p1 || '').trim() || 'Player 1';
    const n2 = vsCpu ? 'Computer' : (settings.p2 || '').trim() || 'Player 2';
    game.players = [newPlayer(n1, false, COLORS[0]), newPlayer(n2, vsCpu, COLORS[1])];
    game.diff = settings.diff;
    game.start = settings.start;
    game.bestOf = settings.legs;
    game.doubleOut = settings.doubleOut === 'on';
    game.legsToWin = Math.ceil(settings.legs / 2);
    game.legNo = 0;
    game.throwsThisMatch = 0;
    game.turn = null;
    game.state = 'idle';
    showScreen('game');
    layout();
    startLeg();
    requestAnimationFrame(layout);   // re-measure once the HUD has rendered
  }

  function quitToMenu() {
    game.token++;
    paused = false;
    resetTransient();
    game.players = [];
    game.state = 'idle';
    closeModal();
    showScreen('menu');
    if (pendingReload) reloadForUpdate();
  }

  // ---------- Menu ----------
  function syncMenu() {
    document.querySelectorAll('#menu .seg').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings[key]) === b.dataset.v));
    });
    $('#diffField').classList.toggle('hidden', settings.mode !== 'cpu');
    $('#p2Field').classList.toggle('hidden', settings.mode === 'cpu');
    $('#doubleNote').textContent = settings.doubleOut === 'on'
      ? 'Your last dart must hit the outer double ring or the bullseye (50).'
      : 'Any dart that lands exactly on zero wins.';
  }

  function initMenu() {
    document.querySelectorAll('#menu .seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const key = seg.dataset.key;
        settings[key] = key === 'start' || key === 'legs' ? Number(b.dataset.v) : b.dataset.v;
        saveSettings();
        syncMenu();
      });
    });
    for (const [id, key] of [['#p1Name', 'p1'], ['#p2Name', 'p2']]) {
      const el = $(id);
      el.value = settings[key] || '';
      el.addEventListener('input', () => { settings[key] = el.value.slice(0, 12); saveSettings(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
    $('#startBtn').addEventListener('click', startMatch);
    $('#howBtn').addEventListener('click', () => showHow());
    $('#pauseBtn').addEventListener('click', showPause);
    syncMenu();

    const logo = $('#logo');
    const ld = Math.min(2, window.devicePixelRatio || 1);
    const size = 132;
    logo.width = size * ld;
    logo.height = size * ld;
    const lc = logo.getContext('2d');
    lc.scale(ld, ld);
    DartBoard.draw(lc, size / 2, size / 2, (size / 2 - 1) / MM.edge);
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!$('#game').classList.contains('hidden')) layout(); }, 120);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.players.length && game.state !== 'over' && $('#modal').classList.contains('hidden')) showPause();
  });

  initMenu();
  if (DEBUG) window.__darts = { game, onLanded, scoreAt };   // test hook, only with ?debug

  // ---------- Updates ----------
  // 1. Every visit: the service worker fetches from the network first, so an online
  //    visit always runs the latest files.
  // 2. Every visit or return to the app (phones often resume rather than reload),
  //    the page also asks the worker to re-check every file with the server.
  // 3. If 48 hours have passed since the last full download, every file is pulled
  //    again from scratch, bypassing all caches.
  // A newer version never interrupts a game: it is applied back on the menu.
  const FULL_EVERY = 48 * 60 * 60 * 1000;
  const RESUME_GAP = 2 * 60 * 1000;
  let swReg = null;
  let pendingReload = false;
  let checking = false;
  let lastCheck = 0;
  const onGameScreen = () => !$('#game').classList.contains('hidden');
  const fullDue = () => Date.now() - store.get('lastFullUpdate', 0) >= FULL_EVERY;

  function reloadForUpdate() {
    // Guard against reload loops if something keeps reporting a change.
    let last = 0;
    try { last = Number(sessionStorage.getItem('darts.reloadAt')) || 0; } catch (e) { /* ignore */ }
    if (Date.now() - last < 30000) { pendingReload = false; return false; }
    try { sessionStorage.setItem('darts.reloadAt', String(Date.now())); } catch (e) { /* ignore */ }
    location.reload();
    return true;
  }

  function applyUpdate() {
    if (onGameScreen()) { pendingReload = true; return; }
    reloadForUpdate();
  }

  function askWorker(msg) {
    return new Promise((resolve) => {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) { resolve(null); return; }
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 30000);
      ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
      sw.postMessage(msg, [ch.port2]);
    });
  }

  async function checkForUpdates() {
    if (checking || navigator.onLine === false) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const full = fullDue();
      if (swReg) swReg.update().catch(() => {});
      const res = await askWorker({ type: 'refresh', full });
      if (res && res.ok) {
        store.set('lastUpdateCheck', Date.now());
        if (full) store.set('lastFullUpdate', Date.now());
        if (res.changed) applyUpdate();
      }
    } finally {
      checking = false;
    }
  }

  function onReturn() {
    if (document.hidden) return;
    // Returning to the menu counts as a new visit; mid-game only the 48 hour check runs.
    if ((!onGameScreen() && Date.now() - lastCheck > RESUME_GAP) || fullDue()) checkForUpdates();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const firstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'updated') applyUpdate();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          swReg = reg;
          // A brand new install has just downloaded everything fresh.
          if (firstInstall) { store.set('lastFullUpdate', Date.now()); store.set('lastUpdateCheck', Date.now()); }
          else checkForUpdates();
        })
        .catch(() => {});
    });
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', (e) => { if (e.persisted) onReturn(); });
    window.addEventListener('focus', onReturn);
    // Long-running sessions: look again each hour for the 48 hour full refresh.
    setInterval(() => { if (!document.hidden && fullDue()) checkForUpdates(); }, 60 * 60 * 1000);
  }
})();
