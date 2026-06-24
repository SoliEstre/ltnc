# LongTimeNoC (LTNC)

> **Long time no see — long time no `C`(onsole).**
> 모니터링이 대신 봐주니, **오랫동안 콘솔(C) 안 봐도 되는** 자체 호스팅 모니터링.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**LTNC** is a self-hosted, installable server & service monitoring system — a single‑process hub, outbound‑only agents, and a SPA + PWA "war‑room" dashboard — with the three things the lightweight self‑hosted monitoring landscape still lacks: **PWA web‑push alerts**, **server‑group RBAC**, and an **AI situation digest**.

**LTNC**(LongTimeNoC)는 단일 허브 프로세스 + 아웃바운드 전용 에이전트 + SPA·PWA 워룸 대시보드로 구성된 **설치형 자체 호스팅 서버·서비스 모니터링**입니다. 가벼운 자체 호스팅 도구들이 아직 못 갖춘 **PWA 웹푸시 · 서버그룹 RBAC · AI 상황 다이제스트**를 채우는 것이 목표입니다.

📖 **[English](#english)** · **[한국어](#한국어)**

---

## English

### Why LTNC?

Most lightweight self‑hosted monitors (Beszel, Uptime Kuma, Gatus, Netdata, Grafana OSS, Scouter, …) are good at metrics and uptime, but as of 2026 **none** of them ship all three of:

- **Native web push** — get paged on your phone *without a vendor app*, over the standard **Web Push (VAPID)** protocol + an installable PWA. Critical alerts escalate across two channels when left unacknowledged (Android Doze makes push‑only delivery unreliable, so LTNC doesn't rely on it alone).
- **Fine‑grained RBAC** — scope each user to specific **server groups** and feature areas, with an audit trail and TOTP.
- **AI situation digest** — a two‑stage pipeline (rule/statistical anomaly flagging first → only the flagged windows' rollups go to an LLM) turns raw graphs into a plain‑language *"what's going on right now"* brief.

LTNC fills exactly that gap while staying a single small Node process you can run on a NAS.

### Architecture (3‑tier)

```
Agent (per server) --wss(token, outbound-only)--> Hub (single Node process) <--WS/HTTPS--> SPA + PWA
 /proc delta · systemd · ports                     ingest · SQLite WAL rollup              uPlot charts
 Tomcat manager / access-log  (APM-lite)           checks (HTTP/TCP/SSL) · alerts          war-room view
 MySQL status + replica lag                        RBAC · audit · TOTP                     web push (VAPID)
 log live-tail · custom exec metrics               AI digest (anomaly → LLM)               app badging
```

- **Outbound‑only agents** — each agent dials the hub over `wss` with a token; **no inbound ports** on the monitored hosts. Exponential backoff + jitter + a ring buffer mean nothing is lost across a hub blip.
- **Single‑process hub** — web + WebSocket + auth + storage in one Node process (Beszel‑style). Storage is **SQLite (WAL)** with tiered rollups: raw (1 min, 14 days) → 5 min (90 days) → 1 h (1–3 years); monthly `ATTACH` archives and `VACUUM INTO` snapshots. The storage layer is an adapter (SQLite by default, MySQL optional — never share the instance with your application DB).
- **Frontend** — EstreUX `.eux` specs brewed to [EstreUI.js](https://github.com/SoliEstre/EstreUI.js) (macro shell) + [EstreUV.js](https://github.com/SoliEstre/EstreUV.js) (micro tiles, Lit); charts via [uPlot](https://github.com/leeoniya/uPlot). A real SPA and an installable PWA from one responsive codebase.

### Features

- **Live dashboard** — server cards (online dot, CPU/mem/disk gauges, service & port badges, cert D‑n), updated in real time over WebSocket.
- **Server detail** — per‑metric charts (CPU, memory, per‑mount disk, network, disk I/O), a per‑box **% ↔ absolute** unit toggle, and adaptive / full‑scale axis modes.
- **Synthetic checks** — HTTP / TCP / SSL checks with response‑time charts and threshold bands; auto‑discovered by the dashboard.
- **Alerts** — channel plugins: **Web Push (VAPID, no vendor account)**, KakaoWork, Telegram, Slack. Critical = two channels + unacknowledged escalation.
- **AI situation digest** — two‑stage anomaly → LLM brief; pluggable provider (Anthropic by default, OpenAI‑compatible, or local). Auto‑disabled when no API key is set.
- **RBAC + auth** — scrypt login, TOTP, server‑group / feature scopes, audit log.
- **APM‑lite** — Tomcat manager status + access‑log `%D` percentiles; MySQL global status + replica lag.
- **Cutover war‑room** — see below.
- **Custom exec metrics** — an agent can run an arbitrary shell command and expose the numeric result as `exec.<name>` (e.g. replica lag, certificate days left).

### Cutover war‑room (reusable)

A dedicated **war‑room** view for **server migrations / cutovers**: replication lag + dual‑side (old vs new) response‑time comparison + a status strip, all on one screen. It is **generalized** so it works for *any* such scenario with **zero code changes**:

- **Replication lag** auto‑discovers any server reporting a replica‑lag metric (default `exec.mysql_replica_lag`). To override, set on the page:
  ```js
  window.LTNC_WARROOM = { replicaServers: ['db-standby'], replicaMetric: 'exec.pg_replica_lag' };
  ```
- **Response‑time comparison** is driven by your registered HTTP checks (`/api/checks`) — register the *old* and *new* endpoints and they appear side by side.

So the next time you move a service between hosts or clouds, open the war‑room and it just works.

### Packages

| package | role |
|---|---|
| [`packages/hub`](packages/hub) | single‑process hub: ingest, storage + rollup, checks, alerts, RBAC, API, WS |
| [`packages/agent`](packages/agent) | per‑server collector: system / systemd / Tomcat / MySQL, outbound `wss` |
| [`packages/web`](packages/web) | SPA + PWA dashboard (EstreUI.js + EstreUV.js, brewed from `.eux`) |
| [`packages/ai`](packages/ai) | AI digest module (anomaly select → LLM brief), provider‑pluggable |

### Quick start

Requires **Node ≥ 20** (Node 22+/24 recommended — the hub uses the built‑in `node:sqlite`).

```bash
# 1) clone & install
git clone https://github.com/SoliEstre/ltnc.git
cd ltnc
npm install

# 2) configure the hub
cp config.example.yaml config.yaml
#   edit config.yaml: agents[].token (a long random string), passHash, etc.

# 3) run the hub  (web + WS + API on :8420)
npm run hub
#   → open http://localhost:8420

# 4) on each monitored server, configure & run an agent
cp agent.example.yaml agent.yaml
#   set  hub: wss://<your-host>/agent ,  id ,  token  (matching the hub)
npm run agent
```

### Configuration

- **`config.yaml`** (hub) — `port`/`bind`, `dataDir`, `agents[]` (id + token), `passHash` (scrypt), `push` (VAPID), `checks[]` (HTTP/TCP/SSL), `notify.webhooks[]`, `ai.apiKey`. See [`config.example.yaml`](config.example.yaml).
- **`agent.yaml`** (per server) — `hub` URL + `token`, `intervalSec`, `mounts`, `systemdUnits`, `ports`, `execMetrics[]` (custom numeric commands). See [`agent.example.yaml`](agent.example.yaml).
- Wire protocol: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

### Deployment

A single‑container recipe (node:24‑alpine + a reverse proxy with **WebSocket support enabled**) lives in [`deploy/nas`](deploy/nas) — written for Synology Container Manager + Nginx Proxy Manager, but any Docker host works. **Host LTNC outside the fleet it watches** so it survives a full‑fleet outage.

### Roadmap

- **Agent: Node.js (today) → Go static binary** — same `wss` + token protocol, drop‑in replacement.
- Deeper RBAC, BCI‑based APM, and additional storage adapters.

### Tech stack

EstreUX `.eux` → EstreUI.js + EstreUV.js (Lit) · uPlot · `node:sqlite` (WAL) · Web Push (VAPID) · Node.js.

---

## 한국어

### LTNC 란?

가벼운 자체 호스팅 모니터링 도구(Beszel · Uptime Kuma · Gatus · Netdata · Grafana OSS · Scouter 등)는 메트릭·업타임은 잘 하지만, 2026년 기준 아래 **세 가지를 모두** 갖춘 건 **없습니다**:

- **네이티브 웹 푸시** — *벤더 앱 없이* 표준 **Web Push(VAPID)** + 설치형 PWA 로 휴대폰 알림. 미확인 시 두 채널로 에스컬레이션(안드로이드 Doze 때문에 푸시 단독 전달은 불안정해, 그것에만 의존하지 않습니다).
- **세분화 RBAC** — 사용자를 특정 **서버그룹**·기능 범위로 제한 + 감사 로그 + TOTP.
- **AI 상황 다이제스트** — 2단(룰/통계 이상 선별 → 선별된 구간 롤업만 LLM)으로 원시 그래프를 *"지금 무슨 일이 벌어지고 있는지"* 평문 브리핑으로.

LTNC 는 바로 이 공백을 메우면서도, NAS 에서도 돌릴 수 있는 **단일 작은 Node 프로세스**로 유지됩니다.

### 아키텍처 (3계층)

```
에이전트(서버마다) --wss(토큰·아웃바운드 전용)--> 허브(단일 Node 프로세스) <--WS/HTTPS--> SPA + PWA
 /proc 델타 · systemd · 포트                       수집 · SQLite WAL 롤업                  uPlot 차트
 Tomcat manager / 액세스로그 (APM-lite)            체크(HTTP/TCP/SSL) · 알림               워룸 화면
 MySQL status + 복제 지연                          RBAC · 감사 · TOTP                      웹푸시(VAPID)
 로그 라이브테일 · 커스텀 exec 메트릭             AI 다이제스트(이상 → LLM)              앱 뱃징
```

- **아웃바운드 전용 에이전트** — 에이전트가 토큰으로 허브에 `wss` 다이얼. 감시 대상 호스트에 **인바운드 포트 불필요**. 지수 백오프 + 지터 + 링버퍼로 허브 일시장애에도 유실 없음.
- **단일 프로세스 허브** — 웹 + WebSocket + 인증 + 저장을 한 Node 프로세스에(Beszel 패턴). 저장 = **SQLite(WAL)** 3계층 롤업: raw(1분·14일) → 5분(90일) → 1시간(1–3년), 월별 `ATTACH` 아카이브 · `VACUUM INTO` 스냅샷. 저장 계층은 어댑터(SQLite 기본 · MySQL 옵션 — 앱 DB 와 같은 인스턴스 사용 금지).
- **프론트엔드** — EstreUX `.eux` → [EstreUI.js](https://github.com/SoliEstre/EstreUI.js)(매크로 셸) + [EstreUV.js](https://github.com/SoliEstre/EstreUV.js)(마이크로 타일, Lit), 차트는 [uPlot](https://github.com/leeoniya/uPlot). 진짜 SPA + 설치형 PWA 를 단일 반응형 코드베이스로.

### 기능

- **라이브 대시보드** — 서버 카드(온라인 점 · CPU/메모리/디스크 게이지 · 서비스·포트 뱃지 · 인증서 D‑n), WebSocket 실시간 갱신.
- **서버 상세** — 메트릭별 차트(CPU · 메모리 · 마운트별 디스크 · 네트워크 · 디스크 I/O), 박스별 **% ↔ 실제 용량** 토글, 적응 / 전체스케일 축 모드.
- **합성 체크** — HTTP / TCP / SSL 체크 + 응답시간 차트 · 임계 띠, 대시보드가 자동 발견.
- **알림** — 채널 플러그인: **Web Push(VAPID, 벤더 계정 불필요)** · 카카오워크 · Telegram · Slack. critical = 두 채널 + 미확인 에스컬레이션.
- **AI 상황 다이제스트** — 2단 이상 → LLM 브리핑, 프로바이더 교체(Anthropic 기본 · OpenAI 호환 · 로컬). API 키 없으면 자동 비활성.
- **RBAC + 인증** — scrypt 로그인 · TOTP · 서버그룹/기능 scope · 감사 로그.
- **APM‑lite** — Tomcat manager status + 액세스로그 `%D` 백분위수, MySQL global status + 복제 지연.
- **컷오버 워룸** — 아래 참조.
- **커스텀 exec 메트릭** — 에이전트가 임의 셸 명령 결과를 `exec.<name>` 수치로 노출(복제 지연 · 인증서 잔여일 등).

### 컷오버 워룸 (재사용 가능)

**서버 이전/컷오버** 전용 **워룸**: 복제 지연 + 양측(현행 vs 신규) 응답시간 비교 + 상태 스트립을 한 화면에. **일반화**되어 있어 *어떤* 이전 시나리오에도 **코드 변경 0**으로 동작합니다:

- **복제 지연**은 복제‑지연 메트릭(기본 `exec.mysql_replica_lag`)을 보고하는 서버를 **자동 발견**합니다. 직접 지정하려면 페이지에서:
  ```js
  window.LTNC_WARROOM = { replicaServers: ['db-standby'], replicaMetric: 'exec.pg_replica_lag' };
  ```
- **응답시간 비교**는 등록된 HTTP 체크(`/api/checks`)로 구동됩니다 — *현행*·*신규* 엔드포인트를 등록하면 나란히 표시됩니다.

다음에 서비스를 호스트/클라우드 간 이전할 때, 워룸을 열기만 하면 그대로 작동합니다.

### 패키지

| 패키지 | 역할 |
|---|---|
| [`packages/hub`](packages/hub) | 단일 프로세스 허브: 수집 · 저장+롤업 · 체크 · 알림 · RBAC · API · WS |
| [`packages/agent`](packages/agent) | 서버별 수집기: system / systemd / Tomcat / MySQL, 아웃바운드 `wss` |
| [`packages/web`](packages/web) | SPA + PWA 대시보드 (EstreUI.js + EstreUV.js, `.eux` brew) |
| [`packages/ai`](packages/ai) | AI 다이제스트 모듈 (이상 선별 → LLM 브리핑), 프로바이더 교체 |

### 빠른 시작

**Node ≥ 20** 필요(허브가 내장 `node:sqlite` 를 쓰므로 Node 22+/24 권장).

```bash
# 1) 클론 & 설치
git clone https://github.com/SoliEstre/ltnc.git
cd ltnc
npm install

# 2) 허브 설정
cp config.example.yaml config.yaml
#   config.yaml 편집: agents[].token(충분히 긴 무작위 문자열), passHash 등

# 3) 허브 실행  (웹 + WS + API on :8420)
npm run hub
#   → http://localhost:8420 접속

# 4) 감시할 서버마다 에이전트 설정 & 실행
cp agent.example.yaml agent.yaml
#   hub: wss://<호스트>/agent ,  id ,  token (허브와 일치) 설정
npm run agent
```

### 설정

- **`config.yaml`**(허브) — `port`/`bind`, `dataDir`, `agents[]`(id + token), `passHash`(scrypt), `push`(VAPID), `checks[]`(HTTP/TCP/SSL), `notify.webhooks[]`, `ai.apiKey`. → [`config.example.yaml`](config.example.yaml).
- **`agent.yaml`**(서버별) — `hub` URL + `token`, `intervalSec`, `mounts`, `systemdUnits`, `ports`, `execMetrics[]`(커스텀 수치 명령). → [`agent.example.yaml`](agent.example.yaml).
- 와이어 프로토콜: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

### 배포

단일 컨테이너 레시피(node:24‑alpine + **WebSocket 지원을 켠** 리버스 프록시)가 [`deploy/nas`](deploy/nas) 에 있습니다 — Synology Container Manager + Nginx Proxy Manager 기준이지만 어떤 Docker 호스트에서도 동작합니다. **LTNC 는 감시 대상 밖에 호스팅**해 전체 장애에도 관제가 살아남게 하세요.

### 로드맵

- **에이전트: Node.js(현재) → Go 정적 바이너리** — 동일 `wss` + 토큰 프로토콜, drop‑in 교체.
- 더 깊은 RBAC, BCI 기반 APM, 추가 저장 어댑터.

### 기술 스택

EstreUX `.eux` → EstreUI.js + EstreUV.js (Lit) · uPlot · `node:sqlite`(WAL) · Web Push(VAPID) · Node.js.

---

## License

[MIT](LICENSE) © SoliEstre
