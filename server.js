// Agent Office — read-only dashboard over local AI agent session files.
// Never writes to any agent's files; it only reads Claude Code, Codex and Cursor state.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const PORT = Number(process.env.PORT || 3004);
const HOST = process.env.HOST || '127.0.0.1';
const ARCHIVE_DAYS = Number(process.env.ARCHIVE_DAYS || 3);
const WORKING_WINDOW_MS = 20_000; // file touched this recently => agent is active
const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

const PATHS = {
  claudeProjects: path.join(HOME, '.claude/projects'),
  claudeSessions: path.join(HOME, '.claude/sessions'),
  codexHome: path.join(HOME, '.codex'),
  cursorProjects: path.join(HOME, '.cursor/projects'),
};

// ---------- file helpers ----------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Parsed JSON lines from the end of the file (drops the first, possibly partial, line).
function tailJsonl(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const lines = readSlice(file, start, size - start).split('\n');
  if (start > 0) lines.shift();
  return parseLines(lines);
}

function headJsonl(file, size) {
  const lines = readSlice(file, 0, Math.min(size, HEAD_BYTES)).split('\n');
  if (size > HEAD_BYTES) lines.pop();
  return parseLines(lines);
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip partial/corrupt line */ }
  }
  return out;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function clip(s, n = 140) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cleanUserText(s) {
  return String(s || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
    .replace(/<\/?user_query>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1 ')
    .replace(/<command-(message|args)>[\s\S]*?<\/command-\1>/g, '')
    .trim();
}

function endsWithQuestion(text) {
  const t = String(text || '').trim().slice(-300);
  return /\?\s*(\**|`*)\s*$/.test(t) || /\?\s*\n/.test(t.slice(-120));
}

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return input.description || clip(input.command, 60);
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(input.notebook_path)}`;
    case 'Grep': return `Searching “${clip(input.pattern, 30)}”`;
    case 'Glob': return `Finding ${clip(input.pattern, 30)}`;
    case 'WebFetch': try { return `Reading ${new URL(input.url).host}`; } catch { return 'Fetching a page'; }
    case 'WebSearch': return `Searching web: ${clip(input.query, 40)}`;
    case 'Agent': case 'Task': return `Helper: ${clip(input.description, 40)}`;
    case 'TodoWrite': return 'Updating to-do list';
    case 'AskUserQuestion': return clip(input.questions?.[0]?.question, 80) || 'Asked you a question';
    case 'ExitPlanMode': return 'Plan ready for your approval';
    default:
      if (name?.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `${server}: ${tool}`;
      }
      return name || 'Working';
  }
}

const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// ---------- Claude Code ----------

function readClaudeLive() {
  const live = new Map();
  for (const ent of listDir(PATHS.claudeSessions)) {
    if (!ent.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PATHS.claudeSessions, ent.name), 'utf8'));
      if (j.sessionId) live.set(j.sessionId, { ...j, alive: pidAlive(j.pid) });
    } catch { /* ignore */ }
  }
  return live;
}

const parseCache = new Map(); // file -> { key, summary }

function cached(file, st, fn) {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = parseCache.get(file);
  if (hit && hit.key === key) return hit.summary;
  const summary = fn();
  parseCache.set(file, { key, summary });
  return summary;
}

