#!/usr/bin/env node
/**
 * Local sync agent
 * - Pushes session/git data to Railway dashboard
 * - Pulls pending tasks and executes them via `claude -p`
 * - Pushes results back
 *
 * Usage:
 *   DASHBOARD_URL=https://your-app.railway.app SYNC_SECRET=your-secret node sync.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3333';
const SYNC_SECRET = process.env.SYNC_SECRET || 'change-me';
const INTERVAL = 5_000; // 5 seconds (faster for task responsiveness)
const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');

// Track dashboard-spawned claude sessions for --resume
const dashboardSessions = new Map(); // original sessionId -> dashboard sessionId

// Currently running tasks
const runningTasks = new Map(); // taskId -> { proc, chunks, done }

// ── Session/Git data collection ──
function getActiveSessions() {
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  let files;
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')); } catch { return []; }
  const active = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      try { process.kill(data.pid, 0); active.push(data); } catch {}
    } catch {}
  }
  return active;
}

function getGitInfo(projectPath) {
  try {
    if (!fs.existsSync(path.join(projectPath, '.git'))) return null;
    const branch = execSync('git branch --show-current', { cwd: projectPath, encoding: 'utf8' }).trim();
    const lastCommit = execSync('git log -1 --format="%h|%s|%ar"', { cwd: projectPath, encoding: 'utf8' }).trim();
    const changed = execSync('git status --porcelain', { cwd: projectPath, encoding: 'utf8' }).trim();
    const changedFiles = changed ? changed.split('\n') : [];
    let remote = '';
    try { remote = execSync('git remote get-url origin', { cwd: projectPath, encoding: 'utf8' }).trim(); } catch {}
    const [hash, subject, relTime] = lastCommit.split('|');
    return { branch, lastCommit: { hash, subject, relTime }, changedFiles: changedFiles.map(f => ({ status: f.substring(0, 2).trim(), file: f.substring(3) })), remote };
  } catch { return null; }
}

function getSessionConversation(sessionId) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsDir); } catch { return []; }
  for (const dir of projectDirs) {
    const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;
    try {
      const content = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = content.split('\n');
      const entries = [];
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.type !== 'user' && d.type !== 'assistant') continue;
          let msg = d.message;
          if (typeof msg === 'string') msg = JSON.parse(msg);
          const role = msg.role || d.type;
          const rawContent = msg.content;
          let text = '';
          if (typeof rawContent === 'string') text = rawContent;
          else if (Array.isArray(rawContent)) text = rawContent.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
          text = text.trim();
          if (!text) continue;
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (!text) continue;
          entries.push({ role, text: text.substring(0, 2000), timestamp: d.timestamp });
        } catch {}
      }
      return entries.slice(-30);
    } catch {}
  }
  return [];
}

function getGlobalHistory() {
  const historyFile = path.join(CLAUDE_DIR, 'history.jsonl');
  try {
    const content = fs.readFileSync(historyFile, 'utf8').trim();
    const lines = content.split('\n').slice(-50);
    return lines.map(line => { try { const p = JSON.parse(line); return { display: p.display?.substring(0, 100), project: p.project, timestamp: p.timestamp }; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── Execute claude task locally ──
function executeTask(task) {
  const { taskId, sessionId, cwd, prompt } = task;

  const entry = { chunks: [], done: false };
  runningTasks.set(taskId, entry);

  const args = ['-p', '--output-format', 'text'];

  // Resume dashboard conversation if exists
  const dashSid = dashboardSessions.get(sessionId);
  if (dashSid) {
    args.push('--resume', dashSid);
  }

  args.push(prompt);

  console.log(`[Task ${taskId}] Executing: claude ${args.slice(0, 3).join(' ')} "${prompt.substring(0, 50)}..."`);

  const proc = spawn('claude', args, {
    cwd: fs.existsSync(cwd) ? cwd : process.env.HOME,
    env: { ...process.env },
    shell: false
  });

  proc.stdout.on('data', (data) => {
    entry.chunks.push(data.toString());
  });

  proc.stderr.on('data', (data) => {
    // Capture stderr too (progress info etc)
    const text = data.toString().trim();
    if (text && !text.includes('⠋') && !text.includes('⠙')) {
      entry.chunks.push(text);
    }
  });

  proc.on('close', (code) => {
    entry.done = true;
    console.log(`[Task ${taskId}] Done (exit: ${code})`);

    // Try to capture the new session ID from claude output for --resume
    // Claude -p creates a session we can resume
  });

  proc.on('error', (err) => {
    entry.chunks.push(`[오류] ${err.message}`);
    entry.done = true;
  });
}

// ── Sync loop ──
async function sync() {
  try {
    const sessions = getActiveSessions();
    const enriched = sessions.map(s => ({
      ...s,
      projectName: path.basename(s.cwd),
      git: getGitInfo(s.cwd),
      uptime: Date.now() - s.startedAt,
      conversationHistory: getSessionConversation(s.sessionId)
    }));
    const history = getGlobalHistory();

    // Collect results from running/completed tasks
    const taskResults = [];
    for (const [taskId, entry] of runningTasks) {
      if (entry.chunks.length > 0 || entry.done) {
        taskResults.push({
          taskId,
          chunks: entry.chunks.splice(0), // drain chunks
          done: entry.done
        });
        if (entry.done) {
          runningTasks.delete(taskId);
        }
      }
    }

    const res = await fetch(`${DASHBOARD_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: SYNC_SECRET,
        sessions: enriched,
        history,
        taskResults
      })
    });

    const result = await res.json();
    const now = new Date().toLocaleTimeString('ko-KR');

    // Execute any pending tasks
    if (result.pendingTasks && result.pendingTasks.length > 0) {
      for (const task of result.pendingTasks) {
        console.log(`[${now}] New task: ${task.taskId} - "${task.prompt.substring(0, 50)}"`);
        executeTask(task);
      }
    }

    const taskCount = runningTasks.size;
    console.log(`[${now}] Synced: ${result.sessions} sessions${taskCount ? `, ${taskCount} tasks running` : ''}`);
  } catch (e) {
    console.error(`Sync failed: ${e.message}`);
  }
}

console.log(`Claude Dashboard Sync Agent`);
console.log(`  Server: ${DASHBOARD_URL}`);
console.log(`  Interval: ${INTERVAL / 1000}s`);
console.log(`  Ready to execute remote tasks via claude -p`);
console.log('');

sync();
setInterval(sync, INTERVAL);
