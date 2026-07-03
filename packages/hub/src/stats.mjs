// stats.mjs — LTNC "통계(statistics)" 탭 백엔드: ClickHouse 조회 (allowlist named 쿼리).
// 보안: 클라 raw SQL 불가 — name(화이트리스트) + 정제 파라미터(b/days/limit)만. hub 가 SQL 구성(H3).
// 접속: CH HTTP(clickhouse:8123, docker 내부망). read-only ltnc_reader. global fetch.
// 응답 kind: table | dist | series(추세, split 가능) | bars(카테고리 막대) | heat(그리드 히트맵).
// 추세 셀렉터 공통: 일/주/월/분기/년(b=d/w/m/q/y).
// config.stats = { enabled, url, db, user, pass, timeoutSec }.
//
// ── 예시 스키마 (배포처마다 교체) ──────────────────────────────────────────────
//   아래 QUERIES 는 하나의 GENERIC 예시 테이블 `events` 를 대상으로 각 응답 kind 를
//   한 번씩 시연하는 레퍼런스 쿼리셋이다. 실제 배포에서는 이 스키마·쿼리를 자기
//   데이터 웨어하우스에 맞게 통째로 교체한다(프레임워크·헬퍼는 그대로 재사용).
//
//   analytics.events (예시 정의):
//     ts          DateTime   — 이벤트 발생 시각
//     user_id     String     — 행위 주체 식별자
//     event_type  String     — 이벤트 종류(예: view/click/signup/purchase)
//     value       Float64    — 수치 페이로드(예: 소요시간·금액 등)
//     path        String     — 요청/화면 경로
//     status      String     — 처리 결과(예: ok/error)
// ────────────────────────────────────────────────────────────────────────────

