// ltnc-client.js — LTNC 대시보드 데이터 코어 (공유 계약 — 림/타일/차트 모든 lane 이 이것만 통해 데이터 접근)
// 비모듈 전역(window.LTNC) — EstreUI(classic script) · EstreUV(ES module) 양쪽에서 동일 사용.
// 프로토콜 = ltnc/docs/PROTOCOL.md (/api/servers · /api/range · WS /live init/metrics/presence)
(function () {
  'use strict';

  const listeners = new Map();    // event -> Set<fn>   (events: init·metrics·presence·connection + M2: alert·digest 등 허브 신규 t 범용 중계)
  const servers = new Map();      // id -> { id, host, tags, lastSeen, online, latest:{metric:{ts,value}} }
  let ws = null, backoff = 1000, connected = false;
  let reconnectTimer = null;      // M2: 로그인 직후 즉시 재연결을 위한 재시도 타이머 핸들

  function emit(ev, data) { (listeners.get(ev) || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[LTNC]', ev, e); } }); }

  function applyInit(list) {
    servers.clear();
    for (const s of list) servers.set(s.id, s);
    emit('init', { servers: snapshot() });
  }
  function snapshot() { return [...servers.values()]; }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/live`);
    ws.onopen = () => { backoff = 1000; connected = true; emit('connection', { connected: true }); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'init') applyInit(m.servers);
      else if (m.t === 'metrics') {
        const s = servers.get(m.server);
        if (s) {
          s.lastSeen = m.ts; s.online = true;
          for (const [k, v] of Object.entries(m.metrics)) s.latest[k] = { ts: m.ts, value: v };
        }
        emit('metrics', m);                       // { server, ts, metrics }
      } else if (m.t === 'presence') {
        const s = servers.get(m.server);
        if (s) s.online = m.online;
        emit('presence', m);                      // { server, online }
      } else if (typeof m.t === 'string') {
        emit(m.t, m);                             // M2: alert·digest 등 허브 신규 이벤트 범용 중계 (M2 계약)
      }
    };
    ws.onclose = (e) => {
      connected = false;
      // M2: 허브가 미인증 WS 를 close 4401 로 끊으면 로그인 필요 신호를 함께 전달 (M2 계약)
      emit('connection', (e && e.code === 4401) ? { connected: false, authRequired: true } : { connected: false });
      reconnectTimer = setTimeout(connect, backoff * (0.75 + Math.random() * 0.5));
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  window.LTNC = {
    /** 이벤트 구독: init({servers}) · metrics({server,ts,metrics}) · presence({server,online}) · connection({connected}) */
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
    /** 현재 서버 목록 스냅샷 (최신값 포함) */
    servers: snapshot,
    /** 단일 서버 */
    server(id) { return servers.get(id); },
    /** 시계열 조회 → {res, points} (raw=[ts,v], agg=[ts,avg,min,max]) */
    async range(server, metric, fromSec, toSec, res = 'auto') {
      const q = new URLSearchParams({ server, metric, from: fromSec, to: toSec, res });
      const r = await fetch(`/api/servers`.replace('servers', 'range') + '?' + q);
      // M2: 인증 만료(401) → 로그인 필요 신호 (connection 이벤트로 전달, M2 계약)
      if (r.status === 401) { emit('connection', { connected: false, authRequired: true }); throw new Error('range 401'); }
      if (!r.ok) throw new Error('range ' + r.status);
      return r.json();
    },
    /** REST 폴백 초기화(WS 전 첫 페인트용) */
    async refresh() {
      const r = await fetch('/api/servers');
      if (r.ok) applyInit((await r.json()).servers);
      // M2: 인증 만료(401) → 로그인 필요 신호 (M2 계약)
      else if (r.status === 401) emit('connection', { connected: false, authRequired: true });
    },
    /** M2: 로그인 성공 직후 WS 즉시 재연결 (백오프 리셋) */
    reconnect() {
      backoff = 1000;
      if (ws != null && ws.readyState !== WebSocket.CLOSED) {
        try { ws.close(); } catch {}      // onclose 가 백오프 1000ms 로 재연결 스케줄
      } else {
        clearTimeout(reconnectTimer);
        connect();
      }
    },
    get connected() { return connected; },
    /** 메트릭 표시 헬퍼 — 이름→한글 라벨/단위/포맷 */
    label(metric) {
      const L = {
        'cpu.pct': ['CPU', '%'], 'cpu.core_max_pct': ['코어 최대', '%'], 'load.1m': ['로드(1m)', ''],
        'mem.used_pct': ['메모리', '%'], 'mem.used_mb': ['메모리 사용', 'GB', 1024, 2], 'mem.total_mb': ['메모리 전체', 'GB', 1024, 2],
        'diskio.read_kbps': ['디스크 읽기', 'KB/s'], 'diskio.write_kbps': ['디스크 쓰기', 'KB/s'],
        'net.rx_kbps': ['네트워크 수신', 'MB/s', 1024, 3], 'net.tx_kbps': ['네트워크 송신', 'MB/s', 1024, 3], 'net.link_mbps': ['링크 속도', 'Mbps'],
        'exec.mysql_replica_lag': ['복제 지연', '초'],   // M2: 워룸(컷오버) 핵심 지표
        'loop.lag_ms': ['루프지연 평균', 'ms'], 'loop.lag_p99_ms': ['루프지연 p99', 'ms'], 'loop.lag_max_ms': ['루프지연 최대', 'ms'],   // @hub 허브 자가감시(이벤트루프 지연)
      };
      // [name, unit, div?, prec?] — div/prec 있으면 표시 단계에서 값을 div 로 나눠 prec 자리로(예: 메모리 MB→GB)
      if (L[metric]) return { name: L[metric][0], unit: L[metric][1], div: L[metric][2], prec: L[metric][3] };
      let m;
      // M2: 체크러너(@checks 가상 서버) 메트릭 라벨
      if ((m = metric.match(/^check\.(.+)\.ms$/))) return { name: '응답시간(' + m[1] + ')', unit: 'ms' };
      if ((m = metric.match(/^check\.(.+)\.up$/))) return { name: '가용(' + m[1] + ')', unit: '' };
      if ((m = metric.match(/^disk\.(.+)\.used_pct$/))) return { name: '디스크(' + m[1] + ')', unit: '%' };
      if ((m = metric.match(/^disk\.(.+)\.used_gb$/))) return { name: '디스크(' + m[1] + ')', unit: 'GB' };
      if ((m = metric.match(/^svc\.(.+)\.active$/))) return { name: m[1], unit: 'svc' };
      if ((m = metric.match(/^port\.(\d+)\.open$/))) return { name: ':' + m[1], unit: 'port' };
      if ((m = metric.match(/^exec\.(.+)$/))) return { name: m[1], unit: '' };
      return { name: metric, unit: '' };
    },
  };

  LTNC.refresh().catch(() => {});
  connect();
})();
