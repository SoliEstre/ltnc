/**
 * EstreUV — Dark Mode Tile (Phase B 강화)
 *
 * EstreUI v1.3.0 의 overwatchPanel 안 다크 모드 토글 tile 을 EstreUV 컴포넌트로 변환.
 *
 * Phase A → Phase B 변경:
 * - Alienese alias 시스템 적용 (`*t` → `text` · `*c` → `color`) 으로 F3 부분 검증
 * - lifecycle race 검증을 위한 hook count 노출
 *
 * 검증 목표:
 * - F2: EstreUI 없이 단독 페이지에서도 작동 (Phase A 통과)
 * - F3: Alienese 단축 attribute 가 long-form → reactive property → 렌더 반영 작동, 빌드 단계 0
 * - D1: raw Lit 동등 구현 대비 LoC 비교 base
 *
 * 미구현 (Phase C 에서):
 * - EstreUI 와 함께 사용 시 estreUi.cycleDarkMode() 호출 (현재는 직접 토글)
 * - intent 에서 darkMode 상태 읽기 (현재는 컴포넌트가 직접 localStorage 관리)
 */

import { html, css } from 'lit';
import { EstreUVElement } from './estreuv-element.js';
import { applyAliases } from './alienese-alias.js';

const STORAGE_KEY = 'estreuv-spike.darkMode';

export class DarkModeTile extends EstreUVElement {

    /**
     * Alienese alias 선언.
     * - `*t`  → `text`   (label override)
     * - `*c`  → `color`  (icon/border color)
     * 마크업: `<estreuv-dark-mode-tile text="테마" color="purple">` 또는
     *         `<estreuv-dark-mode-tile data-dark-mode-state="auto">` 등.
     * JS:     tile['*t'] = '테마'   → tile.text = '테마'
     */
    static aliases = {
        '*t': 'text',
        '*c': 'color',
    };

    static properties = {
        ...EstreUVElement.properties,
        /** 'auto' | 'light' | 'dark' */
        state: { type: String, reflect: true, attribute: 'data-dark-mode-state' },
        // text · color 는 applyAliases() 가 자동 추가
    };

    static styles = css`
        :host {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding: 8px 12px;
            border: 1px solid var(--estreuv-tile-color, currentColor);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            min-width: 64px;
            font-family: system-ui, sans-serif;
            color: var(--estreuv-tile-color, inherit);
        }
        :host(:hover) {
            opacity: 0.85;
        }
        .icon {
            font-size: 1.6rem;
            line-height: 1;
        }
        .label {
            font-size: 0.8rem;
            text-transform: capitalize;
        }
    `;

    constructor() {
        super();
        this.state = this._loadInitial();
        this._applyToBody();
    }

    /** localStorage 또는 OS prefers-color-scheme 으로 초기 상태 결정 */
    _loadInitial() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === '1') return 'dark';
        if (saved === '0') return 'light';
        return 'auto';
    }

    /** body[data-dark-mode] 속성으로 적용. EstreUI 가 있으면 위임, 없으면 직접 */
    _applyToBody() {
        const isDark = this._effectiveIsDark();
        if (typeof window.estreUi?.setDarkMode === 'function') {
            const value = this.state === 'auto' ? null : (this.state === 'dark');
            window.estreUi.setDarkMode(value);
        } else {
            document.body.toggleAttribute('data-dark-mode', isDark);
        }
    }

    _effectiveIsDark() {
        if (this.state === 'dark') return true;
        if (this.state === 'light') return false;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    }

    cycle() {
        const next = this.state === 'auto' ? 'light'
                   : this.state === 'light' ? 'dark'
                   : 'auto';
        this.state = next;
        if (next === 'dark') localStorage.setItem(STORAGE_KEY, '1');
        else if (next === 'light') localStorage.setItem(STORAGE_KEY, '0');
        else localStorage.removeItem(STORAGE_KEY);
        this._applyToBody();
        this.requestIntentUpdate({ darkMode: next });
    }

    /**
     * color reactive prop 변경 시 host element 의 CSS custom property 갱신.
     * inner div style 에 박아도 :host 의 border-color 는 cascade 못 받으므로 host 직접 set.
     */
    willUpdate(changedProperties) {
        super.willUpdate?.(changedProperties);
        if (changedProperties.has('color')) {
            if (this.color) {
                this.style.setProperty('--estreuv-tile-color', this.color);
            } else {
                this.style.removeProperty('--estreuv-tile-color');
            }
        }
    }

    render() {
        const icon = this.state === 'dark' ? '☾' : this.state === 'light' ? '☀' : '🌓';
        // Alienese alias 검증: text · color 가 long-form HTML attribute 또는 *t · *c 로 들어옴.
        // color 의 시각 적용은 willUpdate 가 host 의 --estreuv-tile-color 갱신.
        const labelText = this.text || this.state;
        return html`
            <div class="icon" aria-hidden="true">${icon}</div>
            <div class="label">${labelText}</div>
        `;
    }

    firstUpdated() {
        this.addEventListener('click', () => this.cycle());
    }

    onShow(handle) {
        super.onShow(handle);
        const saved = this._loadInitial();
        if (saved !== this.state) {
            this.state = saved;
            this._applyToBody();
        }
    }
}

// alias install (Lit finalize 이전에 적용되도록 customElements.define 직전 호출)
applyAliases(DarkModeTile);

customElements.define('estreuv-dark-mode-tile', DarkModeTile);