export function createStatsModule({ cfg, log = console }) {
  const sc = cfg.stats || {};
  const enabled = !!sc.enabled;
  const url = (sc.url || 'http://clickhouse:8123').replace(/\/+$/, '');
  const db = sc.db || 'analytics';
  const user = sc.user || 'ltnc_reader';
  const pass = sc.pass || '';
  const timeoutMs = (Number(sc.timeoutSec) || 30) * 1000;

  async function ch(sql) {
    const res = await fetch(`${url}/?database=${encodeURIComponent(db)}&default_format=JSON`, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': pass, 'content-type': 'text/plain; charset=utf-8' },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`CH ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).data || [];
  }

  // ── 파라미터/헬퍼 ──
  // 공통 버킷: 일/주(월요일)/월/분기/년 — 모든 추세 공통 셀렉터. col 에 적용해 버킷 시작 Date 반환.
  const bucketExpr = (p, col) => {
    const b = { d: 1, w: 1, m: 1, q: 1, y: 1 }[p.get('b')] ? p.get('b') : 'm';
    if (b === 'd') return `toDate(${col})`;
    if (b === 'w') return `toStartOfWeek(${col}, 1)`;
    return `${ { m: 'toStartOfMonth', q: 'toStartOfQuarter', y: 'toStartOfYear' }[b] }(${col})`;
  };
  const clampLimit = (p, def = 12, max = 50) => Math.min(Math.max(Number(p.get('limit')) || def, 1), max);
  const N = (v) => Number(v) || 0;
  // 추세 구간(일수) — days 파라미터(0=전체). 소스행 필터(col) / 결과버킷 필터(t) 두 형태.
  const rangeDays = (p) => { const n = Math.floor(Number(p.get('days')) || 0); return (n > 0 && n <= 4000) ? n : 0; };
  const srcSince = (p, col, pre = 'AND') => { const dd = rangeDays(p); return dd ? ` ${pre} ${col} >= today() - ${dd} ` : ''; };

  // 응답 빌더
  const table = (title, columns, rows, numCols) => ({ title, kind: 'table', columns, rows, numCols });
  const dist = (title, items, total) => ({ title, kind: 'dist', total, items });
  const series = (title, ser, opt = {}) => ({ title, kind: 'series', unit: opt.unit || '', split: !!opt.split, xunit: opt.xunit || '', series: ser });
  const bars = (title, categories, ser, opt = {}) => ({ title, kind: 'bars', categories, split: opt.split !== false, series: ser, unit: opt.unit || '' });
  const heat = (title, xcats, ycats, values) => ({ title, kind: 'heat', xcats, ycats, values });   // values[y][x]

  // (k,t,v) 행 → series[] 피벗 (top N by 합계, 내림차순)
  function pivotSeries(rows, topN) {
    const byKey = new Map();
    for (const r of rows) {
      const k = String(r.k);
      if (!byKey.has(k)) byKey.set(k, { name: k, points: [], _sum: 0 });
      const s = byKey.get(k);
      s.points.push([N(r.t), N(r.v)]);
      s._sum += N(r.v);
    }
    let arr = [...byKey.values()].sort((a, b) => b._sum - a._sum);
    if (topN) arr = arr.slice(0, topN);
    arr.forEach(s => delete s._sum);
    return arr;
  }

  // 요일 카테고리(월=1 … 일=7) — bars/heat x축 라벨
  const DOW_CATS = ['월', '화', '수', '목', '금', '토', '일'];

  // ── allowlist named 예시 쿼리 (kind 별 1종 이상 시연 — 배포처마다 교체) ──
  const QUERIES = {
    // [table] 오늘 이벤트 유형별 요약
    'events_today': async (p) => {
      const d = await ch(`SELECT event_type, count() cnt, round(avg(value), 2) avg_value
        FROM ${db}.events WHERE ts >= today() GROUP BY event_type ORDER BY cnt DESC LIMIT ${clampLimit(p, 20, 100)}`);
      return table('오늘의 이벤트 요약', ['이벤트 유형', '건수', '평균 값'],
        d.map(r => [r.event_type || '(미상)', N(r.cnt), N(r.avg_value)]), [1, 2]);
    },

    // [dist] 이벤트 유형 분포
    'event_type_dist': async (p) => {
      const dd = rangeDays(p) || 30;
      const d = await ch(`SELECT event_type k, count() c FROM ${db}.events
        WHERE ts >= today() - ${dd} GROUP BY k ORDER BY c DESC LIMIT ${clampLimit(p, 20, 100)}`);
      const total = d.reduce((s, r) => s + N(r.c), 0);
      return dist(`이벤트 유형 분포 (최근 ${dd}일)`,
        d.map(r => ({ key: r.k || '(미상)', cnt: N(r.c), pct: total ? Math.round(N(r.c) * 1000 / total) / 10 : 0 })), total);
    },

    // [dist] 처리 결과(status) 분포
    'status_dist': async (p) => {
      const dd = rangeDays(p) || 30;
      const d = await ch(`SELECT status k, count() c FROM ${db}.events
        WHERE ts >= today() - ${dd} GROUP BY k ORDER BY c DESC`);
      const total = d.reduce((s, r) => s + N(r.c), 0);
      return dist(`상태 분포 (최근 ${dd}일)`,
        d.map(r => ({ key: r.k || '(미상)', cnt: N(r.c), pct: total ? Math.round(N(r.c) * 1000 / total) / 10 : 0 })), total);
    },

    // [dist] 경로 Top
    'top_paths': async (p) => {
      const dd = rangeDays(p) || 30;
      const d = await ch(`SELECT path k, count() c FROM ${db}.events
        WHERE ts >= today() - ${dd} GROUP BY k ORDER BY c DESC LIMIT ${clampLimit(p, 15, 100)}`);
      const total = d.reduce((s, r) => s + N(r.c), 0);
      return dist(`경로 Top (최근 ${dd}일)`,
        d.map(r => ({ key: r.k || '(없음)', cnt: N(r.c), pct: total ? Math.round(N(r.c) * 1000 / total) / 10 : 0 })), total);
    },

    // [series] 이벤트 수 추세 (공통 버킷 b + 구간 days)
    'events_trend': async (p) => {
      const bk = bucketExpr(p, 'ts');
      const d = await ch(`SELECT toUnixTimestamp(${bk}) t, count() c FROM ${db}.events
        WHERE 1 ${srcSince(p, 'ts')} GROUP BY t ORDER BY t`);
      return series('이벤트 추세', [{ name: '이벤트 수', points: d.map(r => [N(r.t), N(r.c)]) }]);
    },

    // [series] 활성 사용자(순 user_id) 추세
    'active_users_trend': async (p) => {
      const bk = bucketExpr(p, 'ts');
      const d = await ch(`SELECT toUnixTimestamp(${bk}) t, uniqExact(user_id) v FROM ${db}.events
        WHERE 1 ${srcSince(p, 'ts')} GROUP BY t ORDER BY t`);
      return series('활성 사용자 추세', [{ name: '순 사용자', points: d.map(r => [N(r.t), N(r.v)]) }]);
    },

    // [series·split] 이벤트 유형별 추세 (pivotSeries 로 top N 분리)
    'events_by_type_trend': async (p) => {
      const bk = bucketExpr(p, 'ts');
      const d = await ch(`SELECT event_type k, toUnixTimestamp(${bk}) t, count() v FROM ${db}.events
        WHERE 1 ${srcSince(p, 'ts')} GROUP BY k, t ORDER BY t`);
      return series('유형별 이벤트 추세', pivotSeries(d, clampLimit(p, 8)), { split: true });
    },

    // [bars] 요일별 활동 (카테고리 막대, 지표별 시리즈)
    'dow_bars': async () => {
      const d = await ch(`SELECT toDayOfWeek(ts) dow, count() cnt, uniqExact(user_id) users
        FROM ${db}.events GROUP BY dow ORDER BY dow`);
      const idx = new Map(d.map(r => [N(r.dow), r]));   // dow 1=월 … 7=일
      const ser = [
        { name: '이벤트 수', values: DOW_CATS.map((_, i) => N(idx.get(i + 1)?.cnt)) },
        { name: '활성 사용자', values: DOW_CATS.map((_, i) => N(idx.get(i + 1)?.users)) },
      ];
      return bars('요일별 활동', DOW_CATS, ser);
    },

    // [heat] 시간대 × 요일 이벤트 히트맵 (values[y=시][x=요일])
    'hourly_heatmap': async () => {
      const d = await ch(`SELECT toDayOfWeek(ts) wd, toHour(ts) h, count() v FROM ${db}.events GROUP BY wd, h`);
      const values = Array.from({ length: 24 }, () => Array(7).fill(0));
      for (const r of d) values[N(r.h)][N(r.wd) - 1] = N(r.v);
      return heat('시간대 × 요일 이벤트 히트맵', DOW_CATS, Array.from({ length: 24 }, (_, h) => `${h}시`), values);
    },
  };

  async function query(name, params) {
    const fn = QUERIES[name];
    if (!fn) return null;
    return fn(params || new URLSearchParams());
  }

  if (enabled) log.log(`[stats] 통계 API 활성 — CH ${url}/${db} (${Object.keys(QUERIES).length} queries)`);
  else log.log('[stats] 통계 API 비활성 (config.stats.enabled 미설정)');

  return { enabled, query, names: () => Object.keys(QUERIES) };
}
