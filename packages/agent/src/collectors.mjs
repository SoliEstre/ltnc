// collectors.mjs — 시스템 지표 수집 (/proc delta 기반 · win32 개발용 폴백)
// 규약: 누적 카운터는 두 시점 delta 로 계산(이전 샘플 상태 보관), guest 는 user/nice 에 포함이라 제외.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';

const isLinux = process.platform === 'linux';
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

// ---- 디스크 사용률(%) + 실제 용량(GB) (mounts: config) ----
const GiB = 1073741824;
async function diskUsage(out, mounts) {
  for (const m of mounts) {
    try {
      const s = await fs.promises.statfs(m);
      const key = m === '/' ? 'root' : m.replace(/^\/+/, '').replace(/\//g, '_');
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
  await diskUsage(out, cfg.mounts || ['/']);
  diskio(out, intervalSec);
  netio(out, intervalSec, cfg);
  await systemd(out, cfg.systemdUnits || []);
  await ports(out, cfg.ports || []);
  await execMetrics(out, cfg.execMetrics || []);
  return out;
}
