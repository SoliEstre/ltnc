/**
 * EstreUV — barrel entry (spike).
 *
 * 통합앱·소비자가 `import { ... } from 'estreuv'` 로 받는 표면.
 * tile 컴포넌트는 import 시 customElements 에 자동 등록되므로 side-effect import 권장:
 *   import 'estreuv/tiles/dark-mode-tile';
 */

export { EstreUVElement } from './estreuv-element.js';
export {
    ESTREUI_LIFECYCLE_NAMES,
    dispatchLifecycle,
    wireArticle,
    getLifecycleHistory,
} from './lifecycle-bridge.js';
export {
    intentContext,
    provideIntent,
    consumeIntent,
    requestIntentUpdate,
} from './intent-context.js';
export {
    ALIENESE_DEFAULT_ALIASES,
    applyAliases,
    resolveAlias,
    isAliasApplied,
} from './alienese-alias.js';
