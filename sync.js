#!/usr/bin/env node
/**
 * Local sync agent - pushes Claude session status to Railway dashboard.
 * Monitors session activity to determine working/idle/completed status.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3333';
const SYNC_SECRET = process.env.SYNC_SECRET || 'change-me';
const INTERVAL = 5_000;
const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');

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
    const changedFiles = changed ? changed.split('\n').filter(Boolean) : [];
    let remote = '';
    try { remote = execSync('git remote get-url origin', { cwd: projectPath, encoding: 'utf8' }).trim(); } catch {}
    const [hash, subject, relTime] = lastCommit.split('|');
    const totalCommitsToday = (() => {
      try { return parseInt(execSync('git log --since="midnight" --oneline', { cwd: projectPath, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length); } catch { return 0; }
    })();
    return { branch, lastCommit: { hash, subject, relTime }, changedFiles: changedFiles.map(f => ({ status: f.substring(0, 2).trim(), file: f.substring(3) })), remote, totalCommitsToday };
  } catch { return null; }
}

// Parse session JSONL to determine status and recent activity
function getSessionStatus(sessionId) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsDir); } catch { return null; }

  for (const dir of projectDirs) {
    const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    try {
      const stat = fs.statSync(jsonlPath);
      const content = fs.readFileSync(jsonlPath, 'utf8').trim();
      const lines = content.split('\n');

      let lastActivity = stat.mtimeMs;
      let status = 'idle'; // idle, working, waiting
      let lastAction = '';
      let lastUserMessage = '';
      let toolsUsed = [];
      let messageCount = { user: 0, assistant: 0 };
      let recentActions = [];
      let tokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

      // Parse all entries for token totals, last 50 for detailed status
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'assistant') {
            let msg = d.message;
            if (typeof msg === 'string') msg = JSON.parse(msg);
            if (msg.usage) {
              tokenUsage.input += msg.usage.input_tokens || 0;
              tokenUsage.output += msg.usage.output_tokens || 0;
              tokenUsage.cacheCreation += msg.usage.cache_creation_input_tokens || 0;
              tokenUsage.cacheRead += msg.usage.cache_read_input_tokens || 0;
            }
          }
        } catch {}
      }

      const recent = lines.slice(-50);
      for (const line of recent) {
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;

          if (d.type === 'user') {
            messageCount.user++;
            let msg = d.message;
            if (typeof msg === 'string') msg = JSON.parse(msg);
            const c = msg.content;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) text = c.filter(x => x?.type === 'text').map(x => x.text).join(' ');
            text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
            if (text) lastUserMessage = text.substring(0, 200);
          }

          if (d.type === 'assistant') {
            messageCount.assistant++;
            let msg = d.message;
            if (typeof msg === 'string') msg = JSON.parse(msg);
            const c = msg.content;
            if (Array.isArray(c)) {
              for (const block of c) {
                if (block?.type === 'text' && block.text?.trim()) {
                  const cleaned = block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
                  if (cleaned) {
                    lastAction = cleaned.substring(0, 200);
                    recentActions.push({ type: 'message', text: cleaned.substring(0, 150), timestamp: ts });
                  }
                }
                if (block?.type === 'tool_use') {
                  const toolName = block.name || '';
                  toolsUsed.push(toolName);
                  let detail = '';
                  if (toolName === 'Bash' && block.input?.command) detail = block.input.command.substring(0, 80);
                  else if (toolName === 'Write' && block.input?.file_path) detail = path.basename(block.input.file_path);
                  else if (toolName === 'Edit' && block.input?.file_path) detail = path.basename(block.input.file_path);
                  else if (toolName === 'Read' && block.input?.file_path) detail = path.basename(block.input.file_path);
                  recentActions.push({ type: 'tool', name: toolName, detail, timestamp: ts });
                }
              }
            }
          }
        } catch {}
      }

      const lastModifiedAgo = Date.now() - lastActivity;

      // Status will be determined later by process detection (see getProcessStatus)
      // For now just collect data
      const toolSummary = [...new Set(toolsUsed.slice(-20))];

      return {
        status: 'idle', // overridden by getProcessStatus
        lastAction,
        lastUserMessage,
        lastActivityAgo: lastModifiedAgo,
        messageCount,
        toolSummary,
        recentActions: recentActions.slice(-10),
        totalEntries: lines.length,
        tokenUsage
      };
    } catch {}
  }
  return null;
}

// Detect real status via process CPU + child processes
function getProcessStatus(pid) {
  try {
    const cpu = parseFloat(execSync(`ps -p ${pid} -o %cpu= 2>/dev/null`, { encoding: 'utf8' }).trim()) || 0;
    const childPids = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const children = childPids.length;

    let childCmds = [];
    if (children > 0) {
      try {
        childCmds = childPids.map(cp =>
          execSync(`ps -p ${cp} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim()
        ).filter(Boolean);
      } catch {}
    }

    // Determine status
    // caffeinate alone doesn't count as "working" - it's just keeping the mac awake
    const meaningfulChildren = childCmds.filter(c => c !== 'caffeinate');

    if (cpu > 5 || meaningfulChildren.length > 0) {
      return { status: 'working', cpu, children, childCmds: meaningfulChildren };
    } else if (cpu > 0.5) {
      return { status: 'waiting', cpu, children, childCmds: [] };
    }
    return { status: 'idle', cpu, children: 0, childCmds: [] };
  } catch {
    return { status: 'idle', cpu: 0, children: 0, childCmds: [] };
  }
}

function getGlobalHistory() {
  const historyFile = path.join(CLAUDE_DIR, 'history.jsonl');
  try {
    const content = fs.readFileSync(historyFile, 'utf8').trim();
    const lines = content.split('\n').slice(-50);
    return lines.map(line => { try { const p = JSON.parse(line); return { display: p.display?.substring(0, 100), project: p.project, timestamp: p.timestamp }; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function sync() {
  try {
    const sessions = getActiveSessions();
    const enriched = sessions.map(s => {
      const sessionStatus = getSessionStatus(s.sessionId) || {};
      const procStatus = getProcessStatus(s.pid);

      return {
        ...s,
        projectName: path.basename(s.cwd),
        git: getGitInfo(s.cwd),
        uptime: Date.now() - s.startedAt,
        ...sessionStatus,
        // Process-based status overrides JSONL-based
        status: procStatus.status,
        cpu: procStatus.cpu,
        childProcesses: procStatus.childCmds,
      };
    });
    const history = getGlobalHistory();

    const res = await fetch(`${DASHBOARD_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SYNC_SECRET, sessions: enriched, history })
    });

    const result = await res.json();
    const now = new Date().toLocaleTimeString('ko-KR');
    const statuses = enriched.map(s => `${s.projectName}:${s.status || '?'}`).join(', ');
    console.log(`[${now}] ${result.sessions} sessions | ${statuses}`);
  } catch (e) {
    console.error(`Sync failed: ${e.message}`);
  }
}

console.log(`Claude Dashboard Sync Agent → ${DASHBOARD_URL}`);
sync();
setInterval(sync, INTERVAL);
