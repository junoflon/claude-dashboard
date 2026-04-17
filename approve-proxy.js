/**
 * 로컬 승인 프록시
 * Mac에서 상시 실행. Railway 봇이 이 서버를 호출하면 터미널에 "y" 전송.
 *
 * 사용법: node approve-proxy.js
 * ngrok이나 cloudflare tunnel로 외부 노출 필요
 */
const http = require('http');
const { execSync } = require('child_process');

const PORT = 3334;
const APPROVE_SECRET = process.env.APPROVE_SECRET || 'approve-me';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.secret !== APPROVE_SECRET) {
          res.writeHead(403); res.end('Forbidden'); return;
        }

        let approved = 0;
        try {
          const psOut = execSync(`ps -eo pid=,tty=,%cpu= -p $(pgrep -x claude 2>/dev/null | tr '\\n' ',')0 2>/dev/null`, { encoding: 'utf8' });
          const procs = psOut.trim().split('\n').filter(Boolean).map(line => {
            const [pid, tty, cpu] = line.trim().split(/\s+/);
            return { pid, cpu: parseFloat(cpu) || 0, tty };
          }).filter(p => p.cpu < 3 && p.tty && /^ttys\d+$/.test(p.tty));

          for (const p of procs) {
            try {
              // Ink UI (raw mode) → \r (Enter) 전송
              execSync(`python3 -c "import os; fd=os.open('/dev/${p.tty}',os.O_WRONLY|os.O_NONBLOCK); os.write(fd,b'\\r'); os.close(fd)"`, { timeout: 2000 });
              approved++;
            } catch {}
          }
        } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, approved }));
        console.log(`[Approve] ${approved}개 세션 승인`);
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

server.listen(PORT, () => console.log(`[Approve Proxy] 포트 ${PORT} — Mac 로컬에서만 실행`));
