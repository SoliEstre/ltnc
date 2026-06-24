# LTNC web M1 — lane 간 통합 계약 (rim / tiles / charts)

> 3개 병렬 lane 이 이 계약만 지키면 통합이 성립한다. 데이터 접근은 **전부 `window.LTNC`**(scripts/ltnc-client.js — 이미 구현됨) 경유. 빌드 스텝 없음(브라우저 직행). 다크 테마 기본. 언어 한국어.

## 공통: window.LTNC (구현 완료 — 수정 금지, 사용만)
- `LTNC.on(ev, fn)` — `init({servers})` · `metrics({server,ts,metrics})` · `presence({server,online})` · `connection({connected})`
- `LTNC.servers()` → `[{id,host,tags,lastSeen,online,latest:{metric:{ts,value}}}]` · `LTNC.server(id)`
- `await LTNC.range(server, metric, fromSec, toSec, res='auto')` → `{res, points}` (raw=`[ts,v]`, agg=`[ts,avg,min,max]`)
- `LTNC.label(metric)` → `{name, unit}` (한글 라벨)

## Lane A — EstreUI 림(앱쉘) + 페이지 + 통합 글루 (소유: public/index.html · public/scripts/app* · estreui 림 파일 일체)
- estreui npm 패키지(루트 node_modules/estreui)를 림 템플릿으로 커스텀해 `public/` 에 배치.
- 페이지 2개: ① **대시보드**(서버 카드 그리드 — 컨테이너에 서버별 `<ltnc-server-card server="<id>">` 생성) ② **서버 상세**(서버 선택 시 — 차트 영역에 `LTNCCharts.create()` 호출, 아래 Lane C 시그니처).
- `index.html` 로드 순서: estreui 스택 → `/scripts/ltnc-client.js` → `/scripts/ltnc-charts.js`(classic) → `<script type="module" src="/tiles/index.js">`(UV 타일 등록).
- PWA: estreui 동봉 webmanifest/serviceWorker 를 LTNC 명의(이름 LongTimeNoC, 테마 다크)로 커스텀.
- 타일/차트 내부 구현에 의존 금지 — 태그명·시그니처만 사용.