function claudeUserText(rec) {
  if (rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  if (typeof c === 'string') return cleanUserText(c) || null;
  if (Array.isArray(c)) {
    if (c.some((x) => x.type === 'tool_result')) return null;
    const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    return cleanUserText(t) || null;
  }
  return null;
}

function parseClaudeFile(file, st) {
  const recs = tailJsonl(file, st.size);
  const s = {
    title: null, lastPrompt: null, firstPrompt: null, model: null, cwd: null, branch: null,
    costUSD: null, firstTs: null, lastTs: null, lastUserTs: null,
    lastKind: null, // 'user' | 'assistant' | 'error' | 'interrupted'
    lastAssistantText: '', stopReason: null, pending: [], lastTool: null,
  };
  const pending = new Map();
  for (const r of recs) {
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!s.firstTs) s.firstTs = t;
      s.lastTs = t;
    }
    if (r.cwd) s.cwd = r.cwd;
    if (r.gitBranch) s.branch = r.gitBranch;
    switch (r.type) {
      case 'ai-title': s.title = r.aiTitle || s.title; break;
      case 'last-prompt': s.lastPrompt = r.lastPrompt || s.lastPrompt; break;
      case 'cost-state': s.costUSD = r.totalCostUSD ?? s.costUSD; break;
      case 'system':
        if (r.level === 'error' || r.subtype === 'api_error') {
          s.lastKind = 'error';
          s.errorText = clip(r.error?.message || r.content || 'API error', 160);
        }
        break;
      case 'assistant': {
        if (r.isSidechain) break;
        const m = r.message || {};
        if (m.model && m.model !== '<synthetic>') s.model = m.model;
        for (const c of m.content || []) {
          if (c.type === 'text' && c.text?.trim()) s.lastAssistantText = c.text;
          if (c.type === 'tool_use') {
            pending.set(c.id, { name: c.name, desc: describeTool(c.name, c.input) });
            s.lastTool = { name: c.name, desc: describeTool(c.name, c.input), ts: Date.parse(r.timestamp) };
          }
        }
        if (m.stop_reason) s.stopReason = m.stop_reason;
        s.lastKind = 'assistant';
        break;
      }
      case 'user': {
        if (r.isSidechain) break;
        const c = r.message?.content;
        if (Array.isArray(c)) for (const x of c) if (x.type === 'tool_result') pending.delete(x.tool_use_id);
        const text = claudeUserText(r);
        if (text) {
          if (text.startsWith('[Request interrupted')) { s.lastKind = 'interrupted'; pending.clear(); break; }
          s.lastUserTs = Date.parse(r.timestamp) || s.lastUserTs;
          s.lastUserText = text;
          s.lastKind = 'user';
          s.lastAssistantText = '';
          s.stopReason = null;
        }
        break;
      }
    }
  }
  s.pending = [...pending.values()];
  if (!s.title || !s.firstPrompt) {
    for (const r of headJsonl(file, st.size)) {
      if (r.type === 'user') { const t = claudeUserText(r); if (t) { s.firstPrompt = t; break; } }
    }
  }
  return s;
}

function scanClaude(now) {
  const live = readClaudeLive();
  const agents = [];
  for (const proj of listDir(PATHS.claudeProjects)) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(PATHS.claudeProjects, proj.name);
    for (const ent of listDir(dir)) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, ent.name);
      const st = safeStat(file);
      if (!st || st.size === 0) continue;
      const id = ent.name.replace(/\.jsonl$/, '');
      const s = cached(file, st, () => parseClaudeFile(file, st));
      if (!s.firstTs && !s.lastPrompt && !s.firstPrompt) continue;
      const lv = live.get(id);
      const alive = !!lv?.alive;

      // Helpers (subagents) live in <id>/subagents/*.jsonl
      let helpers = 0, helpersActive = 0;
      for (const sub of listDir(path.join(dir, id, 'subagents'))) {
        if (!sub.name.endsWith('.jsonl')) continue;
        helpers++;
        const sst = safeStat(path.join(dir, id, 'subagents', sub.name));
        if (sst && now - sst.mtimeMs < WORKING_WINDOW_MS * 3) helpersActive++;
      }

      const lastActivity = Math.max(st.mtimeMs, s.lastTs || 0);
      const recent = now - st.mtimeMs < WORKING_WINDOW_MS;
      const busy = alive && lv.status === 'busy';
      const ask = s.pending.find((p) => ASK_TOOLS.has(p.name));
      let status, detail;

      if (ask) { status = 'needs_you'; detail = ask.desc; }
      else if (alive && lv.status && !['busy', 'idle'].includes(lv.status)) {
        status = 'needs_you'; detail = `Status: ${lv.status}`;
      } else if (s.lastKind === 'error') { status = 'error'; detail = s.errorText; }
      else if (s.pending.length) {
        const p = s.pending[s.pending.length - 1];
        if (busy || recent || helpersActive) { status = 'working'; detail = p.desc; }
        else if (alive) { status = 'needs_you'; detail = `Waiting for permission: ${p.desc}`; }
        else { status = 'stopped'; detail = `Stopped during: ${p.desc}`; }
      } else if (s.lastKind === 'user') {
        if (busy || recent) { status = 'working'; detail = 'Thinking…'; }
        else { status = 'stopped'; detail = 'Got your message but never replied'; }
      } else if (s.lastKind === 'interrupted') { status = 'stopped'; detail = 'You interrupted it'; }
      else if (busy) { status = 'working'; detail = 'Thinking…'; }
      else if (endsWithQuestion(s.lastAssistantText)) { status = 'needs_you'; detail = 'Asked you a question'; }
      else { status = 'done'; detail = 'Finished — your turn'; }

      const archived = !alive && now - lastActivity > ARCHIVE_DAYS * 86400_000;

      agents.push({
        id: `claude:${id}`, kind: 'claude', sessionId: id,
        title: clip(s.title || s.lastPrompt || s.firstPrompt || 'Untitled session', 80),
        firstPrompt: clip(s.firstPrompt, 300),
        lastPrompt: clip(s.lastUserText || s.lastPrompt, 300),
        lastMessage: clip(s.lastAssistantText, 600),
        project: s.cwd || proj.name.replace(/-/g, '/'),
        branch: s.branch, model: s.model, costUSD: s.costUSD,
        status, detail, archived, archivedReason: archived ? `No activity for ${ARCHIVE_DAYS}+ days` : null,
        alive, pid: alive ? lv.pid : null, entrypoint: lv?.entrypoint || null, liveName: lv?.name || null,
        startedAt: s.firstTs || st.birthtimeMs || st.mtimeMs, lastActivity,
        taskStartedAt: s.lastUserTs, helpers, helpersActive,
        lastTool: s.lastTool,
        _file: file,
      });
    }
  }
  return agents;
}

