/**
 * EstreUV — Alienese Alias System (Phase B 베이스)
 *
 * Alienese 단축 식별자 (`*t` · `*bg` 등) 와 long-form HTML/JS 명칭 사이의 매핑.
 *
 * 3 단계 매핑:
 *   Alienese form (`*t`)         ┐
 *                                ├─► long-form name (`text`)  ─► reactive property
 *   HTML attribute (`text`)      ┘
 *
 * 왜 HTML 은 long-form 인가:
 *   `*` 는 HTML attribute 명명 규칙 위반 (브라우저 파서가 무시·정규화). 따라서 HTML 마크업은
 *   long-form (`text` · `background`) 또는 `e-` prefix (`e-t` · `e-bg`) 를 사용. Alienese form
 *   `*t` 는 **JS 식별자 레벨** 의 단축 (PM 007 §리스크 R5 mitigation 그대로).
 *
 * Alienese 영역 침범 금지 (코드 컨벤션):
 *   JS 변수명 / 함수 인자 / 로컬 const 등에 단문자 (`t`/`bg`/`c`/`sz`/`on`/`ic`) 사용 금지.
 *   Alienese 시스템이 reserve. 대안 — `$tile` · `tile2` · `targetTile` 등 명시적/sigil 이름.
 *
 * Spectrum `SpectrumMixin` 패턴 차용:
 *   - 베이스 클래스에서 alias map 일괄 처리
 *   - reactive property 자동 등록 (long-form 이름)
 *   - 인스턴스 prototype 에 Alienese alias getter/setter
 *
 * 사용 예시:
 *   import { applyAliases } from './alienese-alias.js';
 *   class MyTile extends EstreUVElement {
 *     static aliases = { '*t': 'text', '*bg': 'background' };
 *   }
 *   applyAliases(MyTile);
 *
 *   // 마크업: <my-tile text="hello" background="blue"></my-tile>
 *   // JS:    tile['*t']   → 'hello'  (long-form 'text' 와 같은 값)
 *   //        tile['*t'] = 'world'  → tile.text = 'world' (reactive 갱신)
 */

/** 권장 기본 alias 셋 — 첫 tile 들이 자주 쓰는 단축 */
export const ALIENESE_DEFAULT_ALIASES = Object.freeze({
    '*t':  'text',
    '*bg': 'background',
    '*c':  'color',
    '*sz': 'size',
    '*on': 'enabled',
    '*ic': 'icon',
});

/** WeakSet — applyAliases 가 한 클래스에 두 번 적용되는 것을 차단 */
const _appliedClasses = new WeakSet();

/**
 * 클래스에 Alienese alias 시스템 설치.
 *
 * - `class.aliases` (또는 두번째 인자) 의 long-form 값들을 reactive property 로 자동 등록
 *   (이미 properties 에 선언된 경우는 건드리지 않음)
 * - 인스턴스 prototype 에 Alienese 식별자 getter/setter 추가 (long-form 으로 위임)
 *
 * @param {typeof HTMLElement} ctor
 * @param {Object<string, string>} [aliasMap] — 미지정 시 ctor.aliases 사용
 * @returns {typeof HTMLElement} ctor (체이닝)
 */
export function applyAliases(ctor, aliasMap) {
    if (_appliedClasses.has(ctor)) return ctor;
    const map = aliasMap || ctor.aliases || {};
    if (!map || Object.keys(map).length === 0) {
        _appliedClasses.add(ctor);
        return ctor;
    }

    // 1. reactive properties 확장 — long-form 이 이미 properties 에 있으면 그대로
    const existing = ctor.properties || {};
    const additions = {};
    Object.values(map).forEach((longForm) => {
        if (!(longForm in existing)) {
            additions[longForm] = { type: String, reflect: true };
        }
    });
    if (Object.keys(additions).length > 0) {
        // Lit decorator 없이 static properties 직접 setter — Lit 내부의 finalize() 가 read 하므로
        // applyAliases 는 finalize 전에 호출되어야 함 (모듈 top-level 또는 customElements.define 직전).
        Object.defineProperty(ctor, 'properties', {
            value: { ...existing, ...additions },
            configurable: true,
            writable: true,
            enumerable: true,
        });
    }

    // 2. Alienese alias getter/setter — instance 가 `tile['*t']` 식으로 접근
    Object.entries(map).forEach(([alienese, longForm]) => {
        if (Object.prototype.hasOwnProperty.call(ctor.prototype, alienese)) return;
        Object.defineProperty(ctor.prototype, alienese, {
            get() { return this[longForm]; },
            set(v) { this[longForm] = v; },
            configurable: true,
            enumerable: false,
        });
    });

    _appliedClasses.add(ctor);
    return ctor;
}

/**
 * Alienese 단축 식별자를 long-form 으로 변환 (단발).
 * 마크업 generator·디버그 도구용.
 *
 * @param {string} aliasOrLongForm
 * @param {Object<string, string>} [aliasMap]
 * @returns {string}
 */
export function resolveAlias(aliasOrLongForm, aliasMap = ALIENESE_DEFAULT_ALIASES) {
    return aliasMap[aliasOrLongForm] ?? aliasOrLongForm;
}

/**
 * 검증·디버그: 클래스가 alias 설치 됐는지.
 * @param {typeof HTMLElement} ctor
 */
export function isAliasApplied(ctor) {
    return _appliedClasses.has(ctor);
}
