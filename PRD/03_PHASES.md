# Claude Agent Office — Phase 분리 계획

## Phase 1: 시스템 개요 + 디스코드 알림봇

**목표:** 모바일에서 실시간 모니터링 + 알림 받기

### 체크리스트
- [ ] `/api/system-stats` 엔드포인트 (스킬/에이전트/플러그인 카운트)
- [ ] index.html에 사이드바 네비게이션 추가
- [ ] 시스템 개요 페이지 (숫자 카드 + 자산 목록)
- [ ] 디스코드 봇 생성 (Discord Developer Portal)
- [ ] discord.js 설치 + 봇 기본 구조 (bot.js)
- [ ] 봇 명령어: `!status` (전체 현황 요약)
- [ ] 봇 명령어: `!sessions` (세션 목록 + 상태)
- [ ] waiting 세션 감지 → 디스코드 채널 알림
- [ ] server.js에 봇 통합 (같은 프로세스)
- [ ] Railway 배포 (서버 + 봇 동시)

**완료 기준:** 디스코드에서 `!status` 치면 현황 나오고, waiting 세션 발생 시 자동 알림

### 기술 상세
- discord.js v14 사용
- 기존 server.js에 Discord client 추가
- DISCORD_TOKEN, DISCORD_CHANNEL_ID를 환경변수로
- sync.js가 보내는 데이터에서 상태 변경 감지

---

## Phase 2: 원격 트리거 + 소통

**목표:** 디스코드에서 직접 작업 지시 + 결과 확인

### 체크리스트
- [ ] `!trigger "프롬프트" --project=이름` 명령어
- [ ] /api/trigger 엔드포인트 (child_process로 claude 실행)
- [ ] 작업 큐 관리 (jobs.json)
- [ ] 작업 진행 중 로그 → 디스코드 실시간 전달
- [ ] 작업 완료 시 결과 요약 → 디스코드 전달
- [ ] `!detail [프로젝트]` 명령어 (세션 상세)
- [ ] `!kill [세션ID]` 명령어 (세션 중지)
- [ ] 웹 대시보드에도 트리거 UI 추가

**완료 기준:** 디스코드에서 `!trigger "index.html 수정해줘" --project=claude-dashboard` 치면 실제 작업 시작

### 기술 상세
- `child_process.spawn('claude', ['-p', prompt], { cwd: projectPath })`
- stdout 파싱하여 진행 상태 추출
- jobs.json에 작업 기록 영속화

---

## Phase 3: 고도화

**목표:** 완전한 AI 에이전트 오피스

### 체크리스트
- [ ] `!pr` `!deploy` 등 Git 원격 명령
- [ ] `!skills` 목록 + 활성화/비활성화
- [ ] 작업 히스토리 타임라인 (대시보드)
- [ ] 3D 오피스에 픽셀아트 캐릭터 시스템
- [ ] 에이전트별 고유 캐릭터 + 이름표
- [ ] 대시보드 다크/라이트 모드 토글
- [ ] 통계 차트 (일별 토큰 사용량, 세션 수 등)

**완료 기준:** QJC 수준의 에이전트 오피스 완성
