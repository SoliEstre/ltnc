// auth.mjs — 간단 인증 게이트(다중 계정 + 영속 세션) — M2 계약 §인증
// 계정: 레거시 단일(auth.user/passHash) + auth.users[]({user,passHash,home?}) 병행 — home = 로그인 직후 이동 루트탭.
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
  // 계정 목록 = 레거시 단일(user/passHash) + users[]({user,passHash,home?}) — user·passHash 둘 다 있는 항목만 유효.
  //   home = 로그인 직후 이동할 루트탭 id(예 'stats') — login/me 응답으로 web 에 전달.
  const accounts = [];
  if (authCfg?.user && authCfg?.passHash) accounts.push({ user: String(authCfg.user), passHash: authCfg.passHash, home: authCfg.home ? String(authCfg.home) : null });
  for (const a of (Array.isArray(authCfg?.users) ? authCfg.users : [])) {
    if (a?.user && a?.passHash) accounts.push({ user: String(a.user), passHash: a.passHash, home: a.home ? String(a.home) : null });
  }
  const enabled = accounts.length > 0;
  if (!authCfg) {
    log.warn('[auth] config.auth 미설정 — API/WS 보호 비활성(기존 동작 유지). 외부 노출 시 설정을 권장해요');
  } else if (!enabled) {
    log.warn('[auth] config.auth 가 불완전(user·passHash 필요) — 인증 비활성으로 기동해요');
  } else {
    log.log(`[auth] 계정 ${accounts.length}개 활성 (${accounts.map(a => a.user + (a.home ? `→${a.home}` : '')).join(', ')})`);
  }
  const ttlSec = Number(authCfg?.sessionTtlSec) || 2592000; // 기본 30일 — sliding 연장이라 활동 중엔 사실상 무기한
  const sessions = new Map(); // sid -> { user, home, expires(ms) }
  // 미존재 계정 시도용 더미 해시 — 항상 1회 scrypt 계산해 타이밍 균일화
  const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

  // ── 영속화: 부팅 시 복원(만료분 제외) + 변경 시 디바운스 저장 (vapid.json 과 같은 dataDir 패턴) ──
  const storePath = (enabled && dataDir) ? path.join(dataDir, 'sessions.json') : null;
  if (storePath && fs.existsSync(storePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const t = Date.now();
      for (const [sid, s] of Object.entries(raw)) if (s && s.expires > t) sessions.set(sid, { user: s.user, home: s.home ?? null, expires: s.expires });
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

  /** 로그인 시도 — 성공 시 { sid, user, home }, 실패 시 null. 사용자명 상수시간 비교 + 항상 1회 scrypt */
  function login(user, pass) {
    if (!enabled) return null;
    let matched = null;
    for (const a of accounts) {
      if (crypto.timingSafeEqual(sha256(user ?? ''), sha256(a.user))) matched = a;
    }
    const passOk = verifyPassword(pass ?? '', matched ? matched.passHash : dummyHash); // 미존재 계정도 동일 비용
    if (!(matched && passOk)) return null;
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { user: matched.user, home: matched.home, expires: Date.now() + ttlSec * 1000 });
    persist();
    return { sid, user: matched.user, home: matched.home };
  }

  /** 요청 쿠키에서 유효 세션 조회 → { user, home, sid, renewed } | null.
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
    return { user: s.user, home: s.home ?? null, sid, renewed };
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
