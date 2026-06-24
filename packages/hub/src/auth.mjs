// auth.mjs — 간단 인증 게이트(단일 계정 + 메모리 세션) — M2 계약 §인증
// passHash 형식: scrypt$N$r$p$salt(hex)$key(hex)
// 해시 생성 CLI: node packages/hub/src/auth.mjs <비밀번호>
// 세션은 메모리 Map (재기동 시 전원 재로그인 — 계약 허용 사항)
import crypto from 'node:crypto';
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
 */
export function createAuth(authCfg, log = console) {
  const enabled = !!(authCfg && authCfg.user && authCfg.passHash);
  if (!authCfg) {
    log.warn('[auth] config.auth 미설정 — API/WS 보호 비활성(기존 동작 유지). 외부 노출 시 설정을 권장해요');
  } else if (!enabled) {
    log.warn('[auth] config.auth 가 불완전(user·passHash 필요) — 인증 비활성으로 기동해요');
  }
  const ttlSec = Number(authCfg?.sessionTtlSec) || 86400;
  const sessions = new Map(); // sid -> { user, expires(ms) }

  // 만료 세션 청소 (10분 주기, 프로세스 종료 비차단)
  setInterval(() => {
    const t = Date.now();
    for (const [sid, s] of sessions) if (s.expires < t) sessions.delete(sid);
  }, 600 * 1000).unref();

  /** 로그인 시도 — 성공 시 세션 id, 실패 시 null. 사용자명·비밀번호 모두 상수시간 비교 */
  function login(user, pass) {
    if (!enabled) return null;
    const userOk = crypto.timingSafeEqual(sha256(user ?? ''), sha256(authCfg.user));
    const passOk = verifyPassword(pass ?? '', authCfg.passHash); // user 불일치여도 항상 계산(타이밍 균일화)
    if (!(userOk && passOk)) return null;
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { user: String(authCfg.user), expires: Date.now() + ttlSec * 1000 });
    return sid;
  }

  /** 요청 쿠키에서 유효 세션 조회 → { user } | null */
  function sessionFrom(req) {
    const sid = parseCookies(req.headers?.cookie)[COOKIE];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(sid); return null; }
    return s;
  }

  /** 요청의 세션 폐기 (로그아웃) */
  function logout(req) {
    const sid = parseCookies(req.headers?.cookie)[COOKIE];
    if (sid) sessions.delete(sid);
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
