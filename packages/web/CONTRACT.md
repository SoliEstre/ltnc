# LTNC web M1 — lane 간 통합 계약 (rim / tiles / charts)

> 3개 병렬 lane 이 이 계약만 지키면 통합이 성립한다. 데이터 접근은 **전부 `window.LTNC`**(scripts/ltnc-client.js — 이미 구현됨) 경유. 빌드 스텝 없음(브라우저 직행). 테마 = 라이트 기본 + 다크 오버라이드(EstreUI 자체 다크모드 설정 연동, 아래 토큰 표). 언어 한국어.

## 공통: window.LTNC (구현 완료 — 수정 금지, 사용만)
- `LTNC.on(ev, fn)` — `init({servers})` · `metrics({server,ts,metrics})` · `presence({server,online})` · `connection({connected})`
- `LTNC.servers()` → `[{id,host,tags,lastSeen,online,latest:{metric:{ts,value}}}]` · `LTNC.server(id)`
- `await LTNC.range(server, metric, fromSec, toSec, res='auto')` → `{res, points}` (raw=`[ts,v]`, agg=`[ts,avg,min,max]`)
- `LTNC.label(metric)` → `{name, unit}` (한글 라벨)

## Lane A — EstreUI 림(앱쉘) + 페이지 + 통합 글루 (소유: public/index.html · public/scripts/app* · estreui 림 파일 일체)
- estreui npm 패키지(루트 node_modules/estreui)를 림 템플릿으로 커스텀해 `public/` 에 배치.
- 페이지 2개: ① **대시보드**(서버 카드 그리드 — 컨테이너에 서버별 `<ltnc-server-card server="<id>">` 생성) ② **서버 상세**(서버 선택 시 — 차트 영역에 `LTNCCharts.create()` 호출, 아래 Lane C 시그니처).
- `index.html` 로드 순서: estreui 스택 → `/scripts/ltnc-client.js` → `/scripts/ltnc-charts.js`(classic) → `<script type="module" src="/tiles/index.js">`(UV 타일 등록).
- PWA: estreui 동봉 webmanifest/serviceWorker 를 LTNC 명의(이름 LongTimeNoC, 테마 라이트/다크 — OS 추종)로 커스텀.
- 타일/차트 내부 구현에 의존 금지 — 태그명·시그니처만 사용.

