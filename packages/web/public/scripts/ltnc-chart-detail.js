// ltnc-chart-detail.js — 차트 단독 전체화면 뷰 (드래그 팬 · 구간 네비 · 달력)
// 의존: window.LTNCCharts(윈도우 모드 setView/panScale/getView) · window.LTNC · (옵션) window.ltncUnitPair
// 진입: LTNCChartDetail.open({ server, metric })  — metric 은 현재 표시 메트릭(예: disk.root.used_pct | mem.used_mb)
// 기본값(요구): 구간=일(86400) · 범위=전체(full) · 우측끝=now(라이브 새로고침)
(function () {
  'use strict';

  const RANGES = [
    { label: '연', sec: 31536000 },
    { label: '월', sec: 2592000 },
    { label: '주', sec: 604800 },
    { label: '일', sec: 86400 },
    { label: '12시간', sec: 43200 },
    { label: '3시간', sec: 10800 },
    { label: '1시간', sec: 3600 },
  ];

  let overlay = null, chart = null, refreshTimer = null, panCleanup = null, onKey = null;

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function btn(text, fn) { const b = el('button', 'ltnc_dv_btn'); b.type = 'button'; b.textContent = text; b.addEventListener('click', fn); return b; }
  function group(labelText, child) { const g = el('div', 'ltnc_dv_group'); const l = el('span', 'ltnc_dv_label'); l.textContent = labelText; g.append(l, child); return g; }

  const nowSec = () => Math.floor(Date.now() / 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  function fmtTs(ts) { const d = new Date(ts * 1000); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function toDateInput(ts) { const d = new Date(ts * 1000); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }

  function open(arg) {
    const server = arg && arg.server;
    const metric0 = arg && arg.metric;
    if (!server || !metric0 || !window.LTNCCharts || !window.LTNC) return;
    close();

    const pair = (typeof window.ltncUnitPair === 'function') ? window.ltncUnitPair(metric0) : null;
    let unit = pair ? (metric0 === pair.abs ? 'abs' : 'pct') : null;
    let rangeSec = 86400;     // 기본 일
    let scaleMode = 'full';   // 기본 전체

    const curMetric = () => pair ? (unit === 'abs' ? pair.abs : pair.pct) : metric0;
    function fullMaxFor(m) {
      if (pair && m === pair.abs) { const t = LTNC.server(server) && LTNC.server(server).latest && LTNC.server(server).latest[pair.total]; if (t && t.value > 0) return t.value; }
      return null;
    }

    // ── DOM ──
    overlay = el('div', 'ltnc_dv_overlay');
    const panel = el('div', 'ltnc_dv_panel');
    const head = el('div', 'ltnc_dv_head');
    const title = el('div', 'ltnc_dv_title');
    const ctrls = el('div', 'ltnc_dv_ctrls');
    const bClose = btn('✕', close); bClose.classList.add('ltnc_dv_close');
    head.append(title, ctrls, bClose);

    // 구간
    const gRange = el('div', 'ltnc_dv_seg');
    RANGES.forEach(r => { const b = btn(r.label, () => setRange(r.sec)); b.dataset.sec = r.sec; gRange.appendChild(b); });
    ctrls.appendChild(group('구간', gRange));
    // 범위(상대/전체)
    const gScale = el('div', 'ltnc_dv_seg');
    const bRel = btn('상대', () => setScale('auto')); const bFull = btn('전체', () => setScale('full'));
    gScale.append(bRel, bFull); ctrls.appendChild(group('범위', gScale));
    // 단위(옵션)
    let bUnit = null;
    if (pair) { const g = el('div', 'ltnc_dv_seg'); bUnit = btn('', () => { unit = unit === 'abs' ? 'pct' : 'abs'; remount(); }); g.appendChild(bUnit); ctrls.appendChild(group('단위', g)); }
    // 이동(prev/next/now)
    const gNav = el('div', 'ltnc_dv_seg');
    const bPrev = btn('◀', () => step(-1)); const bNext = btn('▶', () => step(1)); const bNow = btn('지금', () => goNow());
    gNav.append(bPrev, bNext, bNow); ctrls.appendChild(group('이동', gNav));
    // 날짜
    const cal = el('input', 'ltnc_dv_cal'); cal.type = 'date';
    cal.addEventListener('change', () => { if (cal.value) jumpDate(cal.value); });
    ctrls.appendChild(group('날짜', cal));

    const chartWrap = el('div', 'ltnc_dv_chart');
    const foot = el('div', 'ltnc_dv_foot');
    panel.append(head, chartWrap, foot);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ── 차트(윈도우 모드, 기본 일·전체·끝=now) ──
    const n0 = nowSec();
    chart = LTNCCharts.create(chartWrap, {
      server: server, metric: curMetric(), live: false,
      viewFrom: n0 - rangeSec, viewTo: n0,
      scaleMode: scaleMode, fullMax: fullMaxFor(curMetric()),
      fullMin: window.ltncFullScaleFloor ? window.ltncFullScaleFloor(curMetric()) : null, thresholdBands: window.ltncThresholdBands ? window.ltncThresholdBands(curMetric()) : null,
      height: Math.max(chartWrap.clientHeight || 0, 300),
    });

    function setRange(sec) { rangeSec = sec; const v = chart.getView(); chart.setView(v.to - sec, v.to); sync(); }
    function setScale(m) { scaleMode = m; chart.setScaleMode(m); sync(); }
    function step(dir) { const v = chart.getView(); let to = v.to + dir * v.widthSec; const n = nowSec(); if (to > n) to = n; chart.setView(to - v.widthSec, to); sync(); }
    function goNow() { const n = nowSec(); chart.setView(n - rangeSec, n); sync(); }
    function jumpDate(s) { const d = new Date(s + 'T23:59:59'); let to = Math.floor(d.getTime() / 1000); const n = nowSec(); if (to > n) to = n; chart.setView(to - rangeSec, to); sync(); }
    function remount() {
      const v = chart.getView();
      chart.destroy();
      chart = LTNCCharts.create(chartWrap, { server: server, metric: curMetric(), live: false, viewFrom: v.from, viewTo: v.to, scaleMode: scaleMode, fullMax: fullMaxFor(curMetric()), fullMin: window.ltncFullScaleFloor ? window.ltncFullScaleFloor(curMetric()) : null, thresholdBands: window.ltncThresholdBands ? window.ltncThresholdBands(curMetric()) : null, height: Math.max(chartWrap.clientHeight || 0, 300) });
      sync();
    }
    function sync() {
      const lab = LTNC.label(curMetric());
      title.textContent = server + ' · ' + lab.name + (lab.unit ? ' (' + lab.unit + ')' : '');
      gRange.querySelectorAll('button').forEach(b => b.dataset.active = (+b.dataset.sec === rangeSec) ? '1' : '');
      bRel.dataset.active = scaleMode === 'auto' ? '1' : ''; bFull.dataset.active = scaleMode === 'full' ? '1' : '';
      if (bUnit) bUnit.textContent = unit === 'abs' ? pair.absLabel : '%';
      const v = chart.getView();
      bNow.dataset.active = (v.to >= v.now - 30) ? '1' : '';
      foot.textContent = fmtTs(v.from) + '  ~  ' + fmtTs(v.to) + '   ·   그래프를 좌우로 드래그해 이동';
      cal.value = toDateInput(v.to);
    }

    // ── 드래그 팬 (chartWrap 전체에서 잡음; 현재 chart 클로저 참조 — remount 후에도 유효) ──
    let dragging = false, startX = 0, sv = null, pend = null;
    const cx = (e) => (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
    function down(e) { dragging = true; startX = cx(e); sv = chart.getView(); document.body.classList.add('ltnc_dv_grabbing'); }
    function move(e) {
      if (!dragging) return;
      const dx = cx(e) - startX, px = chart.plotPxWidth();
      const dt = Math.round(dx * (sv.widthSec / px));     // 오른쪽 드래그(dx>0) → 과거로 이동(to 감소)
      const n = nowSec(); let to = sv.to - dt; if (to > n) to = n; const from = to - sv.widthSec;
      pend = [from, to]; chart.panScale(from, to);
      if (e.cancelable) e.preventDefault();
    }
    function up() { if (!dragging) return; dragging = false; document.body.classList.remove('ltnc_dv_grabbing'); if (pend) { chart.setView(pend[0], pend[1]); pend = null; setTimeout(sync, 60); } }
    chartWrap.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    chartWrap.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', up);
    const onResize = () => { if (chart) chart.setHeight(Math.max(chartWrap.clientHeight || 0, 300)); };
    window.addEventListener('resize', onResize);
    panCleanup = () => {
      chartWrap.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      chartWrap.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up);
      window.removeEventListener('resize', onResize);
    };

    sync();
    // 우측끝이 now 면 10초마다 따라가기(라이브)
    refreshTimer = setInterval(() => { const v = chart.getView(); if (v.to >= v.now - 30) goNow(); }, 10000);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
  }

  function close() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    if (panCleanup) { try { panCleanup(); } catch {} panCleanup = null; }
    if (chart) { try { chart.destroy(); } catch {} chart = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.classList.remove('ltnc_dv_grabbing');
  }

  window.LTNCChartDetail = { open: open, close: close };
})();