// ---------- Codex ----------

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older node */ }

function parseCodexRollout(file, st) {
  const recs = tailJsonl(file, st.size);
  const s = { lastEvent: null, lastAgentText: '', lastUserText: '', lastUserTs: null, lastTool: null,
    pendingCalls: new Map(), firstTs: null, lastTs: null, cwd: null, model: null, firstPrompt: null, errorText: null };
  for (const r of recs) {
    const t = Date.parse(r.timestamp);
    if (t) { s.firstTs ??= t; s.lastTs = t; }
    const p = r.payload || {};
    if (r.type === 'session_meta' || r.type === 'turn_context') { s.cwd = p.cwd || s.cwd; s.model = p.model || s.model; }
    if (r.type === 'event_msg') {
      switch (p.type) {
        case 'user_message':
          s.lastUserText = cleanUserText(p.message); s.lastUserTs = t; s.lastEvent = 'user';
          s.firstPrompt ??= s.lastUserText; s.lastAgentText = ''; break;
        case 'agent_message': s.lastAgentText = p.message || s.lastAgentText; break;
        case 'task_started': s.lastEvent = 'started'; break;
        case 'task_complete': s.lastEvent = 'complete'; if (p.last_agent_message) s.lastAgentText = p.last_agent_message; s.pendingCalls.clear(); break;
        case 'turn_aborted': s.lastEvent = 'aborted'; s.pendingCalls.clear(); break;
        case 'error': s.lastEvent = 'error'; s.errorText = clip(p.message, 160); break;
        default:
          if (/approval_request|request_user_input|elicitation/.test(p.type || '')) {
            s.lastEvent = 'needs'; s.needsText = p.type.includes('patch') ? 'Approve file changes' : p.type.includes('exec') ? `Approve command: ${clip((p.command || []).join?.(' ') || p.command, 60)}` : 'Asked you a question';
          }
      }
    }
    if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        let desc = p.name || 'tool';
        try {
          const a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || p.action || {});
          const cmd = a.command || a.cmd;
          if (cmd) desc = clip(Array.isArray(cmd) ? cmd.slice(-1)[0] : cmd, 60);
        } catch { /* keep name */ }
        s.lastTool = { name: p.name || 'shell', desc, ts: t };
        if (p.call_id) s.pendingCalls.set(p.call_id, desc);
        if (s.lastEvent !== 'needs') s.lastEvent = 'tool';
      }
      if (/_output$/.test(p.type || '') && p.call_id) {
        s.pendingCalls.delete(p.call_id);
        if (s.lastEvent === 'needs') s.lastEvent = 'tool';
      }
    }
  }
  s.pendingCalls = [...s.pendingCalls.values()];
  return s;
}

function codexRolloutFiles() {
  const out = [];
  const walk = (dir, archived, depth = 0) => {
    for (const e of listDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, archived, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push({ file: p, archived });
    }
  };
  walk(path.join(PATHS.codexHome, 'sessions'), false);
  walk(path.join(PATHS.codexHome, 'archived_sessions'), true);
  return out;
}

function readCodexThreads() {
  if (!DatabaseSync) return [];
  const dbs = listDir(PATHS.codexHome).filter((e) => /^state_\d+\.sqlite$/.test(e.name))
    .map((e) => e.name).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!dbs.length) return [];
  let db;
  try {
    db = new DatabaseSync(path.join(PATHS.codexHome, dbs[0]), { readOnly: true });
    return db.prepare('SELECT * FROM threads').all();
  } catch { return []; } finally { try { db?.close(); } catch { /* ignore */ } }
}

