// ltnc-charts.js — LTNC 시계열 차트 모듈 (Lane C)
// 비모듈 전역(window.LTNCCharts) — uPlot(window.uPlot) + 데이터 코어(window.LTNC)만 의존.
// 계약 = packages/web/CONTRACT.md Lane C 절:
//   LTNCCharts.create(el, {server, metric, rangeSec=3600, height=180}) → {destroy(), setRange(sec), el}
//   - 초기 로드: LTNC.range(..., 'auto') — raw 면 단일 라인, 5m/1h(agg) 면 avg 라인 + min/max 음영 밴드
//   - 라이브: raw 해상도일 때만 LTNC.on('metrics') append + rangeSec 슬라이딩 창,
//             agg 해상도면 60초 주기 재조회(집계 버킷은 완결 단위로만 갱신되므로 append 불가)
//   - ResizeObserver 반응형, 다크 테마, 시간축 HH:MM / MM-DD 한국어 포맷, 단위 = LTNC.label(metric)
(function () {
  'use strict';

  // ── 테마 토큰 (CSS --ltnc-* 라이브 조회 — EstreUI 라이트/다크 설정 자동 추종) ──
  // CONTRACT.md 공통 토큰과 동일 팔레트. 캔버스(uPlot)는 color-mix() 미지원 엔진 호환 위해
  // 토큰 hex 를 rgba 로 변환해 쓰고, 레전드/빈안내(HTML)는 CSS var 로 직접 추종(ensureCss).
  function _toRgb(c) {
    c = String(c || '').trim();
    var m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) { var h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]; }
    m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { var x = m[1]; return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]; }
    m = /rgba?\(([^)]+)\)/i.exec(c);
    if (m) { var p = m[1].split(',').map(function (s) { return parseFloat(s); }); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
    return null;
  }
  function _rgba(c, a) { var t = _toRgb(c); return t ? 'rgba(' + t[0] + ',' + t[1] + ',' + t[2] + ',' + a + ')' : c; }
  function readThemeTokens() {
    var cs = getComputedStyle(document.body);
    var v = function (n, f) { var g = cs.getPropertyValue(n); return (g && g.trim()) || f; };
    var dim = v('--ltnc-dim', '#9aa0a6');
    var accent = v('--ltnc-accent', '#ff9500');
    return {
      text: v('--ltnc-text', '#e8eaed'),
      dim:  dim,                      // 축 라벨
      grid: _rgba(dim, 0.14),         // 그리드(dim 저투명)
      tick: _rgba(dim, 0.30),
      line: accent,                   // 시리즈 라인(오렌지)
      band: _rgba(accent, 0.16),      // min/max 음영 밴드
      edge: _rgba(accent, 0.45),      // min/max 경계선(흐리게)
    };
  }
  let C = readThemeTokens();

  // ── 다크모드 전환(body[data-dark-mode] 토글/OS 변경) 시 캔버스 팔레트 라이브 재적용 ──
  const _liveCharts = new Set();
  function _onThemeChange() {
    C = readThemeTokens();
    _liveCharts.forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-dark-mode') { _onThemeChange(); break; }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-dark-mode'] });
  }

  const CSS_HREF = '/vendor/uplot/uPlot.min.css';
  const AGG_REFRESH_MS = 60_000;         // agg 해상도 재조회 주기(60초)

  // ── uPlot CSS 동적 로드 (중복 삽입 가드) ──
  function ensureCss() {
    if (document.querySelector('link[data-ltnc-uplot]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-ltnc-uplot', '1');
    document.head.appendChild(link);
    // 레전드/빈안내 텍스트 색 = CSS 토큰 직접 참조 → 라이트/다크 자동 추종(재주입 불필요)
    const style = document.createElement('style');
    style.setAttribute('data-ltnc-uplot', '1');
    style.textContent =
      '.u-legend { color: var(--ltnc-dim, #9aa0a6); font-size: 11px; }' +
      '.u-legend .u-value { color: var(--ltnc-text, #e8eaed); }' +
      '.ltnc-chart-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;' +
      ' color: var(--ltnc-dim, #9aa0a6); font-size:13px; pointer-events:none; }';
    document.head.appendChild(style);
  }

  // ── 시간축 한국어 포맷: 범위 2일 미만 = HH:MM, 이상 = MM-DD (자정 눈금엔 MM-DD 병기) ──
  function makeTimeFormatter(getRangeSec) {
    const p2 = (n) => String(n).padStart(2, '0');
    return (u, splits) => splits.map((ts) => {
      if (ts == null) return '';
      const d = new Date(ts * 1000);
      if (getRangeSec() >= 172800) return p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
      // 자정 경계는 날짜를 병기해 일 구분을 표시
      return (d.getHours() === 0 && d.getMinutes() === 0)
        ? p2(d.getMonth() + 1) + '-' + p2(d.getDate())
        : hm;
    });
  }

  // ── 호버 범례용 시각 포맷: 24시간제 + 고정폭(MM-DD HH:MM:SS) — 값 폭 변동에도 흔들리지 않게 ──
  function fmtLegendTime(ts) {
    if (ts == null) return '';
    const d = new Date(ts * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
           p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  // ── 차트 인스턴스 생성 ──
  function create(el, opts) {
    if (!el) throw new Error('[LTNCCharts] 대상 엘리먼트가 필요해요');
    if (!window.uPlot) throw new Error('[LTNCCharts] uPlot 이 로드되지 않았어요 (/vendor/uplot/uPlot.iife.min.js 선행 필요)');
    if (!window.LTNC) throw new Error('[LTNCCharts] LTNC 데이터 코어가 로드되지 않았어요 (/scripts/ltnc-client.js 선행 필요)');
    ensureCss();

    const server = opts && opts.server;
    const metric = opts && opts.metric;
    let rangeSec = (opts && opts.rangeSec) || 3600;
    let height = (opts && opts.height) || 180;
    let scaleMode = (opts && opts.scaleMode) === 'full' ? 'full' : 'auto';  // auto=상대(데이터 추종) / full=전체(0~최대)
    let fullMax = (opts && Number(opts.fullMax) > 0) ? Number(opts.fullMax) : null;  // full 모드 고정 상한(예: 디스크 총용량 GB)
    let fullMin = (opts && Number(opts.fullMin) > 0) ? Number(opts.fullMin) : null;  // full 모드 상한의 '바닥'(floor) — 초과 시 데이터 따라 성장(예: 네트워크 100Mbps)
    const thresholdBands = (opts && Array.isArray(opts.thresholdBands)) ? opts.thresholdBands : null;  // Y축 등급 띠 배경(예: 외부체크 응답시간 good/fine/bad/issue/failure)
    // 윈도우 모드(단독 뷰 네비게이션): live=false 면 임의 구간 [viewFrom, viewTo] 표시(라이브 append 없음)
    let live = !(opts && opts.live === false);
    let viewFrom = (opts && Number(opts.viewFrom)) || null;
    let viewTo = (opts && Number(opts.viewTo)) || null;
    let lastFrom = 0, lastTo = 0;
    if (!server || !metric) throw new Error('[LTNCCharts] {server, metric} 옵션은 필수예요');

    const label = LTNC.label(metric);                       // {name, unit, div?, prec?} 한글 라벨
    const seriesLabel = label.name + (label.unit ? ' (' + label.unit + ')' : '');
    // 표시 단위 변환: div 있으면 데이터·상한을 표시단위로 나눠 그린다(예: 메모리 MB→GB ÷1024).
    // 데이터 자체를 변환하므로 축 눈금이 표시단위 기준 정수로 깔끔히 떨어진다(저장값은 MB 그대로).
    const vdiv = label.div || 1;
    const sv = (v) => (v == null ? v : v / vdiv);
    if (vdiv !== 1 && fullMax != null) fullMax = fullMax / vdiv;
    if (vdiv !== 1 && fullMin != null) fullMin = fullMin / vdiv;
    // 세로축 눈금에 단위 병기 여부: 작은 박스(인라인)는 false 로 단위 생략(제목에 단위 있음 → 값 잘림 방지),
    // 단독(전체화면) 뷰는 true(기본)로 단위 병기 + 자동폭. 기본 true.
    const axisUnit = !(opts && opts.axisUnit === false);
    // 임계 밴드(등급 띠) 배경 — drawClear 훅에서 plot 영역에 옅게 채움. from/to 는 데이터단위(sv 적용), to=Infinity 는 plot 상단까지.
    function drawThresholdBands(u) {
      if (!thresholdBands || !thresholdBands.length || !u.ctx || !u.bbox) return;
      const ctx = u.ctx, bb = u.bbox;
      ctx.save();
      ctx.globalAlpha = 0.11;
      for (const b of thresholdBands) {
        const lo = sv(b.from);
        const hi = (b.to == null || b.to === Infinity) ? null : sv(b.to);
        let yLo = u.valToPos(lo, 'y', true);                            // 낮은 값 = 큰 y(아래)
        let yHi = hi == null ? bb.top : u.valToPos(hi, 'y', true);      // 높은 값 = 작은 y(위); 무한대 = plot 상단
        yLo = Math.max(bb.top, Math.min(bb.top + bb.height, yLo));
        yHi = Math.max(bb.top, Math.min(bb.top + bb.height, yHi));
        const h = yLo - yHi;
        if (h <= 0.5) continue;
        ctx.fillStyle = b.fill;
        ctx.fillRect(bb.left, yHi, bb.width, h);
      }
      ctx.restore();
    }

    // 내부 상태
    let u = null;                 // uPlot 인스턴스
    let mode = 'raw';             // 'raw' | 'agg' — 초기 조회 응답의 res 로 결정
    let data = [[], []];          // raw: [ts[], v[]] / agg: [ts[], avg[], min[], max[]]
    let offMetrics = null;        // LTNC.on('metrics') 해제 함수
    let aggTimer = null;          // agg 모드 재조회 타이머
    let destroyed = false;
    let loadSeq = 0;              // 비동기 응답 경합 가드(setRange 연타 대비)

    // 빈 데이터/에러 안내 오버레이
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    let emptyMsg = null;
    function showEmpty(text) {
      if (!emptyMsg) {
        emptyMsg = document.createElement('div');
        emptyMsg.className = 'ltnc-chart-empty';
        el.appendChild(emptyMsg);
      }
      emptyMsg.textContent = text;
    }
    function hideEmpty() { if (emptyMsg) { emptyMsg.remove(); emptyMsg = null; } }

    // ── uPlot 옵션 빌드 (raw/agg 에 따라 시리즈 구성이 달라 모드 전환 시 재생성) ──
    function buildOpts(isAgg) {
      const axisCommon = {
        stroke: C.dim,
        grid: { stroke: C.grid, width: 1 },
        ticks: { stroke: C.tick, width: 1 },
        font: '11px sans-serif',
      };
      const series = [
        { value: (u2, ts) => fmtLegendTime(ts) }, // x: 호버 범례 시각(24시간 고정폭)
        { label: seriesLabel, stroke: C.line, width: 1.5, points: { show: false },
          value: (u2, v) => v == null ? '–' : fmtVal(v) },
      ];
      const bands = [];
      if (isAgg) {
        // min/max 음영 밴드: 시리즈 [x, avg, min, max] — 밴드는 max(3)→min(2) 사이를 채움
        series.push({ label: '최소', stroke: C.edge, width: 0.5, points: { show: false },
          value: (u2, v) => v == null ? '–' : fmtVal(v) });
        series.push({ label: '최대', stroke: C.edge, width: 0.5, points: { show: false },
          value: (u2, v) => v == null ? '–' : fmtVal(v) });
        bands.push({ series: [3, 2], fill: C.band });
      }
      return {
        width: Math.max(el.clientWidth || 0, 200),
        height: height,
        series: series,
        bands: bands,
        cursor: { points: { size: 6 } },
        scales: Object.assign({ x: { time: true } }, yScale()),
        axes: [
          Object.assign({}, axisCommon, { values: makeTimeFormatter(() => rangeSec) }),
          Object.assign({}, axisCommon, { size: yAxisSize,
            values: (u2, splits) => splits.map((v) => v == null ? '' : fmtAxis(v)) }),
        ],
        hooks: { drawClear: [drawThresholdBands] },   // 등급 띠 배경(있을 때만 그림)
        legend: { live: true },
      };
    }

    // ── 세로축 범위 모드 ──
    // full(전체): 최대값이 정의되는 지표는 0~최대 고정 → 화면 꽉 찬 선 = 실제 포화 (직관적 이상탐지)
    //   - % 지표(0~100) → [0, 100] · svc/port(0/1) → [0, 1] · 무한 지표(kbps 등) → [0, 데이터최대×1.05]
    // auto(상대): uPlot 기본(데이터 구간 확대) — 미세 변동 관찰용
    function yScale() {
      if (scaleMode !== 'full') return {};
      if (fullMax != null) return { y: { range: [0, fullMax] } };            // 명시 상한(디스크/메모리 총용량) 우선
      if (fullMin != null) return { y: { range: (u2, mn, mx) => [0, Math.max(fullMin, (mx || 0) * 1.05)] } };  // 바닥(floor) + 초과 시 적응형(네트워크)
      if (/(\.|_)pct$/.test(metric)) return { y: { range: (u2, mn, mx) => [0, Math.max(100, mx || 0)] } };
      if (/^(svc|port)\./.test(metric)) return { y: { range: [0, 1] } };
      return { y: { range: (u2, mn, mx) => [0, Math.max((mx || 0) * 1.05, 1)] } };
    }

    // 값 포맷 — prec 지정 메트릭은 고정 소수자리(예: 메모리 GB 2자리), 그 외 큰 수는 천 단위 구분
    // 주의: 여기 v 는 이미 표시단위(sv 적용 후)다.
    function fmtNum(v) {
      if (label.prec != null) {                       // 최대 prec 자리(후행 0 제거): toFixed 후 +로 trailing zero 정리
        const r = +v.toFixed(label.prec);
        return Math.abs(r) >= 1000 ? r.toLocaleString('ko-KR') : String(r);
      }
      return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('ko-KR')
           : Math.abs(v) >= 100 ? v.toFixed(0)
           : Math.round(v * 10) / 10;
    }
    function fmtVal(v) { return fmtNum(v) + (label.unit ? ' ' + label.unit : ''); }   // 단위 병기(레전드/툴팁/단독축)
    function fmtAxis(v) { return axisUnit ? fmtVal(v) : String(fmtNum(v)); }           // 세로축: 인라인은 단위 생략
    // 세로축 gutter 폭 = 실제 눈금 라벨 최대폭 측정(고정폭 아님) → 어떤 값/단위도 잘리지 않게 자동 확보
    function yAxisSize(self, values) {
      if (!values || !values.length || !self || !self.ctx) return axisUnit ? 60 : 44;
      self.ctx.save();
      self.ctx.font = '11px sans-serif';
      let max = 0;
      for (const s of values) { const w = self.ctx.measureText(s == null ? '' : String(s)).width; if (w > max) max = w; }
      self.ctx.restore();
      return Math.ceil(max) + 14;   // 눈금선·여백 패딩
    }

    // ── 차트 (재)구성: 모드에 맞는 uPlot 을 새로 만든다 ──
    function rebuild(isAgg) {
      if (u) { u.destroy(); u = null; }
      mode = isAgg ? 'agg' : 'raw';
      u = new uPlot(buildOpts(isAgg), data, el);
    }

    // ── 초기/재조회 로드 ──
    async function load() {
      const seq = ++loadSeq;
      const now = Math.floor(Date.now() / 1000);
      // live(트레일링): [now-range, now] · 윈도우: [viewFrom, viewTo](우측은 now 초과 금지)
      const to = live ? now : Math.min(viewTo != null ? viewTo : now, now);
      const from = live ? (to - rangeSec) : (viewFrom != null ? viewFrom : to - rangeSec);
      rangeSec = Math.max(1, to - from);
      lastFrom = from; lastTo = to;
      let res;
      try {
        res = await LTNC.range(server, metric, from, to, 'auto');
      } catch (e) {
        if (destroyed || seq !== loadSeq) return;
        console.error('[LTNCCharts] range 조회 실패', server, metric, e);
        data = [[], []];
        rebuild(false);
        showEmpty('데이터 없음 (조회 실패)');
        return;
      }
      if (destroyed || seq !== loadSeq) return;   // 그 사이 destroy/setRange 발생 → 낡은 응답 폐기

      const points = (res && res.points) || [];
      // 해상도 판별: 응답 res 필드 우선, 없으면 포인트 형태([ts,v]=raw, [ts,avg,min,max]=agg)로 추론
      const isAgg = res && res.res ? res.res !== 'raw'
                  : (points[0] ? points[0].length === 4 : rangeSec > 14 * 86400);

      if (isAgg) {
        const xs = [], avg = [], min = [], max = [];
        for (const p of points) { xs.push(p[0]); avg.push(sv(p[1])); min.push(sv(p[2])); max.push(sv(p[3])); }
        data = [xs, avg, min, max];
      } else {
        const xs = [], vs = [];
        for (const p of points) { xs.push(p[0]); vs.push(sv(p[1])); }
        data = [xs, vs];
      }
      rebuild(isAgg);
      if (!points.length) showEmpty('데이터 없음'); else hideEmpty();
      armLive();
    }

    // ── 라이브 갱신 배선 ──
    // raw: metrics 이벤트 append + 슬라이딩 창 / agg: 집계 버킷은 5분 배치로만 완결되므로
    //      실시간 append 가 불가능 → 60초마다 range 재조회로 최신 버킷을 반영한다.
    function disarmLive() {
      if (offMetrics) { offMetrics(); offMetrics = null; }
      if (aggTimer) { clearInterval(aggTimer); aggTimer = null; }
    }
    function armLive() {
      disarmLive();
      if (!live) return;          // 윈도우(과거 구간) 모드 = 라이브 갱신 없음
      if (mode === 'raw') {
        offMetrics = LTNC.on('metrics', (m) => {
          if (m.server !== server) return;
          const v = m.metrics ? m.metrics[metric] : undefined;
          if (v === undefined || typeof v !== 'number') return;
          // append (재전송 등으로 과거 ts 가 오면 정렬 깨짐 방지를 위해 무시)
          const xs = data[0], vs = data[1];
          if (xs.length && m.ts <= xs[xs.length - 1]) return;
          xs.push(m.ts); vs.push(sv(v));
          // rangeSec 슬라이딩 창 유지 — 창 밖 과거 점 제거
          const cutoff = m.ts - rangeSec;
          let drop = 0;
          while (drop < xs.length && xs[drop] < cutoff) drop++;
          if (drop) { xs.splice(0, drop); vs.splice(0, drop); }
          hideEmpty();
          if (u) u.setData(data);
        });
      } else {
        aggTimer = setInterval(() => { load().catch(() => {}); }, AGG_REFRESH_MS);
      }
    }

    // ── 반응형: 부모(el) 폭 추종 ──
    const ro = new ResizeObserver(() => {
      if (u && el.clientWidth > 0) u.setSize({ width: el.clientWidth, height: height });
    });
    ro.observe(el);

    // 다크모드 전환 시 이 차트의 캔버스 색을 현재 토큰으로 재구성(_onThemeChange 가 호출)
    const applyTheme = () => { if (!destroyed && u) rebuild(mode === 'agg'); };
    _liveCharts.add(applyTheme);

    // 최초 로드
    load().catch((e) => console.error('[LTNCCharts]', e));

    // ── 공개 핸들 ──
    return {
      el: el,
      /** 조회 범위(초) 변경 → 재조회·재렌더 (윈도우 모드면 우측끝 고정·폭만 변경) */
      setRange(sec) {
        if (destroyed || !sec || sec <= 0) return;
        rangeSec = sec;
        if (!live && viewTo != null) viewFrom = viewTo - sec;
        disarmLive();
        load().catch((e) => console.error('[LTNCCharts]', e));
      },
      /** 임의 구간 표시(단독 뷰 네비게이션) — 라이브 끔 */
      setView(fromTs, toTs) {
        if (destroyed) return;
        fromTs = Math.floor(fromTs); toTs = Math.floor(toTs);
        if (!(toTs > fromTs)) return;
        live = false; viewFrom = fromTs; viewTo = toTs; rangeSec = toTs - fromTs;
        disarmLive();
        load().catch((e) => console.error('[LTNCCharts]', e));
      },
      /** 드래그 중 표시창만 즉시 이동(재조회 없이 setScale — 들어오는 가장자리는 release 때 채움) */
      panScale(fromTs, toTs) {
        if (destroyed || !u) return;
        try { u.setScale('x', { min: fromTs, max: toTs }); } catch {}
      },
      /** 라이브(트레일링·now) 복귀 — sec 주면 폭 변경 */
      goLive(sec) {
        if (destroyed) return;
        live = true; viewFrom = null; viewTo = null;
        if (sec && sec > 0) rangeSec = sec;
        load().catch((e) => console.error('[LTNCCharts]', e));
      },
      /** 현재 표시 구간 정보 */
      getView() {
        return { from: lastFrom, to: lastTo, now: Math.floor(Date.now() / 1000), widthSec: rangeSec, live: live, mode: mode };
      },
      /** 플롯 영역 픽셀 폭(팬 픽셀→시간 환산용) */
      plotPxWidth() { return (u && u.over && u.over.clientWidth) ? u.over.clientWidth : (el.clientWidth || 1); },
      /** 세로축 범위 모드 변경('auto'=상대 | 'full'=전체) → 현재 데이터로 즉시 재렌더 */
      setScaleMode(m) {
        if (destroyed) return;
        const next = m === 'full' ? 'full' : 'auto';
        if (next === scaleMode) return;
        scaleMode = next;
        rebuild(mode === 'agg');
        armLive();
      },
      /** 차트 높이(px) 변경 → 즉시 리사이즈 */
      setHeight(px) {
        if (destroyed || !px || px <= 0) return;
        height = px;
        if (u) u.setSize({ width: Math.max(el.clientWidth || 0, 200), height: height });
      },
      /** 차트 파기: uPlot destroy + 이벤트 구독 해제 + observer 해제 */
      destroy() {
        if (destroyed) return;
        destroyed = true;
        loadSeq++;             // 진행 중인 비동기 load 응답 무효화
        disarmLive();
        ro.disconnect();
        _liveCharts.delete(applyTheme);
        if (u) { u.destroy(); u = null; }
        hideEmpty();
      },
    };
  }

  window.LTNCCharts = { create: create };
})();
