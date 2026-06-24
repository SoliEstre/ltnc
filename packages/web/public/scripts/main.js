// main.js — LTNC 애플리케이션 진입점 (EstreUI 림 결선)
// 페이지 별칭/핸들러 = scripts/app.js 의 LTNCPagesProvider. 데이터 글루도 app.js 참조.

// custom handles
// (LTNC 는 별도 커스텀 핸들 없음 — 타일은 EstreUV 웹컴포넌트(Lane B)로 분리)


// 커스텀 페이지 매니저
class AppPageManager extends EstreUiCustomPageManager {

    constructor() {
        super();
    }

    /**
     * * estreUi 초기화 이후 호출되어야 함
     */
    init(extPidMap, pageHandlers) {
        return super.init(extPidMap, pageHandlers);
    }

}


// 앱 액션 매니저 (PWA 서비스 워커 업데이트 흐름)
class AppActionManager {

    // instance property
    #serviceWorkerHandler = null;
    get swHandler() { return this.#serviceWorkerHandler; }
    #swUpdateChecker = null;
    #swUpdateBeforeAsk = t; // PWA 업데이트 방식 (true: 즉시 설치 후 재시작 안내, false: 사용자 동의 후 설치)

    #pageManager = null;
    get pageManager() { return this.#pageManager; }

    get isApp() { return window.app != n && window.app.request != n; }

    constructor() {
        this.#pageManager = pageManager;
    }

    init(serviceWorkerHandler) {
        this.#serviceWorkerHandler = serviceWorkerHandler;

        this.initServiceWorker();
    }

    initServiceWorker() {
        const swHandler = this.swHandler;

        const waiting = swHandler.waiting;
        if (waiting != n) this.onWaitingNewServiceWorker(waiting);

        swHandler.setOnInstallingListener(worker => this.onInstallingNewServiceWorker(worker));
        swHandler.setOnWaitingListener(worker => this.onWaitingNewServiceWorker(worker));
        swHandler.setOnActivatedNewerListener(worker => this.onActivatedNewServiceWorker(worker));
        swHandler.setOnControllerChangeListener(event => this.onControllerChangedToNewServiceWorker(event));
    }

    async onReadyEstreUi() {
        const swHandler = this.swHandler;
        const installing = swHandler.installing;
        const waiting = swHandler.waiting;
        const activated = swHandler.activated;

        // 설치 중인 채 멈춘 서비스 워커 강제 진행
        if (installing != n && installing.state == "installing") {
            navigator.serviceWorker.ready.then(reg => {
                const worker = reg?.active;
                if (window.isDebug) console.log("Force activate installing service worker: ", worker);
                else if (window.isLog) console.log("Force activate installing service worker: " + worker.scriptURL);
            });
        }

        // 대기 중인 서비스 워커 강제 활성화
        if (waiting != n && waiting != swHandler.controller) {
            const controller = swHandler.controller;
            let handled = f;
            if (controller != n) { // 최초 설치가 아닌 경우
                handled = t;
                await swHandler.clearCache(controller);
                waiting.addEventListener("statechange", e => {
                    if (waiting.state == "activated") {
                        if (window.isDebug) console.log("Apply activated service worker by reload: ", waiting);
                        else if (window.isLog) console.log("Apply activated service worker by reload: " + waiting.scriptURL);
                        location.reload();
                    }
                });
            }
            swHandler.skipWaiting(waiting);
            return handled;
        }

        // 활성화됐지만 제어권이 없는 서비스 워커 강제 적용
        if (activated != n && activated != swHandler.controller) {
            const handled = await postPromise(resolve => {
                setTimeout(async _ => {
                    if (activated != swHandler.controller) {
                        if (swHandler.controller != n && (await swHandler.getApplicationCount()) < 2) {
                            window.location.reload();
                            resolve(t);
                            return;
                        }
                        this.onWaitingAnotherClientToClose(activated);
                        resolve(f);
                    } else resolve(f);
                }, 1000); // 메인 컨트롤러 적용 확인 대기
            });
            if (handled) return t;
        }

        if (swHandler.controller != n) this.setServiceWorkerControllerEvents();
    }

    async onInstallingNewServiceWorker(worker) {
        const swHandler = this.swHandler;

        if (this.#swUpdateBeforeAsk) {
            if (!swHandler.isInitialSetup) {
                note("새 버전 앱을 설치하고 있어요...");
            }
        }
    }

    async onWaitingNewServiceWorker(worker) {
        const swHandler = this.swHandler;

        if (this.#swUpdateBeforeAsk) {
            // 방식 1: 즉시 설치 후, 활성화되면 재시작 안내
            if (!swHandler.isInitialSetup) {
                swHandler.skipWaiting(worker);
            }
        } else {
            // 방식 2: 사용자가 동의할 때까지 대기 후 즉시 적용
            if (!swHandler.isInitialSetup) estreToastConfirm({
                title: "새 버전 업데이트 안내",
                message: "새 버전의 LTNC 대시보드가 있어요<br />지금 업데이트할까요?<br /><span class=\"font_sr12\">* 앱을 완전히 닫았다가 다시 열면 자동 적용돼요<br />** 새 버전을 적용하지 않으면 일부 기능이 비정상 작동할 수 있어요</span>",
                positive: "지금 업데이트",
                negative: "나중에",
                callbackPositive: async _ => {
                    await swHandler.controller?.let(it => this.clearCache(it));
                    swHandler.skipWaiting(worker);
                },
            });
        }
    }

    async onActivatedNewServiceWorker(worker) {
        const swHandler = this.swHandler;

        if (this.#swUpdateBeforeAsk) {
            // 방식 1: 즉시 설치 후, 활성화되면 재시작 안내
            if (!swHandler.isInitialSetup) estreToastConfirm({
                title: "앱 재시작 안내",
                message: "새 버전의 LTNC 대시보드가 준비됐어요<br />적용하려면 앱을 재시작해야 해요<br />지금 재시작할까요?<br /><span class=\"font_sr12\">* 앱을 완전히 닫았다가 다시 열면 자동 적용돼요<br />** 새 버전을 적용하지 않으면 일부 기능이 비정상 작동할 수 있어요<br />적용 시 열려 있는 모든 창이 새로고침돼요</span>",
                positive: "지금 적용",
                negative: "나중에",
                callbackPositive: _ => {
                    swHandler.clientsClaim(worker);
                    location.reload();
                },
            });
        } else {
            // 방식 2: 사용자가 동의할 때까지 대기 후 즉시 적용
            if (!swHandler.isInitialSetup) {
                swHandler.clientsClaim(worker);
                location.reload();
            }
        }
    }

    onWaitingAnotherClientToClose(worker) {
        estreToastAlert({
            title: "다른 창의 작업 저장을 기다려요",
            message: "새 버전 앱이 로드됐어요<br />이 안내를 닫으면 이전 버전으로 열린 창들이 새로고침돼요<br />작업 내용을 저장한 뒤 확인을 눌러 모든 창에 새 버전을 적용해 주세요",
            positive: "확인",
            callbackDissmiss: _ => {
                this.swHandler.clientsClaim(worker);
                setTimeout(_ => {
                    if (worker != this.swHandler.controller) location.reload();
                    else note("새 버전 앱이 적용됐어요");
                }, 1000);
            },
        });
    }

    async onControllerChangedToNewServiceWorker(event) {
        const swHandler = this.swHandler;
        const version = await swHandler.getVersion();
        if (window.isLogging) console.log("New service worker controller is ready: v" + version);
        this.setServiceWorkerControllerEvents();
    }

    setServiceWorkerControllerEvents() {
        const swHandler = this.swHandler;
        const controller = swHandler.controller;
        controller.addEventListener("statechange", e => {
            if (controller.state == "redundant") {
                if (window.isDebug) console.log("Current service worker became redundant: ", controller);
                else if (window.isLog) console.log("Current service worker became redundant: " + controller.scriptURL);
                const reloadMessage = "To be reloaded the app to apply new service worker";
                if (swHandler.controller != n && swHandler.controller != controller) {
                    if (window.isLogging) console.log(reloadMessage);
                    location.reload();
                } else swHandler.service.addEventListener("controllerchange", e => {
                    if (window.isDebug) console.log("New service worker is controlling the app: ", swHandler.controller);
                    else if (window.isLog) console.log("New service worker is controlling the app: " + swHandler.controller.scriptURL);
                    if (window.isLogging) console.log(reloadMessage);
                    location.reload();
                });
            }
        });

        this.#swUpdateChecker = setInterval(async _ => {
            await swHandler.update();
        }, 60 * 60 * 1000);
        // ^^ 서비스 워커 업데이트 확인 주기
    }