function scanCodex(now) {
  const agents = [];
  const threads = readCodexThreads();
  const byRollout = new Map(threads.filter((t) => t.rollout_path).map((t) => [path.resolve(t.rollout_path), t]));
  const files = codexRolloutFiles();
  const seen = new Set();
  const all = files.map((f) => ({ ...f, thread: byRollout.get(path.resolve(f.file)) }));
  for (const t of threads) {
    if (t.rollout_path && !files.some((f) => path.resolve(f.file) === path.resolve(t.rollout_path))) {
      all.push({ file: t.rollout_path, archived: !!t.archived, thread: t });
    }
  }
  for (const { file, archived: inArchiveDir, thread: t } of all) {
    if (seen.has(file)) continue;
    seen.add(file);
    const st = safeStat(file);
    const s = st ? cached(file, st, () => parseCodexRollout(file, st)) : null;
    const tsOf = (v) => (v ? (v > 1e12 ? v : v * 1000) : 0);
    const lastActivity = Math.max(st?.mtimeMs || 0, s?.lastTs || 0, tsOf(t?.updated_at_ms || t?.updated_at));
    const recent = now - (st?.mtimeMs || 0) < WORKING_WINDOW_MS;
    let status, detail;
    const ev = s?.lastEvent;
    if (ev === 'needs') { status = 'needs_you'; detail = s.needsText; }
    else if (ev === 'error') { status = 'error'; detail = s.errorText; }
    else if (ev === 'complete') {
      if (endsWithQuestion(s.lastAgentText)) { status = 'needs_you'; detail = 'Asked you a question'; }
      else { status = 'done'; detail = 'Finished — your turn'; }
    } else if (ev === 'aborted') { status = 'stopped'; detail = 'Turn was interrupted'; }
    else if (ev && recent) { status = 'working'; detail = s.lastTool?.desc || 'Thinking…'; }
    else if (ev === 'tool' && s.pendingCalls.length && now - lastActivity < 10 * 60_000) {
      status = 'needs_you'; detail = `Waiting for approval: ${s.pendingCalls.slice(-1)[0]}`;
    } else if (ev) { status = 'stopped'; detail = 'Stopped mid-task'; }
    else { status = 'done'; detail = 'No activity recorded'; }

    const explicitArchive = !!t?.archived || inArchiveDir;
    const archived = explicitArchive || now - lastActivity > ARCHIVE_DAYS * 86400_000;
    const id = t?.id || path.basename(file).replace(/\.jsonl$/, '');
    agents.push({
      id: `codex:${id}`, kind: 'codex', sessionId: id,
      title: clip(t?.name || t?.title || t?.preview || s?.firstPrompt || t?.first_user_message || 'Untitled thread', 80),
      firstPrompt: clip(t?.first_user_message || s?.firstPrompt, 300),
      lastPrompt: clip(s?.lastUserText, 300), lastMessage: clip(s?.lastAgentText, 600),
      project: t?.cwd || s?.cwd || '', branch: t?.git_branch || null, model: t?.model || s?.model || null,
      tokens: t?.tokens_used || null,
      status, detail, archived,
      archivedReason: explicitArchive ? 'Archived in Codex' : archived ? `No activity for ${ARCHIVE_DAYS}+ days` : null,
      alive: recent, startedAt: tsOf(t?.created_at_ms || t?.created_at) || s?.firstTs || st?.birthtimeMs, lastActivity,
      taskStartedAt: s?.lastUserTs, helpers: 0, helpersActive: 0, lastTool: s?.lastTool || null,
      _file: st ? file : null,
    });
  }
  return agents;
}

// ---------- Cursor ----------

