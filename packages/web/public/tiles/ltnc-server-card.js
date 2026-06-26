// @provenance source=eux/ltnc-server-card.eux sha256=ce17ce12a9a9bdbe054d9a1abb153439fdd6b14955f47a31b4e6b46122cef224 target=estreuv
// @expansion temperature=0.0 model=claude-fable-5[1m] template=agent/claude-code@ltnc-m1
// @hand-revision 2026-06-15 (M3) — 디스크 게이지: 최악 1개 → 마운트별 전부(_disks). .eux 동기 갱신(재-brew 시 sha 재산정 필요).
// @hand-revision 2026-06-19 — 게이지 조건부: loop.lag 보유 서버(@hub 허브 자가감시)는 cpu/mem/disk 대신 루프지연(평균·최대) 게이지; 그 외도 값 없는 게이지 미표시(빈 '—' 제거). .eux 동기 갱신.
//
// <ltnc-server-card server="web-1"> — 서버 1대의 현재 상태 카드.
// 온라인 점 · CPU/메모리/디스크 미니 게이지(<ltnc-stat-gauge>) · 서비스/포트 뱃지 · 인증서 D-n.
// LTNC.on('metrics'/'presence'/'init') 실시간 갱신, disconnectedCallback 에서 전부 해제.
// 클릭 → CustomEvent('ltnc:open-server', {detail:{server}, bubbles, composed}) — Lane A 가 수신.

import { html, css, nothing } from 'lit';
import { EstreUVElement } from 'estreuv';
import './ltnc-stat-gauge.js';

export class LtncServerCard extends EstreUVElement {

    static properties = {
        ...EstreUVElement.properties,
        /** 표시할 서버 id (필수, 예: web-1) */
        server: { type: String },
        /** LTNC.server(server) 스냅샷 — 내부 state */
        _info: { state: true },
        /** presence 반영 */
        _online: { state: true },
        /** 마지막 metrics 수신 epoch sec */
        _lastTs: { state: true },
        /** "n초 전" 상대시간 재계산용 tick */
        _tick: { state: true },
    };

    static styles = css`
        :host { display: block; font-family: system-ui, sans-serif; }
        .card {
            background: var(--ltnc-card, #1a1d23);
            color: var(--ltnc-text, #e8eaed);
            border: 1px solid color-mix(in srgb, var(--ltnc-border, #9aa0a6) 14%, transparent);
            border-radius: 12px;
            padding: 14px 16px;
            cursor: pointer;
            transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
            user-select: none;
        }
        .card:hover {
            border-color: var(--ltnc-accent, #ff9500);
            transform: translateY(-2px);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        }
        .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
        .dot {
            width: 9px; height: 9px; border-radius: 50%;
            align-self: center; flex: none;
            background: var(--ltnc-crit, #ff4d4f);
        }
        .dot.on {
            background: var(--ltnc-ok, #34c759);
            box-shadow: 0 0 6px var(--ltnc-ok, #34c759);
        }
        .name { font-weight: 700; font-size: 1.02rem; }
        .host {
            color: var(--ltnc-dim, #9aa0a6); font-size: 0.78rem;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .gauges { display: flex; flex-wrap: wrap; gap: 12px 14px; justify-content: space-around; margin-bottom: 10px; }
        .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .badge {
            font-size: 0.7rem; line-height: 1;
            padding: 4px 8px; border-radius: 999px;
            border: 1px solid transparent;
            font-variant-numeric: tabular-nums;
        }
        .badge.up {
            color: var(--ltnc-ok, #34c759);
            border-color: color-mix(in srgb, var(--ltnc-ok, #34c759) 45%, transparent);
            background: color-mix(in srgb, var(--ltnc-ok, #34c759) 12%, transparent);
        }
        .badge.down {
            color: var(--ltnc-crit, #ff4d4f);
            border-color: color-mix(in srgb, var(--ltnc-crit, #ff4d4f) 45%, transparent);
            background: color-mix(in srgb, var(--ltnc-crit, #ff4d4f) 12%, transparent);
        }
        .foot {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 0.74rem; color: var(--ltnc-dim, #9aa0a6);
        }
        .cert.warn { color: var(--ltnc-warn, #ffb020); }
        .cert.crit { color: var(--ltnc-crit, #ff4d4f); font-weight: 700; }
        .empty { color: var(--ltnc-dim, #9aa0a6); font-size: 0.8rem; padding: 8px 0 14px; }
    `;

