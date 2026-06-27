// collectors.mjs — 시스템 지표 수집 (Linux=/proc delta · Windows=WMI delta + fs.statfs)
// 규약: 누적 카운터는 두 시점 delta 로 계산(이전 샘플 상태 보관), guest 는 user/nice 에 포함이라 제외.
// Windows: 디스크 용량은 fs.statfs(크로스플랫폼), 네트워크·디스크IO 는 WMI(Win32_PerfRawData_*) 누적
//          카운터를 PowerShell(pwsh 우선·powershell.exe 폴백) 1콜/샘플로 읽어 동일 delta 패턴으로 rate 산출.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';

const isLinux = process.platform === 'linux';
const isWin = process.platform === 'win32';
const state = { cpu: null, cores: null, diskio: null, net: null, winCpu: null };

const readProc = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// ---- CPU ----
function cpuLinux(out) {
  const lines = readProc('/proc/stat').split('\n').filter(l => l.startsWith('cpu'));
  if (!lines.length) return;
  const parse = (l) => {
    const f = l.trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f; // guest 제외
    const idleAll = idle + iowait;
    const total = user + nice + sys + idleAll + irq + softirq + steal;
    return { total, idle: idleAll };
  };
  const agg = parse(lines[0]);
  const cores = lines.slice(1).map(parse);
  if (state.cpu) {
    const dt = agg.total - state.cpu.total, di = agg.idle - state.cpu.idle;
    if (dt > 0) out['cpu.pct'] = Math.max(0, Math.min(100, (1 - di / dt) * 100));
    let coreMax = 0;
    cores.forEach((c, i) => {
      const p = state.cores?.[i];
      if (p) { const t = c.total - p.total, id = c.idle - p.idle; if (t > 0) coreMax = Math.max(coreMax, (1 - id / t) * 100); }
    });
    if (cores.length) out['cpu.core_max_pct'] = Math.max(0, Math.min(100, coreMax));
  }
  state.cpu = agg; state.cores = cores;
}
function cpuWin(out) {
  const cpus = os.cpus();
  const agg = cpus.reduce((a, c) => { for (const k in c.times) a[k] = (a[k] || 0) + c.times[k]; return a; }, {});
  const total = Object.values(agg).reduce((a, b) => a + b, 0);
  if (state.winCpu) {
    const dt = total - state.winCpu.total, di = agg.idle - state.winCpu.idle;
    if (dt > 0) out['cpu.pct'] = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  state.winCpu = { total, idle: agg.idle };
}

// ---- 메모리 ----
function mem(out) {
  if (isLinux) {
    const mi = Object.fromEntries(readProc('/proc/meminfo').split('\n')
      .map(l => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map(m => [m[1], Number(m[2])]));
    if (mi.MemTotal) {
      const usedKb = mi.MemTotal - (mi.MemAvailable ?? mi.MemFree ?? 0);
      out['mem.total_mb'] = mi.MemTotal / 1024;
      out['mem.used_mb'] = usedKb / 1024;
      out['mem.used_pct'] = usedKb / mi.MemTotal * 100;
    }
  } else {
    const t = os.totalmem(), f = os.freemem();
    out['mem.total_mb'] = t / 1048576; out['mem.used_mb'] = (t - f) / 1048576; out['mem.used_pct'] = (t - f) / t * 100;
  }
  out['load.1m'] = os.loadavg()[0];
}

// ---- 디스크 사용률(%) + 실제 용량(GB) (mounts: config) — fs.statfs 는 크로스플랫폼(Windows 드라이브도 OK) ----
const GiB = 1073741824;
function diskKey(m) {
  if (/^[A-Za-z]:[\\/]?$/.test(m)) return m[0].toLowerCase();                                   // Windows 드라이브 루트 'C:\' → 'c'
  if (/^[A-Za-z]:/.test(m)) return m.replace(/[\\/:]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase(); // 서브폴더 'C:\Data' → 'c_data'
  return m === '/' ? 'root' : m.replace(/^\/+/, '').replace(/\//g, '_');                          // Linux 마운트 '/' → root · '/mnt/x' → mnt_x
}
async function diskUsage(out, mounts) {
  for (const m of mounts) {
    try {
      const s = await fs.promises.statfs(m);
      const key = diskKey(m);
      out[`disk.${key}.used_pct`] = (1 - s.bavail / s.blocks) * 100;        // df 와 근사
      out[`disk.${key}.used_gb`] = (s.blocks - s.bfree) * s.bsize / GiB;     // df Used 컬럼
      out[`disk.${key}.total_gb`] = s.blocks * s.bsize / GiB;               // 총 용량(전체-스케일·차트 toggle 용)
    } catch { /* 마운트 없음 — 무시 */ }
  }
}

// ---- 디스크 IO (/proc/diskstats — 물리 디바이스만, 섹터=512B) ----
function diskio(out, intervalSec) {
  if (!isLinux) return;
  let rd = 0, wr = 0;
  for (const l of readProc('/proc/diskstats').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 14) continue;
    const dev = f[2];
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(dev)) continue; // loop/dm/파티션 제외
    rd += Number(f[5]); wr += Number(f[9]);
  }
  if (state.diskio && intervalSec > 0) {
    out['diskio.read_kbps'] = Math.max(0, (rd - state.diskio.rd) * 512 / 1024 / intervalSec);
    out['diskio.write_kbps'] = Math.max(0, (wr - state.diskio.wr) * 512 / 1024 / intervalSec);
  }
  state.diskio = { rd, wr };
}

// ---- 네트워크 (/proc/net/dev — lo 제외 합산) + 링크속도(전체-스케일 상한용) ----
function netio(out, intervalSec, cfg) {
  if (!isLinux) return;
  let rx = 0, tx = 0, linkMbps = 0;
  for (const l of readProc('/proc/net/dev').split('\n').slice(2)) {
    const m = l.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
    const sp = parseInt(readProc('/sys/class/net/' + iface + '/speed'), 10);  // 물리 NIC 협상속도(Mbps)
    if (Number.isFinite(sp) && sp > 0) linkMbps += sp;
  }
  if (state.net && intervalSec > 0) {
    out['net.rx_kbps'] = Math.max(0, (rx - state.net.rx) / 1024 / intervalSec);
    out['net.tx_kbps'] = Math.max(0, (tx - state.net.tx) / 1024 / intervalSec);
  }
  // 가상 NIC(Xen 등)는 협상속도 미노출 → config netLinkMbps 폴백(provisioned 대역폭)
  if (linkMbps <= 0 && cfg && Number(cfg.netLinkMbps) > 0) linkMbps = Number(cfg.netLinkMbps);
  if (linkMbps > 0) out['net.link_mbps'] = linkMbps;
  state.net = { rx, tx };
}

// ---- Windows 성능 카운터 (네트워크 + 디스크IO 누적 바이트) — PS 1콜/샘플 ----
// /proc 등가가 없어 누적 카운터를 읽어 delta 로 rate 산출. net+diskIO 를 한 번의 PS 호출로 합쳐 비용 최소화.
//  · 네트워크: Get-NetAdapter -Physical|Status=Up — 하드웨어 기준(언어/지역화 무관)이라 vSwitch(Hyper-V)·NIC팀·
//    터널·끊긴 NIC 를 자동 배제 → rx/tx 이중카운트 방지. link 은 max(물리 NIC 속도, bits/sec).
//  · present-신호: 소스가 없으면 해당 키를 *출력하지 않음*(0 baseline 오염 방지 — Node 가 undefined 로 skip).
//  · 2^53 초과 정밀도: 누적 바이트가 9PB 넘어야 ULP 발생, 그조차 ULP≪delta 라 rate 무해(delta-only 사용).
const WIN_PS =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$up=Get-NetAdapter -Physical|Where-Object{$_.Status -eq 'Up'};" +
  "$rx=[uint64]0;$tx=[uint64]0;$bw=[uint64]0;$nc=0;" +
  "foreach($x in $up){$s=$x|Get-NetAdapterStatistics;if($s){$rx+=[uint64]$s.ReceivedBytes;$tx+=[uint64]$s.SentBytes;$nc++};if([uint64]$x.Speed -gt $bw){$bw=[uint64]$x.Speed}};" +
  "$d=Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk|Where-Object{$_.Name -eq '_Total'}|Select-Object -First 1;" +
  "$o=[ordered]@{};if($nc -gt 0){$o.rx=$rx;$o.tx=$tx;$o.bw=$bw};if($d){$o.dr=[uint64]$d.DiskReadBytesPersec;$o.dw=[uint64]$d.DiskWriteBytesPersec};" +
  "[pscustomobject]$o|ConvertTo-Json -Compress";

let _psExe; // undefined=미해결 · 'pwsh'|'powershell'=해결 · null=불가
function resolvePsExe(prefer) {
  if (_psExe !== undefined) return Promise.resolve(_psExe);
  const probe = (exe) => new Promise((res) =>
    execFile(exe, ['-NoProfile', '-Command', 'exit 0'], { timeout: 6000, windowsHide: true },
      (err) => res(!err || err.code !== 'ENOENT')));  // ENOENT=미설치 · 그 외 오류는 존재로 간주
  // 기본 순서 = powershell 우선: Windows PowerShell 5.1 은 콜드스폰이 pwsh7 보다 ~2배 빠르고(매 샘플 spawn 패턴에 유리)
  // Windows Server 에 항상 상존. cfg.psExe='pwsh' 로 강제 가능. 둘 다 WIN_PS 동일 결과.
  const order = prefer ? [prefer, prefer === 'pwsh' ? 'powershell' : 'pwsh'] : ['powershell', 'pwsh'];
  return (async () => {
    for (const exe of order) { if (await probe(exe)) { _psExe = exe; return exe; } }
    _psExe = null; return null;  // 둘 다 없음(비정상 — Windows 면 powershell 은 상존)
  })();
}
async function winPerf(cfg, timeout = 15000) {  // 콜드스폰 + Get-NetAdapter 부하 헤드룸(tick 재진입가드라 interval 초과 무방)
  const exe = await resolvePsExe(cfg && cfg.psExe);
  if (!exe) return null;
  return new Promise((res) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], { timeout, windowsHide: true },
      (err, stdout) => { if (err) return res(null); try { res(JSON.parse(stdout) || null); } catch { res(null); } });
  });
}
// 누적 카운터 → rate(kbps): 키 present(undefined/null 아님) + finite + 비음수 delta 일 때만 보고.
// 실측 경과시간(now-state.t)으로 나눠 누락 구간 복구 시 스파이크 방지. dropout/0-읽기 시 키 없음 → state 미갱신.
// 카운터 reset(음수 delta — 재부팅/NIC reset)은 baseline 만 갱신·rate 미보고(가짜 0 trough 대신 차트 공백).
function netioWin(out, perf, cfg) {
  if (!perf) return;
  let linkMbps = perf.bw != null ? Number(perf.bw) / 1e6 : 0;  // Speed(bits/sec)→Mbps, 즉시값(누적 아님)
  if (!(linkMbps > 0) && cfg && Number(cfg.netLinkMbps) > 0) linkMbps = Number(cfg.netLinkMbps);
  if (linkMbps > 0) out['net.link_mbps'] = linkMbps;
  if (perf.rx == null || perf.tx == null) return;              // 물리 Up NIC 0개 → state 미갱신(스파이크 방지)
  const rx = Number(perf.rx), tx = Number(perf.tx), now = Date.now();
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return;
  if (state.net) {
    const dt = (now - state.net.t) / 1000, drx = rx - state.net.rx, dtx = tx - state.net.tx;
    if (dt > 0 && drx >= 0 && dtx >= 0) { out['net.rx_kbps'] = drx / 1024 / dt; out['net.tx_kbps'] = dtx / 1024 / dt; }
  }
  state.net = { rx, tx, t: now };
}
function diskioWin(out, perf) {
  if (!perf || perf.dr == null || perf.dw == null) return;     // _Total 미존재 → state 미갱신
  const rd = Number(perf.dr), wr = Number(perf.dw), now = Date.now();
  if (!Number.isFinite(rd) || !Number.isFinite(wr)) return;
  if (state.diskio) {
    const dt = (now - state.diskio.t) / 1000, drd = rd - state.diskio.rd, dwr = wr - state.diskio.wr;
    if (dt > 0 && drd >= 0 && dwr >= 0) { out['diskio.read_kbps'] = drd / 1024 / dt; out['diskio.write_kbps'] = dwr / 1024 / dt; }
  }
  state.diskio = { rd, wr, t: now };
}

