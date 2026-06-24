// config.mjs — LTNC hub 설정 로더 (YAML, 기본값 병합)
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DEFAULTS = {
  port: 8420,
  bind: '127.0.0.1',            // 보안 기본 loopback — 외부 노출은 reverse-proxy 권장 (Constellation v2.4.11 규율 동일)
  dataDir: './data',
  db: 'ltnc.db',
  agents: [],                    // [{ id, token, tags? }]
  retention: { rawDays: 14, agg5mDays: 90, agg1hDays: 1095 },
  rollupIntervalSec: 300,
  offlineAfterSec: 90,           // 마지막 batch 후 이 시간 지나면 offline 판정
  // ── M2 ──
  auth: null,                    // { user, passHash(scrypt$N$r$p$salt$hex), sessionTtlSec } — 미설정 시 보호 비활성
  rules: [],                     // 알림 룰 추가/덮어쓰기 (기본 룰은 alerts.mjs 내장)
  notify: {},                    // { cooldownSec?, webhooks:[{name,url,severities?}], push:{enabled,subject?} }
  checks: [],                    // [{ id, url, method?, keyword?, intervalSec?, timeoutSec? }]
  hideChecks: [],                // 화면 표시 제외할 외부 체크 id 목록 — DB(시리즈/데이터) 는 보존, 대시보드 카드·워룸에서만 숨김
  ai: {},                        // { model?, apiKey?, intervalSec? } — packages/ai 다이제스트
};

export function loadConfig(file) {
  let user = {};
  const p = file || process.env.LTNC_CONFIG || 'config.yaml';
  if (fs.existsSync(p)) user = YAML.parse(fs.readFileSync(p, 'utf8')) || {};
  const cfg = {
    ...DEFAULTS, ...user,
    retention: { ...DEFAULTS.retention, ...(user.retention || {}) },
    notify: { ...DEFAULTS.notify, ...(user.notify || {}) },
    ai: { ...DEFAULTS.ai, ...(user.ai || {}) },
  };
  cfg.configPath = path.resolve(p);
  cfg.dataDir = path.resolve(path.dirname(cfg.configPath), cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  cfg.dbPath = path.join(cfg.dataDir, cfg.db);
  if (!Array.isArray(cfg.agents)) throw new Error('config.agents 는 배열이어야 해요');
  if (!Array.isArray(cfg.checks)) throw new Error('config.checks 는 배열이어야 해요');
  if (!Array.isArray(cfg.hideChecks)) throw new Error('config.hideChecks 는 배열이어야 해요');
  if (!Array.isArray(cfg.rules)) throw new Error('config.rules 는 배열이어야 해요');
  return cfg;
}