    async checkUpdate() {
        const worker = await (this.swHandler ?? serviceWorkerHandler).update();
        if (worker) return worker;
        else if (worker == n) note("아직 서비스 준비가 끝나지 않았어요");
        else note("현재 최신 버전이에요");
    }

    async clearCache() {
        if (this.isApp) await window.app.request("clearCache");
        if (this.swHandler.controller != n) await (this.swHandler ?? serviceWorkerHandler).clearCache();
    }

    async forceReload() {
        wait();
        await this.clearCache();
        location.reload();
    }

}


// setup instances
const appPageManager = new AppPageManager();

const appActionManager = new AppActionManager(appPageManager);


// custom handle callbacks
// (없음)


// LTNC 애플리케이션 + EstreUI 초기화
$(document).ready((e) => setTimeout(_ => {

    // 페이지 별칭/핸들러 결선 (LTNCPagesProvider = scripts/app.js)
    appPageManager.init(LTNCPagesProvider.pages, new LTNCPagesProvider(appPageManager));

    // EstreUI 림 초기화
    estreUi.init(false);

    appActionManager.init(serviceWorkerHandler);

    appActionManager.onReadyEstreUi().then(handled => {
        if (!handled) {
            // 시작 페이지 = 대시보드
            appPageManager.bringPage("dashboard");

            // M2: 푸시 알림 클릭으로 새 창이 열린 경우(?ltncOpen=...) 라우팅 — 림 준비 직후 1회 (app.js)
            setTimeout(_ => ltncRouteFromParams(), 80);

            postQueue(_ => estreUi.checkOnReady());
        }
    });
}, 1));
