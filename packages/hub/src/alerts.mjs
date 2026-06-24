// alerts.mjs — 알림 엔진: 룰 평가(ingest 직후 + 30초 sweep) · dedup · resolved 전이 · 쿨다운
// M2 계약: 기본 룰 내장 + config rules 병합(동일 server+metric+severity 키 덮어쓰기) ·
//          dedup = 동일 키 firing 중 재발행 금지 · 해소 시 resolved 1회 · 채널 재통지 쿨다운 기본 300s
// 발행 시: DB 기록 → WS /live {t:'alert'} 브로드캐스트 → 채널 디스패치(notify.mjs)

// 기본 룰 세트 (계약 명세 그대로) — op 는 >|<|==|!= 에 더해 >=|<= 도 허용(기본 룰의 ≥ 표현용)
const DEFAULT_RULES = [
  { metric: 'disk.*.used_pct', op: '>=', threshold: 85, forSec: 0, severity: 'warn' },
  { metric: 'disk.*.used_pct', op: '>=', threshold: 93, forSec: 0, severity: 'crit' },
  { metric: 'cpu.pct', op: '>=', threshold: 90, forSec: 300, severity: 'warn' },
  { metric: 'mem.used_pct', op: '>=', threshold: 92, forSec: 300, severity: 'warn' },
  { metric: 'svc.*.active', op: '==', threshold: 0, forSec: 0, severity: 'crit' },
  { metric: 'port.*.open', op: '==', threshold: 0, forSec: 0, severity: 'crit' },
  { metric: 'exec.cert_days_left', op: '<', threshold: 14, forSec: 0, severity: 'warn' },
  { metric: 'exec.mysql_replica_lag', op: '>', threshold: 10, forSec: 0, severity: 'warn' },
  { metric: 'exec.mysql_replica_lag', op: '>', threshold: 60, forSec: 120, severity: 'crit' },
  { metric: 'check.*.up', op: '==', threshold: 0, forSec: 0, severity: 'crit' },
];