## Lane B — EstreUV 타일 (소유: eux/ · public/tiles/ · public/vendor/lit·estreuv)
- `.eux` 스펙(eux/*.eux — EstreUX v0/v1 포맷) 작성 + brew 산출물 = `public/tiles/*.js` (ES module, self-registering).
- 필수 타일 3종:
  - `<ltnc-server-card server="web-1">` — 서버명·online 점·CPU/메모리/디스크 미니 게이지·서비스/포트 뱃지·인증서 D-n. `LTNC.on('metrics'/'presence')` 실시간 갱신. 클릭 시 `dispatchEvent(new CustomEvent('ltnc:open-server',{detail:{server},bubbles:true,composed:true}))` (Lane A 가 수신해 상세 페이지 전환).
  - `<ltnc-stat-gauge metric="cpu.pct" value="12.3">` — 카드 내부용 소형 게이지(단독 사용도 가능).
  - `<ltnc-conn-badge>` — 허브 연결 상태(`LTNC.on('connection')`).
- `public/tiles/index.js` = 타일 전체 import 진입점.
- lit/estreuv 로딩은 EstreUV 의 standalone 패턴(레포 `E:\WorkBase\EstreUV.js\packages\estreuv\index-standalone.html` 참조) 그대로 — 가능하면 `public/vendor/` 로컬 사본, 불가피하면 CDN import map(주석으로 사유 명기). import map 자체는 Lane A 의 index.html 에 들어가므로 **필요한 import map JSON 을 `public/tiles/IMPORTMAP.json` 으로 산출**(Lane A 가 삽입).
- 다크 테마, 오렌지 포인트(#ff9500), 상태색 green/amber/red.

## Lane C — 차트 (소유: public/scripts/ltnc-charts.js · public/vendor/uplot)
- uPlot 을 `public/vendor/uplot/`(uPlot.iife.min.js + uPlot.min.css — 루트 node_modules/uplot/dist 에서 복사)로 vendoring.
- 전역 `window.LTNCCharts` (classic script):
  - `LTNCCharts.create(el, {server, metric, rangeSec=3600, height=180})` → 핸들 `{destroy(), setRange(sec), el}`
  - 동작: `LTNC.range()` 로 초기 로드(res auto — agg 면 avg 라인 + min/max 밴드), `LTNC.on('metrics')` 로 라이브 append(rangeSec 창 유지), 컨테이너 ResizeObserver 반응형, 다크 테마, 시간축 한국어 포맷.
  - 라벨/단위 = `LTNC.label(metric)`.
- 의존: uPlot 전역(window.uPlot) + LTNC 만.

## 공통 스타일 토큰 (각 lane CSS 에서 동일 변수 사용)
`--ltnc-bg:#101216  --ltnc-card:#1a1d23  --ltnc-text:#e8eaed  --ltnc-dim:#9aa0a6  --ltnc-accent:#ff9500  --ltnc-ok:#34c759  --ltnc-warn:#ffb020  --ltnc-crit:#ff4d4f`

---

# M2 확장 계약 (알림 · 인증 · 체크러너 · AI 다이제스트 · 워룸)

## hub 신규 API (Lane HUB 구현 · Lane WEB 소비)
- **인증(간단 게이트 — RBAC 전 단계)**: `POST /api/login {user, pass}` → httpOnly 세션 쿠키(`ltnc_sid`) · `POST /api/logout` · `GET /api/me` → `{user}` 또는 401.
  보호 범위 = **데이터 API(/api/*, login/me 제외) + WS /live** (401/close 4401). 정적 파일·/agent(토큰)·/api/health 는 공개.
  계정 = config `auth: {user, passHash, sessionTtlSec}` — passHash 는 `node:crypto` scrypt(`scrypt$N$r$p$salt$hex` 형식), 평문 금지.
- **알림**: `GET /api/alerts?limit=50` → `{alerts:[{id,ts,server,metric,severity,state,title,detail,value,ackAt}]}`
  (severity = `warn|crit`, state = `firing|resolved`). `POST /api/alerts/:id/ack`.
  WS /live 신규 이벤트: `{t:'alert', alert:{...}}` (발생/해소 시 브로드캐스트).
- **웹푸시**: `GET /api/push/vapid` → `{publicKey}` · `POST /api/push/subscribe {subscription}` · `POST /api/push/unsubscribe {endpoint}`. VAPID 키는 hub 가 최초 기동 시 생성해 `data/vapid.json` 보관.
- **체크러너(HTTP 업타임)**: config `checks: [{id, url, method?, keyword?, intervalSec?, timeoutSec?}]` → 주기 실행, 결과를 **가상 서버 `@checks`** 의 메트릭으로 시계열 저장: `check.<id>.up`(1/0) · `check.<id>.ms`(응답시간) — 기존 /api/range·LTNCCharts 로 차트 재사용. `GET /api/checks` → 최신 상태 목록.
- **AI 다이제스트**: `GET /api/digest/latest` → `{ts, status, brief, items:[...]}|null` · `POST /api/digest/run`(수동 트리거). WS 이벤트 `{t:'digest', digest:{...}}`.

## 알림 룰 (config `rules` — hub 평가, 기본 내장 + config 덮어쓰기)
`[{metric(glob 허용: svc.*.active), op(>|<|==|!=), threshold, forSec(지속시간), severity, server?(생략=전체)}]`
기본 세트: disk*≥85 warn/≥93 crit · cpu.pct≥90(5m) warn · mem.used_pct≥92(5m) warn · svc.*.active==0 crit · port.*.open==0 crit · exec.cert_days_left<14 warn · exec.mysql_replica_lag>10 warn/>60(2m) crit · check.*.up==0 crit · 서버 offline crit. dedup = 동일 (server,metric,severity) firing 중 재발행 금지, 해소 시 resolved 1회. 쿨다운 기본 300s.
채널: `notify: {webhooks:[{name,url,severities:[...]}], push:{enabled}}` — crit 은 푸시+webhook 동시.

## Lane WEB 신규 화면
- **알림센터**: appbar 벨 아이콘(미확인 수 뱃지 + `navigator.setAppBadge`) → 알림 목록 페이지(심각도 색·ack 버튼·실시간 추가). 푸시 구독 토글 버튼(권한 요청은 반드시 버튼 탭 핸들러 안에서. iOS 는 홈화면 설치 안내 문구).
- **로그인**: 데이터 API 401 시 로그인 화면(오버레이/페이지) → POST /api/login → 성공 시 LTNC.refresh()+WS 재연결. ltnc-client.js 가 401 시 `connection` 이벤트에 `{connected:false, authRequired:true}` 를 줄 수 있게 소폭 확장 허용(이 파일만 예외적으로 Lane WEB 수정 가능).
- **워룸(컷오버) 페이지**: 메뉴에서 진입 — 어떤 서버 이전/컷오버에도 적용되도록 일반화. ① 복제 지연 = `replicaMetric`(기본 `exec.mysql_replica_lag`) 을 보고하는 **복제본 서버 자동 발견**(또는 `window.LTNC_WARROOM.replicaServers[]` 명시) → 발견된 모두 차트, 없으면 '대기중' ② 양측(현행/신규) 응답시간 비교 = `/api/checks` 의 `check.*.ms` **동적 발견** ③ 4대 핵심 상태 스트립 한 화면. 차트 = LTNCCharts 재사용(server='@checks').
- **SW**: push 핸들러(`notification.data={alertId}` 클릭 라우팅 — 알림센터로) + Badging.

## Lane AI (packages/ai — hub 가 import)
- `createDigest({store, cfg})` → `{run(), latest()}`: ① 이상 선별 = 룰 위반/급변(z-score) 구간 수집(plain code) ② 선별 요약 + 서버별 핵심 롤업만 프롬프트로 → Anthropic Messages API(REST fetch, 모델 config `ai.model` 기본 claude-haiku, 키 `ai.apiKey` 또는 env ANTHROPIC_API_KEY) ③ 출력 = `{status: ok|warn|crit, brief(2~3문장 한국어), items:[{server,metric,note}]}`. 키 없으면 비활성(상태 'disabled') — 크래시 금지. 주기 = config `ai.intervalSec`(기본 900).
