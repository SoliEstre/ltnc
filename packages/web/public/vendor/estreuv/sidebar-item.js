/**
 * EstreUV — Sidebar Item — 사이드바 안의 항목 component
 *
 * `<estreuv-sidebar>` 의 slot 에 light-DOM 자식으로 배치됨. 따라서:
 * - article 의 `dispatchLifecycle(articleRoot, ...)` 가 `querySelectorAll('[data-estreuv]')` 로 직접 찾음
 *   → 사이드바와 *독립적으로* article lifecycle 을 받음 (중첩 깊이 무관)
 * - 동시에 부모 사이드바로부터 `compact` / `active` prop 을 prop-down 으로 받음 (단방향, race 없음)
 * - 클릭 시 `estreuv-sidebar-activate` 이벤트를 부모 사이드바에 event-up
 *
 * 이중 채널 구조: (1) article ↔ item lifecycle (flat dispatch), (2) sidebar ↔ item state (prop-down/event-up).
 * 두 채널이 서로 간섭하지 않음 — 채널 분리 원칙이 nested 케이스에서도 성립.
 */

import { html, css } from 'lit';
import { EstreUVElement } from './estreuv-element.js';
import { applyAliases } from './alienese-alias.js';

export class EstreuvSidebarItem extends EstreUVElement {

    /** Alienese: `*t` → `label`, `*ic` → `icon` */
    static aliases = { '*t': 'label', '*ic': 'icon' };

    static properties = {
        ...EstreUVElement.properties,
        /** active (현재 선택) — 사이드바가 prop-down */
        active: { type: Boolean, reflect: true },
        /** compact (사이드바 collapsed 시) — 사이드바가 prop-down */
        compact: { type: Boolean, reflect: true },
        /** 선택적 배지 카운트 (사이드바가 counts 맵에서 prop-down). 0/없으면 숨김 */
        count: { type: Number },
        // label · icon 은 applyAliases 가 추가
    };

    static styles = css`
        :host {
            display: block;
        }
        a {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            font-size: 0.85rem;
            text-decoration: none;
            color: inherit;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        :host(:hover) a { background: rgba(127,127,127,0.12); }
        :host([active]) a { background: rgba(127,127,127,0.22); font-weight: 700; }
        .icon { width: 1.1em; text-align: center; flex: 0 0 auto; }
        .label-text { flex: 1; }
        .badge {
            min-width: 18px; padding: 0 6px; height: 18px; border-radius: 9px;
            background: var(--estreuv-badge, #e5484d); color: #fff;
            font-size: 0.7rem; font-weight: 700;
            display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
        }
        :host([compact]) .label-text { display: none; }
    `;

    constructor() {
        super();
        this.active = false;
        this.compact = false;
        this.count = 0;
        this.label = '';
        this.icon = '•';
        this._everShownFromArticle = false;
    }

    _activate() {
        this.dispatchEvent(new CustomEvent('estreuv-sidebar-activate', {
            detail: { label: this.label },
            bubbles: true,
            composed: true,
        }));
    }

    render() {
        return html`
            <a @click=${() => this._activate()} title=${this.label}>
                <span class="icon" aria-hidden="true">${this.icon}</span>
                <span class="label-text">${this.label}</span>
                ${this.count > 0 ? html`<span class="badge">${this.count}</span>` : ''}
            </a>
        `;
    }

    // ─── EstreUI 라이프사이클 — article 의 flat dispatch 가 직접 호출 (사이드바 경유 X) ──

    onShow(handle) {
        super.onShow(handle);
        this._everShownFromArticle = true;
        // 항목 단위 onShow 에서 할 일이 있으면 여기 (예: lazy 로드). 지금은 마커만.
    }
}

applyAliases(EstreuvSidebarItem);
customElements.define('estreuv-sidebar-item', EstreuvSidebarItem);
