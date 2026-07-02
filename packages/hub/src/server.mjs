// server.mjs — HTTP API + WS(/agent ingest · /live dashboard) + 정적 SPA 단일 서버
// M2 확장: 인증 게이트(/api/login·logout·me + 보호 라우트 + WS /live 쿠키 검증 4401) ·
//          알림 API(/api/alerts) · 웹푸시 API(/api/push/*) · 체크 상태(/api/checks) · AI 다이제스트(/api/digest/*)
// ext = index.mjs 가 채우는 확장 모듈 묶음 { auth, notifier, alerts, checks, digest } — 전부 옵셔널(없으면 해당 기능 비활성)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

// 세션 보호 예외 경로 — login/logout/me(인증 흐름 자체) · health(모니터 공개) · ingest(에이전트 토큰 별도 인증)
const PUBLIC_API = new Set(['/api/health', '/api/login', '/api/logout', '/api/me', '/api/ingest']);

const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

/** 요청 본문 수집 (1MB 상한) */
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > limit) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function tokenAgent(cfg, token) {
  if (!token) return null;
  for (const a of cfg.agents) {
    const t = Buffer.from(String(a.token));
    const u = Buffer.from(String(token));
    if (t.length === u.length && crypto.timingSafeEqual(t, u)) return a;
  }
  return null;
}

