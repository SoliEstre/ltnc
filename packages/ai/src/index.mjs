// index.mjs — @ltnc/ai: AI 상황 다이제스트 엔진
// 구조 = 2단계: ① 이상 선별(plain code — LLM 호출 전 비용 절감 필터) ② LLM 한국어 다이제스트(Anthropic Messages API 직접 fetch)
// 계약: packages/web/CONTRACT.md "M2 확장 계약 — Lane AI" 절. hub 가 import 해서 사용.
//   createDigest({store, cfg, broadcast}) → { run(), latest(), status(), intervalSec }
// 안전 원칙: API 키가 없으면 status()='disabled' 로 조용히 비활성(run() no-op) — 절대 크래시 금지.
import fs from 'node:fs';
import path from 'node:path';

// ---- 기본값 ----
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';   // OpenAI-호환 게이트웨이 등은 cfg.ai.baseUrl 로 덮어쓰기
const DEFAULT_INTERVAL_SEC = 900;                        // 주기 실행은 hub 책임 — 여기선 해석된 값만 노출
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 600;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CANDIDATE_ITEMS = 40;                          // 프롬프트 폭주 방지 상한

// 급변(스파이크) 탐지 대상 핵심 지표 (CONTRACT: cpu.pct·mem.used_pct·disk*·net*)
const SPIKE_METRIC_RE = /^(cpu\.pct$|mem\.used_pct$|disk\.|net\.)/;

// ---- 임계 룰 (CONTRACT M2 "알림 룰" 기본 세트와 동일한 판정 기준) ----
// 평가 입력: (metric 이름, 최신 value) → {severity, note} | null
function evalThreshold(metric, value) {
  // 디스크 사용률: disk.<mount>.used_pct ≥85 warn / ≥93 crit
  if (/^disk\..*\.used_pct$/.test(metric)) {
    if (value >= 93) return { severity: 'crit', note: `디스크 사용률 ${value.toFixed(1)}% (치명 임계 93% 초과)` };
    if (value >= 85) return { severity: 'warn', note: `디스크 사용률 ${value.toFixed(1)}% (주의 임계 85% 초과)` };
    return null;
  }
  if (metric === 'cpu.pct' && value >= 90) return { severity: 'warn', note: `CPU 사용률 ${value.toFixed(1)}% (임계 90% 초과)` };
  if (metric === 'mem.used_pct' && value >= 92) return { severity: 'warn', note: `메모리 사용률 ${value.toFixed(1)}% (임계 92% 초과)` };
  // systemd 서비스/포트 다운 (1/0 지표)
  if (/^svc\..+\.active$/.test(metric) && value === 0) {
    return { severity: 'crit', note: `서비스 ${metric.slice(4, -7)} 중지 상태` };
  }
  if (/^port\..+\.open$/.test(metric) && value === 0) {
    return { severity: 'crit', note: `포트 ${metric.slice(5, -5)} 응답 없음` };
  }
  // HTTPS 인증서 잔여일
  if (metric === 'exec.cert_days_left' && value < 14) {
    return { severity: 'warn', note: `인증서 만료 ${Math.floor(value)}일 남음 (14일 미만)` };
  }
  // MySQL 복제 지연(초)
  if (metric === 'exec.mysql_replica_lag') {
    if (value > 60) return { severity: 'crit', note: `MySQL 복제 지연 ${value.toFixed(0)}초 (60초 초과)` };
    if (value > 10) return { severity: 'warn', note: `MySQL 복제 지연 ${value.toFixed(0)}초 (10초 초과)` };
    return null;
  }
  // HTTP 업타임 체크 (가상 서버 @checks 의 check.<id>.up)
  if (/^check\..+\.up$/.test(metric) && value === 0) {
    return { severity: 'crit', note: `HTTP 체크 ${metric.slice(6, -3)} 실패(다운)` };
  }
  return null;
}

