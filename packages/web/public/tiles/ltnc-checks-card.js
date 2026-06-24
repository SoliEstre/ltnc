// @provenance source=eux/ltnc-checks-card.eux target=estreuv (hand-authored M3 2026-06-15)
//
// <ltnc-checks-card server="@checks"> — 외부 HTTP 체크(@checks 가상 서버) 전용 카드.
// check.<id>.up(1/0)·check.<id>.ms 를 주소별 행으로: 상태 점 · id · 응답시간 막대 · ms.
// 행 클릭 → 그 체크의 응답시간 단독 그래프(LTNCChartDetail). 일반 서버 카드와 다른 전용 표시.
import { html, css, nothing } from 'lit';
import { EstreUVElement } from 'estreuv';

// ── 응답시간 게이지 등급 (고정 최대 + 구간별 색) ──
const CHECK_MS_MAX = 2000;          // 게이지 고정 최대값(ms) — 초과는 100%(failure)
// 응답시간 시계열 차트(full 스케일)도 동일 기준을 쓰도록 전역 공유 (app.js 의 ltncFullScaleFloor 가 읽음)
if (typeof window !== 'undefined') window.LTNC_CHECK_MS_MAX = CHECK_MS_MAX;
const CHECK_GRADES = [              // ms 상한별 등급 (오름차순) — 마지막(failure)=초과 또는 down
    { key: 'good',    max: 200,      label: 'good',    color: '#34c759' },  // 초록
    { key: 'fine',    max: 500,      label: 'fine',    color: '#8fd14f' },  // 연두
    { key: 'bad',     max: 1000,     label: 'bad',     color: '#ffd60a' },  // 노랑
    { key: 'issue',   max: 2000,     label: 'issue',   color: '#ff9f0a' },  // 주황
    { key: 'failure', max: Infinity, label: 'failure', color: '#ff4d4f' },  // 빨강(초과/실패)
];
function checkGrade(up, ms) {
    if (!up || ms == null) return CHECK_GRADES[CHECK_GRADES.length - 1];     // down/미상 = failure
    return CHECK_GRADES.find((g) => ms <= g.max) || CHECK_GRADES[CHECK_GRADES.length - 1];
}
// 응답시간 시계열 차트 Y축 등급 띠(배경) — 차트 모듈(ltnc-charts.js)이 그림. CHECK_GRADES 단일 소스 공유.
//   [{from, to, fill}] ms 구간별 색. 마지막(failure)은 to=Infinity(차트가 plot 상단까지 채움).
if (typeof window !== 'undefined') window.LTNC_CHECK_BANDS = (() => {
    const out = []; let prev = 0;
    for (const g of CHECK_GRADES) { out.push({ from: prev, to: g.max, fill: g.color }); prev = g.max; }
    return out;
})();

export class LtncChecksCard extends EstreUVElement {

    static properties = {
        ...EstreUVElement.properties,
        server: { type: String },     // 보통 '@checks'
        _rows: { state: true },       // [{id, up, ms}]
        _online: { state: true },
    };

    static styles = css`
        :host { display: block; font-family: system-ui, sans-serif; }
        .card {
            background: var(--ltnc-card, #1a1d23);
            color: var(--ltnc-text, #e8eaed);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 12px;
            padding: 12px 14px;
        }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .ic { font-size: 1rem; }
        .name { font-weight: 700; font-size: 1.0rem; }
        .count {
            margin-left: auto; font-size: 0.74rem; font-variant-numeric: tabular-nums;
            padding: 2px 8px; border-radius: 999px;
            color: var(--ltnc-ok, #34c759);
            border: 1px solid color-mix(in srgb, var(--ltnc-ok, #34c759) 45%, transparent);
            background: color-mix(in srgb, var(--ltnc-ok, #34c759) 12%, transparent);
        }
        .count.bad {
            color: var(--ltnc-crit, #ff4d4f);
            border-color: color-mix(in srgb, var(--ltnc-crit, #ff4d4f) 45%, transparent);
            background: color-mix(in srgb, var(--ltnc-crit, #ff4d4f) 12%, transparent);
        }
        .rows { display: flex; flex-direction: column; gap: 2px; }
        .row {
            display: flex; align-items: center; gap: 8px;
            padding: 4px 6px; border-radius: 7px; cursor: pointer;
            transition: background 120ms ease;
        }
        .row:hover { background: rgba(255,255,255,0.05); }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ltnc-crit, #ff4d4f); }
        .dot.on { background: var(--ltnc-ok, #34c759); box-shadow: 0 0 5px var(--ltnc-ok, #34c759); }
        .id {
            font-size: 0.82rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            flex: 0 0 28%;
        }
        .bar {
            flex: 1 1 auto; height: 6px; border-radius: 3px; overflow: hidden;
            /* 고정 최대(2000ms) 기준 구간 배경을 옅게 표시 — good ≤10% · fine ≤25% · bad ≤50% · issue ≤100% */
            background: linear-gradient(90deg,
                color-mix(in srgb, #34c759 20%, transparent) 0 10%,
                color-mix(in srgb, #8fd14f 20%, transparent) 10% 25%,
                color-mix(in srgb, #ffd60a 20%, transparent) 25% 50%,
                color-mix(in srgb, #ff9f0a 20%, transparent) 50% 100%);
        }
        .bar > span { display: block; height: 100%; border-radius: 3px; transition: width 120ms ease; }
        .grade {
            font-size: 0.7rem; font-weight: 700; flex: none; min-width: 50px; text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .ms {
            font-size: 0.76rem; color: var(--ltnc-dim, #9aa0a6);
            font-variant-numeric: tabular-nums; flex: none; min-width: 48px; text-align: right;
        }
        .row.down .id { color: var(--ltnc-crit, #ff4d4f); }
        .row.down .ms { color: var(--ltnc-crit, #ff4d4f); font-weight: 700; }
        .empty { color: var(--ltnc-dim, #9aa0a6); font-size: 0.82rem; padding: 10px 0; }
        .hint { margin-top: 6px; font-size: 0.68rem; color: var(--ltnc-dim, #9aa0a6); }
    `;