function cursorText(msg) {
  const c = msg?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

function parseCursorFile(file, st) {
  const recs = tailJsonl(file, st.size);
  const s = { lastRole: null, lastAssistantText: '', lastUserText: '', firstPrompt: null, lastTool: null };
  for (const r of recs) {
    const role = r.role || r.message?.role;
    if (role === 'user') {
      const t = cleanUserText(cursorText(r));
      if (t) { s.lastUserText = t; s.lastRole = 'user'; s.lastAssistantText = ''; }
    } else if (role === 'assistant') {
      const t = cursorText(r);
      if (t.trim()) s.lastAssistantText = t;
      for (const c of r.message?.content || []) {
        if (c.type === 'tool_use' || c.type === 'tool-call') s.lastTool = { name: c.name || c.toolName, desc: describeTool(c.name || c.toolName, c.input || c.args) };
      }
      s.lastRole = 'assistant';
    }
  }
  for (const r of headJsonl(file, st.size)) {
    if ((r.role || r.message?.role) === 'user') { const t = cleanUserText(cursorText(r)); if (t) { s.firstPrompt = t; break; } }
  }
  return s;
}

// Cursor names project folders by flattening the path with dashes; undo it when the result exists.
function cursorProjectPath(name) {
  const guess = process.platform === 'win32'
    ? name.replace(/^([a-z])-/i, '$1:\\').replace(/-/g, '\\')
    : '/' + name.replace(/-/g, '/');
  return safeStat(guess) ? guess : name;
}

function scanCursor(now) {
  const agents = [];
  for (const proj of listDir(PATHS.cursorProjects)) {
    if (!proj.isDirectory()) continue;
    const tdir = path.join(PATHS.cursorProjects, proj.name, 'agent-transcripts');
    for (const conv of listDir(tdir)) {
      if (!conv.isDirectory()) continue;
      const file = path.join(tdir, conv.name, `${conv.name}.jsonl`);
      const st = safeStat(file);
      if (!st || st.size === 0) continue;
      const s = cached(file, st, () => parseCursorFile(file, st));
      const recent = now - st.mtimeMs < WORKING_WINDOW_MS;
      let helpers = 0, helpersActive = 0;
      for (const sub of listDir(path.join(tdir, conv.name, 'subagents'))) {
        helpers++;
        const sst = safeStat(path.join(tdir, conv.name, 'subagents', sub.name));
        if (sst && now - sst.mtimeMs < WORKING_WINDOW_MS * 3) helpersActive++;
      }
      let status, detail;
      if (recent || helpersActive) { status = 'working'; detail = s.lastTool?.desc || 'Working…'; }
      else if (s.lastRole === 'user') { status = 'stopped'; detail = 'Got your message but never replied'; }
      else if (endsWithQuestion(s.lastAssistantText)) { status = 'needs_you'; detail = 'Asked you a question'; }
      else { status = 'done'; detail = 'Finished — your turn'; }
      const archived = now - st.mtimeMs > ARCHIVE_DAYS * 86400_000;
      agents.push({
        id: `cursor:${conv.name}`, kind: 'cursor', sessionId: conv.name,
        title: clip(s.firstPrompt || 'Untitled chat', 80),
        firstPrompt: clip(s.firstPrompt, 300), lastPrompt: clip(s.lastUserText, 300), lastMessage: clip(s.lastAssistantText, 600),
        project: cursorProjectPath(proj.name), branch: null, model: null,
        status, detail, archived, archivedReason: archived ? `No activity for ${ARCHIVE_DAYS}+ days` : null,
        alive: recent, startedAt: st.birthtimeMs || st.mtimeMs, lastActivity: st.mtimeMs,
        taskStartedAt: null, helpers, helpersActive, lastTool: s.lastTool,
        _file: file,
      });
    }
  }
  return agents;
}

// ---------- transcript (drill-down) ----------

function transcript(agent, limit = 60) {
  if (!agent._file) return [];
  const st = safeStat(agent._file);
  if (!st) return [];
  const items = [];
  const push = (role, kind, text, ts) => { if (text && String(text).trim()) items.push({ role, kind, text: String(text).slice(0, 4000), ts: ts || null }); };
  for (const r of tailJsonl(agent._file, st.size)) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : null;
    if (agent.kind === 'claude') {
      if (r.isSidechain) continue;
      if (r.type === 'user') {
        const t = claudeUserText(r);
        if (t) push('user', 'text', t, ts);
      } else if (r.type === 'assistant') {
        for (const c of r.message?.content || []) {
          if (c.type === 'text') push('agent', 'text', c.text, ts);
          if (c.type === 'tool_use') push('agent', 'tool', describeTool(c.name, c.input), ts);
        }
      } else if (r.type === 'system' && r.level === 'error') push('system', 'error', r.error?.message || r.content, ts);
    } else if (agent.kind === 'codex') {
      const p = r.payload || {};
      if (r.type === 'event_msg' && p.type === 'user_message') push('user', 'text', cleanUserText(p.message), ts);
      if (r.type === 'event_msg' && p.type === 'agent_message') push('agent', 'text', p.message, ts);
      if (r.type === 'response_item' && /call$/.test(p.type || '')) push('agent', 'tool', p.name || 'tool', ts);
    } else {
      const role = r.role || r.message?.role;
      const t = role === 'user' ? cleanUserText(cursorText(r)) : cursorText(r);
      push(role === 'user' ? 'user' : 'agent', 'text', t, ts);
    }
  }
  return items.slice(-limit);
}

