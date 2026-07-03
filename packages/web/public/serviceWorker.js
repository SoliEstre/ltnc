const INSTALLATION_VERSION_NAME = "ltnc-0.1.0-r20260703";
// ^^ LTNC PWA 릴리스 버전 — 앱 파일 변경 시 이 값을 올려서 캐시 갱신
//    r20260626: 라이트모드 컬러셋(main.css·ltnc-charts.js) — 기존 PWA 캐시 무효화
//    r20260626b: 타일 라이트모드(게이지 트랙·카드/뱃지 보더 흰색-알파→토큰)
//    r20260702: 메인메뉴 업데이트 확인 버튼(mainMenu.html·app.js — appActionManager.checkUpdate)
//    r20260703: 통계 탭(ClickHouse allowlist, config.stats 게이트 — rootbar 📊·staticDoc #stats·app.js LTNCStatsPage) + 다중 계정·계정별 홈탭(auth users[]/home)

const INSTALLATION_FILE_LIST = [
    "./serviceWorker.js",
    "./fixedTop.html",
    "./fixedBottom.html",
    "./mainMenu.html",
    "./staticDoc.html",
    "./instantDoc.html",
    "./managedOverlay.html",
    "./overwatchPanel.html",
    "./customHandlePrototypes.html",


    "./styles/main.css",


    "./scripts/main.js",
    "./scripts/app.js",
    "./scripts/ltnc-client.js",
    "./scripts/ltnc-charts.js",
    "./scripts/ltnc-chart-detail.js",

    "./tiles/index.js",
    "./tiles/ltnc-server-card.js",
    "./tiles/ltnc-checks-card.js",
    "./tiles/ltnc-stat-gauge.js",
    "./tiles/ltnc-conn-badge.js",
];


// Common files cache - Be changes some time but, well not changed very often
const CACHE_NAME_COMMON_FILES = "ltnc-common-files-cache-v1-20260626";

const COMMON_FILES_TO_CACHE = [
    "./",
    "./index.html",
    "./serviceLoader.html",
    "./stockHandlePrototypes.html",
    "./webmanifest.json",


    "./styles/estreUiInitialize.css",
    "./styles/estreUiEmoji.css",
    "./styles/estreUiRoot.css",
    "./styles/estreUiCore.css",
    "./styles/estreUiCore2.css",
    "./styles/estreUiAliases.css",
    "./styles/estreUi.css",
    "./styles/estreUiHandles.css",
    "./styles/estreUiHandleUnical.css",


    "./scripts/jcodd.js",
    "./scripts/doctre.js",
    "./scripts/modernism.js",
    "./scripts/alienese.js",
    "./scripts/estreU0EEOZ.js",
    "./scripts/estreUi-core.js",
    "./scripts/estreUi-dialog.js",
    "./scripts/estreUi-notation.js",
    "./scripts/estreUi-notification.js",
    "./scripts/estreUi-pageModel.js",
    "./scripts/estreUi-pageManager.js",
    "./scripts/estreUi-handles.js",
    "./scripts/estreUi-interaction.js",
    "./scripts/estreUi-main.js",


    "./vendor/uplot/uPlot.iife.min.js",
    "./vendor/uplot/uPlot.min.css",
];


// Static files cache - Rarely changes after release
const CACHE_NAME_STATIC_FILES = "ltnc-static-files-cache-v1-20260611";

const STATIC_FILES_TO_CACHE = [
    "https://raw.githack.com/googlefonts/noto-emoji/main/fonts/NotoColorEmoji.ttf",


    "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap",


    // "https://code.jquery.com/jquery-3.7.1.js",
    // "https://code.jquery.com/jquery-4.0.0.slim.min.js",
    "https://code.jquery.com/jquery-4.0.0.min.js",
    "https://unpkg.com/@dotlottie/player-component@latest/dist/dotlottie-player.mjs",


    "./lotties/menu_and_back_btn.json",
    "./lotties/menu_and_close_btn.json",
    "./lotties/loading_circle.json",
    "./lotties/ptr_indic.json",
    "./lotties/progress_bar.json",

    "./vectors/more_vertical_slim_icon.svg",
    "./vectors/app_icon.svg",
    "./vectors/cover-icon-default-static.svg",
    "./vectors/cover-icon-default-instant.svg",
    "./vectors/cover-icon-default-overlay.svg",
];


// Stony files cache - Very frequently changes and heavy sized files (for background caching)
const CACHE_NAME_STONY_FILES = "ltnc-stony-files-cache-v1-20260611";

const STONY_FILES_TO_CACHE = [

];


const CHECK_ALWAYS_NEWER_FILE_LIST = [
    "./serviceWorker.js",
];


const EMPTY_RESPONSE = new Response(null, {
    status: 200,
    headers: {
        "Content-Type": "octet/stream",
        "Content-Length": "0",
    }
});

self.isLog = true;
self.isDebug = false;
self.isVerbose = false;
Object.defineProperty(self, "isLogging", {
    "get": function () { return this.isLog || this.isDebug; },
    configurable: true,
    enumerable: false,
});
Object.defineProperty(self, "isVerbosely", {
    "get": function () { return this.isDebug && this.isVerbose; },
    configurable: true,
    enumerable: false,
});

