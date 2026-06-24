// storage.mjs — SQLite(WAL) 시계열 저장 + 3계층 롤업 + 보존 purge
// 설계 근거: 결정 005 §3 (raw 14d → 5m 90d → 1h 3y, write 단일 프로세스 소유, 저카디널리티 인덱스 금지)
// 엔진 = node:sqlite 내장(DatabaseSync) — 네이티브 의존 0 (Node 22.5+는 --experimental-sqlite, 23.4+/24 무플래그)
import { DatabaseSync } from 'node:sqlite';

const BUCKET_5M = 300, BUCKET_1H = 3600;

export function openStorage(dbPath, retention) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers(
      id INTEGER PRIMARY KEY,
      agent TEXT NOT NULL UNIQUE,
      host TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS series(
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL,
      metric TEXT NOT NULL,
      UNIQUE(server_id, metric)
    );
    CREATE TABLE IF NOT EXISTS raw(
      series_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY(series_id, ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agg_5m(
      series_id INTEGER NOT NULL,
      bucket_ts INTEGER NOT NULL,
      cnt INTEGER NOT NULL, sum REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL,
      PRIMARY KEY(series_id, bucket_ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agg_1h(
      series_id INTEGER NOT NULL,
      bucket_ts INTEGER NOT NULL,
      cnt INTEGER NOT NULL, sum REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL,
      PRIMARY KEY(series_id, bucket_ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    -- M2: 알림 이력 (alerts.mjs) — 기존 DB 에도 IF NOT EXISTS 로 무중단 추가
    CREATE TABLE IF NOT EXISTS alerts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server TEXT NOT NULL,
      metric TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'firing',
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      value REAL,
      ack_at INTEGER
    );
    -- M2: 웹푸시 구독 (notify.mjs)
    CREATE TABLE IF NOT EXISTS push_subs(
      endpoint TEXT PRIMARY KEY,
      sub TEXT NOT NULL,
      created INTEGER NOT NULL
    );
  `);

  // ts 보조 인덱스 — purge DELETE·rollup SELECT 가 ts/bucket_ts '단독'으로 거르는데
  // raw/agg PK 가 (series_id, ts) 라 ts 단독 필터는 풀스캔 → 정시 purge 가 수 초 루프 블록(외부체크 ms 동반 스파이크 주범).
  // ts=고카디널리티라 결정005 §3 '저카디널리티 인덱스 금지'에 저촉 안 함. IF NOT EXISTS 라 기존 DB 에 무중단 추가(기동 1회 빌드).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_raw_ts    ON raw(ts);
    CREATE INDEX IF NOT EXISTS idx_agg5m_bts ON agg_5m(bucket_ts);
    CREATE INDEX IF NOT EXISTS idx_agg1h_bts ON agg_1h(bucket_ts);
  `);

  const st = {
    serverByAgent: db.prepare('SELECT * FROM servers WHERE agent=?'),
    insServer: db.prepare('INSERT INTO servers(agent,host,tags,first_seen,last_seen) VALUES(?,?,?,?,?)'),
    touchServer: db.prepare('UPDATE servers SET last_seen=?, host=COALESCE(NULLIF(?,\'\'),host) WHERE id=?'),
    allServers: db.prepare('SELECT * FROM servers ORDER BY agent'),
    seriesGet: db.prepare('SELECT id FROM series WHERE server_id=? AND metric=?'),
    seriesIns: db.prepare('INSERT INTO series(server_id,metric) VALUES(?,?)'),
    seriesByServer: db.prepare('SELECT id, metric FROM series WHERE server_id=?'),
    insRaw: db.prepare('INSERT OR REPLACE INTO raw(series_id,ts,value) VALUES(?,?,?)'),
    latestRaw: db.prepare('SELECT ts, value FROM raw WHERE series_id=? ORDER BY ts DESC LIMIT 1'),
    rangeRaw: db.prepare('SELECT ts, value FROM raw WHERE series_id=? AND ts BETWEEN ? AND ? ORDER BY ts'),
    range5m: db.prepare('SELECT bucket_ts ts, sum/cnt avg, min, max FROM agg_5m WHERE series_id=? AND bucket_ts BETWEEN ? AND ? ORDER BY bucket_ts'),
    range1h: db.prepare('SELECT bucket_ts ts, sum/cnt avg, min, max FROM agg_1h WHERE series_id=? AND bucket_ts BETWEEN ? AND ? ORDER BY bucket_ts'),
    metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
    metaSet: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
    // M2: 알림
    insAlert: db.prepare('INSERT INTO alerts(ts,server,metric,severity,state,title,detail,value) VALUES(?,?,?,?,\'firing\',?,?,?)'),
    getAlert: db.prepare('SELECT * FROM alerts WHERE id=?'),
    resolveAlert: db.prepare('UPDATE alerts SET state=\'resolved\' WHERE id=?'),
    ackAlert: db.prepare('UPDATE alerts SET ack_at=? WHERE id=? AND ack_at IS NULL'),
    listAlerts: db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?'),
    firingAlerts: db.prepare('SELECT * FROM alerts WHERE state=\'firing\' ORDER BY id'),
    // M2: 웹푸시 구독
    addPushSub: db.prepare('INSERT OR REPLACE INTO push_subs(endpoint,sub,created) VALUES(?,?,?)'),
    delPushSub: db.prepare('DELETE FROM push_subs WHERE endpoint=?'),
    allPushSubs: db.prepare('SELECT endpoint, sub FROM push_subs'),
  };

  const seriesCache = new Map(); // `${serverId}\0${metric}` -> series_id
  function seriesId(serverId, metric) {
    const key = serverId + '\0' + metric;
    let id = seriesCache.get(key);
    if (id) return id;
    const row = st.seriesGet.get(serverId, metric);
    id = row ? Number(row.id) : Number(st.seriesIns.run(serverId, metric).lastInsertRowid);
    seriesCache.set(key, id);
    return id;
  }

  function upsertServer(agent, host, tags, now) {
    let s = st.serverByAgent.get(agent);
    if (!s) {
      st.insServer.run(agent, host || '', tags || '', now, now);
      s = st.serverByAgent.get(agent);
    } else {
      st.touchServer.run(now, host || '', s.id);
    }
    return Number(s.id);
  }

  // node:sqlite 엔 transaction 헬퍼가 없어 BEGIN/COMMIT 직접 (단일 쓰기 프로세스 전제)
  function txInsertBatch(serverId, ts, metrics) {
    db.exec('BEGIN');
    try {
      for (const [name, val] of Object.entries(metrics)) {
        const v = Number(val);
        if (!Number.isFinite(v)) continue;
        st.insRaw.run(seriesId(serverId, name), ts, v);
      }
      st.touchServer.run(ts, '', serverId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function metaGet(k, dflt) { const r = st.metaGet.get(k); return r ? Number(r.v) : dflt; }

  // 롤업: 완결된 버킷만 (지각 샘플 30초 여유). 1h 는 5m 에서 계층 집계.
  function rollup(now = Math.floor(Date.now() / 1000)) {
    const safe5 = Math.floor((now - 30) / BUCKET_5M) * BUCKET_5M;          // 이 시각 미만 버킷은 완결
    const from5 = metaGet('rollup5m_wm', 0);
    if (from5 < safe5) {
      db.prepare(`
        INSERT OR REPLACE INTO agg_5m(series_id,bucket_ts,cnt,sum,min,max)
        SELECT series_id, (ts/${BUCKET_5M})*${BUCKET_5M} b, COUNT(*), SUM(value), MIN(value), MAX(value)
        FROM raw WHERE ts >= ? AND ts < ? GROUP BY series_id, b
      `).run(from5, safe5);
      st.metaSet.run('rollup5m_wm', String(safe5));
    }
    const safe1h = Math.floor(safe5 / BUCKET_1H) * BUCKET_1H;
    const from1h = metaGet('rollup1h_wm', 0);
    if (from1h < safe1h) {
      db.prepare(`
        INSERT OR REPLACE INTO agg_1h(series_id,bucket_ts,cnt,sum,min,max)
        SELECT series_id, (bucket_ts/${BUCKET_1H})*${BUCKET_1H} b, SUM(cnt), SUM(sum), MIN(min), MAX(max)
        FROM agg_5m WHERE bucket_ts >= ? AND bucket_ts < ? GROUP BY series_id, b
      `).run(from1h, safe1h);
      st.metaSet.run('rollup1h_wm', String(safe1h));
    }
  }

  function purge(now = Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM raw WHERE ts < ?').run(now - retention.rawDays * 86400);
    db.prepare('DELETE FROM agg_5m WHERE bucket_ts < ?').run(now - retention.agg5mDays * 86400);
    db.prepare('DELETE FROM agg_1h WHERE bucket_ts < ?').run(now - retention.agg1hDays * 86400);
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  // res: raw|5m|1h|auto (auto = 범위 길이에 맞는 계층 — 차트 줌레벨용)
  function queryRange(serverId, metric, from, to, res = 'auto') {
    const row = st.seriesGet.get(serverId, metric);
    if (!row) return { res: 'raw', points: [] };
    if (res === 'auto') {
      const span = to - from;
      res = span <= 2 * 86400 ? 'raw' : span <= 30 * 86400 ? '5m' : '1h';
    }
    if (res === 'raw') return { res, points: st.rangeRaw.all(row.id, from, to).map(r => [r.ts, r.value]) };
    const q = res === '5m' ? st.range5m : st.range1h;
    return { res, points: q.all(row.id, from, to).map(r => [r.ts, r.avg, r.min, r.max]) };
  }

  function latestByServer(serverId) {
    const out = {};
    for (const s of st.seriesByServer.all(serverId)) {
      const r = st.latestRaw.get(s.id);
      if (r) out[s.metric] = { ts: r.ts, value: r.value };
    }
    return out;
  }

  // M2: 알림 row → API/WS 응답 형태(camelCase, 계약 §알림)
  const alertRow = (r) => r && ({
    id: Number(r.id), ts: Number(r.ts), server: r.server, metric: r.metric,
    severity: r.severity, state: r.state, title: r.title, detail: r.detail,
    value: r.value, ackAt: r.ack_at == null ? null : Number(r.ack_at),
  });

  return {
    db,
    upsertServer,
    insertBatch: (serverId, ts, metrics) => txInsertBatch(serverId, ts, metrics),
    rollup, purge, queryRange, latestByServer,
    servers: () => st.allServers.all(),
    // M2: 알림
    insertAlert: ({ ts, server, metric, severity, title, detail, value }) =>
      Number(st.insAlert.run(ts, server, metric, severity, title, detail || '', value ?? null).lastInsertRowid),
    getAlert: (id) => alertRow(st.getAlert.get(id)),
    resolveAlert: (id) => st.resolveAlert.run(id),
    ackAlert: (id, ts) => st.ackAlert.run(ts, id),
    listAlerts: (limit = 50) => st.listAlerts.all(limit).map(alertRow),
    firingAlerts: () => st.firingAlerts.all().map(alertRow),
    // M2: 웹푸시 구독
    addPushSub: (endpoint, sub, created) => st.addPushSub.run(endpoint, sub, created),
    delPushSub: (endpoint) => st.delPushSub.run(endpoint),
    allPushSubs: () => st.allPushSubs.all(),
    close: () => db.close(),
  };
}
