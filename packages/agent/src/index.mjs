// index.mjs — LTNC agent: 수집 루프 + 아웃바운드 WS(지수백오프+지터, ring buffer flush)
// 프로토콜 = docs/PROTOCOL.md v1. 재연결 규율 = 결정 005 §3 (500ms→30s ×2 ±25%, 무한 재시도).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import YAML from 'yaml';
import { collect } from './collectors.mjs';

const cfgPath = process.argv[2] || process.env.LTNC_AGENT_CONFIG || 'agent.yaml';
const cfg = {
  hub: 'ws://127.0.0.1:8420/agent',
  id: os.hostname(),
  token: '',
  intervalSec: 10,
  bufferMax: 3600,
  mounts: process.platform === 'win32' ? ['C:\\'] : ['/'],
  systemdUnits: [],
  ports: [],
  execMetrics: [],
  ...(fs.existsSync(cfgPath) ? YAML.parse(fs.readFileSync(cfgPath, 'utf8')) || {} : {}),
};
if (!cfg.token) { console.error(`[agent] token 미설정 (${path.resolve(cfgPath)})`); process.exit(1); }

const buffer = [];           // 미전송 batch ring buffer
let ws = null, helloAcked = false, backoff = 500;

function connect() {
  const url = `${cfg.hub}?token=${encodeURIComponent(cfg.token)}`;
  ws = new WebSocket(url, { handshakeTimeout: 10000 });

  ws.on('open', () => {
    backoff = 500;
    ws.send(JSON.stringify({ t: 'hello', v: 1, agent: cfg.id, host: os.hostname() }));
  });

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'hello_ack') {
      helloAcked = true;
      console.log(`[agent] hub 접속 OK (buffered=${buffer.length})`);
      flush();
    } else if (m.t === 'ok') {
      // ack 받은 ts 까지 버퍼 정리
      while (buffer.length && buffer[0].ts <= m.ts) buffer.shift();
    }
  });

  const reconnect = () => {
    helloAcked = false;
    const jitter = backoff * (0.75 + Math.random() * 0.5);
    setTimeout(connect, jitter);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.on('close', (code) => { console.warn(`[agent] 연결 끊김(${code}) — 재시도`); reconnect(); });
  ws.on('error', (e) => { ws.terminate?.(); });
}

function flush() {
  if (!helloAcked || !ws || ws.readyState !== WebSocket.OPEN) return;
  for (const b of buffer) ws.send(JSON.stringify(b));
}

let collecting = false;
async function tick() {
  if (collecting) return;                       // 이전 collect 진행중(느린 Windows PS 등) → 이번 tick skip(PS 프로세스 다발 방지)
  collecting = true;
  try {
    const metrics = await collect(cfg, cfg.intervalSec);
    if (!Object.keys(metrics).length) return;
    const batch = { t: 'batch', ts: Math.floor(Date.now() / 1000), metrics };
    buffer.push(batch);
    while (buffer.length > cfg.bufferMax) buffer.shift();
    if (helloAcked && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(batch));
  } catch (e) { console.error('[agent] collect 실패:', e.message); }
  finally { collecting = false; }
}

console.log(`[agent] LTNC agent '${cfg.id}' → ${cfg.hub} (interval=${cfg.intervalSec}s)`);
connect();
tick();                                       // 첫 샘플(카운터 prime)
setInterval(tick, cfg.intervalSec * 1000);
