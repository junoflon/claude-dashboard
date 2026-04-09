/**
 * Discord Bot — 채널별 전문가 에이전트
 *
 * A+C 혼합 모드:
 * - Mac 켜져 있으면 → 로컬 claude --resume/--continue
 * - Mac 꺼져 있으면 → GitHub + Remote Tasks (PR 생성)
 */

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CLAUDE_AGENTS_DIR = path.join(require('os').homedir(), '.claude', 'agents');

// ─── 전문가 정의 ───
const EXPERTS = {
  architect: { name: 'Architect', emoji: '🏗️', color: 0x3b82f6, channelName: '설계', systemFile: 'architect.md', description: '시스템 설계 전문가' },
  debugger:  { name: 'Debugger',  emoji: '🔴', color: 0xef4444, channelName: '디버그', systemFile: 'debugger.md', description: '디버깅 전문가' },
  researcher:{ name: 'Researcher',emoji: '🔍', color: 0x06b6d4, channelName: '리서치', systemFile: 'researcher.md', description: '리서치 전문가' },
  deployer:  { name: 'Deployer',  emoji: '🚀', color: 0x22c55e, channelName: '배포', systemFile: 'deployer.md', description: '배포 전문가' },
  reviewer:  { name: 'Reviewer',  emoji: '📝', color: 0xeab308, channelName: '리뷰', systemFile: 'reviewer.md', description: '코드 리뷰 전문가' },
};

let channelToExpert = new Map();

class AgentBot {
  constructor(token, dashboardData) {
    this.token = token;
    this.dashboardData = dashboardData;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.jobs = new Map();
    this.setup();
  }