// cache.addAll 은 목록 중 하나라도 실패(404·CORS·리다이렉트 응답)하면 전체가 reject → install 실패 → SW 가 영영 active 안 됨.
// (예: unpkg @latest 가 302 리다이렉트 → addAll 이 redirected 응답을 캐시 못해 throw → 푸시·오프라인 먹통.)
// 개별 add + 실패 허용(allSettled)으로 install 회복탄력성 확보 — 실패한 파일은 런타임 네트워크로 보충.
async function cacheAllSettled(cache, urls) {
    const results = await Promise.allSettled(urls.map((u) => cache.add(u)));
    const failed = urls.filter((_, i) => results[i].status === "rejected");
    if (failed.length) console.warn("Service Worker - 일부 파일 캐시 건너뜀(install 계속 진행):", failed);
    return failed;
}

self.addEventListener("install", (event) => {
    if (self.isLogging) console.log("Service Worker - Install service worker with cache list" + INSTALLATION_VERSION_NAME);
    const scope = self.registration.scope;
    // vv When use for force installing the new service worker always (not recommended)
    //self.skipWaiting();
    event.waitUntil(
        caches.keys().then(async keyList => {
            const loaders = [];
            if (!keyList.includes(CACHE_NAME_COMMON_FILES)) {
                if (self.isLogging) console.log("Service Worker - Caching common files - " + CACHE_NAME_COMMON_FILES);
                loaders.push(caches.open(CACHE_NAME_COMMON_FILES).then((cache) => cache.addAll(COMMON_FILES_TO_CACHE.map(it => it.replace(/^\.\//, scope)))));
            }
            if (!keyList.includes(CACHE_NAME_STATIC_FILES)) {
                if (self.isLogging) console.log("Service Worker - Caching static files - " + CACHE_NAME_STATIC_FILES);
                loaders.push(caches.open(CACHE_NAME_STATIC_FILES).then((cache) => cache.addAll(STATIC_FILES_TO_CACHE.map(it => it.replace(/^\.\//, scope)))));
            }
            if (!keyList.includes(INSTALLATION_VERSION_NAME)) {
                if (self.isLogging) console.log("Service Worker - Caching application files - " + INSTALLATION_VERSION_NAME);
                loaders.push(caches.open(INSTALLATION_VERSION_NAME).then((cache) => cache.addAll(INSTALLATION_FILE_LIST.map(it => it.replace(/^\.\//, scope)))));
            }
            await Promise.all(loaders);
            if (self.isLogging) console.log("Service Worker - All required files are cached");

            if (!keyList.includes(CACHE_NAME_STATIC_FILES)) (async _ => {
                if (self.isLogging) console.log("Service Worker - Caching static files - " + CACHE_NAME_STATIC_FILES);
                await caches.open(CACHE_NAME_STATIC_FILES).then((cache) => cache.addAll(STATIC_FILES_TO_CACHE.map(it => it.replace(/^\.\//, scope))));
                if (self.isLogging) console.log("Service Worker - Static files are cached");
            })();

            return;
        })
    );
});

self.addEventListener("activate", (event) => {
    if (self.isLogging) console.log("Service Worker - Begin service worker with " + INSTALLATION_VERSION_NAME);
    event.waitUntil(
        caches.keys().then((keyList) =>
            Promise.all(
                keyList.map((key) => {
                    if (CACHE_NAME_COMMON_FILES !== key && CACHE_NAME_STATIC_FILES !== key && INSTALLATION_VERSION_NAME !== key && CACHE_NAME_STONY_FILES !== key) {
                        if (self.isLogging) console.log("Service Worker - Clear older cached - " + key);
                        return caches.delete(key);
                    }
                })
            )
        )
    );
    // vv When use for force alternate the fetch interceptor of new service worker without reload page always (not recommended)
    // event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    const scope = self.registration.scope;
    const urlString = event.request.url;
    const url = new URL(urlString);
    const pathname = url.pathname;
    const fullpath = url.origin + pathname;
    if (CHECK_ALWAYS_NEWER_FILE_LIST.find(it => fullpath == it.replace(/^\.\//, scope))) {
        event.respondWith(
            fetch(event.request).catch(async (error) => {
                if (self.isLogging) console.log("Service Worker - Return cached file by error on fetch: ", event.request.url);
                return (await caches.match(event.request)) ?? error;
            })
        );
    } else if (pathname.includes("/|") || pathname.includes("/%7C")) event.respondWith(EMPTY_RESPONSE);
    else if (COMMON_FILES_TO_CACHE.find(it => fullpath == it.replace(/^\.\//, scope)) || INSTALLATION_FILE_LIST.find(it => fullpath == it.replace(/^\.\//, scope)) || STATIC_FILES_TO_CACHE.find(it => fullpath == it.replace(/^\.\//, scope)) || STONY_FILES_TO_CACHE.find(it => fullpath == it.replace(/^\.\//, scope))) {
        event.respondWith((async () => {
            // if (self.isLogging) console.log("Service Worker - Fetch intercepted for: ", urlString);
            // Try to get the response from a cache.
            const cachedResponse = await caches.match(event.request);
            // Return it if we found one.
            if (cachedResponse) {
                if (self.isLogging) console.log("Service Worker - Return cached file: ", event.request.url);
                return cachedResponse;
            } else {
                // If we didn't find a match in the cache, use the network.
                if (self.isLogging) console.log("Service Worker - Not in cache list, try fetch directly: ", event.request.url);
                return fetch(event.request).catch(async (error) => {
                    if (self.isLogging) console.log("Service Worker - Return cached file by error on fetch: ", event.request.url);
                    return (await caches.match(event.request)) ?? error;
                });
            }
        })());
    }
});

self.addEventListener("message", async (event) => {
    let response = null;
    switch (event.data.type) {
        case "SKIP_WAITING":
            if (self.isLogging) console.log('Service Worker: SKIP_WAITING received');
            self.skipWaiting();
            // Never call source for alternate old service worker
            return;

        case "CLIENTS_CLAIM":
            if (self.isLogging) console.log('Service Worker: CLIENTS_CLAIM received');
            self.clients.claim();
            // Never call source for alternate old service worker
            return;

        case "clearCache":
            response = await caches.delete(INSTALLATION_VERSION_NAME).then(() => {
                if (self.isLogging) console.log("Cache cleared: ", INSTALLATION_VERSION_NAME);
            });
            break;

        case "clearCommonCache":
            response = await caches.delete(CACHE_NAME_COMMON_FILES).then(returns => {
                if (self.isLogging) console.log("Service Worker - Common Cache cleared: ", CACHE_NAME_COMMON_FILES);
                return returns;
            });
            break;

        case "clearStaticCache":
            response = await caches.delete(CACHE_NAME_STATIC_FILES).then(returns => {
                if (self.isLogging) console.log("Service Worker - Static Cache cleared: ", CACHE_NAME_STATIC_FILES);
                return returns;
            });
            break;

        case "clearStonyCache":
            response = await caches.delete(CACHE_NAME_STONY_FILES).then(returns => {
                if (self.isLogging) console.log("Service Worker - Stony Cache cleared: ", CACHE_NAME_STONY_FILES);
                return returns;
            });
            break;

        case "clearAllCaches":
            response = await caches.keys().then(async keyList => {
                if (self.isLogging) console.log("Service Worker - Clear all caches");
                const deletions = [];
                keyList.forEach(key => {
                    if (self.isLogging) console.log("Service Worker - Clear cached: " + key);
                    deletions.push(caches.delete(key));
                });
                return Promise.all(deletions);
            });
            break;

        case "getVersion":
            response = INSTALLATION_VERSION_NAME;
            break;

        case "getApplicationCount":
            response = await self.clients.matchAll({
                includeUncontrolled: false,
                type: 'window'
            }).then(clients => clients.length);
            break;
    }
    event.source.postMessage({ type: "worked", request: event.data, response });
});


// ════ M2: 웹푸시 수신 → OS 알림 표시 ════
// 허브 페이로드(JSON): { title, body, data: { alertId } } — 클릭 라우팅은 data 기반(iOS scope 제약 대응)
self.addEventListener("push", (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (exc) {
        // JSON 이 아니면 본문 텍스트로 폴백
        payload = { body: event.data ? event.data.text() : "" };
    }
    const title = payload.title || "LTNC 알림";
    const alertId = payload.data && payload.data.alertId != null ? payload.data.alertId : null;
    const options = {
        body: payload.body || "",
        data: payload.data || {},                                   // { alertId } — notificationclick 라우팅용
        icon: self.registration.scope + "vectors/app_icon.svg",
        badge: self.registration.scope + "vectors/app_icon.svg",
        tag: alertId != null ? "ltnc-alert-" + alertId : undefined, // 동일 알림 갱신 시 중복 표시 방지
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// ════ M2: 푸시 알림 클릭 → 기존 창 포커스 우선, 없으면 새 창 — 알림센터 페이지 라우팅 ════
// iOS 는 scope 밖 URL 오픈 제약이 있어 URL 직접 지정 대신 data(alertId) 기반으로 라우팅:
//  - 기존 창: postMessage({type:'ltnc:open-alerts'}) → app.js 가 알림 페이지로 전환
//  - 새 창: scope + ?ltncOpen=alerts 진입 파라미터 → main.js/app.js 가 라우팅
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const alertId = data.alertId != null ? data.alertId : null;
    const scope = self.registration.scope;
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.startsWith(scope) && "focus" in client) {
                    client.postMessage({ type: "ltnc:open-alerts", alertId });
                    return client.focus();
                }
            }
            const target = scope + "?ltncOpen=alerts" + (alertId != null ? "&ltncAlertId=" + encodeURIComponent(alertId) : "");
            if (self.clients.openWindow) return self.clients.openWindow(target);
        })
    );
});
