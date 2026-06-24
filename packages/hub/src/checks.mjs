// checks.mjs — HTTP(S) 업타임 체크러너 → 가상 서버 '@checks' 메트릭 적재
// M2 계약: config checks[{id,url,method?,keyword?,intervalSec?,timeoutSec?}] 주기 실행(기본 60s, 타임아웃 10s),
//          결과 = check.<id>.up(1/0) · check.<id>.ms(응답시간) — 기존 storage/차트 파이프라인 그대로 재사용.
// ingest 콜백은 server.mjs 의 ingestVirtual 로 결선 → upsert('@checks') + insertBatch + WS metrics 브로드캐스트
// + 알림 룰(check.*.up==0 crit) 평가까지 기존 경로로 자동 수행.

export function createCheckRunner({ cfg, ingest, log = console }) {
  const checks = (Array.isArray(cfg.checks) ? cfg.checks : []).filter((c) => c && c.id && c.url);
  const status = new Map(); // id -> 최신 결과 (GET /api/checks 용)
  const timers = [];

  /** 체크 1건 실행 → 결과 기록 + 메트릭 적재 */
  async function runOne(c) {
    const t0 = Date.now();
    let up = 0, ms = 0, error = '';
    try {
      const res = await fetch(c.url, {
        method: c.method || 'GET',
        redirect: 'follow',
        headers: { 'user-agent': 'LTNC-check/1.0' },
        signal: AbortSignal.timeout((Number(c.timeoutSec) || 10) * 1000),
      });
      ms = Date.now() - t0;
      up = res.ok ? 1 : 0;
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        await res.body?.cancel?.();
      } else if (c.keyword) {
        const body = await res.text(); // keyword 본문 매칭
        if (!body.includes(c.keyword)) { up = 0; error = `키워드 '${c.keyword}' 미발견`; }
      } else {
        await res.body?.cancel?.();
      }
    } catch (e) {
      ms = Date.now() - t0;
      error = e?.name === 'TimeoutError' ? '타임아웃' : String(e?.cause?.message || e?.message || e);
    }
    const ts = Math.floor(Date.now() / 1000);
    status.set(c.id, { id: c.id, url: c.url, up, ms, ts, error: up ? '' : error });
    try {
      ingest(ts, { [`check.${c.id}.up`]: up, [`check.${c.id}.ms`]: ms });
    } catch (e) {
      log.error('[checks] 적재 실패:', e?.message || e);
    }
  }

  /** 전체 체크 기동 — 간격 내 위상 분산(de-phase) 후 각자 주기 반복.
   *  종전엔 6건을 한 틱에 동시 발사 → 허브 루프가 잠깐 멈추면 6건이 같은 타임스탬프에 똑같이 튐(가짜 동기화).
   *  첫 발사를 간격 등분으로 흩뿌리면, '한 서버만 스파이크'(그 서버 실장애)와 '전역 스파이크'(허브 루프 멈춤)를 구분 가능. */
  function start() {
    const n = Math.max(1, checks.length);
    checks.forEach((c, i) => {
      const iv = (Number(c.intervalSec) || 60) * 1000;
      const offset = Math.round((i / n) * iv); // 간격을 체크 수로 등분해 첫 발사 분산
      const kick = setTimeout(() => {
        runOne(c).catch((e) => log.error('[checks]', e?.message || e));
        const t = setInterval(() => runOne(c).catch((e) => log.error('[checks]', e?.message || e)), iv);
        t.unref();
        timers.push(t);
      }, offset);
      kick.unref();
      timers.push(kick);
    });
    if (checks.length) log.log(`[checks] 외부 HTTP 체크 ${checks.length}건 가동 (위상 분산, 가상 서버 '@checks')`);
  }

  return {
    start,
    stop: () => timers.forEach(clearInterval),
    status: () => [...status.values()],
  };
}
