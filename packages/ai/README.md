# @ltnc/ai — AI 상황 다이제스트

LTNC hub 가 import 해서 쓰는 AI 다이제스트 엔진이에요. **외부 의존성 0** (Node 내장 `fetch` 사용), 빌드 스텝 없음.

## 동작 구조 (2단계)

1. **이상 선별 (plain code — LLM 전 단계)**
   `store.servers()` + `latestByServer()` 현재 상태 스캔 + 최근 1시간의 5분 롤업(`queryRange`)을 핵심 지표(`cpu.pct`·`mem.used_pct`·`disk.*`·`net.*`)에 대해 조회해서:
   - 임계 초과 (디스크 ≥85/93 · CPU ≥90 · 메모리 ≥92 · 인증서 <14일 · 복제지연 >10/60초)
   - 서비스/포트 다운 (`svc.*.active==0` · `port.*.open==0` · `check.*.up==0`)
   - 급변 (직전 1시간 대비 z-score > 3 또는 평균 2배↑)
   - 서버 오프라인 (`offlineAfterSec` 초과 무수신; 가상 서버 `@checks` 제외)

   만 추려 후보를 만들어요. **이상 0건이면 LLM 호출을 생략**하고 정형문 `ok` 다이제스트를 반환해요(비용 절감). `cfg.ai.alwaysLlm: true` 면 항상 호출해요.

2. **LLM 다이제스트** — Anthropic Messages API 를 직접 `fetch` 해서 한국어 요약 JSON `{status, brief, items}` 를 받아요. 코드펜스 제거 등 파싱 방어 포함, 파싱 실패 시 `status:'error'` + `raw` 원문 보존, API 호출 실패 시 규칙 기반 결과로 폴백해요.

## 사용법 (hub 측)

```js
import { createDigest } from '@ltnc/ai';

const digest = createDigest({ store, cfg, broadcast });
// 주기 실행은 hub 책임 — 해석된 주기는 digest.intervalSec (기본 900초)
setInterval(() => digest.run(), digest.intervalSec * 1000).unref();
// 수동 트리거(POST /api/digest/run): await digest.run()
// 조회(GET /api/digest/latest): digest.latest()  → {ts,status,brief,items,...} | null
// 상태: digest.status() → 'disabled' | 'running' | 'idle' | 'ok'|'warn'|'crit'|'error'
```

- `run()` 완료 시: `latest` 갱신 + `broadcast({t:'digest', digest})` + `<dataDir>/digest-latest.json` 영속(재기동 시 자동 복원).
- **API 키가 없으면 `status()='disabled'`** 로 안전 비활성 — `run()` 은 no-op 이고 어떤 경우에도 크래시하지 않아요.

## 설정 (hub config `ai:` 절)

| 키 | 기본값 | 설명 |
|---|---|---|
| `ai.apiKey` | env `ANTHROPIC_API_KEY` | API 키. 둘 다 없으면 비활성(disabled) |
| `ai.model` | `claude-haiku-4-5-20251001` | 사용할 모델 id |
| `ai.baseUrl` | `https://api.anthropic.com` | API 베이스 URL (아래 provider 플러그블 참고) |
| `ai.intervalSec` | `900` | 다이제스트 주기(초) — hub 가 스케줄링에 사용 |
| `ai.alwaysLlm` | `false` | `true` 면 이상 0건이어도 항상 LLM 호출 |

## Provider 플러그블 구조

기본 provider 는 **Anthropic** (헤더 `x-api-key` + `anthropic-version: 2023-06-01`, 엔드포인트 `<baseUrl>/v1/messages`, Messages API 요청/응답 형식)이에요.

`ai.baseUrl` 을 덮어쓰면 **Anthropic Messages API 형식을 받아주는 어떤 게이트웨이로도** 교체할 수 있어요:

- **OpenAI-호환/멀티 LLM 게이트웨이** (LiteLLM proxy, OpenRouter 등 `/v1/messages` Anthropic-호환 패스스루를 제공하는 게이트웨이): `ai.baseUrl: http://localhost:4000` 처럼 지정하고 `ai.apiKey` 에 게이트웨이 키, `ai.model` 에 게이트웨이가 라우팅하는 모델명을 넣으면 돼요. 게이트웨이가 Anthropic 형식(요청 body `{model,max_tokens,system,messages}`, 응답 `content[].type==='text'`)을 수용하는 한 코드 수정이 필요 없어요.
- 사내 프록시/감사 게이트웨이를 끼울 때도 동일하게 `baseUrl` 만 바꾸면 돼요.

요청·응답 스키마 자체를 바꿔야 하는(순수 OpenAI `chat/completions` 전용 등) 백엔드가 필요해지면 `src/index.mjs` 의 `callLlm()` 한 함수만 provider 분기로 확장하면 되도록 격리해 뒀어요.

## 출력 스키마

```json
{
  "ts": 1780000000,
  "status": "ok | warn | crit | error",
  "brief": "2~3문장 한국어 요약",
  "items": [{ "server": "web-1", "metric": "disk./.used_pct", "note": "한 줄 설명" }],
  "source": "llm | rule | rule-fallback",
  "raw": "(파싱 실패 시에만) LLM 원문",
  "error": "(API 실패 시에만) 오류 메시지"
}
```