    constructor() {
        super();
        this.server = '';
        this._info = null;
        this._online = false;
        this._lastTs = 0;
        this._tick = 0;
        this._offs = [];      // LTNC 구독 해제 함수 보관
        this._tickTimer = null; // 상대시간 갱신 타이머
    }

    // ─── LTNC 와이어링 ──────────────────────────────────────────────────────
    /** 스냅샷 재읽기 — LTNC 미로드여도 안전 no-op */
    _resync() {
        const LTNC = window.LTNC;
        if (!LTNC || !this.server) return;
        const s = LTNC.server(this.server);
        if (s) {
            this._info = s;
            this._online = !!s.online;
            this._lastTs = s.lastSeen || 0;
        }
    }

    connectedCallback() {
        super.connectedCallback();
        this._resync();
        const LTNC = window.LTNC;
        if (LTNC) {
            this._offs.push(
                LTNC.on('init', () => this._resync()), // (재)접속 init — 전체 스냅샷 교체
                LTNC.on('metrics', (m) => {
                    if (m.server !== this.server) return;
                    if (!this._info) this._resync();   // 늦게 등장한 서버
                    this._online = true;
                    this._lastTs = m.ts;               // reactive — latest 는 코어가 같은 객체에 반영
                }),
                LTNC.on('presence', (m) => {
                    if (m.server !== this.server) return;
                    this._online = m.online;
                }),
            );
        }
        // "n초 전" 표기를 10초마다 재계산 (가벼운 tick)
        this._tickTimer = setInterval(() => { this._tick++; }, 10000);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._offs.forEach((off) => { try { off(); } catch {} });
        this._offs = [];
        if (this._tickTimer != null) { clearInterval(this._tickTimer); this._tickTimer = null; }
    }

    /** 카드 클릭 — Lane A 림이 수신해 상세 페이지로 전환 */
    _open() {
        this.dispatchEvent(new CustomEvent('ltnc:open-server', {
            detail: { server: this.server },
            bubbles: true,
            composed: true,
        }));
    }

    // ─── 파생값 ─────────────────────────────────────────────────────────────
    _latestVal(metric) {
        const v = this._info && this._info.latest && this._info.latest[metric];
        return v ? v.value : NaN;
    }

    /** disk.<mount>.used_pct 전부 → 마운트별 게이지 목록 (root 우선, 짧은 라벨) */
    _disks() {
        const latest = (this._info && this._info.latest) || {};
        const out = [];
        for (const [k, v] of Object.entries(latest)) {
            const m = k.match(/^disk\.(.+)\.used_pct$/);
            if (!m) continue;
            const mount = m[1];
            // 짧은 라벨: root → '디스크', 그 외 → 마지막 경로 조각(usr_local_tomcat_logs → logs)
            const seg = mount.split('_').pop();
            const label = mount === 'root' ? '디스크' : (seg || mount);
            out.push({ key: k, mount, pct: v.value, label });
        }
        return out.sort((a, b) => (a.mount === 'root' ? -1 : b.mount === 'root' ? 1 : a.mount.localeCompare(b.mount)));
    }

    /** svc.<unit>.active + port.<n>.open → 뱃지 목록 */
    _badges() {
        const latest = (this._info && this._info.latest) || {};
        const out = [];
        for (const [k, v] of Object.entries(latest)) {
            if (/^svc\..+\.active$/.test(k) || /^port\.\d+\.open$/.test(k)) {
                const L = window.LTNC ? window.LTNC.label(k) : { name: k };
                out.push({ name: L.name, up: v.value === 1 });
            }
        }
        // 서비스 먼저, 포트(':' 시작) 나중 — 안정 정렬
        return out.sort((a, b) => (a.name.startsWith(':') ? 1 : 0) - (b.name.startsWith(':') ? 1 : 0) || a.name.localeCompare(b.name, 'ko'));
    }

