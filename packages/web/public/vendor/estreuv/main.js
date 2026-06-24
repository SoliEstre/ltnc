/**
 * EstreUV-spike — bridge 시나리오 부트스트랩.
 *
 * 본 파일은 index.html (EstreUI 가 있다고 가정한 흐름) 의 entry.
 * EstreUI 본체 없이도 페이지가 깨지지 않도록 stub article 로 fallback.
 */

import { provideIntent } from './intent-context.js';
import { wireArticle } from './lifecycle-bridge.js';
import './dark-mode-tile.js';

// 1. article root 식별 (EstreUI 가 만든 article 또는 stub div)
const articleRoot = document.querySelector('[data-spike-article]');
if (!articleRoot) {
    console.error('[spike] No [data-spike-article] root found.');
    throw new Error('spike root missing');
}

// 2. intent provider 부착
const intentApi = provideIntent(articleRoot, {
    step: 'home',
    data: { _bootMs: Date.now() },
});
window._spikeIntent = intentApi;  // 콘솔에서 .update({...}) 실험 가능

// 3. lifecycle bridge wire-up — EstreUI 가 없으면 수동 트리거
const lifecycle = wireArticle(articleRoot);
window._spikeLifecycle = lifecycle;

// 4. child 가 raise 한 intent-update 이벤트를 받아 article 측 갱신 (uni-directional)
articleRoot.addEventListener('intent-update', (e) => {
    intentApi.update(e.detail.patch);
    console.log('[spike] intent-update via event:', e.detail.patch);
});

// 5. EstreUI 부재 시 stub lifecycle 호출 — 실 EstreUI 환경에서는 핸들러가 호출
if (!window.estreUi) {
    console.log('[spike] EstreUI not present — firing stub onBring/onOpen/onShow.');
    requestAnimationFrame(() => {
        lifecycle.onBring({ stub: true });
        lifecycle.onOpen({ stub: true });
        lifecycle.onShow({ stub: true });
        // onFocus 는 사용자 인터랙션 후 별도 트리거 권장 (race 검증용)
    });
}

// 6. 콘솔 친화 로그
console.log('[spike] booted. Try in DevTools:');
console.log('  _spikeIntent.update({ darkMode: "dark" })');
console.log('  _spikeLifecycle.onShow({ stub: true })');
console.log('  document.querySelector("estreuv-dark-mode-tile").cycle()');
