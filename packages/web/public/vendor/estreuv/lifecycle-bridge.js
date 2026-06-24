/**
 * EstreUV — Lifecycle Bridge (Phase B 강화)
 *
 * EstreUI article lifecycle (onBring/onOpen/onShow/onFocus/onBlur/onHide/onClose/onRelease) 를
 * 자식 EstreUV component 의 동명 메서드로 매핑. Vaadin Router 의 duck-typing 패턴 차용.
 *
 * Phase A → Phase B 변경:
 * - per-call 동기 dedup (같은 synchronous tick 안에서 같은 hookName 이 같은 component 에 두 번
 *   dispatch 되는 race 차단)
 * - 부분 lifecycle 순서 invariant 검사 (onBring < onOpen < onShow ... onClose < onRelease;
 *   cyclic hook 인 onShow/onFocus/onBlur/onHide 는 재진입 허용)
 * - 컴포넌트별 lifecycle history (디버그) — `getLifecycleHistory(comp)`
 * - 컴포넌트별 hook 호출 카운터 — `comp._estreuvLifecycleCounts`
 *
 * 설계 원칙 (Phase B 명문화):
 * - Lit native lifecycle (`connectedCallback` 등) 과 EstreUI lifecycle 은 **완전 분리 채널**.
 *   브라우저가 native, EstreUI 는 article 흐름이 dispatch. 두 채널은 서로 호출하지 않는다.
 * - dual binding race 회피: child component 는 `intent` 를 직접 mutate 하지 않고
 *   `requestIntentUpdate(patch)` 로 owner article 에 위임 (event-up · prop-down).
 *
 * 미해결 (Phase C 에서):
 * - error propagation 정책 (현재 흡수 + 콘솔 경고). retry/escalate 옵션
 * - lifecycle hook async 지원 (현재는 동기만)
 */

/**
 * EstreUI article lifecycle 이름 (현 EstreUI v1.4.0 기준).
 * @see EstreUI.js/.agent/estreui/page-handlers.ko.md
 */
export const ESTREUI_LIFECYCLE_NAMES = Object.freeze([
    'onBring',
    'onOpen',
    'onShow',
    'onFocus',
    'onBlur',
    'onHide',
    'onClose',
    'onRelease',
]);

/**
 * 부분 순서 인덱스 — 작은 인덱스가 먼저 발생해야 함.
 * cyclic hook (재진입 허용) 은 별도로 표시.
 */
const LIFECYCLE_ORDER_INDEX = ESTREUI_LIFECYCLE_NAMES.reduce((acc, name, i) => {
    acc[name] = i;
    return acc;
}, Object.create(null));

const CYCLIC_HOOKS = new Set(['onShow', 'onFocus', 'onBlur', 'onHide']);

/** WeakMap<HTMLElement, Array<{hook, t}>> — 컴포넌트별 호출 이력 (bounded 32) */
const _lifecycleHistory = new WeakMap();

/**
 * Per-articleRoot synchronous in-flight set.
 * dispatchLifecycle 가 같은 tick 안에서 같은 (root, hook) 페어로 두 번 호출되면 차단.
 * 마이크로태스크 끝에 자동 클리어.
 *
 * @type {WeakMap<HTMLElement, Set<string>>}
 */
const _inFlight = new WeakMap();

function _getInFlight(root) {
    let s = _inFlight.get(root);
    if (!s) {
        s = new Set();
        _inFlight.set(root, s);
    }
    return s;
}

function _recordCall(comp, hookName) {
    // history
    let h = _lifecycleHistory.get(comp);
    if (!h) {
        h = [];
        _lifecycleHistory.set(comp, h);
    }
    const last = h[h.length - 1];
    h.push({ hook: hookName, t: performance.now() });
    if (h.length > 32) h.shift();

    // counter on element (편의 — 디버그·검증)
    if (!comp._estreuvLifecycleCounts) comp._estreuvLifecycleCounts = Object.create(null);
    comp._estreuvLifecycleCounts[hookName] = (comp._estreuvLifecycleCounts[hookName] || 0) + 1;

    // 순서 invariant 경고 (non-cyclic 만)
    if (last && !CYCLIC_HOOKS.has(hookName)) {
        const lastIdx = LIFECYCLE_ORDER_INDEX[last.hook];
        const currIdx = LIFECYCLE_ORDER_INDEX[hookName];
        if (currIdx < lastIdx) {
            console.warn(
                `[EstreUV] Lifecycle order violation on <${comp.tagName.toLowerCase()}>: ` +
                `${last.hook} → ${hookName} (expected non-decreasing)`
            );
        }
    }
}

/**
 * 디버그 / 테스트용 — 컴포넌트의 lifecycle 호출 이력 조회.
 * @param {HTMLElement} comp
 * @returns {Array<{hook: string, t: number}>}
 */
export function getLifecycleHistory(comp) {
    return _lifecycleHistory.get(comp)?.slice() ?? [];
}

/**
 * article root 안의 모든 EstreUV component 를 찾아 lifecycle 호출 dispatch.
 * EstreUI article 의 핸들러가 호출하는 진입점.
 *
 * @param {HTMLElement} articleRoot — EstreUI article 의 DOM root
 * @param {string} hookName         — ESTREUI_LIFECYCLE_NAMES 중 하나
 * @param {...any} args             — handle, isFirstFocus 등 EstreUI 가 넘기는 인자
 */
export function dispatchLifecycle(articleRoot, hookName, ...args) {
    if (!ESTREUI_LIFECYCLE_NAMES.includes(hookName)) {
        console.warn(`[EstreUV] Unknown lifecycle: ${hookName}`);
        return;
    }

    // per-call 동기 dedup — 같은 (root, hook) 으로 동일 tick 두번 호출 차단
    const inFlight = _getInFlight(articleRoot);
    if (inFlight.has(hookName)) {
        console.warn(
            `[EstreUV] dispatchLifecycle('${hookName}') re-entrant on same root within tick — skipped`
        );
        return;
    }
    inFlight.add(hookName);
    queueMicrotask(() => inFlight.delete(hookName));

    const components = articleRoot.querySelectorAll('[data-estreuv]');
    components.forEach((comp) => {
        _recordCall(comp, hookName);
        if (typeof comp[hookName] === 'function') {
            try {
                comp[hookName](...args);
            } catch (err) {
                console.error(`[EstreUV] ${comp.tagName} ${hookName} threw:`, err);
            }
        }
    });
}

/**
 * EstreUI 측에서 article 핸들러가 EstreUV component 들의 lifecycle 을 호출하도록
 * 자동 wire-up 하는 helper.
 *
 * 사용 예시 (EstreUI 측 handler 안):
 *   import { wireArticle } from 'estreuv/lifecycle-bridge.js';
 *   class MyArticleHandler extends EstrePageHandler {
 *       onBring(handle) {
 *           super.onBring(handle);
 *           wireArticle(handle.article).onBring(handle);
 *       }
 *       // ... 다른 lifecycle 동일
 *   }
 *
 * @param {HTMLElement} articleRoot
 * @returns {Object<string, (...args: any[]) => void>} — lifecycle 이름별 dispatcher
 */
export function wireArticle(articleRoot) {
    const dispatchers = {};
    ESTREUI_LIFECYCLE_NAMES.forEach((hook) => {
        dispatchers[hook] = (...args) => dispatchLifecycle(articleRoot, hook, ...args);
    });
    return dispatchers;
}