    /** 인증서 만료 잔여일 — latest 키 중 /cert/i 매칭(운영 규약: exec.cert_*_days)의 최솟값. 없으면 null */
    _certDays() {
        const latest = (this._info && this._info.latest) || {};
        let min = null;
        for (const [k, v] of Object.entries(latest)) {
            if (/cert/i.test(k) && Number.isFinite(v.value)) {
                if (min === null || v.value < min) min = v.value;
            }
        }
        return min === null ? null : Math.round(min);
    }

    /** lastTs 기준 상대시간 — 초/분/시 자동 단위 */
    _ago() {
        void this._tick; // tick 의존 — 10초마다 재계산
        if (!this._lastTs) return '';
        const sec = Math.max(0, Math.floor(Date.now() / 1000 - this._lastTs));
        if (sec < 60) return `${sec}초 전`;
        if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
        return `${Math.floor(sec / 3600)}시간 전`;
    }

    render() {
        const info = this._info;
        const disks = this._disks();
        const cert = this._certDays();
        const certCls = cert === null ? '' : cert <= 7 ? 'crit' : cert <= 30 ? 'warn' : '';
        return html`
            <div class="card" role="button" tabindex="0" aria-label="${this.server} 상세 열기"
                 @click=${this._open}
                 @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._open(); } }}>
                <div class="head">
                    <span class="dot ${this._online ? 'on' : ''}" title="${this._online ? '온라인' : '오프라인'}"></span>
                    <span class="name">${this.server}</span>
                    <span class="host">${info ? info.host : ''}</span>
                </div>
                ${!info ? html`<div class="empty">데이터 없음 — 허브 응답 대기 중</div>` : html`
                    <div class="gauges">
                        ${Number.isFinite(this._latestVal('loop.lag_ms'))
                            ? html`
                                <ltnc-stat-gauge metric="loop.lag_ms" .value=${this._latestVal('loop.lag_ms')} max="200" warn="50" crit="200"></ltnc-stat-gauge>
                                ${Number.isFinite(this._latestVal('loop.lag_max_ms'))
                                    ? html`<ltnc-stat-gauge metric="loop.lag_max_ms" .value=${this._latestVal('loop.lag_max_ms')} max="500" warn="100" crit="500"></ltnc-stat-gauge>`
                                    : nothing}`
                            : html`
                                ${Number.isFinite(this._latestVal('cpu.pct')) ? html`<ltnc-stat-gauge metric="cpu.pct" .value=${this._latestVal('cpu.pct')}></ltnc-stat-gauge>` : nothing}
                                ${Number.isFinite(this._latestVal('mem.used_pct')) ? html`<ltnc-stat-gauge metric="mem.used_pct" .value=${this._latestVal('mem.used_pct')}></ltnc-stat-gauge>` : nothing}
                                ${disks.map((d) => html`<ltnc-stat-gauge metric="${d.key}" .value=${d.pct} label="${d.label}"></ltnc-stat-gauge>`)}`}
                    </div>
                    ${this._badges().length ? html`
                        <div class="badges">
                            ${this._badges().map((b) => html`
                                <span class="badge ${b.up ? 'up' : 'down'}"
                                      title="${b.up ? '정상' : '응답 없음'}">${b.name}</span>`)}
                        </div>` : nothing}
                    <div class="foot">
                        <span class="cert ${certCls}">
                            ${cert === null ? nothing : cert < 0 ? '인증서 만료됨!' : `인증서 D-${cert}`}
                        </span>
                        <span>${this._ago()}</span>
                    </div>
                `}
            </div>
        `;
    }
}

if (!customElements.get('ltnc-server-card')) {
    customElements.define('ltnc-server-card', LtncServerCard);
}
