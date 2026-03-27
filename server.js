const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3333;
const SYNC_SECRET = process.env.SYNC_SECRET || 'change-me';
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';

// ── Auth ──
const authTokens = new Set();
function generateToken() { const t = crypto.randomBytes(32).toString('hex'); authTokens.add(t); return t; }
function isAuthenticated(req) {
  if (!DASH_PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/dash_token=([a-f0-9]+)/);
  return match && authTokens.has(match[1]);
}

function getLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Dashboard - Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .login{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;width:360px;text-align:center}
  .login h1{font-size:22px;color:#f0f6fc;margin-bottom:8px}
  .login h1 span{color:#da7756}
  .login p{font-size:13px;color:#8b949e;margin-bottom:24px}
  .login input{width:100%;background:#0d1117;border:1px solid #30363d;color:#f0f6fc;padding:10px 14px;border-radius:8px;font-size:14px;outline:none;margin-bottom:16px}
  .login input:focus{border-color:#da7756}
  .login button{width:100%;background:#da7756;color:#fff;border:none;padding:10px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
  .login button:hover{background:#e8896a}
  .error{color:#f85149;font-size:12px;margin-bottom:12px}
</style></head><body>
<form class="login" method="POST" action="/login">
  <h1><span>Claude</span> Dashboard</h1>
  <p>비밀번호를 입력하세요</p>
  ${error ? '<div class="error">비밀번호가 틀렸습니다</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus>
  <button type="submit">로그인</button>
</form></body></html>`;
}

// ── In-memory store ──
let dashboardData = { activeSessions: [], recentHistory: [], timestamp: 0 };

// ── Task queue: dashboard → local agent ──
// Tasks flow: frontend creates → server stores → local agent polls & executes → pushes result
const tasks = new Map(); // taskId -> { sessionId, cwd, prompt, status, chunks[], createdAt }

function createTask(sessionId, cwd, prompt) {
  const taskId = crypto.randomBytes(8).toString('hex');
  tasks.set(taskId, {
    sessionId, cwd, prompt,
    status: 'pending', // pending → running → done
    chunks: [],
    createdAt: Date.now()
  });
  // Clean old tasks (> 10 min)
  for (const [id, t] of tasks) {
    if (Date.now() - t.createdAt > 600_000) tasks.delete(id);
  }
  return taskId;
}

// ── HTTP helpers ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── Sync handler (local agent pushes data + pulls tasks) ──
async function handleSync(req, res) {
  try {
    const data = await parseBody(req);
    if (data.secret !== SYNC_SECRET) { res.writeHead(403); res.end('Forbidden'); return; }

    // Update dashboard data
    dashboardData = {
      activeSessions: data.sessions || [],
      recentHistory: data.history || [],
      timestamp: Date.now()
    };

    // Collect pending tasks for local agent to execute
    const pendingTasks = [];
    for (const [id, t] of tasks) {
      if (t.status === 'pending') {
        pendingTasks.push({ taskId: id, sessionId: t.sessionId, cwd: t.cwd, prompt: t.prompt });
        t.status = 'running';
      }
    }

    // Process task results from local agent
    if (data.taskResults) {
      for (const result of data.taskResults) {
        const task = tasks.get(result.taskId);
        if (task) {
          task.chunks = task.chunks.concat(result.chunks || []);
          if (result.done) task.status = 'done';
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      sessions: dashboardData.activeSessions.length,
      pendingTasks
    }));
  } catch (e) {
    res.writeHead(400); res.end(e.message);
  }
}

// ── Claude task handler (frontend creates task) ──
async function handleClaude(req, res) {
  try {
    const { sessionId, cwd, prompt } = await parseBody(req);
    if (!prompt) { res.writeHead(400); res.end('Missing prompt'); return; }

    const taskId = createTask(sessionId, cwd, prompt);

    // SSE: poll for results from local agent
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let sentChunks = 0;
    const poll = setInterval(() => {
      const task = tasks.get(taskId);
      if (!task) { clearInterval(poll); res.end(); return; }

      // Send new chunks
      while (sentChunks < task.chunks.length) {
        res.write(`data: ${JSON.stringify({ type: 'text', text: task.chunks[sentChunks] })}\n\n`);
        sentChunks++;
      }

      if (task.status === 'done') {
        clearInterval(poll);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        // Clean up after a bit
        setTimeout(() => tasks.delete(taskId), 30_000);
      }
    }, 500); // Poll every 500ms

    // Timeout after 5 minutes
    setTimeout(() => {
      clearInterval(poll);
      const task = tasks.get(taskId);
      if (task && task.status !== 'done') {
        task.status = 'done';
        res.write(`data: ${JSON.stringify({ type: 'text', text: '\n[시간 초과]' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
      try { res.end(); } catch {}
    }, 300_000);

    req.on('close', () => clearInterval(poll));

  } catch (e) {
    try { res.writeHead(500); res.end(e.message); } catch {}
  }
}

function handleHistory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const session = dashboardData.activeSessions.find(s => s.sessionId === sessionId);
  const history = session?.conversationHistory || [];
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(history));
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // Login (no auth)
    if (req.url === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLoginPage(false)); return;
    }
    if (req.url === '/login' && req.method === 'POST') {
      const body = await new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
      const pw = new URLSearchParams(body).get('password');
      if (pw === DASH_PASSWORD) {
        const token = generateToken();
        res.writeHead(302, { 'Set-Cookie': `dash_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`, 'Location': '/' });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getLoginPage(true));
      }
      res.end(); return;
    }
    if (req.url === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'dash_token=; Path=/; HttpOnly; Max-Age=0', 'Location': '/login' });
      res.end(); return;
    }

    // Sync (uses secret)
    if (req.url === '/api/sync' && req.method === 'POST') { await handleSync(req, res); return; }

    // Auth check
    if (!isAuthenticated(req)) {
      if (req.url.startsWith('/api/')) { res.writeHead(401); res.end('Unauthorized'); }
      else { res.writeHead(302, { 'Location': '/login' }); res.end(); }
      return;
    }

    // Authenticated routes
    if (req.url === '/api/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardData));
    } else if (req.url === '/api/claude' && req.method === 'POST') {
      await handleClaude(req, res);
    } else if (req.url.startsWith('/api/history')) {
      handleHistory(req, res);
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    } else {
      res.writeHead(404); res.end('Not Found');
    }
  } catch (e) {
    console.error(e);
    try { res.writeHead(500); res.end(e.message); } catch {}
  }
});

server.listen(PORT, () => { console.log(`Claude Dashboard running on port ${PORT}`); });
