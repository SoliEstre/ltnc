/**
 * EstreUV — Base Element (Phase B 강화)
 *
 * LitElement 위에 EstreUV 의 컨벤션 layer 추가.
 *
 * 추가하는 것:
 * - intent context 자동 consume (자식이 별도 wiring 없이 받음)
 * - data-estreuv 속성 자동 부여 (lifecycle bridge 가 식별)
 * - 8 라이프사이클 메서드 placeholder (override 안 하면 noop)
 * - lifecycle 호출 이력 조회 헬퍼 (`getLifecycleHistory()` · `hasLifecycleFired()`)
 *
 * 설계 원칙 (Phase B 명문화):
 * - **Lit native lifecycle 과 EstreUI lifecycle 은 분리 채널**.
 *   - `connectedCallback` / `disconnectedCallback` / `firstUpdated` 등 = 브라우저·Lit
 *   - `onBring` / `onOpen` / `onShow` / `onFocus` / `onBlur` / `onHide` / `onClose` / `onRelease` = EstreUI article
 *   - 두 채널은 서로 호출하지 않는다. component 가 둘 다 사용할 때 init 책임 분리:
 *     - DOM 의존 init → connectedCallback / firstUpdated
 *     - 데이터·intent 바인딩 init → onBring (1회) · onShow (재진입)
 *     - 가시성 의존 init → onShow · onHide
 *     - 종료 cleanup → onClose · onRelease
 * - **dual binding race 회피**:
 *   - prop-down: parent → child 는 `intent` reactive property 로 흐름
 *   - event-up: child → parent 는 `requestIntentUpdate(patch)` 가 'intent-update' custom event dispatch
 *   - child 가 직접 `this.intent = ...` 설정 금지 (자체 reactive property 만 mutate, intent 는 read-only)
 *
 * 미구현 (Phase B 후속 + Phase C):
 * - Alienese alias attribute 시스템 (`*t` · `*bg` 등) — Spectrum SpectrumMixin 패턴 차용 예정
 * - intent → reactive property 자동 매핑 (현재는 component 가 수동 매핑)
 */

import { LitElement } from 'lit';
import { consumeIntent, requestIntentUpdate } from './intent-context.js';
import { getLifecycleHistory } from './lifecycle-bridge.js';

export class EstreUVElement extends LitElement {

    static properties = {
        /** intent context 의 현 값 (subscribe 갱신, **read-only from child**) */
        intent: { state: true },
        /** 1회성 lifecycle flag (debug 용) — bridge 가 갱신 */
        _everShown: { state: true },
        _everFocused: { state: true },
    };

    constructor() {
        super();
        /** @type {import('./intent-context.js').EstreIntent} */
        this.intent = {};
        this._everShown = false;
        this._everFocused = false;
        // 자동 consume: 부모 article 이 provide 하지 않아도 안전 (default {} 유지)
        this._intentConsumer = consumeIntent(this, (intent) => {
            this.intent = intent ?? {};
        });
    }

    connectedCallback() {
        super.connectedCallback();
        // lifecycle bridge 가 식별할 attribute 부여
        if (!this.hasAttribute('data-estreuv')) {
            this.setAttribute('data-estreuv', '1');
        }
    }

    /**
     * Child → Parent intent 변경 위임 (uni-directional, dual binding race 회피).
     * 직접 this.intent = ... 하지 말고 이 메서드 호출.
     * @param {Partial<import('./intent-context.js').EstreIntent>} patch
     */
    requestIntentUpdate(patch) {
        requestIntentUpdate(this, patch);
    }

    /** 본 컴포넌트의 EstreUI lifecycle 호출 이력 (디버그) */
    getLifecycleHistory() {
        return getLifecycleHistory(this);
    }

    /**
     * 특정 lifecycle 이 호출된 적 있는지 (true/false)
     * @param {string} hookName
     * @returns {boolean}
     */
    hasLifecycleFired(hookName) {
        const counts = this._estreuvLifecycleCounts;
        return Boolean(counts && counts[hookName] > 0);
    }

    // ─── EstreUI 라이프사이클 placeholder (override 안 하면 noop) ───────────

    /** 페이지가 데이터·intent 와 함께 가져와짐. 첫 1회는 onOpen 직전 */
    onBring(handle) {}

    /** 페이지가 처음 열림. 1회성 초기화 적합 */
    onOpen(handle) {}

    /** 화면에 표시됨. 매번 호출 (재방문 시도 매번) */
    onShow(handle) { this._everShown = true; }

    /** 포커스 받음. isFirstFocus 는 첫 포커스 여부 */
    onFocus(handle, isFirstFocus) {
        if (isFirstFocus) this._everFocused = true;
    }

    /** 포커스 잃음. isFinalBlur 는 페이지 종료 동반 여부 */
    onBlur(handle, isFinalBlur) {}

    /** 화면에서 가려짐 */
    onHide(handle) {}

    /** 페이지 종료 — cleanup */
    onClose(handle) {}

    /** 인스턴스 release */
    onRelease(handle) {}
}
