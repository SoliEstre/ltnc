// notify.mjs — 알림 채널 플러그인: webhook(단순 POST {text}) + 웹푸시(web-push, VAPID 자동 관리)
// M2 계약: webhook = {text} JSON POST(카카오워크/슬랙 호환) · severities 필터 ·
//          웹푸시 = VAPID 키 data/vapid.json 자동 생성, 410/404 시 구독 삭제, crit=Urgency high·TTL 120
//          푸시 페이로드 = { title, body, data: { alertId } }
import fs from 'node:fs';
import path from 'node:path';

export function createNotifier({ cfg, store, log = console }) {
  const ncfg = cfg.notify || {};
  const webhooks = (Array.isArray(ncfg.webhooks) ? ncfg.webhooks : []).filter((w) => w && w.url);
  const pushWanted = !!ncfg.push?.enabled;
  let webpush = null; // 동적 로드(푸시 비활성 시 의존 불요·로드 실패에도 hub 무중단)
  let vapid = null;

  /** 초기화 — 푸시 활성 시 web-push 로드 + VAPID 키 로드/생성(data/vapid.json) */
  async function init() {
    if (!pushWanted) return;
    try {
      webpush = (await import('web-push')).default;
    } catch (e) {
      log.error('[notify] web-push 모듈 로드 실패 — 웹푸시 비활성:', e?.message);
      return;
    }
    try {
      const file = path.join(cfg.dataDir, 'vapid.json');
      if (fs.existsSync(file)) {
        vapid = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        vapid = webpush.generateVAPIDKeys();
        fs.writeFileSync(file, JSON.stringify(vapid, null, 2));
        log.log('[notify] VAPID 키 신규 생성 → ' + file);
      }
      webpush.setVapidDetails(ncfg.push.subject || 'mailto:ltnc@localhost', vapid.publicKey, vapid.privateKey);
      log.log('[notify] 웹푸시 활성 (구독 ' + store.allPushSubs().length + '건)');
    } catch (e) {
      vapid = null;
      log.error('[notify] VAPID 초기화 실패 — 웹푸시 비활성:', e?.message);
    }
  }

  const pushEnabled = () => pushWanted && !!vapid;
  const vapidPublicKey = () => (pushEnabled() ? vapid.publicKey : null);

  /** webhook 본문 텍스트 (한국어, 채팅 도구 호환 단순 텍스트) */
  function webhookText(alert) {
    const head = alert.state === 'resolved' ? '✅ 해소'
      : alert.severity === 'crit' ? '🚨 심각' : '⚠️ 경고';
    return `[LTNC ${head}] ${alert.title}${alert.detail ? `\n${alert.detail}` : ''}`;
  }

  /** 웹푸시 전 구독 발송 — 410/404(만료/소멸) 구독은 자동 삭제 */
  async function sendPush(alert) {
    if (!pushEnabled()) return;
    const payload = JSON.stringify({ title: alert.title, body: alert.detail || '', data: { alertId: alert.id } });
    const opts = alert.severity === 'crit'
      ? { urgency: 'high', TTL: 120 }
      : { urgency: 'normal', TTL: 3600 };
    for (const row of store.allPushSubs()) {
      let sub;
      try { sub = JSON.parse(row.sub); } catch { store.delPushSub(row.endpoint); continue; }
      webpush.sendNotification(sub, payload, opts).catch((e) => {
        if (e?.statusCode === 410 || e?.statusCode === 404) {
          store.delPushSub(row.endpoint);
          log.log('[notify] 만료된 푸시 구독 제거');
        } else {
          log.error('[notify] 푸시 발송 실패:', e?.statusCode || e?.message);
        }
      });
    }
  }

  /** 알림 1건 디스패치 — webhook(severities 필터, firing/resolved 모두) + 푸시(firing 만) */
  function dispatch(alert) {
    for (const wh of webhooks) {
      if (Array.isArray(wh.severities) && !wh.severities.includes(alert.severity)) continue;
      fetch(wh.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: webhookText(alert) }),
        signal: AbortSignal.timeout(10 * 1000),
      }).then((r) => {
        if (!r.ok) log.error(`[notify] webhook ${wh.name || wh.url}: HTTP ${r.status}`);
        return r.body?.cancel?.();
      }).catch((e) => log.error(`[notify] webhook ${wh.name || wh.url} 실패:`, e?.message));
    }
    if (alert.state === 'firing') {
      sendPush(alert).catch((e) => log.error('[notify] 푸시:', e?.message));
    }
  }

  return { init, dispatch, vapidPublicKey, pushEnabled };
}
