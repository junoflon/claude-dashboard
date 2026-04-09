# Claude Agent Office — 데이터 모델

## 1. 엔티티 관계

```
[SystemStats] ── 전체 시스템 자산 카운트
  ├── skills: 38
  ├── agents: 2
  ├── commands: 9
  ├── plugins: 41
  └── hooks: N

[Session] ── 실행 중인 Claude Code 세션
  ├── sessionId (고유 ID)
  ├── pid (프로세스 ID)
  ├── cwd (작업 디렉토리)
  ├── projectName
  ├── status: working | waiting | idle
  ├── git: { branch, lastCommit, changedFiles }
  ├── tokenUsage: { input, output, cache }
  ├── lastAction, lastUserMessage
  ├── recentActions[]
  ├── cpu, childProcesses[]
  └── uptime

[RemoteJob] ── 원격 실행 작업
  ├── jobId (고유 ID)
  ├── prompt (작업 내용)
  ├── targetProject (대상 디렉토리)
  ├── status: queued | running | completed | failed
  ├── triggeredBy: discord | web
  ├── triggeredAt (시작 시간)
  ├── completedAt (완료 시간)
  ├── result (결과 요약)
  └── sessionId (연결된 세션)

[Notification] ── 알림 기록
  ├── type: waiting | error | completed | statusChange
  ├── sessionId
  ├── message
  ├── sentAt
  └── channel: discord | web
```

## 2. 데이터 흐름

```
[sync.js] ──(5초 간격)──> [server.js] ──> /api/dashboard
                                      ──> /api/system-stats
                                      ──> [Discord Bot]
                                            ├── 알림 발송
                                            └── 명령 수신 → /api/trigger
```

## 3. 저장소

| 데이터 | 저장 방식 | 이유 |
|--------|----------|------|
| 세션 정보 | 메모리 (기존 방식 유지) | 실시간성, 영속 불필요 |
| 시스템 통계 | 파일 시스템 직접 읽기 | ~/.claude/ 디렉토리 |
| 원격 작업 | JSON 파일 (jobs.json) | 간단, 재시작 시 복구 |
| 알림 기록 | 메모리 (최근 100개) | 로그 성격, 영속 불필요 |
| 봇 설정 | .env 파일 | 토큰, 채널 ID |

## 4. API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | /api/dashboard | 세션 데이터 (기존) |
| GET | /api/system-stats | 스킬/에이전트/플러그인 카운트 |
| POST | /api/sync | sync.js → 서버 (기존) |
| POST | /api/trigger | 원격 작업 실행 |
| GET | /api/jobs | 원격 작업 목록 |
| GET | /api/jobs/:id | 특정 작업 상세 |