// ---- 급변 탐지: 최근 1h 의 5m 롤업에서 마지막 버킷 vs 직전 버킷들 ----
// 판정: z-score > 3 (표준편차가 의미 있을 때) 또는 직전 평균 대비 2배↑(평균이 노이즈 바닥보다 클 때)
function detectSpike(points) {
  // points = [[ts, avg, min, max], ...] (agg) — avg 시계열만 사용
  if (!Array.isArray(points) || points.length < 5) return null; // 표본 부족 → 판단 보류
  const avgs = points.map(p => Number(p[1])).filter(Number.isFinite);
  if (avgs.length < 5) return null;
  const last = avgs[avgs.length - 1];
  const prior = avgs.slice(0, -1);
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const variance = prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length;
  const std = Math.sqrt(variance);
  // 거의 평평한 시계열의 미세 std 로 인한 오탐 방지: std 하한 0.5
  if (std > 0.5) {
    const z = (last - mean) / std;
    if (z > 3) return { kind: 'z-score', z: Number(z.toFixed(1)), last, mean: Number(mean.toFixed(1)) };
  }
  // 2배 급증: 바닥 노이즈(평균 5 미만) 제외
  if (mean >= 5 && last >= mean * 2) {
    return { kind: 'x2', last, mean: Number(mean.toFixed(1)) };
  }
  return null;
}

// ---- 응답 JSON 파싱 (코드펜스/잡텍스트 방어) ----
function parseLlmJson(text) {
  let t = String(text).trim();
  // ```json ... ``` 또는 ``` ... ``` 코드펜스 제거
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) t = fence[1].trim();
  // 그래도 잡텍스트가 섞이면 첫 '{' ~ 마지막 '}' 구간만 시도
  if (!t.startsWith('{')) {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
  }
  const obj = JSON.parse(t); // 실패 시 throw → 호출부에서 status 'error' 처리
  if (typeof obj !== 'object' || obj === null) throw new Error('JSON 루트가 객체가 아님');
  const status = ['ok', 'warn', 'crit'].includes(obj.status) ? obj.status : 'warn';
  return {
    status,
    brief: typeof obj.brief === 'string' ? obj.brief : '',
    items: Array.isArray(obj.items)
      ? obj.items.filter(i => i && typeof i === 'object').map(i => ({
          server: String(i.server ?? ''), metric: String(i.metric ?? ''), note: String(i.note ?? ''),
        }))
      : [],
  };
}

const SYSTEM_PROMPT = [
  '당신은 서버 인프라 모니터링 분석가입니다.',
  '입력으로 서버별 최신 지표 표와 사전 선별된 이상 후보 목록(JSON)이 주어집니다.',
  '반드시 아래 JSON 형식 단일 객체로만 응답하세요. 코드펜스·마크다운·설명 텍스트를 추가하지 마세요.',
  '{"status":"ok|warn|crit","brief":"...","items":[{"server":"...","metric":"...","note":"..."}]}',
  '- status: 전체 심각도 판정 (정상=ok, 주의 필요=warn, 즉시 대응 필요=crit)',
  '- brief: 비전문가도 이해할 수 있는 2~3문장 한국어 상황 요약 (존댓말)',
  '- items: 주목할 항목별 {server, metric, note(한 줄 한국어 설명)} — 이상이 없으면 빈 배열',
  '- 이상 후보를 그대로 복사하지 말고, 연관된 항목은 묶어서 원인 가설과 함께 설명하세요.',
].join('\n');

/**
 * AI 다이제스트 엔진 생성.
 * @param {object} deps
 * @param {object} deps.store      hub storage (servers()/latestByServer()/queryRange())
 * @param {object} deps.cfg        hub config (cfg.ai.{apiKey,model,baseUrl,intervalSec,alwaysLlm}, cfg.dataDir, cfg.offlineAfterSec)
 * @param {function} [deps.broadcast] WS /live 브로드캐스트 — run() 완료 시 {t:'digest', digest} 전파
 * @returns {{run: function, latest: function, status: function, intervalSec: number}}
 */