export function startServer(cfg, store, log = console, ext = {}) {
  const liveClients = new Set();       // dashboard /live 소켓
  const agentConns = new Map();        // agent id -> ws (presence)
  const lastBatch = new Map();         // agent id -> epoch sec

  const now = () => Math.floor(Date.now() / 1000);

  // 화면 표시 제외 체크 (config.hideChecks) — DB 는 보존, '@checks' 의 latest 와 /api/checks 에서만 숨김
  const hideChecks = new Set(Array.isArray(cfg.hideChecks) ? cfg.hideChecks : []);
  function visibleLatest(agent, sid) {
    const latest = store.latestByServer(sid);
    if (agent !== '@checks' || hideChecks.size === 0) return latest;
    const out = {};
    for (const [k, v] of Object.entries(latest)) {
      const m = k.match(/^check\.(.+)\.(up|ms)$/);
      if (m && hideChecks.has(m[1])) continue;
      out[k] = v;
    }
    return out;
  }

  function serverList() {
    return store.servers().map(s => ({
      id: s.agent, host: s.host, tags: s.tags, lastSeen: s.last_seen,
      online: agentConns.has(s.agent) || (now() - s.last_seen) < cfg.offlineAfterSec,
      latest: visibleLatest(s.agent, s.id),
    }));
  }

  const broadcast = (obj) => {
    const msg = JSON.stringify(obj);
    for (const ws of liveClients) { if (ws.readyState === ws.OPEN) ws.send(msg); }
  };

  function ingest(agentCfg, body) {
    const ts = Number(body.ts) || now();
    if (!body.metrics || typeof body.metrics !== 'object') return false;
    const sid = store.upsertServer(agentCfg.id, body.host || '', agentCfg.tags || '', ts);
    store.insertBatch(sid, ts, body.metrics);
    lastBatch.set(agentCfg.id, now());
    broadcast({ t: 'metrics', server: agentCfg.id, ts, metrics: body.metrics });
    // M2: 알림 엔진 즉시 평가 (실패해도 ingest 본 경로는 무중단)
    try { ext.alerts?.onIngest(agentCfg.id, ts, body.metrics); } catch (e) { log.error('[alerts]', e); }
    return true;
  }

  /** M2: 체크러너 등 hub 내부 발 가상 서버 적재 (예: '@checks' — host='외부 체크') */
  const ingestVirtual = (id, ts, metrics, host) =>
    ingest({ id, tags: 'checks' }, { ts, host: host || '', metrics });

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');

    if (req.method === 'GET' && u.pathname === '/api/health') {
      return J(res, 200, { ok: true, uptime: process.uptime(), db: store.servers().length + ' servers' });
    }

    // ── M2: 인증 흐름 (auth 미설정 시 enabled=false → 무보호 통과, 기존 사용 무중단) ──
    if (req.method === 'POST' && u.pathname === '/api/login') {
      if (!ext.auth?.enabled) return J(res, 200, { ok: true, user: null, note: '인증 비활성' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return J(res, 400, { error: 'bad json' }); }
      const sid = ext.auth.login(body?.user, body?.pass);
      if (!sid) return J(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않아요' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': ext.auth.setCookie(sid) });
      return res.end(JSON.stringify({ ok: true, user: String(body.user) }));
    }
    if (req.method === 'POST' && u.pathname === '/api/logout') {
      const headers = { 'content-type': 'application/json; charset=utf-8' };
      if (ext.auth) { ext.auth.logout(req); headers['set-cookie'] = ext.auth.clearCookie(); }
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'GET' && u.pathname === '/api/me') {
      if (!ext.auth?.enabled) return J(res, 200, { user: null, auth: false });
      const s = ext.auth.sessionFrom(req);
      if (!s) return J(res, 401, { error: 'auth required' });
      const headers = { 'content-type': 'application/json; charset=utf-8' };
      if (s.renewed) headers['set-cookie'] = ext.auth.setCookie(s.sid); // sliding 연장분 쿠키 Max-Age 재발급
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ user: s.user, auth: true }));
    }
    // ── M2: 보호 게이트 — auth 활성 시 /api/* (PUBLIC_API 제외) 세션 필수 ──
    if (ext.auth?.enabled && u.pathname.startsWith('/api/') && !PUBLIC_API.has(u.pathname)) {
      if (!ext.auth.sessionFrom(req)) return J(res, 401, { error: 'auth required' });
    }

    if (req.method === 'GET' && u.pathname === '/api/servers') {
      return J(res, 200, { servers: serverList() });
    }
    if (req.method === 'GET' && u.pathname === '/api/range') {
      const sv = store.servers().find(s => s.agent === u.searchParams.get('server'));
      if (!sv) return J(res, 404, { error: 'unknown server' });
      const from = Number(u.searchParams.get('from')) || now() - 3600;
      const to = Number(u.searchParams.get('to')) || now();
      return J(res, 200, store.queryRange(sv.id, u.searchParams.get('metric') || '', from, to, u.searchParams.get('res') || 'auto'));
    }
    if (req.method === 'POST' && u.pathname === '/api/ingest') {
      const a = tokenAgent(cfg, req.headers['x-ltnc-token']);
      if (!a) return J(res, 401, { error: 'bad token' });
      let buf = '';
      req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { return J(res, 200, { ok: ingest(a, JSON.parse(buf)) }); }
        catch { return J(res, 400, { error: 'bad json' }); }
      });
      return;
    }

    // ── M2: 알림 API ──
    if (req.method === 'GET' && u.pathname === '/api/alerts') {
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 50, 1), 500);
      return J(res, 200, { alerts: store.listAlerts(limit) });
    }
    const ackM = u.pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
    if (req.method === 'POST' && ackM) {
      const id = Number(ackM[1]);
      let alert;
      if (ext.alerts) alert = ext.alerts.ack(id);                       // 엔진 경유 = ack 후 WS 동기화 브로드캐스트
      else { store.ackAlert(id, now()); alert = store.getAlert(id); }   // 엔진 미결선 폴백
      return alert ? J(res, 200, { ok: true, alert }) : J(res, 404, { error: 'unknown alert' });
    }

    // ── M2: 웹푸시 API ──
    if (req.method === 'GET' && u.pathname === '/api/push/vapid') {
      const publicKey = ext.notifier?.vapidPublicKey?.();
      return publicKey ? J(res, 200, { publicKey }) : J(res, 404, { error: '웹푸시 비활성 (config notify.push.enabled)' });
    }
    if (req.method === 'POST' && u.pathname === '/api/push/subscribe') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return J(res, 400, { error: 'bad json' }); }
      const sub = body?.subscription;
      if (!sub?.endpoint) return J(res, 400, { error: 'subscription.endpoint 필요' });
      store.addPushSub(sub.endpoint, JSON.stringify(sub), now());
      return J(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/push/unsubscribe') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return J(res, 400, { error: 'bad json' }); }
      if (!body?.endpoint) return J(res, 400, { error: 'endpoint 필요' });
      store.delPushSub(body.endpoint);
      return J(res, 200, { ok: true });
    }

    // ── M2: 외부 체크 최신 상태 ──
    if (req.method === 'GET' && u.pathname === '/api/checks') {
      const list = ext.checks?.status() || [];
      return J(res, 200, { checks: hideChecks.size ? list.filter(c => !hideChecks.has(c.id)) : list });
    }

    // ── M2: AI 다이제스트 ──
    if (req.method === 'GET' && u.pathname === '/api/digest/latest') {
      if (!ext.digest) return J(res, 200, null);
      return J(res, 200, (await ext.digest.latest()) ?? null);
    }
    if (req.method === 'POST' && u.pathname === '/api/digest/run') {
      if (!ext.digest) return J(res, 503, { error: 'AI 다이제스트 비활성 (packages/ai 모듈 없음)' });
      const d = await ext.digest.run();
      return J(res, 200, d ?? { ok: true });
    }

    // ---- 정적 SPA (packages/web/public) — 경로 탈출 차단 + SPA fallback (인증과 무관하게 공개) ----
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(WEB_ROOT, rel));
      // no-cache(매번 재검증) — 오프라인/반복 캐시는 서비스워커가 담당. 프록시단 장기 캐시 방지.
      if (file.startsWith(WEB_ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      const index = path.join(WEB_ROOT, 'index.html');          // SPA fallback
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        fs.createReadStream(index).pipe(res);
        return;
      }
    }
    return J(res, 404, { error: 'not found' });
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('[http]', e);
      try { J(res, 500, { error: 'internal' }); } catch { /* 응답 이미 종료 */ }
    });
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 20 });

  wss.on('connection', (ws, req) => {
    const u = new URL(req.url, 'http://x');

    if (u.pathname === '/agent') {
      const a = tokenAgent(cfg, u.searchParams.get('token'));
      if (!a) { ws.close(4401, 'bad token'); return; }
      let helloDone = false;
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'hello') {
          helloDone = true;
          agentConns.set(a.id, ws);
          store.upsertServer(a.id, m.host || '', a.tags || '', now());
          ws.send(JSON.stringify({ t: 'hello_ack', serverTime: now() }));
          broadcast({ t: 'presence', server: a.id, online: true });
          log.log(`[agent] ${a.id} 접속 (${m.host || '?'})`);
        } else if (m.t === 'batch' && helloDone) {
          if (ingest(a, m)) ws.send(JSON.stringify({ t: 'ok', ts: m.ts }));
        }
      });
      ws.on('close', () => {
        if (agentConns.get(a.id) === ws) {
          agentConns.delete(a.id);
          broadcast({ t: 'presence', server: a.id, online: false });
          log.log(`[agent] ${a.id} 이탈`);
        }
      });
      return;
    }

    if (u.pathname === '/live') {
      // M2: auth 활성 시 세션 쿠키 검증 — 실패 close 4401 (계약 §인증)
      if (ext.auth?.enabled && !ext.auth.sessionFrom(req)) {
        ws.close(4401, 'auth required');
        return;
      }
      liveClients.add(ws);
      ws.send(JSON.stringify({ t: 'init', servers: serverList() }));
      ws.on('close', () => liveClients.delete(ws));
      return;
    }

    ws.close(4404, 'unknown path');
  });

  httpServer.listen(cfg.port, cfg.bind, () => {
    log.log(`LTNC hub → http://${cfg.bind}:${cfg.port}  [WS: /agent /live]  db=${cfg.dbPath}`);
    if (cfg.bind !== '127.0.0.1' && cfg.bind !== 'localhost' && cfg.bind !== '::1') {
      log.warn(`[hub] ⚠ bind=${cfg.bind} (비-loopback) — 앞단 reverse-proxy + 인증 권장`);
    }
    if (ext.auth?.enabled) log.log('[auth] 인증 게이트 활성 — /api/* 및 WS /live 보호 중');
  });

  return { httpServer, wss, broadcast, serverList, ingestVirtual };
}
