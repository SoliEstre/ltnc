// index.mjs — LTNC hub 엔트리: config → storage → (M2) 인증·채널·서버 → 알림엔진·체크러너·AI 결선 → 스케줄
import { loadConfig } from './config.mjs';
import { openStorage } from './storage.mjs';
import { startServer } from './server.mjs';
import { createAuth } from './auth.mjs';
import { createNotifier } from './notify.mjs';
import { createAlertEngine } from './alerts.mjs';
import { createCheckRunner } from './checks.mjs';
import { createStatsModule } from './stats.mjs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const cfg = loadConfig(process.argv[2]);
const store = openStorage(cfg.dbPath, cfg.retention);

// M2 확장 모듈 묶음 — server.mjs 가 라우팅에 사용 (전부 옵셔널, 없으면 해당 기능 비활성)
const ext = {};
ext.auth = createAuth(cfg.auth, console, cfg.dataDir);    // 인증 게이트 (dataDir = 세션 영속화·재기동 로그인 유지)
ext.notifier = createNotifier({ cfg, store });            // webhook + 웹푸시 채널
await ext.notifier.init();                                // VAPID 키 로드/생성 (푸시 활성 시)

const hub = startServer(cfg, store, console, ext);

// 알림 엔진 — ingest 직후 평가는 server.mjs 내부 훅(ext.alerts.onIngest), 지속/offline 판정은 30초 sweep
ext.alerts = createAlertEngine({ cfg, store, broadcast: hub.broadcast, notifier: ext.notifier, getServers: hub.serverList });
setInterval(() => { try { ext.alerts.sweep(); } catch (e) { console.error('[alerts]', e); } }, 30 * 1000).unref();

// 외부 HTTP 체크러너 — 결과를 가상 서버 '@checks' 메트릭으로 기존 ingest 파이프라인에 적재
ext.checks = createCheckRunner({ cfg, ingest: (ts, metrics) => hub.ingestVirtual('@checks', ts, metrics, '외부 체크') });
ext.checks.start();

// 통계 탭 백엔드 — ClickHouse 조회(allowlist named 쿼리, read-only). config.stats 미설정 시 비활성.
ext.stats = createStatsModule({ cfg, log: console });

// 허브 이벤트루프 지연 자가감시 — 외부체크 ms 가 루프 블록(purge·rollup·GC·호스트 CPU 경합)에 부풀려지는 것을 분리·가시화.
// 판별: 체크 스파이크 + loop.lag 스파이크 동시 = 측정 아티팩트(서버 정상) · loop.lag 평탄한데 한 체크만 튐 = 그 서버 실장애.
const loopLag = monitorEventLoopDelay({ resolution: 20 });
loopLag.enable();
setInterval(() => {
  const ts = Math.floor(Date.now() / 1000);
  const toMs = (ns) => Math.round((ns / 1e6) * 10) / 10; // ns → ms (소수1)
  try {
    hub.ingestVirtual('@hub', ts, {
      'loop.lag_ms': toMs(loopLag.mean),
      'loop.lag_p99_ms': toMs(loopLag.percentile(99)),
      'loop.lag_max_ms': toMs(loopLag.max),
    }, '허브 자가감시');
  } catch (e) { console.error('[selfmon]', e); }
  loopLag.reset();
}, 10 * 1000).unref();
console.log('[selfmon] 이벤트루프 지연 자가감시 가동 (10초)');

// AI 다이제스트(packages/ai) — 동적 import, 파일 부재/로드 실패 시 비활성 로그만(크래시 금지)
try {
  const mod = await import('../../ai/src/index.mjs');
  ext.digest = mod.createDigest({ store, cfg, broadcast: hub.broadcast });
  const ivl = (Number(cfg.ai?.intervalSec) || 900) * 1000;
  setInterval(() => Promise.resolve(ext.digest.run()).catch(e => console.error('[digest]', e)), ivl).unref();
  console.log(`[digest] AI 다이제스트 가동 (주기 ${ivl / 1000}초)`);
} catch (e) {
  console.log('[digest] packages/ai 모듈 없음 — AI 다이제스트 비활성', e?.code ? `(${e.code})` : '');
}

// 롤업(5분) + 보존 purge(1시간)
setInterval(() => { try { store.rollup(); } catch (e) { console.error('[rollup]', e); } }, cfg.rollupIntervalSec * 1000).unref();
setInterval(() => { try { store.purge(); } catch (e) { console.error('[purge]', e); } }, 3600 * 1000).unref();
store.rollup();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`[hub] ${sig} — 종료`); store.close(); process.exit(0); });
}
