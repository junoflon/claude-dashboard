const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3333;
const SYNC_SECRET = process.env.SYNC_SECRET || 'change-me';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── In-memory store (updated by local sync agent) ──
let dashboardData = {
  activeSessions: [],
  recentHistory: [],
  timestamp: 0
};

// Track claude conversation sessions per project (for --resume)
const conversations = new Map(); // sessionId -> [{ role, content }]

// ── Claude API chat ──
async function callClaude(sessionId, cwd, prompt) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // Get or create conversation history
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  const messages = conversations.get(sessionId);

  // Add user message
  messages.push({ role: 'user', content: prompt });

  // Keep last 20 messages to avoid token overflow
  while (messages.length > 20) messages.shift();

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    stream: true,
    system: `You are Claude Code, helping with a project located at: ${cwd}\nBe concise and helpful. Respond in Korean if the user writes in Korean.`,
    messages
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body
  });

  return res;
}

// ── HTTP handlers ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleSync(req, res) {
  try {
    const data = await parseBody(req);
    if (data.secret !== SYNC_SECRET) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    dashboardData = {
      activeSessions: data.sessions || [],
      recentHistory: data.history || [],
      timestamp: Date.now()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: dashboardData.activeSessions.length }));
  } catch (e) {
    res.writeHead(400); res.end(e.message);
  }
}

async function handleClaude(req, res) {
  try {
    const { sessionId, cwd, prompt } = await parseBody(req);
    if (!prompt) { res.writeHead(400); res.end('Missing prompt'); return; }

    const apiRes = await callClaude(sessionId, cwd, prompt);

    if (!apiRes.ok) {
      const err = await apiRes.text();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err }));
      return;
    }

    // Stream SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let fullText = '';

    // Read streaming response
    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.substring(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
          }
        } catch {}
      }
    }

    // Save assistant response to conversation
    if (fullText) {
      const messages = conversations.get(sessionId);
      if (messages) {
        messages.push({ role: 'assistant', content: fullText });
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } catch {}
  }
}

async function handleAction(req, res) {
  // Actions like kill are forwarded to local agent via next sync
  const data = await parseBody(req);
  // For now just acknowledge - can't remotely execute
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, note: 'Remote action queued' }));
}

function handleHistory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  // Find session in synced data
  const session = dashboardData.activeSessions.find(s => s.sessionId === sessionId);
  const history = session?.conversationHistory || [];

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(history));
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (req.url === '/api/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardData));
    } else if (req.url === '/api/sync' && req.method === 'POST') {
      await handleSync(req, res);
    } else if (req.url === '/api/claude' && req.method === 'POST') {
      await handleClaude(req, res);
    } else if (req.url.startsWith('/api/history')) {
      handleHistory(req, res);
    } else if (req.url === '/api/action' && req.method === 'POST') {
      await handleAction(req, res);
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

server.listen(PORT, () => {
  console.log(`Claude Dashboard running on port ${PORT}`);
});