export function createDigest({ store, cfg, broadcast }) {
  const ai = (cfg && cfg.ai) || {};
  const apiKey = () => ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const persistPath = path.join((cfg && cfg.dataDir) || './data', 'digest-latest.json');
  const offlineAfterSec = (cfg && cfg.offlineAfterSec) || 90;
  const intervalSec = Number(ai.intervalSec) > 0 ? Number(ai.intervalSec) : DEFAULT_INTERVAL_SEC;

  let latestDigest = null;   // {ts, status, brief, items, ...}
  let running = false;

  // ---- 재기동 복원: data/digest-latest.json ----
  try {
    if (fs.existsSync(persistPath)) {
      const restored = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      if (restored && typeof restored === 'object' && restored.ts) latestDigest = restored;
    }
  } catch (e) {
    console.error('[ai] digest-latest.json 복원 실패(무시):', e.message);
  }

  function persist(digest) {
    try {
      fs.writeFileSync(persistPath, JSON.stringify(digest, null, 2));
    } catch (e) {
      console.error('[ai] digest 영속 실패(무시):', e.message);
    }
  }

  // ---- ① 이상 선별 (plain code — LLM 전 단계) ----
  function screen(now) {
    const candidates = [];   // [{server, metric, severity, value, note}]
    const snapshot = [];     // 프롬프트용 서버별 최신값 요약
    let servers = [];
    try { servers = store.servers(); } catch (e) { console.error('[ai] store.servers() 실패:', e.message); }

    for (const s of servers) {
      const id = s.agent;                       // 외부 노출 id = agent 명 (hub serverList 와 동일 규약)
      const isVirtual = id.startsWith('@');     // 가상 서버(@checks)는 접속/오프라인 개념 없음
      const online = isVirtual || (now - Number(s.last_seen)) < offlineAfterSec;
      let latest = {};
      try { latest = store.latestByServer(s.id) || {}; } catch (e) { console.error(`[ai] latestByServer(${id}) 실패:`, e.message); }

      // 프롬프트용 스냅샷(핵심 지표만 — 토큰 절약)
      const snap = { server: id, online };
      for (const [m, v] of Object.entries(latest)) {
        if (/^(cpu\.pct$|load\.1m$|mem\.used_pct$|disk\..*\.used_pct$|net\.|svc\.|port\.|exec\.|check\.)/.test(m)) {
          snap[m] = typeof v.value === 'number' ? Number(v.value.toFixed(1)) : v.value;
        }
      }
      snapshot.push(snap);

      // 오프라인 = crit (가상 서버 제외)
      if (!online) {
        candidates.push({ server: id, metric: 'offline', severity: 'crit', value: Number(s.last_seen), note: `서버 오프라인 — 마지막 수신 ${new Date(Number(s.last_seen) * 1000).toLocaleString('ko-KR')}` });
        continue; // 오프라인이면 최신값은 낡은 데이터 — 임계/급변 판정 생략
      }

      for (const [metric, { value }] of Object.entries(latest)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        // (a) 임계 초과 / 서비스·포트 다운
        const hit = evalThreshold(metric, value);
        if (hit) candidates.push({ server: id, metric, severity: hit.severity, value, note: hit.note });
        // (b) 급변: 최근 1h 의 5m 롤업 (핵심 지표만)
        if (SPIKE_METRIC_RE.test(metric)) {
          try {
            const { points } = store.queryRange(s.id, metric, now - 3600, now, '5m');
            const spike = detectSpike(points);
            if (spike) {
              candidates.push({
                server: id, metric, severity: 'warn', value,
                note: spike.kind === 'z-score'
                  ? `급변 감지: 직전 1시간 평균 ${spike.mean} → 최근 ${spike.last} (z=${spike.z})`
                  : `급증 감지: 직전 1시간 평균 ${spike.mean} → 최근 ${spike.last} (2배 이상)`,
              });
            }
          } catch (e) { console.error(`[ai] queryRange(${id},${metric}) 실패:`, e.message); }
        }
      }
    }

    // 동일 (server,metric) 중복 제거 — 심각도 높은 항목 우선
    const rank = { crit: 2, warn: 1 };
    const dedup = new Map();
    for (const c of candidates) {
      const key = c.server + '\0' + c.metric;
      const prev = dedup.get(key);
      if (!prev || rank[c.severity] > rank[prev.severity]) dedup.set(key, c);
    }
    const items = [...dedup.values()]
      .sort((a, b) => rank[b.severity] - rank[a.severity])
      .slice(0, MAX_CANDIDATE_ITEMS);
    return { items, snapshot, serverCount: servers.length };
  }

  // ---- ② LLM 다이제스트 (Anthropic Messages API 직접 fetch) ----
  async function callLlm(screened) {
    const url = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/v1/messages';
    const userPrompt = [
      '## 서버별 최신 지표 스냅샷',
      JSON.stringify(screened.snapshot),
      '',
      '## 사전 선별된 이상 후보 (plain-code 임계/급변/오프라인 판정 결과)',
      screened.items.length ? JSON.stringify(screened.items) : '(없음)',
    ].join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res, raw;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey(),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: ai.model || DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      raw = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`API ${res.status}: ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw);
    if (data.stop_reason === 'refusal') throw new Error('모델이 요청을 거부했어요 (stop_reason=refusal)');
    const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text') : null;
    if (!textBlock || !textBlock.text) throw new Error('응답에 text 블록이 없어요');
    return textBlock.text;
  }

  // ---- 실행 1회: 선별 → (필요 시) LLM → latest 갱신 + 영속 + 브로드캐스트 ----
  async function run() {
    if (!apiKey()) return null;          // disabled — 안전 no-op (크래시 금지)
    if (running) return latestDigest;    // 중복 실행 가드
    running = true;
    const now = Math.floor(Date.now() / 1000);
    let digest;
    try {
      const screened = screen(now);

      if (screened.items.length === 0 && !ai.alwaysLlm) {
        // 이상 0건 → LLM 호출 생략(비용 절감), 정형문 다이제스트
        digest = {
          ts: now,
          status: 'ok',
          brief: `모니터링 중인 서버 ${screened.serverCount}대에서 이상 징후가 발견되지 않았어요. CPU·메모리·디스크·서비스·포트 모두 정상 범위예요.`,
          items: [],
          source: 'rule',              // LLM 미사용 표시
        };
      } else {
        try {
          const text = await callLlm(screened);
          try {
            const parsed = parseLlmJson(text);
            digest = { ts: now, ...parsed, source: 'llm' };
          } catch (parseErr) {
            // JSON 파싱 실패 → status 'error' + 원문 보존 (계약)
            digest = {
              ts: now, status: 'error',
              brief: 'AI 응답을 JSON 으로 해석하지 못했어요. 원문을 raw 필드에 보존했어요.',
              items: screened.items.map(({ server, metric, note }) => ({ server, metric, note })),
              raw: text, source: 'llm',
            };
          }
        } catch (apiErr) {
          // API 호출 실패 → 선별 결과만으로 폴백 다이제스트 (서비스 지속)
          const worst = screened.items.some(i => i.severity === 'crit') ? 'crit' : 'warn';
          digest = {
            ts: now, status: worst,
            brief: `AI 요약 호출에 실패해 규칙 기반 결과만 제공해요 (${apiErr.message.slice(0, 120)}). 이상 후보 ${screened.items.length}건이 감지됐어요.`,
            items: screened.items.map(({ server, metric, note }) => ({ server, metric, note })),
            error: apiErr.message, source: 'rule-fallback',
          };
        }
      }

      latestDigest = digest;
      persist(digest);
      try { if (typeof broadcast === 'function') broadcast({ t: 'digest', digest }); } catch (e) { console.error('[ai] broadcast 실패(무시):', e.message); }
      return digest;
    } catch (e) {
      // 어떤 경우에도 hub 를 크래시시키지 않음
      console.error('[ai] digest run 실패:', e);
      return latestDigest;
    } finally {
      running = false;
    }
  }

  function latest() { return latestDigest; }

  function status() {
    if (!apiKey()) return 'disabled';
    if (running) return 'running';
    return latestDigest ? latestDigest.status : 'idle';
  }

  return { run, latest, status, intervalSec };
}