const OPS = {
  '>': (a, b) => a > b, '<': (a, b) => a < b,
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globToRe = (glob) => new RegExp('^' + String(glob).split('*').map(escapeRe).join('.*') + '$');

/** 메트릭 이름 → 한국어 라벨 (알림 제목용) */
function labelFor(metric) {
  if (metric === 'server.offline') return '서버 오프라인';
  if (metric === 'cpu.pct') return 'CPU 사용률';
  if (metric === 'mem.used_pct') return '메모리 사용률';
  if (metric === 'exec.cert_days_left') return '인증서 만료 임박';
  if (metric === 'exec.mysql_replica_lag') return 'MySQL 복제 지연';
  const seg = metric.split('.');
  if (seg[0] === 'disk') return `디스크(${seg.slice(1, -1).join('.')}) 사용률`;
  if (seg[0] === 'svc') return `서비스 ${seg.slice(1, -1).join('.')} 중단`;
  if (seg[0] === 'port') return `포트 ${seg[1]} 닫힘`;
  if (seg[0] === 'check') return `외부 체크 ${seg.slice(1, -1).join('.')} 실패`;
  return metric;
}

const fmt = (v) => (v == null ? '-' : Math.round(Number(v) * 100) / 100);

/** 기본 룰 + config 룰 병합 — 키 = server|metric|severity, enabled:false 로 기본 룰 끄기 가능 */
function mergeRules(defaults, user) {
  const keyOf = (r) => `${r.server || ''}|${r.metric}|${r.severity}`;
  const map = new Map(defaults.map((r) => [keyOf(r), { ...r }]));
  for (const r of Array.isArray(user) ? user : []) {
    if (!r || !r.metric || !r.severity) continue;
    map.set(keyOf(r), { ...(map.get(keyOf(r)) || {}), ...r });
  }
  return [...map.values()]
    .filter((r) => r.enabled !== false && OPS[r.op] && Number.isFinite(Number(r.threshold)))
    .map((r) => ({ ...r, threshold: Number(r.threshold), forSec: Number(r.forSec) || 0, _re: globToRe(r.metric) }));
}

/**
 * 알림 엔진 생성.
 * @param store      storage.mjs (insertAlert/resolveAlert/ackAlert/getAlert/firingAlerts)
 * @param broadcast  WS /live 브로드캐스트 함수
 * @param notifier   notify.mjs 채널 디스패처
 * @param getServers server.mjs serverList() — offline 판정용 (id/online/lastSeen)
 */
export function createAlertEngine({ cfg, store, broadcast, notifier, getServers, log = console }) {
  const rules = mergeRules(DEFAULT_RULES, cfg.rules);
  const cooldownSec = Number(cfg.notify?.cooldownSec) || 300;
  const nowSec = () => Math.floor(Date.now() / 1000);

  // 평가 상태: key = server|metric|severity
  // { firingId, condSince, lastValue, lastNotify(ms), notified, ruleRef, server, metric }
  const state = new Map();
  const key = (server, metric, sev) => `${server}|${metric}|${sev}`;
  function getSt(k) {
    let s = state.get(k);
    if (!s) { s = { firingId: 0, condSince: 0, lastValue: null, lastNotify: 0, notified: false }; state.set(k, s); }
    return s;
  }

  // 재기동 시 DB 의 firing 알림 복원 — 재기동 직후 동일 알림 중복 재발행 방지
  for (const a of store.firingAlerts()) {
    const st = getSt(key(a.server, a.metric, a.severity));
    st.firingId = a.id;
    st.notified = true; // 해소 시 채널 통지 누락 방지(보수적으로 통지됨으로 간주)
  }

  /** 채널 디스패치 — firing 은 쿨다운 적용, resolved 는 firing 때 통지된 경우만 1회 */
  function notifyChannels(alert, st) {
    try {
      if (alert.state === 'firing') {
        if (Date.now() - st.lastNotify < cooldownSec * 1000) return; // 쿨다운: DB/WS 는 기록, 채널만 억제
        st.lastNotify = Date.now();
        st.notified = true;
        notifier.dispatch(alert);
      } else if (st.notified) {
        notifier.dispatch(alert);
        st.notified = false;
      }
    } catch (e) { log.error('[alerts] 채널 디스패치 실패:', e?.message || e); }
  }

  /** 알림 발행 (dedup: 동일 키 firing 중이면 무시) */
  function fire(rule, server, metric, value, ts, customTitle, customDetail) {
    const k = key(server, metric, rule.severity);
    const st = getSt(k);
    if (st.firingId) return; // dedup
    // 동일 metric 의 crit 이 이미 firing 이면 warn 발행 억제(노이즈 절감)
    if (rule.severity === 'warn' && state.get(key(server, metric, 'crit'))?.firingId) return;
    const title = customTitle || `${server}: ${labelFor(metric)} ${rule.severity === 'crit' ? '심각' : '경고'}`;
    const detail = customDetail
      || `${metric} = ${fmt(value)} (조건: ${rule.op} ${rule.threshold}${rule.forSec ? `, ${rule.forSec}초 지속` : ''})`;
    const id = store.insertAlert({ ts, server, metric, severity: rule.severity, title, detail, value });
    st.firingId = id;
    st.condSince = 0;
    const alert = store.getAlert(id);
    broadcast({ t: 'alert', alert });
    notifyChannels(alert, st);
    log.log(`[alerts] 발생(${rule.severity}) ${server}/${metric} = ${fmt(value)}`);
    // warn → crit 격상 시 기존 warn 알림은 해소 처리
    if (rule.severity === 'crit') {
      const wk = key(server, metric, 'warn');
      const ws = state.get(wk);
      if (ws?.firingId) resolveKey(ws, ts);
    }
  }

  /** firing → resolved 전이 (1회) */
  function resolveKey(st, ts) {
    if (!st.firingId) return;
    store.resolveAlert(st.firingId);
    const alert = store.getAlert(st.firingId);
    st.firingId = 0;
    st.condSince = 0;
    if (alert) {
      broadcast({ t: 'alert', alert });
      notifyChannels(alert, st);
      log.log(`[alerts] 해소(${alert.severity}) ${alert.server}/${alert.metric}`);
    }
  }

  /** ingest 직후 평가 — 해당 서버 batch 의 메트릭만 룰 매칭 */
  function onIngest(server, ts, metrics) {
    for (const [metric, raw] of Object.entries(metrics || {})) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      for (const rule of rules) {
        if (rule.server && rule.server !== server) continue;
        if (!rule._re.test(metric)) continue;
        const k = key(server, metric, rule.severity);
        const st = getSt(k);
        st.lastValue = v;
        if (OPS[rule.op](v, rule.threshold)) {
          if (!rule.forSec) { fire(rule, server, metric, v, ts); continue; }
          // forSec 지속 룰: 최초 충족 시각 기록, 경과하면 발행(미경과분은 30초 sweep 이 승격)
          if (!st.condSince) { st.condSince = ts; st.ruleRef = rule; st.server = server; st.metric = metric; }
          if (ts - st.condSince >= rule.forSec) fire(rule, server, metric, v, ts);
        } else {
          st.condSince = 0;
          if (st.firingId) resolveKey(st, ts);
        }
      }
    }
    // 데이터 수신 = 온라인 → offline 알림 즉시 해소
    const off = state.get(key(server, 'server.offline', 'crit'));
    if (off?.firingId) resolveKey(off, ts);
  }

  /** 30초 주기 sweep — ① forSec 지속 판정 승격 ② 서버 offline 발생/해소 */
  function sweep() {
    const ts = nowSec();
    for (const st of state.values()) {
      if (!st.firingId && st.condSince && st.ruleRef && ts - st.condSince >= st.ruleRef.forSec) {
        fire(st.ruleRef, st.server, st.metric, st.lastValue, ts);
      }
    }
    for (const s of getServers()) {
      if (s.id === '@checks') continue; // 가상 서버는 offline 판정 제외(체크러너 자체가 hub 내장)
      const st = getSt(key(s.id, 'server.offline', 'crit'));
      if (!s.online && s.lastSeen) {
        if (!st.firingId) {
          const rule = { severity: 'crit', op: '==', threshold: 1, forSec: 0 };
          fire(rule, s.id, 'server.offline', 1, ts,
            `${s.id}: 서버 오프라인`,
            `에이전트 응답 없음 (마지막 수신: ${new Date(s.lastSeen * 1000).toLocaleString('ko-KR')})`);
        }
      } else if (st.firingId) {
        resolveKey(st, ts);
      }
    }
  }

  /** 확인(ack) — ack_at 기록 + WS 로 갱신 브로드캐스트(다중 클라이언트 뱃지 동기화) */
  function ack(id) {
    store.ackAlert(id, nowSec());
    const alert = store.getAlert(id);
    if (alert) broadcast({ t: 'alert', alert });
    return alert;
  }

  return { onIngest, sweep, ack, rules };
}
