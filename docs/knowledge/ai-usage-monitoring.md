# AI 도구 주간 사용량 수집 지식

최종 정리: 2026-10-04 · 기준 환경: macOS, Asia/Seoul

## 목적과 범위

현재 장비에 설치된 Codex, Claude Code, Antigravity(명령어 agy)의 주간 사용률을 한 웹페이지에서 확인하려는 프로젝트다. 지금까지는 조회 방법 조사와 참고 저장소의 코드 검토만 수행했다. 웹페이지·수집기는 구현하지 않았고 사용자 인증·설정도 변경하지 않았다.

이 문서는 재사용할 조사 지식이다. 구현 방향은 제안이며 확정된 명세가 아니다. 다음 작업 권한을 부여하는 문서로 해석하지 않는다.

## 근거 수준과 현재 결론

| 대상 | 조회 후보 | 근거 수준 | 남은 확인 |
| --- | --- | --- | --- |
| Codex | 로컬 app-server의 account/rateLimits/read | 공식 문서 + 이 장비 실제 성공 | 여러 한도 그룹, 지속 갱신 및 오류 처리 |
| Claude Code | statusLine stdin JSON | 공식 문서 확인 | 실제 payload와 계정별 필드, 갱신 조건 |
| Claude Code | 기존 CLI OAuth로 usage endpoint 직접 조회 | TokenTV 소스 확인 | 이 장비 동작, 공개 지원 여부, 인증 만료 동작 |
| Antigravity | statusLine stdin JSON의 quota | 공식 문서 확인 | 실제 버킷 구성, 주간/5시간 구분, 갱신 조건 |
| Antigravity | 대화형 /usage 또는 /quota | 공식 문서 확인 | 독립적인 무인 상시 조회 수단 |

Claude·Antigravity의 현재 실제 퍼센트와 세 서비스 모두의 상시 최신화는 아직 검증되지 않았다.

## 장비 조사 기록

2026-10-04 당시:

- Codex CLI 0.155.0, Claude Code 2.1.278 확인.
- agy 실행파일 및 Antigravity.app, Claude.app 존재. agy 버전은 미확인.
- agy --help, agy help models에서 독립 사용량 JSON 조회 옵션을 찾지 못했다. 전체 기능에 없다는 증거는 아니다.
- Claude 사용자 설정에 statusLine 없음.
- Antigravity statusLine은 enabled=true였지만 type과 command가 빈 문자열이어서 사용자 수집 스크립트는 미설정.

## Codex

### 검증한 경로

로컬 프로세스에서 codex app-server를 stdio로 실행하고 다음 순서로 통신했다.

1. initialize 요청(clientInfo 포함)
2. initialized 알림
3. account/rateLimits/read 요청
4. 응답 수신 후 프로세스 종료

대화 thread나 모델 turn을 생성하지 않고 조회에 성공했다. Codex 앱의 사용량 조회 도구에서도 같은 사용률을 확인했다. 앱 전용 도구를 웹페이지에서 직접 호출할 수 있다는 의미는 아니다.

### 필드와 해석

- usedPercent: 사용한 비율.
- windowDurationMins: 한도 구간 길이. 10080분은 7일, 300분은 5시간.
- resetsAt: Unix 초 단위 리셋 시각.
- primary/secondary 위치로 주간 여부를 추정하지 말고 기간을 확인한다.
- rateLimitsByLimitId가 있으면 여러 한도 그룹을 보존하는 설계가 필요하다.

실측 스냅샷: 사용 10%, 잔여 90%, primary.windowDurationMins=10080, secondary=null, resetsAt=1791595942(2026-10-10 10:32:22 KST). **조사 당시 값이며 현재 사용량으로 표시하면 안 된다.**

공식 문서는 account/rateLimits/updated 알림도 설명한다. app-server 및 WebSocket transport에 실험적이라는 안내가 있어 버전별 호환성을 확인해야 한다.

