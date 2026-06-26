// @provenance source=eux/ltnc-stat-gauge.eux sha256=dafe9b567d81947ce2e5a19808a0d84c336bde56437ba6e06423195286fd9f68 target=estreuv
// @expansion temperature=0.0 model=claude-fable-5[1m] template=agent/claude-code@ltnc-m1
//
// <ltnc-stat-gauge metric="cpu.pct" value="12.3"> — 메트릭 1개를 보여주는 소형 SVG 링 게이지.
// 기본 경로 = 부모(서버 카드)가 .value property 로 내려줌. server attribute 를 주면
// 단독 모드 — LTNC 에서 직접 최신값을 읽고 'metrics' 이벤트로 실시간 갱신.
// 외부 차트 라이브러리 없음(가벼움 우선) — SVG 원 2개 + stroke-dasharray.

import { html, css, svg } from 'lit';
import { EstreUVElement } from 'estreuv';

// 링 기하 상수 — 반지름 24px, 270° 스윕(바닥 90° 갭)
const R = 24;
const CIRC = 2 * Math.PI * R;     // 전체 둘레
const SWEEP = 0.75;               // 270° = 둘레의 75%

export class LtncStatGauge extends EstreUVElement {

    static properties = {
        ...EstreUVElement.properties,
        /** 메트릭 이름 (예: cpu.pct) — LTNC.label 로 한글 라벨/단위 해석 */
        metric: { type: String },
        /** 표시 값 — 부모가 property 로 내려주는 게 기본 경로 */
        value: { type: Number },
        /** (선택) 지정 시 단독 모드 — LTNC 에서 직접 구독 */
        server: { type: String },
        /** (선택) 라벨 덮어쓰기 (예: 디스크 mount 표기) */
        label: { type: String },
        /** 링 만충 기준 (% 메트릭은 100) */
        max: { type: Number },
        /** 경고 임계 — 이상이면 주황 */
        warn: { type: Number },
        /** 위험 임계 — 이상이면 빨강 */
        crit: { type: Number },
    };

    static styles = css`
        :host {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
            font-family: system-ui, sans-serif;
            color: var(--ltnc-text, #e8eaed);
            user-select: none;
        }
        .ring { position: relative; width: 56px; height: 56px; }
        svg { display: block; transform: rotate(135deg); } /* 갭이 바닥에 오도록 회전 */
        .track { stroke: color-mix(in srgb, var(--ltnc-dim, #9aa0a6) 26%, transparent); }
        .bar { transition: stroke-dasharray 300ms ease, stroke 300ms ease; }
        .center {
            position: absolute; inset: 0;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            line-height: 1;
        }
        .val { font-size: 0.85rem; font-weight: 600; font-variant-numeric: tabular-nums; }
        .val.empty { opacity: 0.35; }
        .unit { font-size: 0.55rem; color: var(--ltnc-dim, #9aa0a6); margin-top: 1px; }
        .label {
            font-size: 0.68rem;
            color: var(--ltnc-dim, #9aa0a6);
            max-width: 72px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
    `;

    constructor() {
        super();
        this.metric = '';
        this.value = NaN;
        this.server = '';
        this.label = '';
        this.max = 100;
        this.warn = 70;
        this.crit = 90;
        this._offs = []; // LTNC 구독 해제 함수 보관(단독 모드)
    }

    // ─── 단독 모드: LTNC 직접 구독 ─────────────────────────────────────────
    connectedCallback() {
        super.connectedCallback();
        const LTNC = window.LTNC;
        if (!this.server || !LTNC) return; // 부모 주도 모드 또는 LTNC 미로드 — 구독 없음
        const s = LTNC.server(this.server);
        const init = s && s.latest && s.latest[this.metric];
        if (init) this.value = init.value;
        this._offs.push(
            LTNC.on('metrics', (m) => {
                if (m.server !== this.server) return;
                if (Object.prototype.hasOwnProperty.call(m.metrics, this.metric)) {
                    this.value = m.metrics[this.metric];
                }
            }),
            LTNC.on('init', () => { // 재접속 스냅샷 재반영
                const s2 = LTNC.server(this.server);
                const v = s2 && s2.latest && s2.latest[this.metric];
                if (v) this.value = v.value;
            }),
        );
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._offs.forEach((off) => { try { off(); } catch {} });
        this._offs = [];
    }

    // ─── 표시 헬퍼 ──────────────────────────────────────────────────────────
    /** 임계 기반 상태색 — ok(초록) / warn(주황) / crit(빨강) */
    _color() {
        if (!Number.isFinite(this.value)) return 'var(--ltnc-dim, #9aa0a6)';
        if (this.value >= this.crit) return 'var(--ltnc-crit, #ff4d4f)';
        if (this.value >= this.warn) return 'var(--ltnc-warn, #ffb020)';
        return 'var(--ltnc-ok, #34c759)';
    }

    /** 링 채움 비율 0~1 — NaN 이면 0(빈 링) */
    _ratio() {
        if (!Number.isFinite(this.value) || this.max <= 0) return 0;
        return Math.min(1, Math.max(0, this.value / this.max));
    }

    _labelInfo() {
        const L = (window.LTNC && this.metric) ? window.LTNC.label(this.metric) : { name: this.metric, unit: '' };
        return { name: this.label || L.name, unit: L.unit };
    }

    _valueText(unit) {
        if (!Number.isFinite(this.value)) return '–';
        return unit === '%' ? String(Math.round(this.value)) : String(Math.round(this.value * 10) / 10);
    }

    render() {
        const { name, unit } = this._labelInfo();
        const dashTrack = `${CIRC * SWEEP} ${CIRC}`;
        const dashBar = `${CIRC * SWEEP * this._ratio()} ${CIRC}`;
        const empty = !Number.isFinite(this.value);
        return html`
            <div class="ring" title="${name}${empty ? '' : ` ${this._valueText(unit)}${unit}`}">
                ${svg`<svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
                    <circle class="track" cx="28" cy="28" r="${R}" fill="none"
                            stroke-width="5" stroke-linecap="round" stroke-dasharray="${dashTrack}"></circle>
                    <circle class="bar" cx="28" cy="28" r="${R}" fill="none"
                            stroke="${this._color()}" stroke-width="5" stroke-linecap="round"
                            stroke-dasharray="${dashBar}"></circle>
                </svg>`}
                <div class="center">
                    <span class="val ${empty ? 'empty' : ''}">${this._valueText(unit)}</span>
                    ${unit ? html`<span class="unit">${unit}</span>` : ''}
                </div>
            </div>
            <div class="label">${name}</div>
        `;
    }
}

if (!customElements.get('ltnc-stat-gauge')) {
    customElements.define('ltnc-stat-gauge', LtncStatGauge);
}