  setup() {
    this.client.on(Events.ClientReady, () => {
      console.log(`[Bot] ${this.client.user.tag} 온라인`);
      // 서버/채널 목록 출력
      for (const guild of this.client.guilds.cache.values()) {
        console.log(`[Bot] 서버: ${guild.name}`);
        for (const ch of guild.channels.cache.values()) {
          if (ch.type === 0) console.log(`[Bot]   #${ch.name} (${ch.id})`);
        }
      }
      this.mapChannels();
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot) return;
      console.log(`[Bot] 메시지: #${msg.channel.name} "${msg.content.substring(0, 50)}"`);

      const expert = channelToExpert.get(msg.channel.id);
      if (expert) {
        await this.handleExpertMessage(msg, expert);
        return;
      }

      // 전문가 채널이 아니어도 !명령어는 처리
      if (msg.content.startsWith('!')) {
        await this.handleCommand(msg);
        return;
      }

      // 매핑 안 된 채널 → 메시지 내용으로 전문가 자동 감지
      console.log(`[Bot] 자동 감지 모드: #${msg.channel.name}`);
      const detected = this.detectExpert(msg.content);
      if (detected) {
        await this.handleExpertMessage(msg, detected);
      } else {
        // 기본 전문가 (architect)로 응답
        await this.handleExpertMessage(msg, 'architect');
      }
    });
  }

  mapChannels() {
    channelToExpert.clear();
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        for (const [key, expert] of Object.entries(EXPERTS)) {
          if (channel.name === expert.channelName || channel.name === key) {
            channelToExpert.set(channel.id, key);
            console.log(`[Bot] #${channel.name} → ${expert.name}`);
          }
        }
      }
    }
  }

  // ─── 메시지 내용으로 전문가 자동 감지 ───
  detectExpert(text) {
    const t = text.toLowerCase();
    const keywords = {
      debugger:   ['에러','버그','오류','안돼','안 돼','안되','debug','error','fix','왜 안','crash','exception','traceback'],
      researcher: ['조사','비교','리서치','검색','뭐가 좋','추천','research','compare','vs ','차이'],
      deployer:   ['배포','deploy','railway','vercel','빌드','build','서버 올','호스팅','ci/cd','docker'],
      reviewer:   ['리뷰','review','코드 봐','코드봐','개선','리팩토링','refactor','품질','보안 검사'],
      architect:  ['설계','구조','아키텍처','폴더','디자인 패턴','architect','structure','스택'],
    };
    for (const [expert, kws] of Object.entries(keywords)) {
      if (kws.some(k => t.includes(k))) return expert;
    }
    return null; // 감지 못하면 null
  }

  // ─── 로컬 Mac이 살아있는지 확인 ───
  isLocalAlive() {
    try {
      const sessions = this.dashboardData.activeSessions || [];
      const age = Date.now() - (this.dashboardData.timestamp || 0);
      return age < 30000; // 30초 이내 sync 있으면 살아있음
    } catch { return false; }
  }

  // ─── 프로젝트 이름 → 경로/세션 매칭 ───
  findProject(text) {
    const sessions = this.dashboardData.activeSessions || [];
    // 프로젝트명 직접 매칭
    for (const s of sessions) {
      if (text.includes(s.projectName)) {
        return { session: s, path: s.cwd, name: s.projectName, sessionId: s.sessionId };
      }
    }
    // 부분 매칭
    for (const s of sessions) {
      const lower = text.toLowerCase();
      if (lower.includes(s.projectName.toLowerCase())) {
        return { session: s, path: s.cwd, name: s.projectName, sessionId: s.sessionId };
      }
    }
    return null;
  }

  // ─── GitHub remote URL에서 owner/repo 추출 ───
  getGitHubRepo(projectPath) {
    try {
      const remote = execSync('git remote get-url origin', { cwd: projectPath, encoding: 'utf8' }).trim();
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // ─── 전문가 시스템 프롬프트 로드 ───
  loadSystemPrompt(expertKey) {
    const expert = EXPERTS[expertKey];
    try {
      const content = fs.readFileSync(path.join(CLAUDE_AGENTS_DIR, expert.systemFile), 'utf8');
      const parts = content.split('---');
      return parts.length >= 3 ? parts.slice(2).join('---').trim() : content;
    } catch {
      return `You are ${expert.name}, ${expert.description}. Answer in Korean.`;
    }
  }

  // ─── 디스코드 채널의 최근 대화 히스토리 가져오기 ───
  async getChannelHistory(channel, limit = 15) {
    try {
      const messages = await channel.messages.fetch({ limit });
      return [...messages.values()]
        .reverse() // 시간순 정렬
        .map(m => {
          const role = m.author.bot ? 'assistant' : 'user';
          // 봇 메시지는 embed에서 description 추출
          let text = m.content;
          if (m.author.bot && m.embeds.length > 0) {
            text = m.embeds.map(e => e.description || '').join('\n').substring(0, 300);
          }
          return `[${role}] ${text}`;
        })
        .filter(l => l.length > 8) // 빈 메시지 제거
        .join('\n');
    } catch { return ''; }
  }

  // ─── 메시지 처리: A+C 혼합 ───
  async handleExpertMessage(msg, expertKey) {
    const expert = EXPERTS[expertKey];
    if (!expert) return;

    await msg.channel.sendTyping();
    // 현재 메시지 + 히스토리에서 프로젝트 감지
    const project = this.findProject(msg.content) || this.findProject(await this.getChannelHistory(msg.channel, 5));
    const isAlive = this.isLocalAlive();

    // 모드 판단
    let mode = 'question';
    if (project) {
      mode = isAlive ? 'local' : 'remote';
    }

    const modeLabel = { question: '💬 질문 모드', local: '💻 로컬 작업', remote: '☁️ 클라우드 작업' }[mode];

    const thinking = await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(expert.color)
        .setDescription(`${expert.emoji} **${expert.name}** 생각 중...\n${modeLabel}${project ? ` • ${project.name}` : ''}`)
      ]
    });

    // 대화 히스토리 수집
    const history = await this.getChannelHistory(msg.channel);

    try {
      let result;

      if (mode === 'local') {
        result = await this.runLocal(msg.content, expertKey, project, history);
      } else if (mode === 'remote') {
        result = await this.runRemote(msg.content, expertKey, project, history);
      } else {
        result = await this.runQuestion(msg.content, expertKey, history);
      }

      const chunks = splitMessage(result, 1900);
      await thinking.edit({
        embeds: [new EmbedBuilder()
          .setColor(expert.color)
          .setAuthor({ name: `${expert.emoji} ${expert.name} — ${modeLabel}` })
          .setDescription(chunks[0])
          .setFooter({ text: `${project ? project.name + ' • ' : ''}${new Date().toLocaleTimeString('ko-KR')}` })
        ]
      });

      for (let i = 1; i < chunks.length; i++) {
        await msg.channel.send({
          embeds: [new EmbedBuilder().setColor(expert.color).setDescription(chunks[i])]
        });
      }
    } catch (e) {
      await thinking.edit({
        embeds: [new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${e.message}`)]
      });
    }
  }

  // ─── A 모드: 로컬 실행 (Mac 켜져 있을 때) ───
  async runLocal(userMessage, expertKey, project, history) {
    const systemPrompt = this.loadSystemPrompt(expertKey);
    const projectsCtx = this.getProjectsContext();
    const prompt = `${systemPrompt}\n\n---\n${projectsCtx}\n[현재 작업 프로젝트] ${project.name} (${project.path})\n\n${history ? `[이전 대화]\n${history}\n\n` : ''}[현재 메시지]\n${userMessage}`;

    return new Promise((resolve, reject) => {
      // --continue: 마지막 대화 이어하기 (기존 맥락 유지)
      // --resume SESSION_ID: 특정 세션 복귀
      const args = ['-p', prompt, '--dangerously-skip-permissions'];

      const proc = spawn('claude', args, {
        cwd: project.path,
        timeout: 180000,
        env: { ...process.env },
      });

      let output = '';
      let error = '';
      proc.stdout.on('data', d => output += d);
      proc.stderr.on('data', d => error += d);
      proc.on('close', code => {
        if (code === 0 && output.trim()) resolve(output.trim());
        else reject(new Error(error.substring(0, 200) || `Exit code: ${code}`));
      });
      proc.on('error', reject);
    });
  }

  // ─── C 모드: Remote Tasks (Mac 꺼져 있을 때) ───
  async runRemote(userMessage, expertKey, project, history) {
    const repo = this.getGitHubRepo(project.path);
    if (!repo) {
      return `⚠️ **${project.name}**은 GitHub에 연결되어 있지 않아서 원격 작업이 불가합니다.\nMac을 켜고 다시 시도하거나, \`git remote add origin\`으로 GitHub을 연결해주세요.`;
    }

    const systemPrompt = this.loadSystemPrompt(expertKey);
    const expert = EXPERTS[expertKey];

    // Claude Remote Task 실행
    try {
      const triggerPrompt = `${systemPrompt}\n\n---\nGitHub repo: ${repo}\n프로젝트: ${project.name}\n\n유저 요청: ${userMessage}\n\n작업 완료 후 변경사항을 커밋하고, 가능하면 PR을 만들어주세요.`;

      const result = execSync(
        `claude -p ${JSON.stringify(triggerPrompt)} --dangerously-skip-permissions 2>&1`,
        { encoding: 'utf8', timeout: 180000 }
      ).trim();

      return `☁️ **클라우드 모드** (Mac 오프라인)\n📦 GitHub: \`${repo}\`\n\n${result}`;
    } catch (e) {
      // Remote Tasks API fallback
      return [
        `☁️ **클라우드 모드 안내**`,
        ``,
        `Mac이 오프라인이라 로컬 실행이 불가합니다.`,
        `GitHub 저장소: \`${repo}\``,
        ``,
        `**수동 실행 방법:**`,
        `\`\`\``,
        `claude task create \\`,
        `  --repo ${repo} \\`,
        `  --prompt "${userMessage}"`,
        `\`\`\``,
        ``,
        `또는 Mac을 켜면 자동으로 로컬 모드로 전환됩니다.`,
      ].join('\n');
    }
  }

  // ─── 전체 프로젝트 현황 요약 ───
  getProjectsContext() {
    const sessions = this.dashboardData.activeSessions || [];
    if (!sessions.length) return '';
    const lines = sessions.map(s => {
      const st = {working:'작업중',waiting:'대기중',idle:'유휴'}[s.status]||s.status;
      const branch = s.git?.branch || '-';
      const lastAct = s.lastAction?.substring(0, 80) || '-';
      const changed = s.git?.changedFiles?.length || 0;
      const files = s.git?.changedFiles?.slice(0, 5).map(f => f.file).join(', ') || '';
      return `- ${s.projectName} [${st}] 경로:${s.cwd} 브랜치:${branch} 변경:${changed}개${files ? ` (${files})` : ''}\n  최근작업: ${lastAct}`;
    });
    return `[현재 운영 중인 전체 프로젝트]\n${lines.join('\n')}\n`;
  }

  // ─── 단순 질문 (프로젝트 무관) ───
  async runQuestion(userMessage, expertKey, history) {
    const systemPrompt = this.loadSystemPrompt(expertKey);
    const projectsCtx = this.getProjectsContext();
    const prompt = `${systemPrompt}\n\n---\n${projectsCtx}\n${history ? `[이전 대화]\n${history}\n\n` : ''}[현재 메시지]\n${userMessage}`;

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
        timeout: 120000,
        env: { ...process.env },
      });
      let output = '';
      let error = '';
      proc.stdout.on('data', d => output += d);
      proc.stderr.on('data', d => error += d);
      proc.on('close', code => {
        if (code === 0 && output.trim()) resolve(output.trim());
        else reject(new Error(error.substring(0, 200) || `Exit code: ${code}`));
      });
      proc.on('error', reject);
    });
  }

  // ─── 명령어 ───
  async handleCommand(msg) {
    const [cmd] = msg.content.slice(1).split(' ');
    switch (cmd) {
      case 'status': await this.cmdStatus(msg); break;
      case 'sessions': await this.cmdSessions(msg); break;
      case 'experts': await this.cmdExperts(msg); break;
      case 'projects': await this.cmdProjects(msg); break;
      case 'help': await this.cmdHelp(msg); break;
    }
  }

  async cmdStatus(msg) {
    const sessions = this.dashboardData.activeSessions || [];
    const wk = sessions.filter(s => s.status === 'working').length;
    const wt = sessions.filter(s => s.status === 'waiting').length;
    const alive = this.isLocalAlive();

    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(alive ? 0x22c55e : 0xef4444)
        .setTitle('📊 시스템 현황')
        .addFields(
          { name: 'Mac 상태', value: alive ? '🟢 온라인 (로컬 모드)' : '🔴 오프라인 (클라우드 모드)', inline: false },
          { name: '세션', value: `${sessions.length}개 (작업 ${wk} / 대기 ${wt})`, inline: true },
          { name: '전문가', value: `${Object.keys(EXPERTS).length}명`, inline: true },
        )
        .setTimestamp()
      ]
    });
  }

  async cmdSessions(msg) {
    const sessions = this.dashboardData.activeSessions || [];
    if (!sessions.length) { await msg.reply('활성 세션 없음'); return; }
    const lines = sessions.map(s => {
      const icon = { working: '🟢', waiting: '🟡', idle: '⚪' }[s.status] || '⚪';
      return `${icon} **${s.projectName}** — ${s.status}\n　${s.lastAction?.substring(0, 60) || '-'}`;
    });
    await msg.reply({
      embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle('📋 활성 세션').setDescription(lines.join('\n'))]
    });
  }

  async cmdProjects(msg) {
    const sessions = this.dashboardData.activeSessions || [];
    const lines = sessions.map(s => {
      const repo = this.getGitHubRepo(s.cwd);
      return `**${s.projectName}**\n　📁 \`${s.cwd}\`\n　${repo ? `🔗 github.com/${repo}` : '⚠️ GitHub 미연결'}`;
    });
    await msg.reply({
      embeds: [new EmbedBuilder().setColor(0xda7756).setTitle('📦 프로젝트 목록').setDescription(lines.join('\n\n') || '없음')]
    });
  }

  async cmdExperts(msg) {
    const lines = Object.values(EXPERTS).map(e =>
      `${e.emoji} **${e.name}** — #${e.channelName}\n　${e.description}`
    );
    await msg.reply({
      embeds: [new EmbedBuilder().setColor(0xda7756).setTitle('🤖 전문가 팀').setDescription(lines.join('\n\n'))
        .setFooter({ text: '채널에 메시지를 보내면 전문가가 대답합니다' })]
    });
  }

  async cmdHelp(msg) {
    const alive = this.isLocalAlive();
    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('📖 사용법')
        .setDescription([
          `현재 모드: ${alive ? '🟢 **로컬 모드** (Mac 온라인)' : '🔴 **클라우드 모드** (Mac 오프라인)'}`,
          '',
          '**전문가에게 질문하기**',
          '해당 채널에 그냥 메시지를 보내세요:',
          '`#설계` `#디버그` `#리서치` `#배포` `#리뷰`',
          '',
          '**프로젝트 작업 지시**',
          '채널에서 프로젝트명을 포함해 말하세요:',
          '`UTM system에 검색 필터 추가해줘`',
          '→ 프로젝트를 자동 감지하고 해당 폴더에서 작업',
          '',
          '**명령어**',
          '`!status` — 시스템 현황 + Mac 연결 상태',
          '`!sessions` — 활성 세션 목록',
          '`!projects` — 프로젝트 + GitHub 연결 상태',
          '`!experts` — 전문가 목록',
        ].join('\n'))
      ]
    });
  }

  // ─── Waiting 알림 ───
  async notifyWaiting(session, channelId) {
    try {
      const channel = this.client.channels.cache.get(channelId);
      if (!channel) return;
      await channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('⏳ 허용 필요')
          .setDescription(`**${session.projectName}** 세션이 허용을 기다리고 있습니다.\n터미널에서 확인해 주세요.`)
          .setTimestamp()
        ]
      });
    } catch (e) { console.error('[Bot] Notify error:', e.message); }
  }

  async start() {
    if (!this.token) { console.log('[Bot] DISCORD_TOKEN 없음 — 봇 비활성화'); return false; }
    try { await this.client.login(this.token); return true; }
    catch (e) { console.error('[Bot] 로그인 실패:', e.message); return false; }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    let cut = text.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(text.substring(0, cut));
    text = text.substring(cut).trimStart();
  }
  return chunks;
}

module.exports = { AgentBot, EXPERTS };