## Lane B — EstreUV 타일 (소유: eux/ · public/tiles/ · public/vendor/lit·estreuv)
- `.eux` 스펙(eux/*.eux — EstreUX v0/v1 포맷) 작성 + brew 산출물 = `public/tiles/*.js` (ES module, self-registering).
- 필수 타일 3종:
  - `<ltnc-server-card server="web-1">` — 서버명·online 점·CPU/메모리/디스크 미니 게이지·서비스/포트 뱃지·인증서 D-n. `LTNC.on('metrics'/'presence')` 실시간 갱신. 클릭 시 `dispatchEvent(new CustomEvent('ltnc:open-server',{detail:{server},bubbles:true,composed:true}))` (Lane A 가 수신해 상세 페이지 전환).
  - `<ltnc-stat-gauge metric="cpu.pct" value="12.3">` — 카드 내부용 소형 게이지(단독 사용도 가능).
  - `<ltnc-conn-badge>` — 허브 연결 상태(`LTNC.on('connection')`).
- `public/tiles/index.js` = 타일 전체 import 진입점.
- lit/estreuv 로딩은 EstreUV 의 standalone 패턴(레포 `E:\WorkBase\EstreUV.js\packages\estreuv\index-standalone.html` 참조) 그대로 — 가능하면 `public/vendor/` 로컬 사본, 불가피하면 CDN import map(주석으로 사유 명기). import map 자체는 Lane A 의 index.html 에 들어가므로 **필요한 import map JSON 을 `public/tiles/IMPORTMAP.json` 으로 산출**(Lane A 가 삽입).
- 라이트/다크 테마(공통 토큰 자동 추종), 오렌지 포인트(#ff9500), 상태색 green/amber/red.

## Lane C — 차트 (소유: public/scripts/ltnc-charts.js · public/vendor/uplot)
- uPlot 을 `public/vendor/uplot/`(uPlot.iife.min.js + uPlot.min.css — 루트 node_modules/uplot/dist 에서 복사)로 vendoring.
- 전역 `window.LTNCCharts` (classic script):
  - `LTNCCharts.create(el, {server, metric, rangeSec=3600, height=180})` → 핸들 `{destroy(), setRange(sec), el}`
  - 동작: `LTNC.range()` 로 초기 로드(res auto — agg 면 avg 라인 + min/max 밴드), `LTNC.on('metrics')` 로 라이브 append(rangeSec 창 유지), 컨테이너 ResizeObserver 반응형, 라이트/다크 테마(토큰 추종·전환 재색칠), 시간축 한국어 포맷.
  - 라벨/단위 = `LTNC.label(metric)`.
- 의존: uPlot 전역(window.uPlot) + LTNC 만.

## 공통 스타일 토큰 (각 lane CSS 에서 동일 변수 사용) — 라이트 기본 + 다크 오버라이드
EstreUI 자체 다크모드 설정(`body[data-dark-mode="1"]`)에 따라 전환된다. **라이트가 기본값(`:root`)**, 다크는 `body[data-dark-mode="1"]` 에서 재정의(EstreUI 코어 규약과 동일 구조). 캔버스 차트(Lane C)는 CSS 변수를 직접 못 쓰므로 `getComputedStyle` 로 라이브 조회 후 hex→rgba 변환해 사용하고, 다크모드 토글 시 재색칠한다(`ltnc-charts.js` `readThemeTokens`).

| 토큰 | 라이트(기본 `:root`) | 다크(`body[data-dark-mode="1"]`) | 용도 |
|---|---|---|---|
| `--ltnc-bg` | `#f4f5f7` | `#101216` | 페이지 배경 |
| `--ltnc-card` | `#ffffff` | `#1a1d23` | 카드/표면 |
| `--ltnc-text` | `#1f2329` | `#e8eaed` | 본문 텍스트 |
| `--ltnc-dim` | `#5f6368` | `#9aa0a6` | 흐린 텍스트/축 라벨 |
| `--ltnc-accent` | `#a8500a` | `#ff9500` | 포인트(오렌지) |
| `--ltnc-ok` | `#1a7d35` | `#34c759` | 정상(초록) |
| `--ltnc-warn` | `#8a5d00` | `#ffb020` | 경고(노랑) |
| `--ltnc-crit` | `#cc2a2d` | `#ff4d4f` | 위험(빨강) |
| `--ltnc-border` | `#1f2329` | `#9aa0a6` | 보더(`color-mix N%, transparent` 로 소비) |
| `--ltnc-scrim` | `rgba(15,18,22,.42)` | `color-mix(--ltnc-bg 88%, black)` | 모달 백드롭 |
| `--ltnc-shadow` | `0 14px 40px rgba(15,18,22,.14)` | `0 18px 60px rgba(0,0,0,.55)` | 떠있는 표면 그림자 |
| `--ltnc-on-status` | `#ffffff` | `#1a1d23` | 상태색(accent/warn/dim) 배경 위 텍스트 |
| `--ltnc-scheme` | `light` | `dark` | 네이티브 폼/달력/스크롤바 `color-scheme` |

> 라이트 상태색(accent/ok/warn/crit)은 흰 배경 위 텍스트가 WCAG AA(≥4.5:1)를 만족하도록 다크판보다 진하게 조정했다. `--ltnc-crit` 흰글씨 칩(벨 뱃지·crit 칩)은 두 모드 모두 `#fff` 유지(다크 기존 동작 보존). 무설정 기본 테마 = EstreUI auto(OS `prefers-color-scheme`) — index.html 사전 페인트 스크립트가 저장설정 우선·없으면 OS 추종(다크 강제 잠금 해제, 2026-06-26).

---

# M2 확장 계약 (알림 · 인증 · 체크러너 · AI 다이제스트 · 워룸)

## hub 신규 API (Lane HUB 구현 · Lane WEB 소비)
- **인증(간단 게이트 — RBAC 전 단계)**: `POST /api/login {user, pass}` → httpOnly 세션 쿠키(`ltnc_sid`) + `{ok,user,home}` · `POST /api/logout` · `GET /api/me` → `{user,auth,home}` 또는 401.
  보호 범위 = **데이터 API(/api/*, login/me 제외) + WS /live** (401/close 4401). 정적 파일·/agent(토큰)·/api/health 는 공개.
  계정 = config `auth: {user, passHash, sessionTtlSec, home?, users?:[{user,passHash,home?}]}` — **다중 계정**(레거시 단일 + users[] 병행). passHash 는 `node:crypto` scrypt(`scrypt$N$r$p$salt$hex` 형식), 평문 금지.
  `home` = 로그인/부팅 직후 이동할 루트탭 id(예 `stats`) — web 이 login 응답·/api/me 로 받아 `estreUi.switchRootTab(home)` (`ltncApplyHomeTab`, ?ltncOpen= 명시 라우팅이 우선).
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


# 확장 계약 — 통계 탭 (ClickHouse)

> 서버 모니터링(M1/M2)과 별개로, **분석용 데이터 웨어하우스**(ClickHouse)를 read-only 조회하는 통계 탭. hub `stats.mjs` 가 CH 를 조회, web `LTNCStatsPage` 가 카드로 렌더. **동봉 쿼리셋은 예시 스키마(`events`)를 시연하는 레퍼런스이며 배포처마다 교체한다.** 아래는 web 렌더러가 의존하는 **프레임워크 계약**(API·응답 kind·파라미터)으로, 쿼리 교체와 무관하게 유지된다.

## hub 신규 API — `GET /api/stats/<name>` (Lane HUB 구현 · Lane WEB 소비)
- 인증 게이트 보호(/api/* 세션 필수). **클라 raw SQL 불가** — name(화이트리스트) + 정제 파라미터만(H3 규율). 구현 = `packages/hub/src/stats.mjs`(`createStatsModule`), config `stats:{enabled,url,db,user,pass,timeoutSec}`(미설정 시 503, CH 오류=502).
- **allowlist named 쿼리**: hub 의 `QUERIES` 맵에 등록된 name 만 실행. 각 name 은 아래 5종 kind 중 하나를 반환한다. 동봉 쿼리셋은 하나의 예시 테이블(`events`: `ts`·`user_id`·`event_type`·`value`·`path`·`status`)에 대해 각 kind 를 한 번씩 시연할 뿐이며, 실제 배포는 자기 스키마·라벨에 맞게 통째로 교체한다. 등록 name 목록은 hub 가 노출.
- 응답 kind 5종 (web 렌더러가 소비하는 실계약):
  - `{title, kind:'table', columns:[...], rows:[[...],...], numCols?:[열idx]}` (numCols=우측정렬·숫자열, 미지정 시 마지막 열만)
  - `{title, kind:'dist', total, items:[{key,cnt,pct}]}` (분포 — 가로막대)
  - `{title, kind:'series', unit, split?, xunit?, series:[{name, points:[[unixSec,val],...]}]}` (추세 — 시계열; split=true 면 web 이 시리즈별 개별 차트)
  - `{title, kind:'bars', categories:[...], split?, series:[{name, values:[...]}]}` (카테고리 막대; split 면 지표별 개별)
  - `{title, kind:'heat', xcats:[...], ycats:[...], values:[[y][x]]}` (히트맵 — web 이 색농도 그리드 렌더)
- 파라미터(정제 후 hub 가 SQL 구성): `b`=추세 버킷(**d|w|m|q|y**, 기본 m), `days`=추세 구간(일수, 0=전체; 소스행 또는 결과버킷 t 필터), `limit`(dist 인라인 상위 N·상세 재조회 대량). 쿼리별로 추가 화이트리스트 파라미터를 정의할 수 있다. **from/to 없음**(추세는 버킷+days 로 표현).
- series 의 `xunit`(''|isoweek|month) — web x축 눈금 표기 결정(isoweek=년-주차, month=년-월). dist 의 `limit` 을 크게 주면 상세뷰 전체항목.

## Lane WEB — 통계 페이지 (`LTNCStatsPage`, app.js · staticDoc `#stats` · fixedBottom rootbar)
- **하단 rootbar 탭 `📊 통계`**(fixedBottom `data-tab-id="stats"`) → staticDoc `#stats.root_tab_content`(PID `&m=stats`). `onShow` 마다 새로고침(5분 캐시). DOM: `#statsGrid`(상단 고정 섹션네비 `.ltnc_stats_nav` + 섹션·카드). 추세 단위 셀렉터는 추세 섹션 헤더에 렌더(전역 `ltncStatsBucket`).
- **섹션 구성은 등록된 쿼리셋에 따라 배포처가 구성**(순서·그룹핑 자유). 추세 섹션 헤더에 **단위**(`일/주/월/분기/년`)+**구간**(일수) 셀렉터 — 단위 변경 시 구간=단위 기본값 리셋, 선택 변경 시 추세 카드 재렌더. 섹션 제목줄 = 네비 아래 **sticky**. 카드 표시순서 = `display:contents` 슬롯 선배치로 고정.
- 분리(split) 카드 제목 = **시리즈명만**. 각 그래프(series/bars/dist) 카드 헤더 `⛶` → `ltncStatsOpenDetail`(닫기버튼 우측끝, 컨텐츠 무스크롤, 범례=우상단 박스 `.ltnc_stats_dv_body .u-legend`, 상세뷰 한정 선끝 라벨 `ltncStatsLabelPlugin`; dist 상세=전체항목 재조회). 상단 네비 = 섹션 이동 + IntersectionObserver 강조 + **우측 그래프 크기선택**(`LTNC_STATS_SIZES` 기본 s/m/l·전체폭 fs/fm/fl, localStorage `ltnc.statsSize`; 열폭·막대높이=CSS변수, 차트=setSize).
- 렌더 = kind 별: table→`<table>`(numCols), dist→가로막대(인라인 상위 N·상세 전체), series→uPlot(split=시리즈별 카드; **x축 세로줄=버킷 시점만** `splits=xs`, 라벨 stride, 표기 xunit/간격 자동), bars→HTML 세로막대, heat→색농도 그리드. 동시요청 4(`ltncStatsPool`). 차트 `#charts` sec 태그 파기. **리포커스 스크롤복원**(`#installScrollGuard`, window focus 시 마지막 scrollTop 복원). CSS=app.js 주입(오버레이 `.ltnc_dv_*` 재사용). uPlot 전역.
- SW: 앱 JS/HTML(app.js·fixedBottom·staticDoc·instantDoc·mainMenu) 변경 → `INSTALLATION_VERSION_NAME` bump 필수(현 `r20260701c`).
