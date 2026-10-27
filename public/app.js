'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 3000;
  const STATUS = {
    needs_you: { label: 'Needs you', short: 'WAITING' },
    working: { label: 'Working', short: 'WORKING' },
    done: { label: 'Done', short: 'DONE' },
    stopped: { label: 'Stopped', short: 'STOPPED' },
    error: { label: 'Error', short: 'ERROR' },
    archived: { label: 'Archived', short: 'ARCHIVED' },
  };
  const KIND = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
  const GROUPS = [
    { key: 'needs_you', title: 'Needs you', match: (a) => !a.archived && a.status === 'needs_you', sort: 'oldest' },
    { key: 'working', title: 'Working', match: (a) => !a.archived && a.status === 'working' },
    { key: 'stuck', title: 'Stopped / errors', match: (a) => !a.archived && (a.status === 'stopped' || a.status === 'error') },
    { key: 'done', title: 'Done · your turn', match: (a) => !a.archived && a.status === 'done' },
    { key: 'archived', title: 'Archived', match: (a) => a.archived, closed: true },
  ];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('ao.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ao.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const state = {
    agents: [], now: Date.now(), archiveDays: 3, layout: null, prev: new Map(), first: true,
    kind: store.get('kind', 'all'), search: '', selected: null, alerts: store.get('alerts', false),
    openGroups: store.get('openGroups', {}), transcriptTimer: null, avatars: new Map(), error: null,
  };

  // ---------- time ----------
  function rel(ms) {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (s < 45) return `${s}s`;
    if (m < 60) return `${m}m`;
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${d}d ${h % 24}h`;
  }
  const clockNow = () => state.now + (Date.now() - state.fetchedAt || 0);
  function when(a, now) {
    const idle = rel(now - a.lastActivity);
    if (a.archived) return `idle ${idle}`;
    switch (a.status) {
      case 'needs_you': return `waiting ${idle}`;
      case 'working': return a.taskStartedAt ? `for ${rel(now - a.taskStartedAt)}` : 'now';
      default: return `${idle} ago`;
    }
  }
  const fmtDate = (t) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const base = (p) => (p || '').split('/').filter(Boolean).pop() || p || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statusKey = (a) => (a.archived ? 'archived' : a.status);

  function visible() {
    const q = state.search.trim().toLowerCase();
    return state.agents.filter((a) => (state.kind === 'all' || a.kind === state.kind) &&
      (!q || [a.title, a.project, a.detail, a.lastPrompt, a.branch].some((v) => v && v.toLowerCase().includes(q))));
  }

  function avatarFor(a, now) {
    const pose = a.archived ? 'archived' : Office.poseOf(a, now);
    const key = `${a.id}|${pose}`;
    if (!state.avatars.has(key)) state.avatars.set(key, Office.avatar(a, now));
    return state.avatars.get(key);
  }

  // ---------- fetching ----------
  async function poll() {
    try {
      const r = await fetch(location.hash === '#demo' ? '/api/agents?demo=1' : '/api/agents', { cache: 'no-store' });
      if (r.status === 401) throw new Error('Locked: open the link printed by ./run.sh');
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const j = await r.json();
      state.agents = j.agents; state.now = j.now; state.fetchedAt = Date.now(); state.archiveDays = j.archiveDays;
      state.error = null;
      detectTransitions();
    } catch (e) {
      state.error = e.message;
    }
    render();
  }

  function detectTransitions() {
    for (const a of state.agents) {
      const prev = state.prev.get(a.id);
      const cur = statusKey(a);
      if (!state.first && prev !== cur) {
        if (cur === 'needs_you') notify(a, `${a.title} needs you`, a.detail || 'Waiting on your reply', 'needs_you');
        else if (cur === 'done' && (prev === 'working' || prev === undefined)) notify(a, `${a.title} finished`, a.lastMessage || 'Done — your turn', 'done');
      }
      state.prev.set(a.id, cur);
    }
    state.first = false;
  }

  function notify(a, title, body, kind) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `<b>${esc(title)}</b><br>${esc(String(body).slice(0, 140))}`;
    t.onclick = () => { openDrawer(a.id); t.remove(); };
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 9000);
    if (!state.alerts) return;
    beep(kind === 'needs_you' ? 880 : 660);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(title, { body: String(body).slice(0, 200), tag: a.id }); n.onclick = () => { window.focus(); openDrawer(a.id); }; } catch { /* ignore */ }
    }
  }

  let audio;
  function beep(freq) {
    try {
      audio ||= new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.12);
    } catch { /* no audio */ }
  }

  // ---------- render ----------
  function render() {
    const now = clockNow();
    const list = visible();
    renderCounts(list);
    renderOffice(list, now);
    renderRoster(list, now);
    const needs = list.filter((a) => !a.archived && a.status === 'needs_you').length;
    document.title = needs ? `(${needs}) Agent Office` : 'Agent Office';
    $('foot').textContent = state.error ? `⚠ ${state.error}` :
      `Read-only. Updated ${new Date(state.fetchedAt || Date.now()).toLocaleTimeString()} · archived = no activity for ${state.archiveDays}+ days (or archived in Codex).`;
    if (state.selected) fillDrawer();
  }

  function renderCounts(list) {
    const c = { needs_you: 0, working: 0, done: 0, stuck: 0, archived: 0 };
    for (const a of list) {
      if (a.archived) c.archived++;
      else if (a.status === 'stopped' || a.status === 'error') c.stuck++;
      else c[a.status]++;
    }
    const chip = (k, label, n, hot) => `<span class="count ${hot && n ? 'hot' : ''} ${n ? '' : 'zero'}"><i class="dot ${k}"></i>${label} <b>${n}</b></span>`;
    $('counts').innerHTML = chip('needs_you', 'Needs you', c.needs_you, true) + chip('working', 'Working', c.working) +
      chip('done', 'Done', c.done) + chip('stopped', 'Stopped', c.stuck) + chip('archived', 'Archived', c.archived);
  }

  function renderOffice(list, now) {
    const wrap = $('officeWrap');
    const width = $('officeScroll').clientWidth || 800;
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt); // stable desk seating
    const L = Office.layout(sorted, width);
    state.layout = L;
    wrap.style.width = `${L.W * L.scale}px`;
    wrap.style.height = `${L.H * L.scale}px`;
    const cv = $('office');
    cv.style.width = `${L.W * L.scale}px`;
    cv.style.height = `${L.H * L.scale}px`;
    const s = L.scale;
    let html = '';
    const b = Office.boardRect(L);
    const needs = list.filter((a) => !a.archived && a.status === 'needs_you').length;
    html += `<div class="wall-board" style="left:${b.x * s}px;top:${b.y * s}px;width:${b.w * s}px;height:${b.h * s}px">` +
      (needs ? `NEEDS YOU<span class="big">${needs}</span>` : `<span class="ok">ALL CLEAR</span>`) + '</div>';
    for (const d of L.desks) {
      if (!d.agent) continue;
      const a = d.agent, pose = Office.poseOf(a, now);
      let bubble = '';
      if (pose === 'needs_you') bubble = `! ${a.detail || 'Needs you'}`;
      else if (pose === 'working') bubble = a.detail || 'Working…';
      else if (pose === 'stopped') bubble = 'Paused';
      else if (pose === 'error') bubble = 'Error';
      else if (pose === 'done') bubble = '✓ Done';
      html += `<div class="desk-hit ${state.selected === a.id ? 'selected' : ''}" data-id="${esc(a.id)}" title="${esc(a.title)}"
        style="left:${d.x * s}px;top:${d.y * s}px;width:${Office.CELL_W * s}px;height:${Office.CELL_H * s}px">
        ${bubble ? `<div class="bubble ${pose}" style="top:${(pose === 'needs_you' ? -6 : 4) * s}px">${esc(bubble)}</div>` : ''}
        <div class="nameplate"><span class="t">${esc(a.title)}</span><span class="s ${a.status}">${a.status === 'needs_you' ? '' : STATUS[a.status].short + ' · '}${esc(when(a, now)).toUpperCase()}</span></div>
      </div>`;
    }
    if (!L.desks.some((d) => d.agent)) {
      html += `<div class="empty-floor" style="top:${(Office.WALL + 62) * s}px;width:${L.floorW * s}px">No active agents. Start a chat and it shows up here.</div>`;
    }
    html += `<div class="room-sign" style="left:${(L.floorW + L.archW / 2) * s}px;top:${(Office.WALL + 4) * s}px">ARCHIVE · ${L.archivedCount}</div>`;
    for (const bx of L.boxes) {
      html += `<div class="box-hit" data-id="${esc(bx.agent.id)}" title="${esc(bx.agent.title)} — idle ${rel(now - bx.agent.lastActivity)}"
        style="left:${bx.x * s}px;top:${bx.y * s}px;width:${14 * s}px;height:${10 * s}px"></div>`;
    }
    if (L.overflow > 0) {
      const last = L.boxes[L.boxes.length - 1];
      html += `<div class="box-more" style="left:${(L.floorW + 8) * s}px;top:${(last.y + 13) * s}px">+${L.overflow} more</div>`;
    }
    $('overlay').innerHTML = html;
    Office.draw(cv, L, now); // keep pixels in sync with the overlay immediately
  }

  function renderRoster(list, now) {
    let html = '';
    for (const g of GROUPS) {
      const items = list.filter(g.match).sort((a, b) => g.sort === 'oldest' ? a.lastActivity - b.lastActivity : b.lastActivity - a.lastActivity);
      if (!items.length && g.key !== 'needs_you') continue;
      const open = state.openGroups[g.key] ?? !g.closed;
      html += `<details class="group ${g.key}" data-group="${g.key}" ${open ? 'open' : ''}><summary>${g.title}<span class="n">${items.length}</span></summary>`;
      if (!items.length) html += `<div class="empty">Nothing is waiting on you.</div>`;
      for (const a of items) {
        const sk = statusKey(a);
        html += `<button class="row ${state.selected === a.id ? 'selected' : ''}" data-id="${esc(a.id)}">
          <img class="ava" alt="" src="${avatarFor(a, now)}">
          <span style="min-width:0">
            <div class="title">${esc(a.title)}</div>
            <div class="detail"><span class="kind-tag ${a.kind}">${a.kind.toUpperCase()}</span>${esc(a.archived ? a.archivedReason : a.detail)}</div>
            <div class="sub">${esc(base(a.project))}${a.branch ? ' · ' + esc(a.branch) : ''}${a.helpersActive ? ` · ${a.helpersActive} helper${a.helpersActive > 1 ? 's' : ''} running` : ''}</div>
          </span>
          <span class="when ${sk === 'needs_you' ? 'hot' : ''}">${esc(when(a, now))}</span>
        </button>`;
      }
      html += '</details>';
    }
    if (!list.length) html = `<div class="group"><div class="empty">No sessions found${state.search ? ' for that search' : ''}.</div></div>`;
    $('groups').innerHTML = html;
  }

  // ---------- drawer ----------
  function openDrawer(id) {
    state.selected = id;
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('backdrop').hidden = false;
    $('dTranscript').innerHTML = '<div class="empty">Loading…</div>';
    state.transcriptScrolled = false;
    fillDrawer();
    loadTranscript();
    clearInterval(state.transcriptTimer);
    state.transcriptTimer = setInterval(loadTranscript, 4000);
    render();
  }
  function closeDrawer() {
    state.selected = null;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('backdrop').hidden = true;
    clearInterval(state.transcriptTimer);
    render();
  }

  function fillDrawer() {
    const a = state.agents.find((x) => x.id === state.selected);
    if (!a) return;
    const now = clockNow();
    const sk = statusKey(a);
    $('dKind').innerHTML = `<span class="kind-tag ${a.kind}">${a.kind.toUpperCase()}</span> ${esc(KIND[a.kind])}${a.entrypoint ? ' · ' + esc(a.entrypoint.replace('claude-', '')) : ''}`;
    $('dTitle').textContent = a.title;
    $('dStatus').className = `drawer-status ${sk}`;
    $('dStatus').innerHTML = `<span class="lbl">${STATUS[sk].short}</span><span>${esc(a.archived ? a.archivedReason : a.detail)}</span>`;
    const facts = [
      ['Last activity', `${rel(now - a.lastActivity)} ago · ${fmtDate(a.lastActivity)}`],
      a.taskStartedAt && ['Current task started', `${rel(now - a.taskStartedAt)} ago · ${fmtDate(a.taskStartedAt)}`],
      ['Session started', fmtDate(a.startedAt)],
      ['Project', a.project],
      a.branch && ['Branch', a.branch],
      a.model && ['Model', a.model],
      a.costUSD != null && ['Cost so far', `$${Number(a.costUSD).toFixed(2)}`],
      a.tokens && ['Tokens', Number(a.tokens).toLocaleString()],
      a.helpers ? ['Helpers', `${a.helpers} total · ${a.helpersActive} running`] : null,
      a.kind === 'claude' && ['Process', a.alive ? `open (pid ${a.pid})` : 'closed'],
      a.lastPrompt && ['Your last message', a.lastPrompt],
      ['Session ID', a.sessionId],
    ].filter(Boolean);
    $('dFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const cmd = a.kind === 'claude' ? `cd ${a.project} && claude --resume ${a.sessionId}` : a.kind === 'codex' ? `codex resume ${a.sessionId}` : '';
    $('dResume').innerHTML = cmd ? `<span class="muted">Resume in terminal</span><code>${esc(cmd)}</code><button class="icon-btn" id="copyCmd">Copy</button>` : '';
    const btn = $('copyCmd');
    if (btn) btn.onclick = () => navigator.clipboard?.writeText(cmd).then(() => { btn.textContent = 'Copied'; });
  }

  async function loadTranscript() {
    const id = state.selected;
    if (!id) return;
    try {
      const r = await fetch(`/api/transcript?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = await r.json();
      if (state.selected !== id) return;
      const box = $('dTranscript');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = (j.items || []).map((m) =>
        `<div class="msg ${m.kind === 'tool' ? 'tool' : m.kind === 'error' ? 'error' : m.role}">${esc(m.text)}${m.ts && m.kind !== 'tool' ? `<span class="ts">${fmtDate(m.ts)}</span>` : ''}</div>`
      ).join('') || '<div class="empty">No messages recorded.</div>';
      if (!state.transcriptScrolled || atBottom) { box.scrollTop = box.scrollHeight; state.transcriptScrolled = true; }
    } catch { /* keep previous */ }
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-id]');
    if (hit && !e.target.closest('.drawer')) openDrawer(hit.dataset.id);
  });
  $('groups').addEventListener('toggle', (e) => {
    const g = e.target.closest('details[data-group]');
    if (!g) return;
    state.openGroups[g.dataset.group] = g.open;
    store.set('openGroups', state.openGroups);
  }, true);
  $('dClose').onclick = closeDrawer;
  $('backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDrawer(); });
  $('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('kindFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    state.kind = b.dataset.kind; store.set('kind', state.kind);
    syncKindButtons(); render();
  });
  function syncKindButtons() {
    for (const b of $('kindFilter').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === state.kind);
  }
  function syncAlertsBtn() {
    $('alertsBtn').textContent = state.alerts ? '🔔 Alerts on' : '🔕 Alerts off';
    $('alertsBtn').classList.toggle('on', state.alerts);
  }
  $('alertsBtn').onclick = async () => {
    state.alerts = !state.alerts;
    if (state.alerts && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    if (state.alerts) beep(660);
    store.set('alerts', state.alerts); syncAlertsBtn();
  };
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = $('officeScroll').clientWidth;
    if (w !== lastWidth) { lastWidth = w; render(); }
  }).observe($('officeScroll'));

  // ---------- loops ----------
  let lastFrame = 0;
  function frame(t) {
    if (t - lastFrame > 90 && state.layout) { Office.draw($('office'), state.layout, clockNow()); lastFrame = t; }
    requestAnimationFrame(frame);
  }
  syncKindButtons(); syncAlertsBtn();
  poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
})();