출처: [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Claude Code

### 공식 statusLine 연동

statusLine 스크립트 stdin JSON에 다음 필드가 전달된다.

- rate_limits.seven_day.used_percentage
- rate_limits.seven_day.resets_at
- rate_limits.five_hour.used_percentage
- rate_limits.five_hour.resets_at

문서상 Pro/Max 구독 또는 해당 spend-limit gateway 환경에서 조건부로 제공된다. 각 창은 독립적으로 없을 수 있고 첫 API 응답 이전에는 데이터가 없을 수 있다. gateway의 spend limit는 구독 주간 창과 구분한다.

statusLine 재실행은 서버 데이터의 신규 조회와 같지 않다. CLI가 꺼진 시간의 최신화 및 모델별 추가 주간 한도는 별도 검증 대상이다.

출처: [Claude Code statusLine](https://code.claude.com/docs/en/statusline)

### TokenTV의 직접 조회 후보

TokenTV는 CLI 홈의 .credentials.json 또는 macOS Keychain에서 access token을 읽어 다음 endpoint에 GET 요청한다.

- https://api.anthropic.com/api/oauth/profile
- https://api.anthropic.com/api/oauth/usage

프로필 이메일과 기대 계정을 대조한 다음 five_hour, seven_day의 utilization 및 resets_at을 정규화한다. 코드 구조상 대화형 CLI가 켜져 있지 않아도 실행 가능하다.

이는 제3자 구현에서 확인한 방법이다. 공개 외부 API로 지원된다는 근거, 이 장비에서의 실제 성공 여부 및 응답 단위는 추가 확인해야 한다. User-Agent와 beta header가 하드코딩되어 있다.

refresh_with_cli=true인 경우 401 오류 후 claude -p 'Reply only OK.'를 호출해 인증 갱신을 유도한다. 실제 모델 요청이므로 단순 조회로 취급해서는 안 된다. 우리 구현 후보에서는 우선 auth_required로 표시하는 방식을 제안한다.

## Antigravity

### 공식 statusLine 연동

사용자 설정 위치: ~/.gemini/antigravity-cli/settings.json

상태 변화 시 스크립트 stdin으로 JSON을 전달한다. quota 객체는 모델/버킷 ID별로 다음 정보를 가진다.

- remaining_fraction: 잔여 비율.
- reset_time: 리셋 시각.
- reset_in_seconds: 선택적인 남은 초.

공식 예제에는 gemini-weekly 버킷이 있다. 사용률 계산은 (1 - remaining_fraction) × 100. 실제 키 목록은 런타임에서 확인하고, 여러 주간 버킷을 하나로 합치지 않는다.

그룹 표시 규칙(2026-10-22):

- 실측 `/usage` 버킷: gemini-weekly, gemini-5h, 3p-weekly, 3p-5h, gemini-argon-wtu-weekly. statusLine에는 gemini-weekly, 3p-weekly만 확인됨.
- 버킷 ID 접두사로 그룹 결정: `gemini-` → Gemini, `3p-` → Claude · GPT. 접두사 다음 토큰이 weekly/5h가 아니면 모델명으로 표시(예: Argon). 같은 그룹 창은 UI에서 연속 배치.
- 알 수 없는 접두사만 `/usage`의 그룹·버킷 `display_name`을 사용(제어문자 제거, 40자 제한). 실제 display_name 값은 미확인.
- statusLine 갱신은 ID 기준 병합. 누락 버킷은 이전 관측 시각을 유지하고 600초 경과 시 이전 값으로 표시.

### 수동 확인 경로

CLI의 /usage 또는 /quota가 백엔드에서 사용량을 새로 확인해 패널을 연다. 모델 화면 문서에는 Gemini 및 Claude/GPT 그룹의 주간/5시간 잔여량이 나온다. UI 기능의 존재를 독립 polling API 지원으로 해석하지 않는다.

출처:

- [Status line](https://www.antigravity.google/docs/cli/statusline/)
- [Model quotas](https://antigravity.google/docs/cli/commands/usage)
- [Models](https://antigravity.google/docs/models)

## TokenTV에서 참고할 구현

저장소: https://github.com/click6067-ship-it/token-tv

검토 커밋: ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7

소스를 읽었으며 설치·실행·테스트 실행·사용자 인증정보 접근은 하지 않았다. 지원 공급자는 Claude, Codex, Grok이고 Antigravity는 미구현이다.

| 파일 | 참고 내용 |
| --- | --- |
| sources.py | 공급자별 조회, 계정 대조, 오류 분류, 인증정보를 결과에서 제외 |
| usage.py | 사용량 창 정규화, 기간으로 Codex 창 식별, 누락값 보존 |
| state.py | 계정별 캐시, 마지막 성공값과 stale 상태 유지 |
| live.py | 기본 300초/최소 60초 폴링, 웹 /snapshot은 캐시만 조회 |
| tests/test_live.py | 계정 불일치·누락값·stale·기간 식별 테스트 사례 |

물리 시계 없이 웹만 사용하는 구성도 가능하다. 다만 우리 목적에는 전체 포크보다 수집·캐시 구조를 선별 참고하는 방향을 제안한다.

### 그대로 재사용하면 부족한 점

- usage.py는 Codex rateLimitsByLimitId를 읽지 않는다.
- Claude 세부 모델별 주간 한도를 보존하지 않는다.
- state.py의 by_label은 같은 WEEK 라벨 여러 개를 하나로 덮는다. Antigravity 다중 버킷을 추가할 때 정보가 손실된다.
- 인증 갱신에 모델 요청을 사용하는 선택 동작을 분리해야 한다.
- 실제 macOS Keychain 접근 및 endpoint 호환성은 이 장비에서 검증하지 않았다.

소스 링크:

- [수집](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/token_tv/sources.py)
- [정규화](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/token_tv/usage.py)
- [캐시](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/token_tv/state.py)
- [웹·폴링](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/token_tv/live.py)
- [공급자 추가 안내](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/docs/adding-a-provider.md)
- [MIT 라이선스](https://github.com/click6067-ship-it/token-tv/blob/ab39aa32b7d31efbc1fa59af01ec185a0bff7bc7/LICENSE): 코드 복사 시 고지 보존.

## 웹 모니터 설계에 적용할 제안

- 로컬 수집기 → 정규화된 캐시 → 웹페이지 구조.
- provider/account/bucket/window를 구분해 여러 한도 창을 보존.
- 사용률·잔여율·리셋 시각·성공 조회 시각·오래됨/오류 상태 표시.
- 누락·인증 실패·리셋 경과 값을 임의로 0%로 만들지 않음.
- 서비스 간 퍼센트를 평균 내 전체 사용률로 표현하지 않음.
- 원시 payload 대신 필요한 사용량 필드만 저장. 인증정보는 브라우저와 로그에 전달하지 않음.
- 초기 화면은 세 서비스 카드와 필요한 한도 창 중심. 추이 기능은 실제 기록이 쌓인 후 검토.

## 후속 검증 순서 제안

1. Claude 직접 조회 후보를 모델 요청 없이 실측하고 공식 사용량 화면과 대조.
2. Antigravity 실제 quota payload와 독립적인 최신화 경로 확인.
3. 인증 만료, 미실행, 절전 복귀, 리셋 경과 상태의 동작 확인.
4. 결과에 따라 수집 방식과 갱신 간격을 확정하고 웹 구현 범위를 정함.

작업 기록: [PROGRESS](../../.agent-logs/2026-10-04--usage-research/PROGRESS.md), [REPORT](../../.agent-logs/2026-10-04--usage-research/REPORT.md)

## 추가 조사: 응답 완료 알림 (2026-10-04)

사용자가 Codex·Claude 대화의 응답 생성 완료를 감지해 알림을 줄 수 있는지 질문했다. 공식 문서상 가능하며 이번에는 설정·실측·알림 발송 없이 경로만 조사했다.

- Codex notify 설정은 agent-turn-complete 이벤트 때 외부 프로그램을 호출한다. JSON 인자에 thread-id, turn-id, cwd, last-assistant-message 등이 전달된다. CLI 중심의 첫 구현 후보이며 Codex 데스크톱 기존 대화 전체에 대한 적용은 이 장비에서 미검증.
- Codex app-server는 turn/completed 이벤트도 제공한다. 별도로 app-server를 시작했다고 다른 앱 프로세스의 모든 대화 이벤트를 자동으로 구독하는 것은 아니다. 실제 실행 호스트·연결·구독 범위를 확인해야 한다.
- Claude Code Stop hook은 주 에이전트가 응답을 마쳤을 때 발생한다. 사용자 중단은 Stop 대상이 아니며 API 오류는 StopFailure로 구분된다. Notification/PermissionRequest로 승인 대기도 구분 가능하다.
- Claude 문서는 터미널·IDE·Desktop의 Claude Code 세션에 hook이 적용된다고 설명한다. 일반 Claude 웹/앱 Chat까지 동일하게 감지한다는 근거는 아니다.
- Stop 시 다른 hook이 작업을 계속하게 만들거나 background 작업이 남을 수 있다. 응답 완료와 사용자 목표 전체 달성은 별개다.
- 제안 구조: 완료 이벤트 → 로컬 수집기 → 세션 상태 저장 → 웹 실시간 갱신 + macOS 알림. 사용량 polling과 완료 이벤트 수집은 별도 경로로 운영한다.
- 알림 중복 방지를 위해 공급자·세션·턴 식별자를 사용하고, 실행 중/응답 완료/입력 대기/실패 상태를 구분한다. 전체 답변 저장 없이 세션 식별자와 완료 시각만으로 기본 알림이 가능하다.
- 다음 확인: 사용자가 주로 이용하는 화면(CLI, Codex 데스크톱, Claude Code Desktop, 일반 Chat)을 먼저 구분하고 해당 환경에서 이벤트를 실측한다.

출처: [Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code hooks](https://code.claude.com/docs/en/hooks#stop)

## 대상 확정 및 기존 세션 탐색 실측 (2026-10-04)

사용자가 Codex 데스크톱 앱과 Claude Code 터미널을 모니터링 대상으로 확정했다. 목표는 작업 중인 대화 목록과 이번 응답 완료 여부를 보여주는 현황판이다. 구현·hook 설치·알림 활성화는 아직 하지 않았다.

### Codex 데스크톱

- 앱의 list_threads 조회에서 현재 프로젝트 대화가 active로 표시되는 것을 확인했다. 이 앱 전용 도구가 독립 웹 백엔드에서 호출 가능한 API라는 뜻은 아니다.
- ~/.codex/state_5.sqlite를 mode=ro로 열어 threads 스키마를 확인했다. id, title, cwd, rollout_path, source, archived 등의 메타데이터가 있다. 해당 스키마에서 실시간 실행 상태 컬럼은 확인하지 못했다.
- 현재 프로젝트의 rollout 파일에서 event_msg의 task_started와 task_complete가 turn_id로 연결되는 것을 확인했다. 마지막 이벤트는 이번 실행의 task_started였다. 과거 task_complete에는 완료 시각과 duration_ms 등이 있다.
- 따라서 기존 세션 발견(DB 메타데이터) + 새 이벤트 추적(rollout JSONL)이 로컬 읽기 전용 감지의 후보가 된다. 내부 저장 형식이므로 버전 변화에 대비해야 한다. 기록 지연·중단·비정상 종료·승인 대기 감지 및 모든 앱 세션에 대한 범위는 미검증.
- app-server-control 소켓 존재만 확인했다. 연결하거나 대화를 resume하지 않았다.

### Claude Code

- ~/.claude/sessions/*.json에서 pid, sessionId, cwd, procStart, status, statusUpdatedAt, kind, entrypoint 등의 필드를 확인했다.
- 발견한 7개 기록은 모두 entrypoint=claude-desktop, status=idle이었다. 이 기록은 터미널 세션의 직접 검증 근거로 사용할 수 없다.
- PID 존재 여부만 확인하면 7개 모두 살아 있는 것처럼 보였지만, 프로세스 시작 시각을 UTC로 맞춰 비교하자 1개는 시작 시각·실행파일이 달랐다. PID가 재사용된 오래된 기록이었다. 나머지 6개는 시작 시각이 일치했다.
- 따라서 PID 존재만으로 세션 생존을 판정하면 오탐한다. 시작 시각·실행파일·실행 출처도 대조해야 한다. idle 값만으로 새 응답 완료를 추정해서는 안 된다.
- Claude Code 터미널은 공식 UserPromptSubmit/Stop/StopFailure/Notification hook을 중심으로 상태 전이를 수집하는 방향을 제안한다. 이미 열린 터미널 세션 발견 및 hook 활성화 후 실제 상태 전이는 여전히 미검증이다.

### 다음 구현을 위한 조건

초기 스캔에서는 과거 완료 기록을 알림으로 재전송하지 않는다. 이후 발생한 이벤트를 세션·턴별로 처리한다. 프로세스 소멸/기록 누락은 완료가 아니라 확인 불가 또는 연결 종료로 구분한다. Codex의 task_complete 감지와 Claude Stop 감지는 응답 완료를 의미하며 사용자 목표 전체의 성공을 보증하지 않는다.

## 최신 구현: 최소 감지기 완료 (2026-10-04)

이전 절의 미구현 상태 이후 사용자의 구현 요청으로 [local_monitor](../../local_monitor/)를 추가했다. 실행법은 [README](../../README.md), 상세 검증은 [REPORT](../../.agent-logs/2026-10-04--usage-research/REPORT.md)의 마지막 절을 참고한다.

- Python CLI 상태 조회·JSON snapshot·완료 이벤트 watch 구현. 웹 UI와 사용량 수집은 아직 없다.
- 자동 테스트 17개 통과. 실제 Codex 현재 세션 running/과거 완료 파싱 확인.
- Claude 터미널 세션을 실제 실행하고 OK 응답 1회로 UserPromptSubmit→Stop→완료 이벤트 1회 수집 검증. 종료 상태도 확인.
- 기존 Claude 설정을 백업하고 9종 hook을 설치했다. 이전의 '설정 변경 없음'은 조사 당시 기록이며 현재 상태에는 해당하지 않는다.
- 감지기는 검증 후 종료했고 자동 시작 서비스는 없다. hook만 설치 상태로 남아 있다.
- Codex 새 완료의 실시간 전체 흐름, macOS 알림 배너는 미검증. 이 한계를 구현 완료와 구분한다.


## 최신 구현: 웹 현황판 (2026-10-04)

웹 현황판을 추가했다. [README](../../README.md)에 실행·정지 방법이 있다. 기본 주소 http://127.0.0.1:3010, /api/state 캐시 API, 실제 새 완료 이벤트에 대한 페이지 팝업/알림 목록 제공. Python 테스트 20개와 실제 Claude 응답 완료의 웹 알림 1회 수신을 검증했다. 브라우저 권한 차단 안내도 검증했지만 OS 배너 표시는 미검증이다. 주간 사용량 수집은 아직 포함하지 않았다. 실행 상태는 PROGRESS를 기준으로 실제 tmux/HTTP 상태와 대조한다.

## 최신 구현: 남은 사용량 카드 (2026-10-05)

`local_monitor/usage.py`에 계정 사용량 정규화/독립 캐시/수집 스레드, `usage_bridge.py`에 Antigravity quota 최소 수신, `usage_setup.py`에 설치·복원 구현. Codex/Claude 300초 조회, AG 상태줄 수신. 누락/오류/10분 경과/리셋 경과를 실제 잔여 0%와 구분. 사용자 화면과 /api/state에는 비밀/계정 이메일 미포함.

실측 00:52 KST: Codex 주간 잔여81%, Claude 주간97%·5시간100%, AG Gemini/Claude·GPT 주간 각100%. 과거 실측값이므로 현재값으로 재사용하지 않는다. macOS Claude는 `.credentials.json`이 존재해도 토큰이 없을 수 있어 키체인을 우선해야 함. OAuth endpoint 실제 GET 성공, 모델 요청 없음. AG CLI 1.2.14의 `/usage` 표시와 실제 statusLine quota 2개 그룹 일치.

설정: AG statusLine 백업 후 연결, 기존 기본 표시 유지. 실제 CLI 검증 과정에서 local-monitor 프로젝트 신뢰 선택 후 /usage 조회, /exit로 종료. AG는 CLI 미실행 상태에서 독립 갱신하지 않는 한계가 있음. 28개 테스트 및 로컬 브라우저/모바일 확인 완료. 공유 ACTIVE 및 익명 Access 로그인 화면 확인, 인증 후 원격 화면은 미검증. [README](../../README.md)의 최신 안내와 REPORT 참조.

## 2026-10-12: unattended Antigravity quota queries

The earlier passive-only limitation is superseded. The installed CLI supports `agy -p /usage --output-format json --print-timeout 30s`. A real query returned `status: SUCCESS`, `command.name: usage`, and `command.data.groups[].buckets[]` with `id`, `remaining_fraction`, `reset_time`. This command queries quota directly rather than sending an inference prompt.

The server now queries on startup and 300 seconds after each successful query, independently of interactive CLI sessions or statusLine installation. Failures retain previous values and back off to 600/1200/2400/3600 seconds; successful queries restore 300 seconds. Output is bounded and only quota fields enter the cache. Existing statusLine ingestion accepts strictly newer observations so old files cannot undo a newer query or clear its failure state. CLI login and an executable on the server PATH remain required. AGY daily-budget identity remains unknown. See [current operational instructions](../../README.md) and `local_monitor/agy_usage.py`.

Primary references: [official headless usage commands](https://www.agy.dev/docs/cli/headless/), [official usage command](https://www.agy.dev/docs/cli/commands/usage/), [maintainer quota-query implementation](https://github.com/franksde/agy-hud/blob/main/src/usageCommand.ts).
