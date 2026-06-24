/**
 * EstreUV — Sidebar — nested 컨테이너 케이스
 *
 * 사이드바 컨테이너 component. 안의 항목들 (`<estreuv-sidebar-item>`) 도 EstreUV component →
 * **중첩 lifecycle** 검증: article 의 lifecycle dispatch (`dispatchLifecycle(articleRoot, ...)`)
 * 가 `querySelectorAll('[data-estreuv]')` 로 *임의 깊이의* 자손을 평면적으로 찾으므로,
 * 사이드바도 + 그 안의 항목들도 모두 동명 lifecycle 메서드를 받는다. 별도 sub-coordinator 불필요.
 *
 * 핵심 검증:
 * - F1 확장: nested EstreUV component 가 article lifecycle 에 균일 참여 (사이드바 + N개 항목 모두 onShow/onHide 받음)
 * - 리소스 분리: 사이드바의 collapsed state 변경은 prop-down (각 item 이 받음). 양방향 race 없음
 * - 사이드바 + 항목 리스트 류 UI 가 EstreUV 로 자연스럽게 — D2 (OS shell 마이그레이션) 의 정성 근거
 */

import { html, css } from 'lit';
import { EstreUVElement } from './estreuv-element.js';
import { applyAliases } from './alienese-alias.js';

export class EstreuvSidebar extends EstreUVElement {

    /** Alienese: `*t` → `title` */
    static aliases = { '*t': 'title' };

    static properties = {
        ...EstreUVElement.properties,
        /** 접힘 상태 — 항목들에게 prop-down (compact 표시) */
        collapsed: { type: Boolean, reflect: true },
        /** 현재 active 항목 라벨 — 항목들에게 prop-down */
        activeLabel: { type: String, attribute: 'active-label' },
        /** 라벨별 배지 카운트 맵 {label: n} — 항목들에게 count prop-down */
        counts: { type: Object },
        // title 은 applyAliases 가 추가
    };

    static styles = css`
        :host {
            display: block;
            border: 1px solid var(--estreuv-tile-color, currentColor);
            border-radius: 8px;
            font-family: system-ui, sans-serif;
            color: var(--estreuv-tile-color, inherit);
            overflow: hidden;
            width: 200px;
        }
        :host([collapsed]) { width: 56px; }
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            font-size: 0.8rem;
            font-weight: 700;
            opacity: 0.8;
            border-bottom: 1px solid currentColor;
            cursor: pointer;
            user-select: none;
        }
        :host([collapsed]) header .title-text { display: none; }
        nav { display: flex; flex-direction: column; padding: 4px 0; }
        .toggle { font-size: 0.9rem; opacity: 0.6; }
    `;

    constructor() {
        super();
        this.collapsed = false;
        this.activeLabel = '';
        this.counts = {};
        this.title = 'Menu';
    }

    connectedCallback() {
        super.connectedCallback();
        // 항목 클릭 이벤트는 host (light DOM) 에서 직접 받음 — slot 경유 shadow 전파 의존 X
        this.addEventListener('estreuv-sidebar-activate', this._onItemActivate);
    }

    disconnectedCallback() {
        this.removeEventListener('estreuv-sidebar-activate', this._onItemActivate);
        super.disconnectedCallback();
    }

    /** collapsed / activeLabel 변경을 슬롯된 항목들에 prop-down (양방향 race 없음 — owner 단방향) */
    _propagateToItems() {
        const items = this.querySelectorAll('estreuv-sidebar-item');
        const counts = this.counts ?? {};
        items.forEach((item) => {
            item.compact = this.collapsed;
            item.active = item.label === this.activeLabel;
            if (item.label in counts) item.count = counts[item.label];
        });
    }

    updated(changedProperties) {
        super.updated?.(changedProperties);
        // 라이브 intent 변경(prop-down) → counts/active 동기 (메시지 읽음 등으로 갱신될 때)
        if (changedProperties.has('intent')) {
            const intent = this.intent ?? {};
            if (intent.counts != null) this.counts = intent.counts;
            if (intent.sidebarActive != null) this.activeLabel = String(intent.sidebarActive);
        }
        if (changedProperties.has('collapsed') || changedProperties.has('activeLabel')
            || changedProperties.has('counts')) {
            this._propagateToItems();
        }
    }

    toggleCollapsed() {
        this.collapsed = !this.collapsed;
        this.requestIntentUpdate({ sidebarCollapsed: this.collapsed });
    }

    /** 항목 클릭 시 (item 이 'estreuv-sidebar-activate' 이벤트 dispatch) → active 갱신 + intent 위임 */
    _onItemActivate(e) {
        const label = e.detail?.label;
        if (label == null) return;
        this.activeLabel = label;
        this.requestIntentUpdate({ sidebarActive: label });
    }

    render() {
        return html`
            <header @click=${() => this.toggleCollapsed()}>
                <span class="title-text">${this.title}</span>
                <span class="toggle" aria-hidden="true">${this.collapsed ? '▸' : '▾'}</span>
            </header>
            <nav>
                <slot></slot>
            </nav>
        `;
    }

    firstUpdated() {
        // 초기 동기 — 슬롯 채워진 후
        this.updateComplete.then(() => this._propagateToItems());
    }

    // ─── EstreUI 라이프사이클 — 중첩 컨테이너로서 자신만 처리, 항목들은 article 의 flat dispatch 가 직접 처리 ──

    onShow(handle) {
        super.onShow(handle);
        // intent 에서 collapsed / active 복원 (재방문 시 매번)
        const intent = this.intent ?? {};
        if (intent.sidebarCollapsed != null) this.collapsed = !!intent.sidebarCollapsed;
        if (intent.sidebarActive != null) this.activeLabel = String(intent.sidebarActive);
        if (intent.counts != null) this.counts = intent.counts;
    }
}

applyAliases(EstreuvSidebar);
customElements.define('estreuv-sidebar', EstreuvSidebar);