    constructor() {
        super();
        this.server = '@checks';
        this._rows = [];
        this._online = false;
        this._offs = [];
    }

    _resync() {
        const LTNC = window.LTNC;
        if (!LTNC || !this.server) return;
        const s = LTNC.server(this.server);
        this._online = !!(s && s.online);
        const latest = (s && s.latest) || {};
        const map = {};
        for (const [k, v] of Object.entries(latest)) {
            let m;
            if ((m = k.match(/^check\.(.+)\.up$/))) (map[m[1]] = map[m[1]] || {}).up = v.value;
            else if ((m = k.match(/^check\.(.+)\.ms$/))) (map[m[1]] = map[m[1]] || {}).ms = v.value;
        }
        const rows = Object.entries(map).map(([id, o]) => ({ id, up: o.up === 1, ms: o.ms }));
        // 실패(down) 먼저 → id 순
        rows.sort((a, b) => (a.up === b.up ? a.id.localeCompare(b.id) : (a.up ? 1 : -1)));
        this._rows = rows;
    }

    connectedCallback() {
        super.connectedCallback();
        this._resync();
        const LTNC = window.LTNC;
        if (LTNC) {
            this._offs.push(
                LTNC.on('init', () => this._resync()),
                LTNC.on('metrics', (m) => { if (m.server === this.server) this._resync(); }),
                LTNC.on('presence', (m) => { if (m.server === this.server) this._resync(); }),
            );
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._offs.forEach((off) => { try { off(); } catch {} });
        this._offs = [];
    }

    _openCheck(id, e) {
        e.stopPropagation();
        if (window.LTNCChartDetail) window.LTNCChartDetail.open({ server: this.server, metric: 'check.' + id + '.ms' });
    }

    render() {
        const rows = this._rows;
        const up = rows.filter((r) => r.up).length;
        return html`
            <div class="card">
                <div class="head">
                    <span class="ic">🌐</span>
                    <span class="name">외부 체크</span>
                    <span class="count ${up < rows.length ? 'bad' : ''}">${up}/${rows.length} 정상</span>
                </div>
                ${rows.length ? html`
                    <div class="rows">
                        ${rows.map((r) => {
                            const g = checkGrade(r.up, r.ms);
                            // 고정 최대 기준 채움률(0~100%). down 은 full 빨강으로 강조.
                            const pct = r.up ? (r.ms != null ? Math.min(100, r.ms / CHECK_MS_MAX * 100) : 0) : 100;
                            const msText = r.up ? (r.ms != null ? Math.round(r.ms) + 'ms' : '—') : '실패';
                            return html`
                            <div class="row ${r.up ? '' : 'down'}"
                                 @click=${(e) => this._openCheck(r.id, e)}
                                 title="${r.id} — ${g.label} (${msText}) · 눌러서 응답시간 그래프">
                                <span class="dot ${r.up ? 'on' : ''}"></span>
                                <span class="id">${r.id}</span>
                                <span class="bar"><span style="width:${pct}%; background:${g.color};"></span></span>
                                <span class="grade" style="color:${g.color};">${g.label}</span>
                                <span class="ms" style="color:${g.color};">${msText}</span>
                            </div>`;
                        })}
                    </div>
                    <div class="hint">응답시간 게이지: 고정 최대 ${CHECK_MS_MAX}ms · good ≤200 · fine ≤500 · bad ≤1000 · issue ≤2000 · 초과·실패=failure</div>
                ` : html`<div class="empty">외부 체크 대기 중…</div>`}
            </div>
        `;
    }
}

if (!customElements.get('ltnc-checks-card')) {
    customElements.define('ltnc-checks-card', LtncChecksCard);
}
