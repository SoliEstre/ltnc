/**
 * EstreUV — Intent Context (Phase A 1차안)
 *
 * EstreUI article 의 intent stream 을 자식 EstreUV component 에 전파하는 브릿지.
 * @lit/context 의 W3C Web Components Community Protocol 기반.
 *
 * 설계 의도:
 * - EstreUI article 이 intent 를 raise 하면 → IntentContextProvider 가 새 객체로 갱신
 * - 자식 EstreUV component 들이 @consume({context: intentContext, subscribe: true}) 로 받음
 * - dual binding race 회피: child 가 이 context 를 직접 mutate 하지 않음.
 *   변경은 custom event ('intent-update') 를 owner article 에 전파해 article 이 갱신.
 *
 * 미해결 (Phase B 에서):
 * - article 이 intent 를 갱신하는 정확한 시그니처 (현 EstreUI 의 intent API 와 매핑)
 * - intent 의 부분 갱신 vs 전체 교체 정책
 * - default empty intent shape
 */

import { createContext, ContextProvider, ContextConsumer, ContextRoot } from '@lit/context';

/**
 * 정적 consumer 가 provider 보다 *먼저* connect 하는 케이스 대비.
 * EstreUI article 의 tile 들은 보통 article 이 onOpen 에서 provideIntent 하기 전에
 * 이미 DOM 에 있어 context-request 를 먼저 쏜다. ContextRoot 는 미응답 request 를
 * 버퍼링했다가 provider 가 나중에 등장하면 재전파한다. 첫 consumer 생성 시
 * (connectedCallback 의 request 전) document 에 1회 부착.
 */
let _contextRoot = null;
function ensureContextRoot() {
    if (!_contextRoot && typeof document !== 'undefined' && document.body) {
        _contextRoot = new ContextRoot();
        _contextRoot.attach(document.body);
    }
    return _contextRoot;
}

/**
 * Intent context key. Lit context 시스템 안에서 EstreUI ↔ EstreUV 의 single channel.
 * @typedef {Object} EstreIntent
 * @property {string} [step]                — EstreUI navigation step (`%step`)
 * @property {string} [instanceOrigin]      — multi-instance prefix (`^...`)
 * @property {Object<string, any>} [data]   — 자유 데이터 슬롯
 * @property {Object<string, any>} [flags]  — boolean 플래그 슬롯
 */
export const intentContext = createContext(Symbol('estreuv:intent'));

/**
 * Provider helper — EstreUI article 측이 호출.
 * article 의 lifecycle hook (onBring/onShow 등) 이나 intent raise 시점에서 갱신.
 *
 * @param {HTMLElement} host  — provider element (보통 article root)
 * @param {EstreIntent} initial — 초기 intent
 * @returns {{ provider: ContextProvider, update: (next: EstreIntent) => void }}
 */
export function provideIntent(host, initial = {}) {
    ensureContextRoot();
    const provider = new ContextProvider(host, { context: intentContext, initialValue: initial });
    // plain element host 는 ReactiveElement 가 아니라 hostConnected 가 자동 호출되지 않음
    // → context-provider 이벤트 미발신 → ContextRoot 가 먼저 온 consumer 의 request 를 재전파 못함.
    // 수동 호출해 재전파 트리거 (이미 연결된 정적 consumer 들이 늦게 온 provider 에 붙음).
    provider.hostConnected?.();
    return {
        provider,
        update(next) {
            // 새 객체로 교체 (참조 동등성 변경 → consumer 재렌더 트리거)
            provider.setValue({ ...provider.value, ...next });
        },
        replace(next) {
            // 전체 교체 (부분 갱신이 아닌 새 intent)
            provider.setValue(next);
        },
    };
}

/**
 * Consumer helper — EstreUV component 측 baseline.
 * Element 가 lifecycle 이 시작되면 자동 subscribe.
 *
 * 단순 사용:
 *   class MyTile extends EstreUVElement {
 *       constructor() { super(); this._intentConsumer = consumeIntent(this, (intent) => this.intent = intent); }
 *   }
 *
 * @param {HTMLElement} host
 * @param {(intent: EstreIntent) => void} callback
 * @returns {ContextConsumer}
 */
export function consumeIntent(host, callback) {
    // consumer 가 request 를 쏘기 전(생성자/connectedCallback 전)에 ContextRoot 부착 →
    // provider 가 나중에 와도 재구독됨 (late-provider 안전).
    ensureContextRoot();
    return new ContextConsumer(host, {
        context: intentContext,
        subscribe: true,
        callback,
    });
}

/**
 * Child → Parent 변경 위임 (uni-directional, dual binding race 회피).
 * EstreUV component 가 intent 를 변경하고 싶을 때 직접 mutate 하지 않고
 * custom event 로 위임.
 *
 * @param {HTMLElement} child       — 이벤트 dispatch 하는 component
 * @param {Partial<EstreIntent>} patch — 부분 갱신 patch
 */
export function requestIntentUpdate(child, patch) {
    child.dispatchEvent(new CustomEvent('intent-update', {
        detail: { patch },
        bubbles: true,
        composed: true,
    }));
}
