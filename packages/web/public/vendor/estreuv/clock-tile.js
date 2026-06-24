/**
 * EstreUV — Clock Tile (Phase C, tile 2/3)
 *
 * overwatchPanel widget tile 2번째 — **timer-driven reactivity** 패턴 검증.
 * dark-mode-tile 이 "localStorage + 글로벌 API 위임" 패턴이라면 이건 "주기 타이머 →
 * 내부 reactive state" 패턴. lifecycle hook 이 리소스 (setInterval) 생명주기를 제어하는지가
 * 핵심 검증 포인트 — onShow 시 타이머 시작, onHide 시 정지, onClose/onRelease 시 정리.
 *
 * F1 기여: article lifecycle 이 자식 component 의 리소스 정리를 정확히 트리거
 * F3 기여: `*fmt` (Alienese) → `format` long-form → reactive prop
 * D1 기여: timer tile LoC 측정 base
 */

import { html, css } from 'lit';
import { EstreUVElement } from './estreuv-element.js';
import { applyAliases } from './alienese-alias.js';

export class ClockTile extends EstreUVElement {

    /** Alienese alias: `*fmt` → `format` ('24h' | '12h'), `*t` → `text` (label override) */
    static aliases = {
        '*fmt': 'format',
        '*t': 'text',
    };

    static properties = {
        ...EstreUVElement.properties,
        /** 현재 시각 문자열 (타이머가 매초 갱신) */
        now: { state: true },
        /** 타이머 작동 중 여부 (lifecycle 가 제어) — debug */
        running: { state: true },
        // format · text 는 applyAliases() 가 자동 추가
    };

    static styles = css`
        :host {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding: 8px 14px;
            border: 1px solid var(--estreuv-tile-color, currentColor);
            border-radius: 8px;
            user-select: none;
            min-width: 84px;
            font-family: system-ui, sans-serif;
            color: var(--estreuv-tile-color, inherit);
        }
        .time {
            font-size: 1.3rem;
            line-height: 1;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.02em;
        }
        .label {
            font-size: 0.75rem;
            opacity: 0.7;
        }
        :host(:not([data-running])) .time {
            opacity: 0.4;
        }
    `;

    constructor() {
        super();
        this.format = '24h';
        this.now = this._formatNow();
        this.running = false;
        this._timerId = null;
    }

    _formatNow() {
        const d = new Date();
        const h24 = d.getHours();
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        if (this.format === '12h') {
            const ampm = h24 < 12 ? 'AM' : 'PM';
            const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
            return `${h12}:${m}:${s} ${ampm}`;
        }
        return `${String(h24).padStart(2, '0')}:${m}:${s}`;
    }

    _startTimer() {
        if (this._timerId != null) return;
        this.now = this._formatNow();
        this._timerId = setInterval(() => { this.now = this._formatNow(); }, 1000);
        this.running = true;
        this.toggleAttribute('data-running', true);
    }

    _stopTimer() {
        if (this._timerId == null) return;
        clearInterval(this._timerId);
        this._timerId = null;
        this.running = false;
        this.toggleAttribute('data-running', false);
    }

    willUpdate(changedProperties) {
        super.willUpdate?.(changedProperties);
        if (changedProperties.has('format')) this.now = this._formatNow();
    }

    render() {
        return html`
            <div class="time">${this.now}</div>
            <div class="label">${this.text || (this.running ? 'live' : 'paused')}</div>
        `;
    }

    // ─── EstreUI 라이프사이클 — 리소스 생명주기 제어 (Phase C 핵심 검증) ────

    /** 화면에 표시됨 — 타이머 시작 (재방문 시 매번) */
    onShow(handle) { super.onShow(handle); this._startTimer(); }

    /** 화면에서 가려짐 — 타이머 정지 (불필요한 setInterval 누적 방지) */
    onHide(handle) { super.onHide(handle); this._stopTimer(); }

    /** 페이지 종료 — 확실히 정리 */
    onClose(handle) { super.onClose(handle); this._stopTimer(); }

    /** 인스턴스 release — 최종 정리 (Lit disconnectedCallback 과 별개 채널) */
    onRelease(handle) { super.onRelease(handle); this._stopTimer(); }

    /** 안전망 — DOM 에서 떨어지면 (Lit native) 타이머도 정지 */
    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopTimer();
    }
}

applyAliases(ClockTile);
customElements.define('estreuv-clock-tile', ClockTile);
