# LTNC 와이어 프로토콜 v1 (agent ↔ hub ↔ dashboard)

> 모든 메시지는 JSON 단일 객체. WS 텍스트 프레임 1개 = 메시지 1개. 버전 필드 `v:1`.

## 1. Agent → Hub (`/agent?token=<token>`, 아웃바운드 전용)

| t | 방향 | 페이로드 | 설명 |
|---|---|---|---|
| `hello` | a→h | `{t,v:1,agent,host,tags?}` | 접속 직후 1회. `agent` = config 의 agent id |
| `hello_ack` | h→a | `{t,serverTime}` | 인증 성공 응답. 실패 시 소켓 close(4401) |
| `batch` | a→h | `{t,ts,metrics:{<name>:<number>}}` | 수집 1주기 분. `ts`=epoch sec. 재전송(버퍼 flush) 시 과거 ts 허용 |
| `ok` | h→a | `{t,ts}` | batch ack (버퍼 정리 기준) |

- 인증: 쿼리 `token` = config `agents[].token` 일치(상수시간 비교). 불일치 → close 4401.
- 재연결: 지수 백오프 500ms→30s(×2, ±25% 지터), 무한 재시도. 단절 중 샘플은 ring buffer(기본 3600개) 보관 후 flush.
- 메트릭 이름 규약(점 구분): `cpu.pct` `cpu.core_max_pct` `load.1m` `mem.used_pct` `mem.used_mb` `mem.total_mb`
  `disk.<mount>.used_pct` `diskio.read_kbps` `diskio.write_kbps` `net.rx_kbps` `net.tx_kbps`
  `svc.<unit>.active`(1/0) `port.<port>.open`(1/0) `exec.<name>`(임의 수치 — 예: `exec.mysql_replica_lag`)

## 2. Dashboard ↔ Hub (`/live`)

| t | 방향 | 페이로드 |
|---|---|---|
| `init` | h→d | `{t,servers:[{id,host,tags,lastSeen,online,latest:{<metric>:{ts,value}}}]}` |
| `metrics` | h→d | `{t,server,ts,metrics:{}}` (ingest 실시간 중계) |
| `presence` | h→d | `{t,server,online}` (agent 접속/이탈) |

## 3. HTTP API

- `GET /api/health` → `{ok,uptime,db}`
- `GET /api/servers` → init 와 동일 구조
- `GET /api/range?server=&metric=&from=&to=&res=raw|5m|1h|auto` → `{points:[[ts,value]...]}` (agg 는 `[ts,avg,min,max]`)
- `POST /api/ingest` (헤더 `x-ltnc-token`) — WS 불가 환경 폴백, body = batch 와 동일

## 4. 저장 계층 (hub 내부 규약)

raw(1 샘플 그대로, **14일**) → agg_5m(cnt/sum/min/max, **90일**) → agg_1h(**3년**). 롤업 = 5분 주기 배치(완결 버킷만), 1h 는 5m 에서 계층 집계. purge 후 일 1회 `wal_checkpoint`. 시리즈 사전 = `series(server_id,metric)→id`.
