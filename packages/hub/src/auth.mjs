// auth.mjs — 간단 인증 게이트(단일 계정 + 영속 세션) — M2 계약 §인증
// passHash 형식: scrypt$N$r$p$salt(hex)$key(hex)
// 해시 생성 CLI: node packages/hub/src/auth.mjs <비밀번호>
// 세션: 메모리 Map + dataDir/sessions.json 영속화(재기동해도 로그인 유지) + sliding 연장(활동 시 자동 연장).
//   (종전 '재기동 시 전원 재로그인' 계약을 운영 요구로 개선 — dataDir 미전달 시 종전 메모리-only 동작)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const COOKIE = 'ltnc_sid';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** scrypt 해시 문자열 생성 (config auth.passHash 용) */
export function hashPassword(pass, { N = 16384, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pass), salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('hex'), key.toString('hex')].join('$');
}

/** 상수시간 비밀번호 검증 — 형식 오류·예외는 전부 false */
export function verifyPassword(pass, stored) {
  try {
    const [tag, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (tag !== 'scrypt') return false;
    const expected = Buffer.from(keyHex, 'hex');
    const got = crypto.scryptSync(String(pass), Buffer.from(saltHex, 'hex'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: 512 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}

/** 쿠키 헤더 파싱 (의존성 없는 최소 구현) */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 인증 컨텍스트 생성.
 * authCfg 미설정(undefined/null) → enabled=false: 보호 비활성(기존 사용 무중단), 경고 로그만.
 * dataDir 전달 시 세션을 dataDir/sessions.json 에 영속화(재기동 유지). 미전달 = 메모리-only(종전 동작).
 */
export function createAuth(authCfg, log = console, dataDir = null) {
  const enabled = !!(authCfg && authCfg.user && authCfg.passHash);
  if (!authCfg) {
    log.warn('[auth] config.auth 미설정 — API/WS 보호 비활성(기존 동작 유지). 외부 노출 시 설정을 권장해요');
  } else if (!enabled) {
    log.warn('[auth] config.auth 가 불완전(user·passHash 필요) — 인증 비활성으로 기동해요');
  }
  const ttlSec = Number(authCfg?.sessionTtlSec) || 2592000; // 기본 30일 — sliding 연장이라 활동 중엔 사실상 무기한
  const sessions = new Map(); // sid -> { user, expires(ms) }

  // ── 영속화: 부팅 시 복원(만료분 제외) + 변경 시 디바운스 저장 (vapid.json 과 같은 dataDir 패턴) ──
  const storePath = (enabled && dataDir) ? path.join(dataDir, 'sessions.json') : null;
  if (storePath && fs.existsSync(storePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const t = Date.now();
      for (const [sid, s] of Object.entries(raw)) if (s && s.expires > t) sessions.set(sid, { user: s.user, expires: s.expires });
      log.log(`[auth] 세션 ${sessions.size}건 복원 — 재기동에도 로그인 유지 (${storePath})`);
    } catch (e) { log.warn(`[auth] 세션 파일 복원 실패 — 빈 상태로 시작: ${e.message}`); }
  }
  let saveTimer = null;
  function persist() {
    if (!storePath) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(storePath, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); }
      catch (e) { log.warn(`[auth] 세션 저장 실패: ${e.message}`); }
    }, 500);
    if (saveTimer.unref) saveTimer.unref();
  }

  // 만료 세션 청소 (10분 주기, 프로세스 종료 비차단)
  setInterval(() => {
    const t = Date.now();
    let removed = 0;
    for (const [sid, s] of sessions) if (s.expires < t) { sessions.delete(sid); removed++; }
    if (removed) persist();
  }, 600 * 1000).unref();

  /** 로그인 시도 — 성공 시 세션 id, 실패 시 null. 사용자명·비밀번호 모두 상수시간 비교 */
  function login(user, pass) {
    if (!enabled) return null;
    const userOk = crypto.timingSafeEqual(sha256(user ?? ''), sha256(authCfg.user));
    const passOk = verifyPassword(pass ?? '', authCfg.passHash); // user 불일치여도 항상 계산(타이밍 균일화)
    if (!(userOk && passOk)) return null;
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { user: String(authCfg.user), expires: Date.now() + ttlSec * 1000 });
    persist();
    return sid;
  }

  /** 요청 쿠키에서 유효 세션 조회 → { user, sid, renewed } | null.
   *  sliding: 남은 수명이 절반 아래면 활동 시점 기준으로 연장(renewed=true → 라우트에서 쿠키 재발급). */
  function sessionFrom(req) {
    const sid = parseCookies(req.headers?.cookie)[COOKIE];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    const t = Date.now();
    if (s.expires < t) { sessions.delete(sid); persist(); return null; }
    let renewed = false;
    if (s.expires - t < ttlSec * 500) { s.expires = t + ttlSec * 1000; renewed = true; persist(); }
    return { user: s.user, sid, renewed };
  }

  /** 요청의 세션 폐기 (로그아웃) */
  function logout(req) {
    const sid = parseCookies(req.headers?.cookie)[COOKIE];
    if (sid && sessions.delete(sid)) persist();
  }

  return {
    enabled,
    cookieName: COOKIE,
    login,
    logout,
    sessionFrom,
    setCookie: (sid) => `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSec}`,
    clearCookie: () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  };
}

// ── CLI: passHash 생성 ──  node packages/hub/src/auth.mjs <비밀번호>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pass = process.argv[2];
  if (!pass) { console.error('사용법: node auth.mjs <비밀번호>  →  config auth.passHash 값 출력'); process.exit(1); }
  console.log(hashPassword(pass));
}