// ---- systemd 유닛 (ActiveState — active=1) ----
const execP = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : stdout));
});
async function systemd(out, units) {
  if (!isLinux || !units.length) return;
  for (const u of units) {
    const r = await execP('systemctl', ['show', '-p', 'ActiveState', '--value', u]);
    if (r !== null) out[`svc.${u}.active`] = r.trim() === 'active' ? 1 : 0;
  }
}

// ---- 포트 LISTEN 프로브 ----
function portProbe(port, host = '127.0.0.1', timeout = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(1));
    s.on('error', () => done(0));
    s.on('timeout', () => done(0));
  });
}
async function ports(out, list) {
  for (const p of list) out[`port.${p}.open`] = await portProbe(p);
}

// ---- exec 메트릭 (임의 수치 명령 — 복제지연·인증서 만료 등) ----
async function execMetrics(out, defs) {
  for (const d of defs) {
    const r = await execP('bash', ['-c', d.cmd], (d.timeoutSec || 10) * 1000);
    if (r === null) continue;
    const v = parseFloat(String(r).trim());
    if (Number.isFinite(v)) out[`exec.${d.name}`] = v;
  }
}

export async function collect(cfg, intervalSec) {
  const out = {};
  isLinux ? cpuLinux(out) : cpuWin(out);
  mem(out);
  await diskUsage(out, cfg.mounts || (isWin ? ['C:\\'] : ['/']));
  if (isLinux) {
    diskio(out, intervalSec);
    netio(out, intervalSec, cfg);
  } else if (isWin) {
    const perf = await winPerf(cfg);        // net + diskIO 누적 바이트(1 PS 콜)
    netioWin(out, perf, cfg);
    diskioWin(out, perf);
  }
  await systemd(out, cfg.systemdUnits || []);
  await ports(out, cfg.ports || []);
  await execMetrics(out, cfg.execMetrics || []);
  return out;
}
