/**
 * Discord Bot — 채널별 전문가 에이전트
 *
 * A+C 혼합 모드:
 * - Mac 켜져 있으면 → 로컬 claude --resume/--continue
 * - Mac 꺼져 있으면 → GitHub + Remote Tasks (PR 생성)
 */

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { spawn, execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
let Octokit;
(async () => { Octokit = (await import('@octokit/rest')).Octokit; })();
const fs = require('fs');
const path = require('path');

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

      // 승인 메시지 → Claude 호출 없이 바로 터미널에 전송
      if (this.isApproval(msg.content)) {
        await this.approveWaiting(msg);
        return; // 절대 전문가에게 넘기지 않음
      }

      const expert = channelToExpert.get(msg.channel.id);
      if (expert) {
        // "팀", "같이", "협업", "다같이" → 멀티에이전트 모드
        const teamMode = /팀|같이|협업|다같이|전문가들|다 모여|회의/.test(msg.content);
        if (teamMode) {
          const history = await this.getChannelHistory(msg.channel, 6);
          await this.runTeamWork(msg, expert, msg.content, history);
        } else {
          await this.handleExpertMessage(msg, expert);
        }
        return;
      }

      // 전문가 채널이 아니어도 !명령어는 처리
      if (msg.content.startsWith('!')) {
        await this.handleCommand(msg);
        return;
      }

      // 매핑 안 된 채널 → 무시 (전담 채널에서만 응답)
      return;
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

  // ─── 전문가 시스템 프롬프트 (경량) ───
  loadSystemPrompt(expertKey) {
    const expert = EXPERTS[expertKey];
    // 디스코드용은 짧은 프롬프트만. 풀 프롬프트는 코드 작업 시에만.
    return `당신은 ${expert.name}(${expert.description})입니다. 한국어로 간결하게 답변하세요.`;
  }

  // 코드 작업용 풀 프롬프트
  loadFullPrompt(expertKey) {
    const expert = EXPERTS[expertKey];
    try {
      const filePath = path.join(CLAUDE_AGENTS_DIR, expert.systemFile);
      if (!fs.existsSync(filePath)) {
        console.log(`[Bot] 에이전트 파일 없음: ${filePath} → 기본 프롬프트 사용`);
        return `You are ${expert.name}, ${expert.description}. Answer in Korean.`;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const parts = content.split('---');
      return parts.length >= 3 ? parts.slice(2).join('---').trim() : content;
    } catch (e) {
      console.log(`[Bot] 프롬프트 로드 실패 (${expertKey}): ${e.message}`);
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
    console.log(`[Bot] 모드=${mode} 프로젝트=${project?.name||'없음'} alive=${isAlive} 세션수=${(this.dashboardData.activeSessions||[]).length}`);

    const thinking = await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(expert.color)
        .setDescription(`${expert.emoji} **${expert.name}** 생각 중...\n${modeLabel}${project ? ` • ${project.name}` : ''}`)
      ]
    });

    // 대화 히스토리 수집 (최근 6개만 — 속도)
    const history = await this.getChannelHistory(msg.channel, 6);

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
    // 코드 작업은 풀 프롬프트 사용
    const systemPrompt = this.loadFullPrompt(expertKey);
    const prompt = `${systemPrompt}\n\n프로젝트: ${project.name}\n\n${history ? `[대화]\n${history}\n\n` : ''}${userMessage}`;

    return new Promise((resolve, reject) => {
      // --continue: 마지막 대화 이어하기 (기존 맥락 유지)
      // --resume SESSION_ID: 특정 세션 복귀
      // 코드 작업은 Sonnet (정확도), 일반은 Haiku (속도)
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--model', 'sonnet'];

      const proc = spawn('claude', args, {
        cwd: project.path,
        timeout: 180000,
        env: { ...process.env },
      });

      let output = '';
      let error = '';
      const MAX_OUTPUT = 100000; // 100KB 제한
      proc.stdout.on('data', d => { if (output.length < MAX_OUTPUT) output += d; });
      proc.stderr.on('data', d => { if (error.length < 10000) error += d; });
      proc.on('close', code => {
        if (code === 0 && output.trim()) {
          // 작업 완료 후 자동 commit + push (변경 파일만)
          try {
            const status = execSync('git status --porcelain', { cwd: project.path, encoding: 'utf8' }).trim();
            if (status) {
              // 변경된 파일만 추가 (.env, node_modules 제외)
              const files = status.split('\n').map(l => l.substring(3).trim())
                .filter(f => f && !f.includes('.env') && !f.includes('node_modules') && !f.includes('.last-sync'));
              if (files.length > 0) {
                execSync(`git add ${files.map(f => `"${f}"`).join(' ')}`, { cwd: project.path, encoding: 'utf8' });
                execSync('git commit -m "feat: discord bot auto-commit"', { cwd: project.path, encoding: 'utf8', timeout: 10000 });
                execSync('git push 2>/dev/null', { cwd: project.path, encoding: 'utf8', timeout: 30000 });
                resolve(output.trim() + `\n\n✅ ${files.length}개 파일 커밋 + 푸시 완료`);
              } else { resolve(output.trim()); }
            } else { resolve(output.trim()); }
          } catch {
            resolve(output.trim() + '\n\n⚠️ 자동 푸시 실패 (수동 push 필요)');
          }
        }
        else reject(new Error(error.substring(0, 200) || `Exit code: ${code}`));
      });
      proc.on('error', reject);
    });
  }

  // ─── GitHub API 클라이언트 ───
  getOctokit() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return null;
    return new Octokit({ auth: token });
  }

  // ─── C 모드: Mac OFF → Anthropic API로 코드 생성 + GitHub API로 커밋/PR ───
  async runRemote(userMessage, expertKey, project, history) {
    const repo = this.getGitHubRepo(project.path);
    if (!repo) {
      return `⚠️ **${project.name}**은 GitHub에 연결되어 있지 않습니다.`;
    }

    const octokit = this.getOctokit();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!octokit || !apiKey) {
      return `⚠️ GitHub 토큰 또는 Anthropic API 키가 없습니다.`;
    }

    const [owner, repoName] = repo.split('/');
    const expert = EXPERTS[expertKey];
    const client = new Anthropic({ apiKey });

    try {
      // 1. GitHub에서 현재 파일 구조 가져오기
      let repoTree = '';
      try {
        const { data: tree } = await octokit.rest.git.getTree({
          owner, repo: repoName, tree_sha: 'HEAD', recursive: 'true'
        });
        repoTree = tree.tree
          .filter(t => t.type === 'blob')
          .map(t => t.path)
          .slice(0, 50)
          .join('\n');
      } catch {}

      // 2. Claude에게 코드 생성 요청
      const codeResp = await client.messages.create({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 4096,
        system: `당신은 ${expert.name}(${expert.description})입니다.
GitHub 저장소 ${repo}의 코드를 수정해야 합니다.

응답 형식 (반드시 이 형식으로):
---FILE: 파일경로---
파일 전체 내용
---END---

여러 파일 수정 시 위 블록을 반복하세요.
마지막에 ---COMMIT: 커밋 메시지--- 를 적어주세요.
한국어로 설명하되 코드는 영어로 작성하세요.`,
        messages: [{ role: 'user', content: `파일 구조:\n${repoTree}\n\n요청: ${userMessage}` }],
      });

      const codeText = codeResp.content[0]?.text || '';

      // 3. 파일 블록 파싱
      const fileBlocks = [];
      const fileRegex = /---FILE:\s*(.+?)---\n([\s\S]*?)---END---/g;
      let match;
      while ((match = fileRegex.exec(codeText)) !== null) {
        fileBlocks.push({ path: match[1].trim(), content: match[2].trim() });
      }

      const commitMatch = codeText.match(/---COMMIT:\s*(.+?)---/);
      const commitMsg = commitMatch ? commitMatch[1].trim() : `feat: ${userMessage.substring(0, 50)}`;

      if (fileBlocks.length === 0) {
        // 코드 생성 없이 답변만 온 경우
        return `☁️ **${expert.emoji} ${expert.name}** (클라우드)\n\n${codeText.substring(0, 1800)}`;
      }

      // 4. GitHub API로 브랜치 생성 + 파일 커밋
      const branchName = `bot/${Date.now()}`;

      // main 브랜치의 최신 SHA 가져오기
      const { data: ref } = await octokit.rest.git.getRef({
        owner, repo: repoName, ref: 'heads/main'
      });
      const baseSha = ref.object.sha;

      // 새 브랜치 생성
      await octokit.rest.git.createRef({
        owner, repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      });

      // 파일들 커밋
      for (const file of fileBlocks) {
        const content = Buffer.from(file.content).toString('base64');
        let fileSha;
        try {
          const { data: existing } = await octokit.rest.repos.getContent({
            owner, repo: repoName, path: file.path, ref: branchName
          });
          fileSha = existing.sha;
        } catch {} // 새 파일이면 sha 없음

        await octokit.rest.repos.createOrUpdateFileContents({
          owner, repo: repoName,
          path: file.path,
          message: commitMsg,
          content,
          branch: branchName,
          ...(fileSha ? { sha: fileSha } : {}),
        });
      }

      // 5. PR 생성
      const { data: pr } = await octokit.rest.pulls.create({
        owner, repo: repoName,
        title: commitMsg,
        head: branchName,
        base: 'main',
        body: `## Discord 원격 작업\n\n**요청:** ${userMessage}\n**전문가:** ${expert.emoji} ${expert.name}\n**파일:** ${fileBlocks.map(f => f.path).join(', ')}\n\n🤖 Generated from Discord`,
      });

      return `☁️ **클라우드 커밋 완료!**\n\n📦 GitHub: \`${repo}\`\n📝 ${fileBlocks.length}개 파일 수정\n🔀 PR 생성: ${pr.html_url}\n\n${fileBlocks.map(f => `• \`${f.path}\``).join('\n')}`;

    } catch (e) {
      return `❌ 원격 작업 실패: ${e.message?.substring(0, 150)}`;
    }
  }

  // ─── 전체 프로젝트 현황 요약 (특정 폴더만) ───
  getProjectsContext() {
    const PROJECT_DIRS = [
      '/Users/mac/Desktop/#5 사이드 프로젝트',
      '/Users/mac/Desktop/claude-dashboard',
    ];
    const sessions = (this.dashboardData.activeSessions || [])
      .filter(s => PROJECT_DIRS.some(d => s.cwd.startsWith(d)));
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

  // ─── 단순 질문: Anthropic API 직접 호출 (Mac 꺼져도 동작) ───
  async runQuestion(userMessage, expertKey, history) {
    const expert = EXPERTS[expertKey];
    const systemPrompt = `당신은 ${expert.name}(${expert.description})입니다. 한국어로 간결하게 답변하세요.`;
    const needsProjects = /프로젝트|세션|상태|목록|뭐 하고|돌아가/i.test(userMessage);
    const ctx = needsProjects ? this.getProjectsContext() : '';
    const fullMsg = `${ctx}${history ? `[이전 대화]\n${history}\n\n` : ''}${userMessage}`;

    // Anthropic API 직접 호출 (로컬 Mac 불필요)
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('API_KEY 없음');
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: fullMsg }],
      });
      return response.content[0]?.text || '응답 없음';
    } catch (apiErr) {
      // API 실패 시 로컬 claude CLI 폴백
      console.log(`[Bot] API 실패, CLI 폴백: ${apiErr.message}`);
      const prompt = `${systemPrompt}\n\n${fullMsg}`;
      return new Promise((resolve, reject) => {
        const proc = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions', '--model', 'haiku'], {
          timeout: 120000, env: { ...process.env },
        });
        let output = '', error = '';
        proc.stdout.on('data', d => output += d);
        proc.stderr.on('data', d => error += d);
        proc.on('close', code => {
          if (code === 0 && output.trim()) resolve(output.trim());
          else reject(new Error(error.substring(0, 200) || `CLI도 실패`));
        });
        proc.on('error', reject);
      });
    }
  }

  // ─── 명령어 ───
  async handleCommand(msg) {
    const [cmd, ...args] = msg.content.slice(1).split(' ');
    switch (cmd) {
      case 'status': await this.cmdStatus(msg); break;
      case 'sessions': await this.cmdSessions(msg); break;
      case 'experts': await this.cmdExperts(msg); break;
      case 'projects': await this.cmdProjects(msg); break;
      case 'recommend': await this.cmdRecommend(msg, args.join(' ')); break;
      case 'skills': await this.cmdSkills(msg); break;
      case 'help': await this.cmdHelp(msg); break;
    }
  }

  // ─── 스킬 카테고리 ───
  static SKILL_CATEGORIES = {
    '📄 문서 생성': {
      skills: ['docx','pdf','pptx','xlsx','doc-coauthoring','internal-comms'],
      keywords: ['문서','워드','ppt','피피티','엑셀','pdf','슬라이드','프레젠테이션','발표','보고서','스프레드시트','표']
    },
    '🎨 디자인/UI': {
      skills: ['frontend-design','canvas-design','ui-ux-pro-max','algorithmic-art','brand-guidelines','theme-factory','slack-gif-creator','web-artifacts-builder','supanova-design','supanova-redesign','supanova-soft','supanova-output'],
      keywords: ['디자인','UI','UX','프론트','랜딩','웹사이트','아트','그림','로고','테마','gif','수파노바','랜딩페이지']
    },
    '🔍 리서치': {
      skills: ['deep-research-main','deep-research-query','docs-guide-knowledge','vibeindex'],
      keywords: ['리서치','조사','연구','검색','분석','비교','논문','문서 찾기','docs']
    },
    '🛠️ 개발 도구': {
      skills: ['claude-api','mcp-builder','skill-creator','skillers-suda','webapp-testing','pumasi'],
      keywords: ['API','MCP','스킬 만들기','테스트','개발','빌드','코딩','에이전트 만들기','품앗이']
    },
    '📋 기획/PRD': {
      skills: ['show-me-the-prd','kkirikkiri'],
      keywords: ['기획','PRD','기획서','서비스 기획','앱 기획','팀 구성','끼리끼리']
    },
    '🐙 Git/배포': {
      skills: ['git-teacher-help','git-teacher-save','git-teacher-upload','git-teacher-review','git-teacher-setup','git-teacher-status'],
      keywords: ['깃','git','커밋','푸시','PR','배포','GitHub','브랜치']
    },
    '📊 성장/멘토링': {
      skills: ['vibe-sunsang-growth','vibe-sunsang-mentor','vibe-sunsang-knowledge','vibe-sunsang-onboard','vibe-sunsang-retro'],
      keywords: ['성장','멘토','코칭','레벨','바선생','회고','온보딩']
    },
    '🔗 외부 연동': {
      skills: ['nopal-orchestrate','nopal-setup'],
      keywords: ['구글','메일','캘린더','스프레드시트','워크스페이스','노팔']
    },
  };

  // ─── 스킬 추천 (자연어 매칭) ───
  async cmdRecommend(msg, query) {
    if (!query) {
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0x6e7681).setDescription('사용법: `!recommend 하고 싶은 것`\n예: `!recommend PPT 만들고 싶어`')] });
      return;
    }

    const q = query.toLowerCase();
    const matches = [];

    for (const [category, data] of Object.entries(AgentBot.SKILL_CATEGORIES)) {
      const score = data.keywords.filter(k => q.includes(k.toLowerCase())).length;
      if (score > 0) {
        matches.push({ category, skills: data.skills, score });
      }
    }

    // 키워드 매칭 안 되면 API로 스마트 매칭
    if (matches.length === 0) {
      try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          const client = new Anthropic({ apiKey });
          const allSkills = Object.entries(AgentBot.SKILL_CATEGORIES)
            .map(([cat, d]) => `${cat}: ${d.skills.join(', ')}`)
            .join('\n');
          const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content: `사용자 요청: "${query}"\n\n아래 스킬 카테고리에서 가장 관련 있는 것을 추천해줘. 카테고리명과 스킬명만 간결하게.\n\n${allSkills}` }],
          });
          const aiResult = resp.content[0]?.text || '';
          await msg.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x22c55e)
              .setTitle(`🔎 "${query}" 추천 스킬`)
              .setDescription(aiResult)
              .setFooter({ text: 'AI 매칭' })
            ]
          });
          return;
        }
      } catch {}
    }

    if (matches.length === 0) {
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0x6e7681).setDescription(`"${query}"에 맞는 스킬을 찾지 못했어요.`)] });
      return;
    }

    matches.sort((a, b) => b.score - a.score);
    const desc = matches.slice(0, 3).map(m =>
      `**${m.category}**\n${m.skills.map(s => `\`${s}\``).join(' ')}`
    ).join('\n\n');

    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle(`🔎 "${query}" 추천 스킬`)
        .setDescription(desc)
        .setFooter({ text: `${matches.reduce((s, m) => s + m.skills.length, 0)}개 스킬 매칭` })
      ]
    });
  }

  // ─── 스킬 목록 (카테고리별) ───
  async cmdSkills(msg) {
    const desc = Object.entries(AgentBot.SKILL_CATEGORIES).map(([cat, data]) =>
      `**${cat}**\n${data.skills.map(s => `\`${s}\``).join(' ')}`
    ).join('\n\n');

    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xa855f7)
        .setTitle('⬡ 스킬 목록 (카테고리별)')
        .setDescription(desc)
        .setFooter({ text: `총 ${Object.values(AgentBot.SKILL_CATEGORIES).reduce((s, d) => s + d.skills.length, 0)}개 스킬` })
      ]
    });
  }

  // ─── 승인 감지: "승인", "ㅇㅇ", "진행해", "y" 등 ───
  isApproval(text) {
    return /^(승인|ㅇㅇ|진행|허용|ㅇ|y|yes|ok|고|해줘|해)$/i.test(text.trim());
  }

  // ─── 승인: 로컬 프록시 또는 직접 TTY ───
  async approveWaiting(msg) {
    let approved = 0;
    const proxyUrl = process.env.APPROVE_PROXY_URL; // 예: https://xxx.ngrok.io

    // 방법 1: 로컬 프록시 호출 (Railway에서도 동작)
    if (proxyUrl) {
      try {
        const resp = await fetch(`${proxyUrl}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: process.env.APPROVE_SECRET || 'approve-me' }),
        });
        const data = await resp.json();
        approved = data.approved || 0;
      } catch (e) {
        console.log(`[Bot] 프록시 호출 실패: ${e.message}`);
      }
    }

    // 방법 2: 로컬에서 직접 (Mac에서 server.js 돌릴 때)
    if (approved === 0) {
      try {
        const psOut = execSync(`pgrep -x claude 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (psOut) {
          const pids = psOut.split('\n').filter(Boolean);
          for (const pid of pids) {
            try {
              const tty = execSync(`ps -p ${pid} -o tty= 2>/dev/null`, { encoding: 'utf8' }).trim();
              if (tty && /^ttys\d+$/.test(tty)) {
                execSync(`printf '1\\n' > /dev/${tty}`, { timeout: 2000 });
                approved++;
              }
            } catch {}
          }
        }
      } catch {}
    }

    if (approved > 0) {
      await msg.reply({
        embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(`✅ ${approved}개 세션 승인 완료`)]
      });
    } else {
      await msg.reply({
        embeds: [new EmbedBuilder().setColor(0xf59e0b).setDescription(`⚠️ 승인 실패 — Mac이 꺼져있거나 대기 중인 세션이 없습니다.\n\nMac에서 \`node approve-proxy.js\`를 실행하고 APPROVE_PROXY_URL을 설정해주세요.`)]
      });
    }
    return true;
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
          '`!skills` — 스킬 목록 (카테고리별)',
          '`!recommend PPT 만들기` — 스킬 추천',
          '',
          '**팀 협업 모드**',
          '메시지에 "팀", "같이", "협업" 포함 시 전문가들이 협업합니다',
        ].join('\n'))
      ]
    });
  }

  // ─── Waiting 알림 ───
  async notifyWaiting(session, channelId) {
    try {
      const channel = this.client.channels.cache.get(channelId);
      if (!channel) return;
      const tool = session.pendingTool;
      const toolInfo = tool
        ? `\n\n**실행 요청:** \`${tool.name}\`\n\`\`\`${tool.detail}\`\`\``
        : '';
      await channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle(`⏳ ${session.projectName} — 허용 필요`)
          .setDescription(`터미널에서 Y/N 승인이 필요합니다.${toolInfo}\n\n**"승인"** 이라고 입력하면 자동 승인합니다.`)
          .setTimestamp()
        ]
      });
    } catch (e) { console.error('[Bot] Notify error:', e.message); }
  }

  // ─── 멀티에이전트 협업: 에이전트끼리 소통하며 작업 ───
  async runTeamWork(msg, expertKey, userMessage, history) {
    const expert = EXPERTS[expertKey];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { return await this.handleExpertMessage(msg, expertKey); }

    const client = new Anthropic({ apiKey });
    const allExperts = Object.entries(EXPERTS).map(([k, e]) => `${e.emoji} ${e.name}(${e.description})`).join(', ');

    // Step 1: 리드 에이전트가 계획 수립 + 누구에게 넘길지 결정
    const planResp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `당신은 ${expert.name}(${expert.description})입니다. 팀에는 ${allExperts}가 있습니다.
사용자 요청을 분석하고:
1. 당신이 직접 답변할 내용을 작성하세요
2. 다른 전문가에게 넘겨야 할 부분이 있으면 마지막 줄에 "→ @전문가이름: 요청내용" 형식으로 적으세요
3. 혼자 처리 가능하면 넘기지 마세요
한국어로 답변하세요.`,
      messages: [{ role: 'user', content: `${history ? `[대화]\n${history}\n\n` : ''}${userMessage}` }],
    });

    const planText = planResp.content[0]?.text || '';

    // 리드 에이전트 응답 전송
    const mainChunks = splitMessage(planText.split('\n→')[0].trim(), 1900);
    await msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(expert.color)
        .setAuthor({ name: `${expert.emoji} ${expert.name}` })
        .setDescription(mainChunks[0])
        .setTimestamp()
      ]
    });

    // Step 2: 다른 에이전트에게 넘기기
    const handoffs = planText.match(/→ @(\w+):\s*(.+)/g);
    if (handoffs) {
      for (const handoff of handoffs) {
        const m = handoff.match(/→ @(\w+):\s*(.+)/);
        if (!m) continue;
        const targetName = m[1].toLowerCase();
        const targetTask = m[2];
        const targetKey = Object.keys(EXPERTS).find(k =>
          k === targetName || EXPERTS[k].name.toLowerCase() === targetName
        );
        if (!targetKey || targetKey === expertKey) continue;

        const target = EXPERTS[targetKey];
        await msg.channel.sendTyping();

        // 대상 에이전트 응답
        const resp = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system: `당신은 ${target.name}(${target.description})입니다. ${expert.name}이 당신에게 작업을 넘겼습니다. 한국어로 간결하게 답변하세요.`,
          messages: [{ role: 'user', content: `${expert.name}의 요청: ${targetTask}\n\n원래 사용자 요청: ${userMessage}` }],
        });

        const respText = resp.content[0]?.text || '';
        const respChunks = splitMessage(respText, 1900);
        await msg.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(target.color)
            .setAuthor({ name: `${target.emoji} ${target.name} (${expert.name}이 요청)` })
            .setDescription(respChunks[0])
            .setTimestamp()
          ]
        });
      }
    }
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
