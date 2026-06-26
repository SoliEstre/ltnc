// @provenance source=eux/ltnc-conn-badge.eux sha256=dcf229c7716cee3e9f4583d5555faf94207d201063928904384fd7297b7d30d6 target=estreuv
// @expansion temperature=0.0 model=claude-fable-5[1m] template=agent/claude-code@ltnc-m1
//
// <ltnc-conn-badge> — 대시보드 ↔ 허브 WebSocket(/live) 연결 상태 알약 뱃지 (헤더 상단용).
// LTNC.on('connection') 구독, disconnectedCallback 에서 해제.

import { html, css } from 'lit';
import { EstreUVElement } from 'estreuv';

const TEXT = {
    connected: '허브 연결됨',
    disconnected: '허브 끊김 — 재접속 중',
    connecting: '허브 연결 중…',
};

export class LtncConnBadge extends EstreUVElement {

    static properties = {
        ...EstreUVElement.properties,
        /** 'connected' | 'disconnected' | 'connecting' */
        _state: { state: true },
    };

    static styles = css`
        :host { display: inline-block; font-family: system-ui, sans-serif; }
        .pill {
            display: inline-flex; align-items: center; gap: 7px;
            padding: 5px 12px; border-radius: 999px;
            background: var(--ltnc-card, #1a1d23);
            border: 1px solid color-mix(in srgb, var(--ltnc-border, #9aa0a6) 18%, transparent);
            color: var(--ltnc-text, #e8eaed);
            font-size: 0.76rem; line-height: 1;
            user-select: none;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
        .dot.connected { background: var(--ltnc-ok, #34c759); box-shadow: 0 0 5px var(--ltnc-ok, #34c759); }
        .dot.disconnected { background: var(--ltnc-crit, #ff4d4f); animation: pulse 1.2s ease-in-out infinite; }
        .dot.connecting { background: var(--ltnc-warn, #ffb020); animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.25; }
        }
    `;

    constructor() {
        super();
        this._state = 'connecting'; // 아직 connection 이벤트를 못 받은 최초 상태
        this._offs = [];
    }

    connectedCallback() {
        super.connectedCallback();
        const LTNC = window.LTNC;
        if (!LTNC) return;
        if (LTNC.connected) this._state = 'connected'; // 이미 연결돼 있던 경우
        this._offs.push(
            LTNC.on('connection', ({ connected }) => {
                this._state = connected ? 'connected' : 'disconnected';
            }),
        );
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._offs.forEach((off) => { try { off(); } catch {} });
        this._offs = [];
    }

    render() {
        return html`
            <span class="pill" role="status" aria-live="polite">
                <span class="dot ${this._state}"></span>
                <span>${TEXT[this._state] || this._state}</span>
            </span>
        `;
    }
}

if (!customElements.get('ltnc-conn-badge')) {
    customElements.define('ltnc-conn-badge', LtncConnBadge);
}
