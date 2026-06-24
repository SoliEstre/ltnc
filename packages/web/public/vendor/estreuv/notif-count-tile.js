/**
 * EstreUV — Notification Count Tile (Phase C, tile 3/3)
 *
 * overwatchPanel widget tile 3번째 — **external-driven reactivity** 패턴 검증.
 * dark-mode-tile = localStorage + 글로벌 API 위임, clock-tile = timer-driven 이라면
 * 이건 "외부 (intent / 메서드 호출) 가 count 를 밀어넣는" 패턴. intent context 의 값을
 * onShow 시 읽어서 reactive prop 에 반영 + `bump()` / `clear()` 공개 메서드.
 *
 * F1 기여: onShow 시 intent → reactive prop 동기 (재방문 시 매번 최신값)
 * F3 기여: `*c` (Alienese) → `count`, `*max` → `maxDisplay`, `*t` → `text`
 * dual binding 기여: count 변경을 직접 mutate 하지 않고 `requestIntentUpdate({ notifCount })` 로 owner 에게 위임
 */

import { html, css } from 'lit';
import { EstreUVElement } from './estreuv-element.js';
import { applyAliases } from './alienese-alias.js';

export class NotifCountTile extends EstreUVElement {

    /** Alienese alias: `*c` → `count`, `*max` → `maxDisplay`, `*t` → `text` */
    static aliases = {
        '*c': 'count',
        '*max': 'maxDisplay',
        '*t': 'text',
    };

    static properties = {
        ...EstreUVElement.properties,
        // count · maxDisplay · text 는 applyAliases() 가 자동 추가 ({type: String, reflect: true})
        // count 는 숫자지만 attribute 로 들어올 땐 문자열 → 내부에서 Number() 정규화
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
            cursor: pointer;
            user-select: none;
            min-width: 72px;
            font-family: system-ui, sans-serif;
            color: var(--estreuv-tile-color, inherit);
        }
        :host(:hover) { opacity: 0.85; }
        .badge {
            position: relative;
            font-size: 1.6rem;
            line-height: 1;
        }
        .badge[data-has-count]::after {
            content: attr(data-count);
            position: absolute;
            top: -6px;
            right: -10px;
            min-width: 16px;
            height: 16px;
            padding: 0 3px;
            box-sizing: border-box;
            border-radius: 8px;
            background: #e3413a;
            color: #fff;
            font-size: 0.62rem;
            font-weight: 700;
            line-height: 16px;
            text-align: center;
        }
        .label {
            font-size: 0.75rem;
            opacity: 0.7;
        }
    `;

    constructor() {
        super();
        this.count = 0;
        this.maxDisplay = 99;
        this._numCount = 0;
    }

    willUpdate(changedProperties) {
        super.willUpdate?.(changedProperties);
        // 라이브 intent → count 동기 (prop-down). onShow 뿐 아니라 intent 가 바뀔 때마다 반영.
        if (changedProperties.has('intent')) {
            const fromIntent = this.intent?.notifCount ?? this.intent?.data?.notifCount;
            if (fromIntent != null && Number(fromIntent) !== Number(this.count)) {
                this.count = Number(fromIntent);
            }
        }
        if (changedProperties.has('count')) {
            const n = Number(this.count);
            this._numCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
        }
    }

    /** 표시용 문자열 — maxDisplay 초과 시 "N+" */
    _displayCount() {
        const max = Number(this.maxDisplay);
        const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 99;
        return this._numCount > cap ? `${cap}+` : String(this._numCount);
    }

    /** 외부 공개 메서드 — count +by. 직접 mutate 하지 않고 intent 위임 (dual binding 회피) */
    bump(by = 1) {
        const cur = Number(this.count);
        const base = Number.isFinite(cur) && cur >= 0 ? Math.floor(cur) : 0;
        const next = Math.max(0, base + (Number(by) || 1));
        this.count = next;                              // local reactive prop (낙관적 갱신, source of truth)
        this.requestIntentUpdate({ notifCount: next }); // owner article 에 위임
    }

    /** 외부 공개 메서드 — count 0 으로 */
    clear() {
        this.count = 0;
        this.requestIntentUpdate({ notifCount: 0 });
    }

    render() {
        const hasCount = this._numCount > 0;
        return html`
            <div class="badge" ?data-has-count=${hasCount} data-count=${this._displayCount()} aria-hidden="true">🔔</div>
            <div class="label">${this.text || (hasCount ? `${this._numCount} new` : 'no alerts')}</div>
        `;
    }

    firstUpdated() {
        this.addEventListener('click', () => this.bump());
    }

    // ─── EstreUI 라이프사이클 — intent → reactive prop 동기 ──────────────

    /** 화면에 표시됨 — intent context 의 notifCount 를 읽어 최신값 반영 (재방문 시 매번) */
    onShow(handle) {
        super.onShow(handle);
        const fromIntent = this.intent?.notifCount ?? this.intent?.data?.notifCount;
        if (fromIntent != null && Number(fromIntent) !== this._numCount) {
            this.count = Number(fromIntent);
        }
    }
}

applyAliases(NotifCountTile);
customElements.define('estreuv-notif-count-tile', NotifCountTile);
