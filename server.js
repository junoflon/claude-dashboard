require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { AgentBot, EXPERTS } = require('./bot');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 3333;
const SYNC_SECRET = process.env.SYNC_SECRET || 'change-me';
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';

// ── Auth ──
const authTokens = new Set();
function generateToken() { const t = crypto.randomBytes(32).toString('hex'); authTokens.add(t); return t; }
function isAuthenticated(req) {
  if (!DASH_PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/dash_token=([a-f0-9]+)/);
  return m && authTokens.has(m[1]);
}

function getLoginPage(error) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Dashboard</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;width:360px;text-align:center}
.login h1{font-size:22px;color:#f0f6fc;margin-bottom:8px}.login h1 span{color:#da7756}
.login p{font-size:13px;color:#8b949e;margin-bottom:24px}
.login input{width:100%;background:#0d1117;border:1px solid #30363d;color:#f0f6fc;padding:10px 14px;border-radius:8px;font-size:14px;outline:none;margin-bottom:16px}
.login input:focus{border-color:#da7756}
.login button{width:100%;background:#da7756;color:#fff;border:none;padding:10px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.error{color:#f85149;font-size:12px;margin-bottom:12px}
</style></head><body><form class="login" method="POST" action="/login">
<h1><span>Claude</span> Dashboard</h1><p>비밀번호를 입력하세요</p>
${error ? '<div class="error">비밀번호가 틀렸습니다</div>' : ''}
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">로그인</button></form></body></html>`;
}

// ── Data store ──
let dashboardData = { activeSessions: [], recentHistory: [], timestamp: 0 };

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

const CACHE_FILE = path.join(__dirname, '.last-sync.json');

// 시작 시 마지막 캐시 로드
try {
  const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (cached.activeSessions?.length) {
    dashboardData = { ...cached, timestamp: 0 }; // timestamp 0 = stale 표시
    console.log(`[Cache] 마지막 sync 복원: ${cached.activeSessions.length}개 프로젝트`);
  }
} catch {}

async function handleSync(req, res) {
  const data = await parseBody(req);
  if (data.secret !== SYNC_SECRET) { res.writeHead(403); res.end('Forbidden'); return; }
  dashboardData = { activeSessions: data.sessions || [], recentHistory: data.history || [], timestamp: Date.now() };
  // 파일로 캐시 저장 (Mac 꺼져도 프로젝트 목록 유지)
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(dashboardData), 'utf8'); } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessions: dashboardData.activeSessions.length }));
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const allowed = !origin || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('railway.app');
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin || '*' : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (req.url === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(getLoginPage(false)); return;
    }
    if (req.url === '/login' && req.method === 'POST') {
      const body = await new Promise(r => { let b='',len=0; req.on('data',c=>{ len+=c.length; if(len>1e4){r('');return;} b+=c; }); req.on('end',()=>r(b)); });
      const pw = new URLSearchParams(body).get('password');
      if (pw === DASH_PASSWORD) {
        const token = generateToken();
        res.writeHead(302, { 'Set-Cookie': `dash_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`, 'Location': '/' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getLoginPage(true));
      }
      return;
    }
    if (req.url === '/logout') { res.writeHead(302, { 'Set-Cookie': 'dash_token=; Path=/; HttpOnly; Max-Age=0', 'Location': '/login' }); res.end(); return; }
    if (req.url === '/api/sync' && req.method === 'POST') { await handleSync(req, res); return; }

    if (!isAuthenticated(req)) {
      if (req.url.startsWith('/api/')) { res.writeHead(401); res.end('Unauthorized'); }
      else { res.writeHead(302, { 'Location': '/login' }); res.end(); }
      return;
    }

    // ─── Agent CRUD ───
    if (req.url === '/api/agents' && req.method === 'GET') {
      const agentsDir = path.join(require('os').homedir(), '.claude', 'agents');
      try {
        const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
        const agents = files.map(f => {
          const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
          const m = content.match(/^---\n([\s\S]*?)\n---/);
          let meta = {};
          if (m) {
            const yaml = m[1];
            const nameM = yaml.match(/^name:\s*(.+)/m);
            const colorM = yaml.match(/^color:\s*(.+)/m);
            const modelM = yaml.match(/^model:\s*(.+)/m);
            meta.name = nameM ? nameM[1].trim() : f.replace('.md','');
            meta.color = colorM ? colorM[1].trim() : 'green';
            meta.model = modelM ? modelM[1].trim() : 'sonnet';
          }
          // Extract description lines after frontmatter
          const parts = content.split('---');
          const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : '';
          const firstLine = body.split('\n').find(l => l.startsWith('#'));
          meta.title = firstLine ? firstLine.replace(/^#+\s*/, '').split('—')[0].trim() : meta.name;
          meta.subtitle = firstLine && firstLine.includes('—') ? firstLine.split('—')[1].trim() : '';
          meta.file = f;
          return meta;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agents));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
      return;
    }

    if (req.url === '/api/agents' && req.method === 'POST') {
      const data = await parseBody(req);
      if (!data.id || !data.name || !data.role) { res.writeHead(400); res.end('Missing fields'); return; }
      const agentsDir = path.join(require('os').homedir(), '.claude', 'agents');
      if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
      const fileName = data.id.replace(/[^a-z0-9-]/g, '') + '.md';
      const filePath = path.join(agentsDir, fileName);

      const toolsList = (data.tools || ['Read','Glob','Grep','Bash']).map(t => `  - ${t}`).join('\n');
      const triggers = (data.triggers || []).join(', ');
      const responsibilities = (data.responsibilities || []).join(', ');

      // ─── Claude로 전문 프롬프트 자동 생성 ───
      let generatedPrompt = '';
      try {
        const genReq = [
          `너는 Claude Code 에이전트 프롬프트 전문 작성자야.`,
          `아래 정보를 바탕으로 전문가 에이전트의 시스템 프롬프트를 작성해줘.`,
          ``,
          `- 이름: ${data.name}`,
          `- 역할: ${data.role}`,
          `- 설명: ${data.description || data.role}`,
          `- 트리거 키워드: ${triggers}`,
          `- 핵심 책임: ${responsibilities || data.role}`,
          `- 사용 도구: ${(data.tools || []).join(', ')}`,
          ``,
          `아래 형식으로 작성해. 마크다운으로. YAML frontmatter 없이 본문만.`,
          `프롬프트는 한국어+영어 혼합 가능. 실용적이고 구체적으로.`,
          ``,
          `형식:`,
          `# {이름} — {역할}`,
          ``,
          `{이 전문가가 누구인지 2-3문장}`,
          ``,
          `## Core Responsibilities`,
          `{5-8개 구체적 책임 목록}`,
          ``,
          `## Execution Steps`,
          `### Step 1: {분석/수집}`,
          `{구체적 행동}`,
          `### Step 2: {실행/제안}`,
          `{구체적 행동}`,
          `### Step 3: {검증/전달}`,
          `{구체적 행동}`,
          ``,
          `## Output Format`,
          `{출력 형식 규칙}`,
          ``,
          `## Rules`,
          `{5-7개 행동 규칙, "절대 하지 마" 포함}`,
        ].join('\n');

        // spawn으로 안전하게 실행 (커맨드 인젝션 방지)
        generatedPrompt = await new Promise((resolve, reject) => {
          const proc = require('child_process').spawn('claude', ['-p', genReq], { timeout: 60000 });
          let out = '', err = '';
          proc.stdout.on('data', d => { if (out.length < 50000) out += d; });
          proc.stderr.on('data', d => err += d);
          proc.on('close', code => code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err || 'fail')));
          proc.on('error', reject);
        });
      } catch (e) {
        // Fallback: 기본 템플릿 사용
        generatedPrompt = [
          `# ${data.name} — ${data.role}`,
          ``,
          `You are ${data.name}, ${data.description || data.role}.`,
          ``,
          `## Core Responsibilities`,
          ...(data.responsibilities || ['질문에 전문적으로 답변']).map(r => `- ${r}`),
          ``,
          `## Execution Steps`,
          `### Step 1: 상황 파악`,
          `- 사용자의 질문/요청을 분석`,
          `- 관련 파일, 코드, 문맥 확인`,
          ``,
          `### Step 2: 작업 수행`,
          `- 분석 결과를 바탕으로 구체적 답변/작업 실행`,
          `- 필요 시 코드 작성 또는 수정`,
          ``,
          `### Step 3: 검증 및 전달`,
          `- 결과물 검증`,
          `- 명확하고 구조화된 형태로 전달`,
          ``,
          `## Rules`,
          `- 정확하고 실용적인 답변 제공`,
          `- 모르는 것은 모른다고 말하기`,
          `- 한국어로 답변`,
          `- 추측하지 말고 근거 기반으로 답변`,
        ].join('\n');
      }

      const content = `---
name: ${data.id}
description: |
  ${data.description || data.role}

  Trigger on: ${triggers}

  <example>
  Context: User asks about ${data.role}
  user: "${data.triggers?.[0] || data.role}"
  assistant: "I'll use the ${data.id} agent to help."
  <commentary>
  ${data.role} request triggers this agent.
  </commentary>
  </example>

model: ${data.model || 'sonnet'}
color: ${data.color || 'green'}
tools:
${toolsList}
---

${generatedPrompt}
`;

      try {
        fs.writeFileSync(filePath, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: fileName, generated: !!generatedPrompt }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.url.startsWith('/api/agents/') && req.method === 'DELETE') {
      const fileName = req.url.split('/').pop();
      const filePath = path.join(require('os').homedir(), '.claude', 'agents', fileName);
      try {
        fs.unlinkSync(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── 터미널 포커스 (해당 세션이 돌아가는 터미널로 이동) ───
    if (req.url === '/api/focus-terminal' && req.method === 'POST') {
      try {
        const data = await parseBody(req);
        const session = (dashboardData.activeSessions || []).find(s => s.sessionId === data.sessionId);
        if (!session) { res.writeHead(404); res.end('Not Found'); return; }

        const tty = execSync(`ps -p ${session.pid} -o tty= 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (!tty || !/^ttys\d+$/.test(tty)) { res.writeHead(400); res.end('No TTY'); return; }

        // osascript로 해당 TTY를 가진 Terminal 윈도우 포커스
        const script = `tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        set selected of t to true
        set index of w to 1
        return
      end if
    end repeat
  end repeat
end tell`;
        try {
          execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
        } catch {
          // iTerm 시도
          try {
            execSync(`osascript -e 'tell application "iTerm" to activate'`, { timeout: 3000 });
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tty }));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
      return;
    }

    // ─── AI 스킬 추천 ───
    if (req.url === '/api/recommend' && req.method === 'POST') {
      try {
        const data = await parseBody(req);
        const Anthropic = require('@anthropic-ai/sdk');
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ recommendation: null })); return; }
        const client = new Anthropic({ apiKey });
        const resp = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content: `사용자가 "${data.query}"를 하고 싶다고 합니다.\n\n아래 목록(스킬, 플러그인, MCP)에서 가장 적합한 도구를 추천해주세요. 각 추천에 타입(스킬/플러그인)과 이유를 한 줄로 설명. 한국어로 간결하게.\n\n${data.skills}` }],
        });
        const text = resp.content[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recommendation: text }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recommendation: null, error: e.message }));
      }
      return;
    }

    if (req.url === '/api/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dashboardData));
    } else if (req.url === '/' || req.url === '/index.html') {
      const file = path.join(__dirname, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file, 'utf8'));
    } else if (req.url === '/office') {
      const file = path.join(__dirname, 'office.html');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file, 'utf8'));
    } else { res.writeHead(404); res.end('Not Found'); }
  } catch (e) { console.error(e); try { res.writeHead(500); res.end(e.message); } catch {} }
});

server.listen(PORT, () => {
  console.log(`Claude Dashboard on port ${PORT}`);
  // sync.js 자동 시작
  const syncProc = require('child_process').spawn('node', [path.join(__dirname, 'sync.js')], {
    stdio: 'ignore', detached: false
  });
  syncProc.on('error', e => console.error('[Sync] 시작 실패:', e.message));
  console.log(`[Sync] 자동 시작 (PID: ${syncProc.pid})`);
});

// ─── Discord Bot ───
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const NOTIFY_CHANNEL = process.env.DISCORD_CHANNEL_ID || '';
const bot = new AgentBot(DISCORD_TOKEN, dashboardData);
let botReady = false;
bot.start().then(ok => { botReady = ok; });

// Waiting 세션 알림
let notifiedWaiting = new Set();
setInterval(() => {
  if (!botReady || !NOTIFY_CHANNEL) return;
  const sessions = dashboardData.activeSessions || [];
  for (const s of sessions) {
    if (s.status === 'waiting' && !notifiedWaiting.has(s.sessionId)) {
      notifiedWaiting.add(s.sessionId);
      bot.notifyWaiting(s, NOTIFY_CHANNEL);
    }
  }
  // 대기 해제된 세션 정리
  const waitingIds = new Set(sessions.filter(s => s.status === 'waiting').map(s => s.sessionId));
  for (const id of notifiedWaiting) {
    if (!waitingIds.has(id)) notifiedWaiting.delete(id);
  }
}, 5000);