// ---------- server ----------

let lastScan = { at: 0, agents: [] };
function scanAll() {
  const now = Date.now();
  if (now - lastScan.at < 1000) return lastScan;
  const agents = [];
  for (const fn of [scanClaude, scanCodex, scanCursor]) {
    try { agents.push(...fn(now)); } catch (e) { console.error(`${fn.name} failed:`, e.message); }
  }
  lastScan = { at: now, agents };
  return lastScan;
}

// Access key: localhost is reachable by every account on the machine, so require a secret.
const crypto = require('node:crypto');
const KEY_FILE = path.join(HOME, '.config/agent-office/key');
function loadKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { /* create below */ }
  const key = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  return key;
}
const KEY = loadKey();
function keyOk(given) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieKey(req) {
  const m = /(?:^|;\s*)ao_key=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

const publicView = ({ _file, ...rest }) => rest;

// Fake agents covering every state, for previewing the UI (open /#demo).
function demoAgents() {
  const now = Date.now(), m = 60_000;
  const mk = (i, kind, title, status, detail, idleMin, extra = {}) => ({
    id: `demo:${i}`, kind, sessionId: `demo-${i}`, title, status, detail, archived: false, archivedReason: null,
    project: '/home/me/projects/demo', branch: 'main', model: kind === 'claude' ? 'claude-opus-5-5' : null,
    firstPrompt: title, lastPrompt: title, lastMessage: '', alive: true, startedAt: now - (100 - i) * m,
    lastActivity: now - idleMin * m, taskStartedAt: now - (idleMin + 5) * m, helpers: 0, helpersActive: 0, lastTool: null, ...extra,
  });
  return [
    mk(1, 'claude', 'Refactor auth middleware', 'working', 'Editing auth.ts', 0, { helpers: 2, helpersActive: 2 }),
    mk(2, 'codex', 'Fix flaky payments test', 'needs_you', 'Approve command: npm test', 4),
    mk(3, 'cursor', 'Landing page copy', 'done', 'Finished — your turn', 12),
    mk(4, 'claude', 'Migrate DB schema', 'needs_you', 'Which column name should we use?', 22),
    mk(5, 'claude', 'Write release notes', 'done', 'Finished — your turn', 240),
    mk(6, 'codex', 'Upgrade dependencies', 'error', 'API error: rate limited', 30),
    mk(7, 'claude', 'Research caching options', 'stopped', 'You interrupted it', 75),
    mk(8, 'cursor', 'Old onboarding flow', 'done', 'Finished', 6000, { archived: true, archivedReason: 'No activity for 3+ days' }),
    mk(9, 'codex', 'Spike: websockets', 'done', 'Finished', 9000, { archived: true, archivedReason: 'Archived in Codex' }),
  ];
}
const STATIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'read-only' });
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.has('key')) {
    if (!keyOk(url.searchParams.get('key'))) return send(res, 401, 'Wrong key.', 'text/plain');
    res.writeHead(302, { Location: '/', 'Set-Cookie': `ao_key=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    return res.end();
  }
  if (!keyOk(cookieKey(req))) {
    return send(res, 401, 'Agent Office is locked. Open the link printed by ./run.sh (it contains your key).', 'text/plain; charset=utf-8');
  }
  if (url.pathname === '/api/agents') {
    if (url.searchParams.has('demo')) return send(res, 200, { now: Date.now(), archiveDays: ARCHIVE_DAYS, agents: demoAgents() });
    const { at, agents } = scanAll();
    return send(res, 200, { now: at, archiveDays: ARCHIVE_DAYS, agents: agents.map(publicView) });
  }
  if (url.pathname === '/api/transcript') {
    const agent = scanAll().agents.find((a) => a.id === url.searchParams.get('id'));
    if (!agent) return send(res, 404, { error: 'unknown agent' });
    return send(res, 200, { id: agent.id, items: transcript(agent) });
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(STATIC, path.normalize(rel));
  if (!file.startsWith(STATIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}).listen(PORT, HOST, () => {
  console.log(`Agent Office running (archive after ${ARCHIVE_DAYS} days idle)`);
  console.log(`Open: http://localhost:${PORT}/?key=${KEY}`);
});
