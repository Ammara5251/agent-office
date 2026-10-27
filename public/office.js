// Pixel-art office renderer. Draws at a low "base" resolution; CSS scales it up crisply.
'use strict';
(function () {
  const CELL_W = 84, CELL_H = 88, ROW_GAP = 14, WALL = 46, PAD = 6;
  const SLEEP_AFTER_MS = 60 * 60 * 1000;

  const SHIRT = { claude: '#d97757', codex: '#2f9c78', cursor: '#5b7bd5' };
  const SKIN = ['#f1c7a3', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#d9a066'];
  const HAIR = ['#2c1b10', '#5a3825', '#b5651d', '#e6c27a', '#1c1c1c', '#8a8a8a', '#9b2d20', '#3b2a4a'];

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function looks(agent) {
    const h = hash(agent.id);
    return {
      shirt: SHIRT[agent.kind] || '#777',
      skin: SKIN[h % SKIN.length],
      hair: HAIR[(h >>> 4) % HAIR.length],
      hairStyle: (h >>> 9) % 3,
      glasses: ((h >>> 12) % 5) === 0,
    };
  }

  // Visual pose derived from status + idle time.
  function poseOf(agent, now) {
    if (!agent) return 'empty';
    if (agent.status === 'done' && now - agent.lastActivity > SLEEP_AFTER_MS) return 'sleep';
    return agent.status;
  }

  let ctx, W, H;
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x | 0, y | 0, w, h); };

  // ---------- layout ----------
  function layout(agents, cssWidth) {
    const scale = cssWidth >= 1000 ? 3 : 2;
    const baseW = Math.max(CELL_W + 80, Math.floor(cssWidth / scale));
    const archW = baseW < 300 ? 50 : 104;
    const cols = Math.max(1, Math.floor((baseW - archW - PAD * 2) / CELL_W));
    const floor = agents.filter((a) => !a.archived);
    const archived = agents.filter((a) => a.archived);
    const slots = Math.max(cols, Math.ceil(floor.length / cols) * cols);
    const rows = Math.max(1, slots / cols);
    const floorW = baseW - archW;
    const offX = Math.floor((floorW - cols * CELL_W) / 2);
    const desks = [];
    for (let i = 0; i < slots; i++) {
      desks.push({ x: offX + (i % cols) * CELL_W, y: WALL + 8 + Math.floor(i / cols) * (CELL_H + ROW_GAP), agent: floor[i] || null });
    }
    const boxCols = Math.max(1, Math.floor((archW - 12) / 16));
    const height = Math.max(WALL + 8 + rows * (CELL_H + ROW_GAP), WALL + 140);
    const boxRowsFit = Math.floor((height - (WALL + 44) - 6) / 13);
    const capacity = boxCols * boxRowsFit;
    const boxes = archived.slice(0, capacity).map((a, i) => ({
      x: floorW + 9 + (i % boxCols) * 16, y: WALL + 44 + Math.floor(i / boxCols) * 13, agent: a,
    }));
    return { scale, W: baseW, H: height, floorW, archW, desks, boxes, overflow: archived.length - boxes.length, archivedCount: archived.length };
  }

  // ---------- scenery ----------
  function skyColor(d) {
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < 5.5 || h >= 20.5) return ['#0c1633', '#1b2a52'];
    if (h < 7) return ['#f6a96b', '#fbd3a1'];
    if (h < 18) return ['#7cc4f2', '#b9e2fb'];
    return ['#f08a5d', '#f9c58d'];
  }

  function drawWall(L, now) {
    const d = new Date(now);
    px(0, 0, L.floorW, WALL, '#eadfca');
    px(0, WALL - 14, L.floorW, 12, '#d8c6a3');
    px(0, WALL - 14, L.floorW, 1, '#c4b08a');
    px(0, WALL - 2, L.floorW, 2, '#7a5a3a');
    const [sky, sky2] = skyColor(d);
    const night = sky === '#0c1633';
    const spots = [];
    const board = boardRect(L);
    for (let x = 14; x + 34 < L.floorW - 34; x += 96) {
      if (x + 36 < board.x - 2 || x - 2 > board.x + board.w + 2) spots.push(x); // keep clear of the status board
    }
    spots.forEach((x) => {
      px(x - 2, 5, 36, 25, '#8a6a48');
      px(x, 7, 32, 21, sky);
      px(x, 20, 32, 8, sky2);
      if (night) { px(x + 5, 10, 1, 1, '#fff'); px(x + 22, 13, 1, 1, '#fff'); px(x + 14, 9, 1, 1, '#ddd'); px(x + 26, 9, 2, 2, '#f5f0c8'); }
      else { px(x + 6, 11, 8, 2, '#ffffff'); px(x + 8, 10, 4, 1, '#ffffff'); }
      px(x + 15, 7, 2, 21, '#8a6a48');
      px(x, 17, 32, 1, '#8a6a48');
      px(x - 3, 29, 38, 2, '#a68461');
    });
    // Wall clock (real time)
    const cx = L.floorW - 22, cy = 16;
    ctx.fillStyle = '#5b4630'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fbf7ee'; ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, Math.PI * 2); ctx.fill();
    const hr = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2;
    const mn = d.getMinutes() / 60 * Math.PI * 2;
    ctx.strokeStyle = '#2a2420'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(hr) * 3.5, cy - Math.cos(hr) * 3.5); ctx.stroke();
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(mn) * 5.5, cy - Math.cos(mn) * 5.5); ctx.stroke();
    // Status whiteboard
    const b = boardRect(L);
    px(b.x - 1, b.y - 1, b.w + 2, b.h + 2, '#9aa0a6');
    px(b.x, b.y, b.w, b.h, '#fbfbf8');
    px(b.x + 3, b.y + b.h, b.w - 6, 2, '#9aa0a6');
    px(b.x + 6, b.y + b.h + 1, 4, 1, '#e5484d'); px(b.x + 12, b.y + b.h + 1, 4, 1, '#3e8ed0');
  }

  function boardRect(L) {
    const w = Math.min(70, Math.max(46, L.floorW - 120));
    const x = L.floorW > 260 ? 110 + 2 : Math.max(4, Math.floor((L.floorW - w) / 2) - 14);
    return { x, y: 6, w, h: 24 };
  }

  function drawFloor(L) {
    for (let y = WALL; y < L.H; y += 6) {
      const shift = ((y - WALL) / 6) % 2 ? 0 : 18;
      px(0, y, L.floorW, 6, ((y - WALL) / 6) % 2 ? '#c99d66' : '#c39660');
      px(0, y + 5, L.floorW, 1, '#ad8350');
      for (let x = shift; x < L.floorW; x += 36) px(x, y, 1, 5, '#b08550');
    }
    // plant in corner
    plant(4, L.H - 22);
    if (L.floorW > 200) plant(L.floorW - 16, L.H - 22);
  }

  function plant(x, y) {
    px(x + 2, y + 12, 9, 8, '#a0522d'); px(x + 2, y + 12, 9, 2, '#8b4513');
    px(x + 5, y + 2, 3, 10, '#2f7d32'); px(x + 1, y + 5, 4, 3, '#3f9a43'); px(x + 8, y + 3, 4, 3, '#3f9a43');
    px(x + 3, y, 3, 3, '#4caf50'); px(x + 8, y + 7, 4, 3, '#2f7d32');
  }

  function drawArchiveRoom(L, now) {
    const x0 = L.floorW;
    for (let y = 0; y < L.H; y += 8) for (let x = x0; x < L.W; x += 8) {
      px(x, y, 8, 8, ((x - x0) / 8 + y / 8) % 2 ? '#8f98a3' : '#98a1ab');
    }
    px(x0, 0, L.archW, WALL, '#6b7480');
    px(x0, WALL - 2, L.archW, 2, '#4b525c');
    // dividing wall with doorway
    px(x0, 0, 3, L.H, '#5b4630');
    px(x0, WALL + 70, 3, 22, '#98a1ab');
    // filing cabinets
    for (let i = 0; i < 3; i++) {
      const cx = x0 + 8 + i * 18;
      if (cx + 14 > L.W - 4) break;
      px(cx, WALL - 22, 14, 22, '#7b8794'); px(cx, WALL - 22, 14, 1, '#9aa5b1');
      for (let k = 0; k < 3; k++) { px(cx + 1, WALL - 20 + k * 7, 12, 6, '#8a96a3'); px(cx + 5, WALL - 18 + k * 7, 4, 1, '#d1d5db'); }
    }
    // a dim, flickering ceiling light
    const flick = Math.floor(now / 1700) % 7 === 0 ? 0.04 : 0.1;
    ctx.fillStyle = `rgba(255,250,210,${flick})`;
    ctx.fillRect(x0 + 3, WALL, L.archW - 3, L.H - WALL);
    // boxes
    for (const b of L.boxes) {
      px(b.x, b.y + 9, 14, 2, 'rgba(0,0,0,.18)');
      px(b.x, b.y, 14, 10, '#c9a46b'); px(b.x, b.y, 14, 2, '#b28d55'); px(b.x + 6, b.y, 2, 10, '#a8854f');
      px(b.x + 2, b.y + 4, 3, 3, SHIRT[b.agent.kind] || '#fff');
    }
  }

  // ---------- desk + character ----------
  function drawCharacter(cx, top, lk, pose, f) {
    const sitting = pose !== 'needs_you';
    if (pose === 'sleep') {
      // slumped forward, face down on folded arms
      px(cx - 5, top + 10, 10, 8, lk.shirt);
      px(cx - 4, top + 7, 8, 6, lk.hair);
      px(cx - 4, top + 11, 8, 2, lk.skin);
      return;
    }
    // head
    px(cx - 4, top, 8, 7, lk.skin);
    px(cx - 4, top, 8, 2, lk.hair);
    if (lk.hairStyle === 0) { px(cx - 4, top + 2, 1, 2, lk.hair); px(cx + 3, top + 2, 1, 2, lk.hair); }
    if (lk.hairStyle === 1) { px(cx - 5, top + 1, 1, 5, lk.hair); px(cx + 4, top + 1, 1, 5, lk.hair); px(cx - 4, top - 1, 8, 1, lk.hair); }
    if (lk.hairStyle === 2) { px(cx - 3, top - 1, 6, 1, lk.hair); }
    const eye = pose === 'error' ? '#c00' : '#2a1d14';
    if (pose === 'stopped') { px(cx - 3, top + 4, 2, 1, eye); px(cx + 1, top + 4, 2, 1, eye); }
    else { px(cx - 2, top + 3, 1, 2, eye); px(cx + 1, top + 3, 1, 2, eye); }
    if (lk.glasses) { px(cx - 3, top + 3, 3, 1, '#333'); px(cx + 0, top + 3, 3, 1, '#333'); }
    if (pose === 'done') px(cx - 1, top + 5, 2, 1, '#a0522d');
    if (pose === 'needs_you') px(cx - 1, top + 5, 2, 1, '#7a2e1a');
    // torso
    const torsoH = sitting ? 10 : 10;
    px(cx - 5, top + 7, 10, torsoH, lk.shirt);
    px(cx - 1, top + 7, 2, 2, 'rgba(255,255,255,.55)');
    if (!sitting) { px(cx - 4, top + 17, 3, 9, '#3d4a63'); px(cx + 1, top + 17, 3, 9, '#3d4a63'); }
    // arms
    if (pose === 'working') {
      px(cx - 7, top + 8, 2, 8, lk.shirt); px(cx + 5, top + 8, 2, 8, lk.shirt);
    } else if (pose === 'needs_you') {
      px(cx - 7, top + 8, 2, 8, lk.shirt); px(cx - 7, top + 16, 2, 2, lk.skin);
      const o = f ? 1 : 0;
      px(cx + 5 + o, top + 1, 2, 8, lk.shirt); px(cx + 5 + o, top - 2, 3, 3, lk.skin);
    } else if (pose === 'done') {
      px(cx - 7, top + 1, 3, 2, lk.shirt); px(cx + 4, top + 1, 3, 2, lk.shirt);
      px(cx - 7, top + 3, 2, 6, lk.shirt); px(cx + 5, top + 3, 2, 6, lk.shirt);
    } else {
      px(cx - 7, top + 8, 2, 9, lk.shirt); px(cx + 5, top + 8, 2, 9, lk.shirt);
    }
  }

  function drawScreen(x, y, pose, now, f) {
    const w = 16, h = 11;
    switch (pose) {
      case 'working': {
        px(x, y, w, h, '#0f1b33');
        const cols = ['#7dd3fc', '#a7f3d0', '#fca5a5', '#fde68a', '#c4b5fd'];
        const scroll = Math.floor(now / 280);
        for (let i = 0; i < 5; i++) {
          const k = hash(String(scroll + i));
          px(x + 1 + (k % 3), y + 1 + i * 2, 3 + (k % 10), 1, cols[k % cols.length]);
        }
        break;
      }
      case 'needs_you':
        px(x, y, w, h, f ? '#f59e0b' : '#9a3412');
        px(x + 7, y + 2, 2, 5, '#fff'); px(x + 7, y + 8, 2, 2, '#fff');
        break;
      case 'done':
        px(x, y, w, h, '#14532d');
        px(x + 4, y + 5, 2, 2, '#86efac'); px(x + 6, y + 7, 2, 2, '#86efac'); px(x + 8, y + 5, 2, 2, '#86efac'); px(x + 10, y + 3, 2, 2, '#86efac');
        break;
      case 'stopped':
        px(x, y, w, h, '#3f3f46'); px(x + 5, y + 3, 2, 5, '#fbbf24'); px(x + 9, y + 3, 2, 5, '#fbbf24');
        break;
      case 'error':
        px(x, y, w, h, f ? '#450a0a' : '#5c0f0f');
        for (let i = 0; i < 5; i++) { px(x + 5 + i, y + 3 + i, 2, 1, '#f87171'); px(x + 9 - i, y + 3 + i, 2, 1, '#f87171'); }
        break;
      default:
        px(x, y, w, h, '#0b0d12');
        if (pose === 'sleep' && Math.floor(now / 1200) % 2) px(x + w - 2, y + h - 2, 1, 1, '#22c55e');
    }
  }

  function drawDesk(d, now) {
    const { x, y, agent } = d;
    const pose = poseOf(agent, now);
    const f = Math.floor(now / 260) % 2;
    const cx = x + 48;
    // floor glow
    if (pose === 'needs_you' || pose === 'error') {
      const a = 0.18 + 0.14 * Math.sin(now / 260);
      ctx.fillStyle = pose === 'error' ? `rgba(194,65,12,${a})` : `rgba(229,72,77,${a})`;
      ctx.beginPath(); ctx.ellipse(x + CELL_W / 2, y + 48, 40, 24, 0, 0, Math.PI * 2); ctx.fill();
    }
    // rug
    px(x + 6, y + 58, CELL_W - 12, 4, 'rgba(90,60,30,.12)');
    // chair
    const chairX = agent ? cx - 7 : cx - 2;
    px(chairX, y + 22, 14, 13, '#3b4252'); px(chairX + 1, y + 23, 12, 3, '#4c5466');
    // character (behind desk)
    if (agent) {
      const lk = looks(agent);
      const top = pose === 'needs_you' ? y + 9 : y + 18;
      drawCharacter(cx, top, lk, pose, f);
    }
    // desk
    px(x + 10, y + 34, 64, 5, '#b07a45');
    px(x + 10, y + 34, 64, 1, '#c8915a');
    px(x + 10, y + 39, 64, 13, '#8b5a2b');
    px(x + 12, y + 41, 20, 9, '#7d4f24'); px(x + 20, y + 45, 4, 1, '#c8915a');
    px(x + 12, y + 52, 3, 6, '#6e4520'); px(x + 69, y + 52, 3, 6, '#6e4520');
    px(x + 10, y + 58, 64, 2, 'rgba(0,0,0,.14)');
    // monitor
    px(x + 21, y + 30, 4, 4, '#454a55'); px(x + 17, y + 33, 12, 1, '#454a55');
    px(x + 14, y + 17, 18, 14, '#2b2f3a');
    drawScreen(x + 15, y + 18, pose, now + (agent ? hash(agent.id) % 1000 : 0), f);
    if (agent) px(x + 15, y + 29, 3, 1, SHIRT[agent.kind] || '#fff');
    // keyboard
    px(x + 40, y + 35, 15, 2, '#d7d7d7'); px(x + 40, y + 37, 15, 1, '#a3a3a3');
    if (agent) {
      const lk = looks(agent);
      if (pose === 'working') {
        px(x + 40, y + 34 + (f ? 0 : 1), 3, 2, lk.skin); px(x + 52, y + 34 + (f ? 1 : 0), 3, 2, lk.skin);
      }
      if (pose === 'sleep') {
        px(cx - 8, y + 33, 16, 3, lk.shirt); px(cx - 8, y + 33, 3, 3, lk.skin); px(cx + 5, y + 33, 3, 3, lk.skin);
        const zt = (now / 90) % 24;
        for (let k = 0; k < 2; k++) {
          const zy = y + 26 - ((zt + k * 12) % 24), zx = cx + 6 + k * 4;
          ctx.globalAlpha = Math.max(0, 1 - ((zt + k * 12) % 24) / 24);
          px(zx, zy, 4, 1, '#fff'); px(zx + 2, zy + 1, 1, 1, '#fff'); px(zx + 1, zy + 2, 1, 1, '#fff'); px(zx, zy + 3, 4, 1, '#fff');
          ctx.globalAlpha = 1;
        }
      }
      if (pose === 'done' || pose === 'sleep') {
        // coffee mug, steaming while recently done
        px(x + 61, y + 30, 5, 5, '#f1f1f1'); px(x + 66, y + 31, 2, 3, '#f1f1f1'); px(x + 62, y + 31, 3, 1, '#6b3e1e');
        if (pose === 'done') { const s = Math.floor(now / 400) % 3; px(x + 62 + (s % 2), y + 26 - s, 1, 2, 'rgba(255,255,255,.7)'); }
      } else {
        px(x + 59, y + 32, 9, 3, '#f4f4f4'); px(x + 60, y + 31, 8, 1, '#e5e5e5');
      }
      if (pose === 'error') {
        const s = Math.floor(now / 300) % 4;
        ctx.fillStyle = 'rgba(80,80,80,.55)'; ctx.fillRect(x + 26 + (s % 2), y + 12 - s, 4, 3); ctx.fillRect(x + 22 - (s % 2), y + 9 - s, 3, 3);
      }
      // helper robots
      for (let i = 0; i < Math.min(3, agent.helpersActive || 0); i++) {
        const bx = x + 75, by = y + 24 + i * 10 + ((Math.floor(now / 300) + i) % 2);
        px(bx, by, 6, 5, '#cbd5e1'); px(bx + 1, by + 1, 1, 1, '#0ea5e9'); px(bx + 4, by + 1, 1, 1, '#0ea5e9');
        px(bx + 2, by - 2, 1, 2, '#94a3b8'); px(bx + 1, by + 5, 4, 2, '#94a3b8');
      }
    }
  }

  // ---------- public API ----------
  function draw(canvas, L, now) {
    if (canvas.width !== L.W || canvas.height !== L.H) { canvas.width = L.W; canvas.height = L.H; }
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    W = L.W; H = L.H;
    drawFloor(L);
    drawWall(L, now);
    for (const d of L.desks) drawDesk(d, now);
    drawArchiveRoom(L, now);
  }

  function avatar(agent, now) {
    const c = document.createElement('canvas');
    c.width = 20; c.height = 20;
    const saved = ctx;
    ctx = c.getContext('2d');
    px(0, 0, 20, 20, agent.archived ? '#a7adb6' : '#e9dfca');
    const pose = agent.archived ? 'sleep' : poseOf(agent, now);
    drawCharacter(10, pose === 'needs_you' ? 3 : 5, looks(agent), pose === 'sleep' ? 'stopped' : pose, 0);
    ctx = saved;
    return c.toDataURL();
  }

  window.Office = { layout, draw, avatar, boardRect, CELL_W, CELL_H, WALL, poseOf };
})();
