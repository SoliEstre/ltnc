// app.js — LTNC 통합 글루 (Lane A)
// 역할: EstreUI 페이지(대시보드/서버 상세) 선언 + window.LTNC(데이터 코어) ↔ 타일/차트 연결.
// 의존(로드 순서 보장): estreui 스택 → ltnc-client.js(window.LTNC) → uPlot → ltnc-charts.js(window.LTNCCharts) → app.js → main.js
// 타일(<ltnc-server-card>·<ltnc-conn-badge>)과 차트(LTNCCharts.create)는 CONTRACT.md 의 태그명·시그니처만 사용 — 내부 구현 비의존.

"use strict";


// ── 단위 토글(% ↔ 실제 용량) — 메모리·디스크 박스 "박스별 독립" ──
// 박스 토글은 그 박스 차트 1개만 제자리 교체(전체 재구성 아님). 선택은 박스 정체성(키)별 localStorage 유지.
// pct/abs 짝이 있는 메트릭 ↔ {pct, abs, total(전체-스케일용), absLabel} 매핑. 없으면 null(토글 미부착).
function ltncUnitPair(metric) {
    if (/^mem\.used_(pct|mb)$/.test(metric)) return { pct: "mem.used_pct", abs: "mem.used_mb", total: "mem.total_mb", absLabel: "GB" };
    const m = metric.match(/^disk\.(.+)\.used_(pct|gb)$/);
    if (m) return { pct: `disk.${m[1]}.used_pct`, abs: `disk.${m[1]}.used_gb`, total: `disk.${m[1]}.total_gb`, absLabel: "GB" };
    return null;
}
// 박스 정체성 키(서버 무관 — 같은 종류 박스는 기본 단위 공유): 'mem' · 'disk.<mount>'
function ltncUnitKey(metric) {
    if (/^mem\./.test(metric)) return "mem";
    const m = metric.match(/^disk\.(.+)\.used_/);
    return m ? "disk." + m[1] : null;
}
function ltncUnitModeFor(metric) {
    const k = ltncUnitKey(metric);
    return k && localStorage.getItem("ltnc.unit." + k) === "abs" ? "abs" : "pct";
}
function ltncSetUnitMode(metric, mode) {
    const k = ltncUnitKey(metric);
    if (k) localStorage.setItem("ltnc.unit." + k, mode === "abs" ? "abs" : "pct");
}
// 정규(canonical) 베이스 메트릭 → 현재 박스 단위에 맞는 표시 메트릭
function ltncDisplayMetric(baseMetric) {
    const p = ltncUnitPair(baseMetric);
    if (p == null) return baseMetric;
    return ltncUnitModeFor(baseMetric) === "abs" ? p.abs : p.pct;
}

// 서버 최신값에서 disk.<mount>.used_pct 키로 마운트 발견(root 우선) → 정규 메트릭 배열(추가 디스크 자동 포함)
function ltncDiskMetrics(serverId) {
    const sv = window.LTNC ? LTNC.server(serverId) : null;
    if (sv == null || sv.latest == null) return [];
    return Object.keys(sv.latest)
        .filter(k => /^disk\..+\.used_pct$/.test(k))
        .sort((a, b) => (a.includes(".root.") ? -1 : b.includes(".root.") ? 1 : a.localeCompare(b)));
}
// @checks(외부 체크 가상 서버): 시스템 지표 대신 주소별 응답시간(check.<id>.ms) 차트
function ltncCheckMsMetrics(serverId) {
    const sv = window.LTNC ? LTNC.server(serverId) : null;
    if (sv == null || sv.latest == null) return [];
    return Object.keys(sv.latest).filter(k => /^check\..+\.ms$/.test(k)).sort();
}
// 메트릭 목록은 "정규형"(mem.used_pct·disk.*.used_pct)으로 두고, 표시 단위는 각 셀이 알아서 해석한다.
function ltncDetailMetrics(serverId) {
    if (serverId === "@checks") return ltncCheckMsMetrics(serverId);
    if (serverId === "@hub") return ["loop.lag_ms", "loop.lag_p99_ms", "loop.lag_max_ms"];   // 허브 자가감시: 이벤트루프 지연
    return ["cpu.pct", "mem.used_pct", ...ltncDiskMetrics(serverId),
            "net.rx_kbps", "net.tx_kbps", "diskio.read_kbps", "diskio.write_kbps"];
}
function ltncInlineMetrics(serverId) {
    if (serverId === "@checks") return ltncCheckMsMetrics(serverId);
    if (serverId === "@hub") return ["loop.lag_ms", "loop.lag_max_ms"];   // 카드 프리뷰: 평균 + 최대
    return ["cpu.pct", "mem.used_pct", ...ltncDiskMetrics(serverId), "net.rx_kbps", "net.tx_kbps"];
}

// 전체-스케일 축 최대값의 기본/최소(floor) — 데이터가 이를 초과하면 차트 yScale 가 적응형으로 성장.
const NET_FULLSCALE_FLOOR_MBPS = 100;     // 네트워크 floor (Mbps)
const CHECK_MS_FULLSCALE = 2000;          // 외부체크 응답시간 floor (ms) — @checks 카드 CHECK_MS_MAX 와 동일 기준(폴백)
const LOOP_LAG_FULLSCALE = 100;           // @hub 루프지연 차트 Y축 floor(ms) — 정상 ~수ms 라 과확대 방지
const LOOP_LAG_BANDS = [                   // @hub 루프지연 등급 띠(ms): 좋음/주의/위험 — 차트가 0.11 알파로 배경 칠
    { from: 0,   to: 50,       fill: '#34c759' },   // 좋음(초록)
    { from: 50,  to: 500,      fill: '#ffb020' },   // 주의(노랑)
    { from: 500, to: Infinity, fill: '#ff4d4f' },   // 위험(빨강) — 루프 블록
];
// 메트릭별 full-스케일 floor(원시 단위 — 차트가 vdiv 로 표시단위 변환). 인라인·단독뷰 공용. 해당 없으면 null.
window.ltncFullScaleFloor = (metric) => {
    if (/^net\.(rx|tx)_kbps$/.test(metric)) return NET_FULLSCALE_FLOOR_MBPS * 1e6 / 8 / 1024;        // Mbps→KB/s
    if (/^check\..+\.ms$/.test(metric)) return (window.LTNC_CHECK_MS_MAX ?? CHECK_MS_FULLSCALE);     // ms (게이지와 동일)
    if (/^loop\.lag/.test(metric)) return LOOP_LAG_FULLSCALE;                                        // @hub 루프지연
    return null;
};
// 메트릭별 Y축 등급 띠(임계 밴드) — 외부체크 응답시간 + @hub 루프지연. 해당 없으면 null.
window.ltncThresholdBands = (metric) => {
    if (/^check\..+\.ms$/.test(metric) && Array.isArray(window.LTNC_CHECK_BANDS)) return window.LTNC_CHECK_BANDS;
    if (/^loop\.lag/.test(metric)) return LOOP_LAG_BANDS;
    return null;
};

// 차트 생성 옵션 — abs(실제 용량) 표시면 전체-스케일 상한(fullMax)을 total 메트릭에서 채워줌
function ltncChartOpts(serverId, displayMetric, height, rangeSec) {
    const opts = { server: serverId, metric: displayMetric, rangeSec: rangeSec, height: height, scaleMode: ltncChartPrefs.scaleMode, axisUnit: false };
    const pair = ltncUnitPair(displayMetric);
    if (pair && displayMetric === pair.abs && window.LTNC) {
        const tot = LTNC.server(serverId)?.latest?.[pair.total]?.value;
        if (Number.isFinite(tot) && tot > 0) opts.fullMax = tot;
    }
    // 전체 스케일 상한의 '바닥'(floor): 네트워크=100Mbps · 외부체크 응답시간=2000ms(게이지와 동일).
    // 데이터가 floor 를 초과하면 차트 yScale 가 적응형으로 성장(스파이크 안 잘림).
    const floor = window.ltncFullScaleFloor(displayMetric);
    if (floor != null) opts.fullMin = floor;
    const bands = window.ltncThresholdBands(displayMetric);
    if (bands) opts.thresholdBands = bands;
    return opts;
}

// ── 차트 셀 컨트롤러 — 셀 DOM + 차트 1개 + (해당 시) 박스별 단위 토글 ──
// 반환: { el, destroy(), setRange(sec), setScaleMode(m), setHeight(px) } — 트래킹 배열에 이걸 담는다.
// 단위 토글은 이 셀의 차트만 destroy→create(제자리). 전체 페이지/타 박스는 건드리지 않음.
function ltncMakeChartCell(serverId, baseMetric, titleTag, height, rangeSec) {
    const cell = document.createElement("div");
    cell.className = titleTag === "h3" ? "ltnc_chart_cell" : "ltnc_inline_cell";
    const head = document.createElement(titleTag);
    const txt = document.createElement("span");
    txt.className = "ltnc_chart_ttl";        // flex:1 로 늘어나 버튼들을 우측으로 밀어냄
    head.appendChild(txt);
    cell.appendChild(head);
    const mountEl = document.createElement("div");
    mountEl.className = "ltnc_chart_mount";
    cell.appendChild(mountEl);

    const pair = ltncUnitPair(baseMetric);
    let curHeight = height, curRange = rangeSec, handle = null;

    function syncTitle(displayMetric) {
        const label = window.LTNC ? LTNC.label(displayMetric) : { name: displayMetric, unit: "" };
        txt.textContent = label.unit ? label.name + " (" + label.unit + ")" : label.name;
    }
    function build() {
        const displayMetric = ltncDisplayMetric(baseMetric);
        if (handle) { try { handle.destroy(); } catch {} handle = null; }   // 제자리 교체(기존 차트만 파기)
        syncTitle(displayMetric);
        try {
            handle = LTNCCharts.create(mountEl, ltncChartOpts(serverId, displayMetric, curHeight, curRange));
        } catch (exc) { console.error("[LTNC] 차트 생성 실패:", serverId, displayMetric, exc); handle = null; }
        if (toggleBtn) toggleBtn.textContent = ltncUnitModeFor(baseMetric) === "abs" ? pair.absLabel : "%";
    }

    let toggleBtn = null;
    if (pair != null) {
        toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "ltnc_unit_toggle";
        toggleBtn.title = "표시 전환 (% ↔ 실제 용량)";
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const next = ltncUnitModeFor(baseMetric) === "abs" ? "pct" : "abs";
            ltncSetUnitMode(baseMetric, next);
            build();                                  // 이 셀만 재구성
        });
        head.appendChild(toggleBtn);
    }

    // 상세보기(전체화면 단독 그래프) 버튼 — 모든 차트 박스
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "ltnc_expand_btn";
    expandBtn.textContent = "⛶";
    expandBtn.title = "상세보기 (전체화면 단독 그래프)";
    expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.LTNCChartDetail) window.LTNCChartDetail.open({ server: serverId, metric: ltncDisplayMetric(baseMetric) });
    });
    head.appendChild(expandBtn);

    build();

    return {
        el: cell,
        destroy() { if (handle) { try { handle.destroy(); } catch {} handle = null; } },
        setRange(sec) { curRange = sec; if (handle) try { handle.setRange(sec); } catch {} },
        setScaleMode(m) { if (handle && handle.setScaleMode) try { handle.setScaleMode(m); } catch {} },
        setHeight(px) { curHeight = px; if (handle && handle.setHeight) try { handle.setHeight(px); } catch {} },
    };
}

const LTNC_DEFAULT_RANGE_SEC = 3600; // 기본 조회 범위: 1시간

// ── 대시보드 보기 모드 (cards = 카드 그리드 / expanded = 서버별 차트 펼침) ──
const LTNC_INLINE_BASE_HEIGHT = 110;  // 1x 기준 높이(px)
let ltncDashView = (localStorage.getItem("ltnc.dashView") === "expanded") ? "expanded" : "cards";
let ltncCardWidth = (localStorage.getItem("ltnc.cardWidth") === "full") ? "full" : "fit";   // 카드 폭: fit(내용맞춤 wrap, 기본) | full(전체폭 1열)
const ltncInlineCharts = new Map();   // serverId -> [LTNCCharts 핸들]

// ── 차트 표시 설정 (구간/세로축 범위/높이 — 전부 localStorage 유지) ──
const ltncChartPrefs = {
    rangeSec: parseInt(localStorage.getItem("ltnc.rangeSec"), 10) || 3600,                          // 구간(초)
    scaleMode: localStorage.getItem("ltnc.scaleMode") === "full" ? "full" : "auto",                  // 상대/전체
    heightX: Math.min(4, Math.max(1, parseFloat(localStorage.getItem("ltnc.heightX")) || 1)),       // 1x~4x (0.5 단위)
};
function ltncInlineHeight() { return LTNC_INLINE_BASE_HEIGHT * ltncChartPrefs.heightX; }

// 컨트롤 바 active 상태·표시여부 동기화
function ltncSyncControls() {
    const bar = document.getElementById("dashControls");
    if (bar == null) return;
    bar.hidden = ltncDashView !== "expanded";
    bar.querySelectorAll("button[data-range-view]").forEach(b =>
        b.dataset.active = parseInt(b.dataset.rangeView, 10) === ltncChartPrefs.rangeSec ? "1" : "");
    bar.querySelectorAll("button[data-scale]").forEach(b =>
        b.dataset.active = b.dataset.scale === ltncChartPrefs.scaleMode ? "1" : "");
    bar.querySelectorAll("button[data-heightx]").forEach(b =>
        b.dataset.active = parseFloat(b.dataset.heightx) === ltncChartPrefs.heightX ? "1" : "");
}

// 살아있는 인라인 차트 전체에 함수 적용
function ltncEachInlineChart(fn) {
    for (const handles of ltncInlineCharts.values()) {
        for (const chart of handles) { try { fn(chart); } catch (exc) { console.error("[LTNC] 차트 설정 적용 실패:", exc); } }
    }
}

function ltncDestroyInlineCharts(serverId) {
    const ids = serverId != null ? [serverId] : [...ltncInlineCharts.keys()];
    for (const id of ids) {
        for (const chart of ltncInlineCharts.get(id) ?? []) {
            try { chart.destroy(); } catch (exc) { /* 이미 해제 — 무시 */ }
        }
        ltncInlineCharts.delete(id);
    }
}

// 서버 섹션에 인라인 차트 스트립 장착 (펼침 모드 전용 — 멱등)
function ltncMountInlineCharts(section, serverId) {
    if (section.querySelector(".ltnc_inline_charts") != null) return;
    if (window.LTNCCharts == null) return;     // 차트 모듈 미로드 시 카드만 표시 (림 생존)

    const strip = document.createElement("div");
    strip.className = "ltnc_inline_charts";
    const controllers = [];
    for (const metric of ltncInlineMetrics(serverId)) {
        const ctrl = ltncMakeChartCell(serverId, metric, "h4", ltncInlineHeight(), ltncChartPrefs.rangeSec);
        strip.appendChild(ctrl.el);
        controllers.push(ctrl);
    }
    section.appendChild(strip);
    ltncInlineCharts.set(serverId, controllers);
}

// ── 대시보드 서버 그리드 렌더 (멱등 — init 재수신/모드 전환/재호출 안전) ──
// 구조: #serverGrid > .ltnc_server_section[data-server] > <ltnc-server-card> [+ .ltnc_inline_charts(펼침)]
// cards 모드에선 섹션이 display:contents 라 기존 그리드 레이아웃 그대로 유지.
function ltncRenderServerGrid() {
    const grid = document.getElementById("serverGrid");
    if (grid == null || window.LTNC == null) return;
    grid.dataset.view = ltncDashView;
    grid.dataset.width = ltncCardWidth;

    const list = LTNC.servers();
    if (list.length > 0) grid.querySelector(".ltnc_grid_empty")?.remove();

    const seen = new Set();
    for (const s of list) {
        seen.add(s.id);
        let section = grid.querySelector('.ltnc_server_section[data-server="' + s.id + '"]');
        if (section == null) {
            section = document.createElement("div");
            section.className = "ltnc_server_section";
            section.dataset.server = s.id;
            // @checks(외부 HTTP 체크 가상 서버)는 전용 카드, 그 외 서버는 일반 서버 카드
            const card = document.createElement(s.id === "@checks" ? "ltnc-checks-card" : "ltnc-server-card");
            card.setAttribute("server", s.id);
            section.appendChild(card);
            grid.appendChild(section);
        }
        if (ltncDashView === "expanded") {
            ltncMountInlineCharts(section, s.id);
        } else {
            section.querySelector(".ltnc_inline_charts")?.remove();
            ltncDestroyInlineCharts(s.id);
        }
    }
    // 목록에서 사라진 서버 섹션은 차트 해제 후 제거
    grid.querySelectorAll(".ltnc_server_section").forEach(section => {
        const id = section.dataset.server;
        if (!seen.has(id)) { ltncDestroyInlineCharts(id); section.remove(); }
    });

    // 토글 버튼 라벨 + 컨트롤 바 동기화
    const toggle = document.getElementById("dashViewToggle");
    if (toggle != null) {
        toggle.textContent = ltncDashView === "expanded" ? "🃏 카드만 보기" : "📊 차트 펼침";
        toggle.dataset.active = ltncDashView === "expanded" ? "1" : "";
    }
    const widthToggle = document.getElementById("dashWidthToggle");
    if (widthToggle != null) {
        widthToggle.textContent = ltncCardWidth === "full" ? "▭ 전체폭" : "▦ 내용맞춤";
        widthToggle.dataset.active = ltncCardWidth === "full" ? "1" : "";
    }
    ltncSyncControls();
}

// 보기 모드 전환 (토글 버튼)
function ltncToggleDashView() {
    ltncDashView = ltncDashView === "expanded" ? "cards" : "expanded";
    localStorage.setItem("ltnc.dashView", ltncDashView);
    ltncRenderServerGrid();
}

// 카드 폭 전환 (내용맞춤 wrap ↔ 전체폭 1열)
function ltncToggleCardWidth() {
    ltncCardWidth = ltncCardWidth === "full" ? "fit" : "full";
    localStorage.setItem("ltnc.cardWidth", ltncCardWidth);
    ltncRenderServerGrid();
}


// ── 페이지 핸들러: 대시보드 ──
class LTNCDashboardPage extends EstrePageHandler {

    onBring(handle) {
        ltncRenderServerGrid();
    }

    onShow(handle) {
        // WS init 이 페이지 마운트보다 먼저 도착한 경우를 흡수
        ltncRenderServerGrid();
    }

}


// ── 페이지 핸들러: 서버 상세 (instant — 열 때마다 DOM 재생성) ──
class LTNCServerDetailPage extends EstrePageHandler {

    #serverId = null;       // 현재 표시 중인 서버 id
    #charts = [];           // LTNCCharts 핸들 목록 [{destroy, setRange, el}]
    #rangeSec = LTNC_DEFAULT_RANGE_SEC;

    onBring(handle) {
        const serverId = handle.intent?.data?.server;
        this.#rangeSec = LTNC_DEFAULT_RANGE_SEC;
        this.#bindRangeButtons();
        this.#mount(serverId);
    }

    onIntentUpdated(handle, intent) {
        // 이미 열린 상태에서 다른 서버 카드 클릭 → 차트 재구성
        const serverId = intent?.data?.server;
        if (serverId != null && serverId !== this.#serverId) this.#mount(serverId);
    }

    onClose(handle) {
        this.#destroyCharts();
        this.#serverId = null;
    }

    // 헤더 + 차트 mount
    #mount(serverId) {
        if (serverId == null) return;
        this.#serverId = serverId;

        // 헤더: 서버명 + 호스트
        const info = window.LTNC?.server(serverId);
        const nameEl = document.getElementById("serverDetailName");
        const hostEl = document.getElementById("serverDetailHost");
        if (nameEl) nameEl.textContent = serverId;
        if (hostEl) hostEl.textContent = info?.host ?? "";

        // 차트 영역
        const area = document.getElementById("serverCharts");
        if (area == null) return;
        this.#destroyCharts();
        area.innerHTML = "";

        // 차트 모듈(Lane C) 미로드 가드 — 통합 전에도 림은 동작해야 함
        if (window.LTNCCharts == null) {
            const warn = document.createElement("div");
            warn.className = "ltnc_charts_unavailable";
            warn.textContent = "차트 모듈(ltnc-charts.js)을 불러오지 못했어요.";
            area.appendChild(warn);
            return;
        }

        // 메트릭별 셀 컨트롤러(제목+차트, 메모리·디스크는 박스별 단위 토글 — 그 박스만 제자리 교체)
        for (const metric of ltncDetailMetrics(serverId)) {
            const ctrl = ltncMakeChartCell(serverId, metric, "h3", 180, this.#rangeSec);  // 상세는 자체 범위(1h/6h/24h)
            area.appendChild(ctrl.el);
            this.#charts.push(ctrl);
        }
    }

    // 조회 범위 버튼(1시간/6시간/24시간) 바인딩 — instant 페이지라 onBring 마다 새 DOM
    #bindRangeButtons() {
        const bar = document.getElementById("serverCharts")?.closest("article")?.querySelector(".ltnc_range_set");
        if (bar == null) return;
        bar.querySelectorAll("button[data-range]").forEach(btn => {
            btn.addEventListener("click", () => {
                const sec = parseInt(btn.dataset.range, 10);
                if (!Number.isFinite(sec)) return;
                this.#rangeSec = sec;
                bar.querySelectorAll("button[data-range]").forEach(b => b.dataset.active = b === btn ? "1" : "");
                for (const chart of this.#charts) {
                    try { chart.setRange(sec); } catch (exc) { console.error("[LTNC] setRange 실패:", exc); }
                }
            });
        });
    }

    #destroyCharts() {
        for (const chart of this.#charts) {
            try { chart.destroy(); } catch (exc) { /* 이미 해제된 경우 무시 */ }
        }
        this.#charts = [];
    }

}


// ── Pages Provider — PID 별칭 + 핸들러 매핑 (main.js 의 appPageManager.init 에서 사용) ──
class LTNCPagesProvider {

    // 외부 PID 별칭 등록
    static get pages() { return {
        "dashboard": "&m=home",     // 대시보드 (staticDoc home 섹션)
        "server": "&b=server",      // 서버 상세 (instantDoc blinded 섹션)
        "alerts": "&b=alerts",      // M2: 알림센터 (instantDoc blinded 섹션)
        "warroom": "&b=warroom",    // M2: 컷오버 워룸 (instantDoc blinded 섹션)
    }; }


    // properties
    #pageManager = null;
    get pageManager() { return this.#pageManager; }

    constructor(pageManager) {
        this.#pageManager = pageManager;
    }


    // 페이지 핸들러 선언
    "dashboard" = LTNCDashboardPage;
    "server" = LTNCServerDetailPage;
    "alerts" = LTNCAlertsPage;      // M2 (클래스 정의는 아래 M2 블록 — 인스턴스화 시점엔 초기화 완료)
    "warroom" = LTNCWarroomPage;    // M2

}


// ── 문서 레벨 글루 (스크립트 로드 즉시 결선 — 콜백 실행 시점엔 매니저 준비 완료) ──

// 1) 허브 init(서버 목록) 수신 → 대시보드 그리드 동기화
if (window.LTNC != null) {
    LTNC.on("init", () => ltncRenderServerGrid());
} else {
    console.error("[LTNC] 데이터 코어(ltnc-client.js)가 로드되지 않았어요 — index.html 로드 순서를 확인하세요.");
}

// 2) 서버 카드 클릭(타일 발행 CustomEvent) → 서버 상세 페이지 전환
document.addEventListener("ltnc:open-server", e => {
    const serverId = e.detail?.server;
    if (serverId == null) return;
    appPageManager.bringPage("server", { data: { server: serverId } });
});

// 3) 앱 타이틀 클릭 → 대시보드 복귀 (fixedTop #appTitleBtn — 마운트 후 위임 바인딩)
document.addEventListener("click", e => {
    if (e.target.closest?.("#appTitleBtn") != null) appPageManager.bringPage("dashboard");
});
// 상세 백네비게이션은 instantDoc.html 의 인라인 onclick(pageHandle.getHost('component').close())이 처리.

// 4) 대시보드 보기 모드 토글 (카드 그리드 ↔ 서버별 차트 펼침) — 위임 바인딩
document.addEventListener("click", e => {
    if (e.target.closest?.("#dashViewToggle") != null) ltncToggleDashView();
    else if (e.target.closest?.("#dashWidthToggle") != null) ltncToggleCardWidth();
});

// 5) 차트 컨트롤 바 (구간/범위/높이) — 위임 바인딩, 선택 즉시 적용 + localStorage 유지
document.addEventListener("click", e => {
    const rangeBtn = e.target.closest?.("#dashControls button[data-range-view]");
    if (rangeBtn != null) {
        const sec = parseInt(rangeBtn.dataset.rangeView, 10);
        if (!Number.isFinite(sec)) return;
        ltncChartPrefs.rangeSec = sec;
        localStorage.setItem("ltnc.rangeSec", String(sec));
        ltncEachInlineChart(c => c.setRange(sec));
        ltncSyncControls();
        return;
    }
    const scaleBtn = e.target.closest?.("#dashControls button[data-scale]");
    if (scaleBtn != null) {
        const m = scaleBtn.dataset.scale === "full" ? "full" : "auto";
        ltncChartPrefs.scaleMode = m;
        localStorage.setItem("ltnc.scaleMode", m);
        ltncEachInlineChart(c => c.setScaleMode?.(m));
        ltncSyncControls();
        return;
    }
    const heightBtn = e.target.closest?.("#dashControls button[data-heightx]");
    if (heightBtn != null) {
        const x = parseFloat(heightBtn.dataset.heightx);
        if (!Number.isFinite(x) || x < 1 || x > 4) return;
        ltncChartPrefs.heightX = x;
        localStorage.setItem("ltnc.heightX", String(x));
        ltncEachInlineChart(c => c.setHeight?.(ltncInlineHeight()));
        ltncSyncControls();
    }
});


// ════════════════════════════════════════════════════════════════════
// M2 확장 — 로그인 게이트 · 알림센터 · 푸시 구독 · 컷오버 워룸
// (계약 = packages/web/CONTRACT.md "M2 확장 계약" 절. 기존 M0/M1 동작 비변경.)
// ════════════════════════════════════════════════════════════════════


// ── M2-1. 로그인 오버레이 (데이터 API 401 / WS close 4401 → 표시) ──

let ltncLoginVisible = false;   // 중복 표시 가드

function ltncShowLoginOverlay() {
    let overlay = document.getElementById("ltncLoginOverlay");
    if (overlay == null) {
        overlay = document.createElement("div");
        overlay.id = "ltncLoginOverlay";
        overlay.innerHTML =
            '<form id="ltncLoginForm" class="ltnc_login_card" autocomplete="on">' +
            '  <img class="ltnc_login_logo" src="./vectors/app_icon.svg" alt="LTNC" />' +
            '  <h2><span class="ltnc_accent">LTNC</span> 로그인</h2>' +
            '  <p class="ltnc_login_desc">모니터링 데이터를 보려면 로그인이 필요해요</p>' +
            '  <input type="text" name="user" placeholder="아이디" autocomplete="username" required />' +
            '  <input type="password" name="pass" placeholder="비밀번호" autocomplete="current-password" required />' +
            '  <div class="ltnc_login_error" hidden></div>' +
            '  <button type="submit">로그인</button>' +
            '</form>';
        document.body.appendChild(overlay);
        overlay.querySelector("form").addEventListener("submit", ltncSubmitLogin);
    }
    overlay.hidden = false;
    if (!ltncLoginVisible) {
        ltncLoginVisible = true;
        setTimeout(_ => overlay.querySelector('input[name="user"]')?.focus(), 60);
    }
}

function ltncHideLoginOverlay() {
    ltncLoginVisible = false;
    const overlay = document.getElementById("ltncLoginOverlay");
    if (overlay != null) overlay.hidden = true;
}

async function ltncSubmitLogin(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const errEl = form.querySelector(".ltnc_login_error");
    const submitBtn = form.querySelector('button[type="submit"]');
    const user = form.user.value.trim();
    const pass = form.pass.value;
    if (!user || !pass) return;
    submitBtn.disabled = true;
    errEl.hidden = true;
    try {
        const r = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user, pass }),
        });
        if (r.ok) {
            form.pass.value = "";
            ltncHideLoginOverlay();
            // 로그인 성공 → 데이터 재로드 + WS 즉시 재연결 + 알림 재로드 (계약 M2)
            window.LTNC?.refresh().catch(() => {});
            window.LTNC?.reconnect?.();
            ltncLoadAlerts(true);
            window.note?.("로그인했어요");
        } else if (r.status === 401) {
            errEl.textContent = "아이디 또는 비밀번호가 올바르지 않아요";
            errEl.hidden = false;
        } else {
            errEl.textContent = "로그인에 실패했어요 (" + r.status + ")";
            errEl.hidden = false;
        }
    } catch (exc) {
        errEl.textContent = "서버에 연결할 수 없어요 — 잠시 후 다시 시도해 주세요";
        errEl.hidden = false;
    } finally {
        submitBtn.disabled = false;
    }
}

async function ltncLogout() {
    try { await fetch("/api/logout", { method: "POST" }); } catch (exc) { /* 네트워크 실패여도 로그인 화면으로 진행 */ }
    // 세션 종료 → 클라이언트측 알림 상태 초기화 + 로그인 화면
    ltncAlertsState.list = [];
    ltncAlertsState.loaded = false;
    ltncRenderAlerts();
    ltncUpdateAlertBadge();
    window.note?.("로그아웃했어요");
    ltncShowLoginOverlay();
}


// ── M2-2. 알림센터 — 스토어(WS {t:'alert'} 실시간 + GET /api/alerts 초기) ──

const ltncAlertsState = { list: [], loaded: false, loading: false };
const LTNC_SEVERITY_LABEL = { warn: "주의", crit: "심각" };

// 미확인 = firing 상태이면서 아직 ack(확인 처리)되지 않은 알림
function ltncUnreadCount() {
    return ltncAlertsState.list.filter(a => a?.state === "firing" && a?.ackAt == null).length;
}

async function ltncLoadAlerts(force) {
    if (ltncAlertsState.loading) return;
    if (ltncAlertsState.loaded && force !== true) { ltncRenderAlerts(); ltncUpdateAlertBadge(); return; }
    ltncAlertsState.loading = true;
    try {
        const r = await fetch("/api/alerts?limit=50");
        if (r.status === 401) { ltncShowLoginOverlay(); return; }
        if (!r.ok) return;
        const data = await r.json();
        ltncAlertsState.list = Array.isArray(data?.alerts) ? data.alerts : [];
        ltncAlertsState.loaded = true;
        ltncRenderAlerts();
        ltncUpdateAlertBadge();
    } catch (exc) {
        console.error("[LTNC] 알림 목록 로드 실패:", exc);
    } finally {
        ltncAlertsState.loading = false;
    }
}

// 실시간 수신 알림 병합 (발생/해소 모두 동일 id 로 갱신됨)
function ltncUpsertAlert(alert) {
    if (alert?.id == null) return;
    const idx = ltncAlertsState.list.findIndex(a => a.id === alert.id);
    if (idx >= 0) ltncAlertsState.list[idx] = { ...ltncAlertsState.list[idx], ...alert };
    else ltncAlertsState.list.unshift(alert);
    if (ltncAlertsState.list.length > 200) ltncAlertsState.list.length = 200;   // 메모리 상한
    ltncRenderAlerts();
    ltncUpdateAlertBadge();
}

// 앱바 벨 뱃지 + OS 앱 아이콘 뱃지(navigator.setAppBadge) 동기화
function ltncUpdateAlertBadge() {
    const count = ltncUnreadCount();
    document.querySelectorAll(".ltnc_bell_badge").forEach(badge => {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? "99+" : String(count);
    });
    try {
        if (count > 0) navigator.setAppBadge?.(count)?.catch?.(() => {});
        else navigator.clearAppBadge?.()?.catch?.(() => {});
    } catch (exc) { /* Badging API 미지원 — 무시 */ }
}

function ltncFormatAlertTime(ts) {
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts * 1000);
    const p2 = v => String(v).padStart(2, "0");
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate())
        + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
}

// 알림 목록 렌더 (알림 페이지가 열려 있을 때만 — 엘리먼트 부재 시 no-op)
function ltncRenderAlerts() {
    const listEl = document.getElementById("alertsList");
    if (listEl == null) return;
    listEl.innerHTML = "";

    if (ltncAlertsState.list.length === 0) {
        const empty = document.createElement("li");
        empty.className = "ltnc_alerts_empty";
        empty.textContent = ltncAlertsState.loaded ? "표시할 알림이 없어요 — 모두 정상이에요" : "알림을 불러오는 중…";
        listEl.appendChild(empty);
        return;
    }

    const sorted = [...ltncAlertsState.list].sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));
    for (const alert of sorted) {
        const li = document.createElement("li");
        li.className = "ltnc_alert_item";
        li.dataset.severity = alert.severity ?? "";
        li.dataset.state = alert.state ?? "";
        if (alert.ackAt != null) li.dataset.acked = "1";

        // 심각도 칩 (warn=주황 / crit=빨강 / resolved=회색)
        const chip = document.createElement("span");
        chip.className = "ltnc_alert_chip";
        chip.textContent = alert.state === "resolved" ? "해소" : (LTNC_SEVERITY_LABEL[alert.severity] ?? alert.severity ?? "-");
        li.appendChild(chip);

        // 본문: 서버 · 제목 / 상세 / 시각
        const body = document.createElement("div");
        body.className = "ltnc_alert_body";
        const head = document.createElement("div");
        head.className = "ltnc_alert_head";
        const serverEl = document.createElement("strong");
        serverEl.textContent = alert.server ?? "-";
        const titleEl = document.createElement("span");
        titleEl.textContent = alert.title ?? alert.metric ?? "";
        head.append(serverEl, titleEl);
        body.appendChild(head);
        if (alert.detail) {
            const detailEl = document.createElement("div");
            detailEl.className = "ltnc_alert_detail";
            detailEl.textContent = alert.detail;
            body.appendChild(detailEl);
        }
        const timeEl = document.createElement("div");
        timeEl.className = "ltnc_alert_time";
        timeEl.textContent = ltncFormatAlertTime(alert.ts) + (alert.ackAt != null ? " · 확인됨" : "");
        body.appendChild(timeEl);
        li.appendChild(body);

        // ack(확인) 버튼 — 미확인 + firing 인 경우만
        if (alert.ackAt == null && alert.state === "firing") {
            const ackBtn = document.createElement("button");
            ackBtn.type = "button";
            ackBtn.className = "ltnc_alert_ack";
            ackBtn.textContent = "확인";
            ackBtn.title = "이 알림을 확인 처리해요";
            ackBtn.addEventListener("click", () => ltncAckAlert(alert.id, ackBtn));
            li.appendChild(ackBtn);
        }
        listEl.appendChild(li);
    }
}

async function ltncAckAlert(id, btn) {
    if (btn != null) btn.disabled = true;
    try {
        const r = await fetch("/api/alerts/" + encodeURIComponent(id) + "/ack", { method: "POST" });
        if (r.status === 401) { ltncShowLoginOverlay(); return; }
        if (!r.ok) throw new Error("ack " + r.status);
        const target = ltncAlertsState.list.find(a => a.id === id);
        if (target != null) target.ackAt = Math.floor(Date.now() / 1000);
        ltncRenderAlerts();
        ltncUpdateAlertBadge();
    } catch (exc) {
        console.error("[LTNC] 알림 확인 처리 실패:", exc);
        if (btn != null) btn.disabled = false;
    }
}


// ── M2-3. 웹푸시 구독 토글 (알림 페이지 상단) ──

const LTNC_PUSH = {
    get supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; },
    // iPadOS 가 데스크톱 UA 를 쓰는 경우까지 포함한 iOS 계열 판별
    get isIos() { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); },
    get isStandalone() { return window.matchMedia?.("(display-mode: standalone)")?.matches === true || navigator.standalone === true; },
};

// VAPID 공개키(base64url) → Uint8Array (pushManager.subscribe 용)
function ltncUrlB64ToU8(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function ltncGetPushSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
}

// 구독 상태 → 패널 UI 동기화
async function ltncSyncPushPanel() {
    const stateEl = document.getElementById("alertsPushState");
    const toggle = document.getElementById("alertsPushToggle");
    const iosNote = document.getElementById("alertsPushIosNote");
    if (stateEl == null || toggle == null) return;

    // iOS(사파리)는 홈 화면 설치(standalone) 상태에서만 웹푸시 가능
    if (LTNC_PUSH.isIos && !LTNC_PUSH.isStandalone) {
        toggle.disabled = true;
        stateEl.textContent = "홈 화면에 추가 후 사용 가능해요";
        if (iosNote != null) iosNote.hidden = false;
        return;
    }
    if (!LTNC_PUSH.supported) {
        toggle.disabled = true;
        stateEl.textContent = "이 브라우저는 푸시 알림을 지원하지 않아요";
        return;
    }
    if (Notification.permission === "denied") {
        toggle.disabled = true;
        stateEl.textContent = "알림 권한이 차단돼 있어요 — 브라우저 설정에서 허용해 주세요";
        return;
    }
    try {
        const sub = await ltncGetPushSubscription();
        toggle.disabled = false;
        toggle.dataset.subscribed = sub != null ? "1" : "";
        toggle.textContent = sub != null ? "푸시 끄기" : "푸시 켜기";
        stateEl.textContent = sub != null ? "이 기기로 푸시 알림을 받고 있어요" : "푸시 알림이 꺼져 있어요";
    } catch (exc) {
        console.error("[LTNC] 푸시 구독 상태 확인 실패:", exc);
        toggle.disabled = true;
        stateEl.textContent = "푸시 상태를 확인하지 못했어요";
    }
}

// 구독/해제 토글 — 반드시 버튼 클릭 핸들러에서 직접 호출 (권한 요청 = 사용자 제스처 요건)
async function ltncTogglePush() {
    const toggle = document.getElementById("alertsPushToggle");
    const stateEl = document.getElementById("alertsPushState");
    if (toggle == null || toggle.disabled) return;
    const wasSubscribed = toggle.dataset.subscribed === "1";
    toggle.disabled = true;
    try {
        if (wasSubscribed) {
            // 구독 해제 → 허브에도 endpoint 폐기 통지
            const existing = await ltncGetPushSubscription();
            if (existing != null) {
                const endpoint = existing.endpoint;
                await existing.unsubscribe();
                try {
                    await fetch("/api/push/unsubscribe", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ endpoint }),
                    });
                } catch (exc) { /* 허브 통지 실패해도 로컬 해제는 완료 */ }
            }
            window.note?.("푸시 알림을 껐어요");
        } else {
            // 권한 요청은 사용자 제스처 체인 안에서 가장 먼저 (iOS 사파리 요건)
            const perm = await Notification.requestPermission();
            if (perm !== "granted") {
                if (stateEl != null) stateEl.textContent = "알림 권한이 허용되지 않았어요";
                return;
            }
            const vr = await fetch("/api/push/vapid");
            if (vr.status === 401) { ltncShowLoginOverlay(); return; }
            if (!vr.ok) throw new Error("vapid " + vr.status);
            const { publicKey } = await vr.json();
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: ltncUrlB64ToU8(publicKey),
            });
            const sr = await fetch("/api/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription: sub.toJSON() }),
            });
            if (!sr.ok) {
                // 허브 등록 실패 → 로컬 구독 롤백 (유령 구독 방지)
                try { await sub.unsubscribe(); } catch (exc) { /* 무시 */ }
                if (sr.status === 401) { ltncShowLoginOverlay(); return; }
                throw new Error("subscribe " + sr.status);
            }
            window.note?.("이 기기로 푸시 알림을 받아요");
        }
    } catch (exc) {
        console.error("[LTNC] 푸시 구독 처리 실패:", exc);
        window.note?.("푸시 설정에 실패했어요");
    } finally {
        await ltncSyncPushPanel();
    }
}


// ── M2-4. 페이지 핸들러: 알림센터 (instant — 열 때마다 DOM 재생성) ──
class LTNCAlertsPage extends EstrePageHandler {

    onBring(handle) {
        // instant 페이지 — 매 오픈마다 새 DOM 이므로 매번 바인딩
        document.getElementById("alertsPushToggle")
            ?.addEventListener("click", () => ltncTogglePush());
        ltncSyncPushPanel();
        ltncRenderAlerts();
        ltncLoadAlerts();   // 미로드 시에만 fetch (로드됨이면 즉시 렌더)
        // handle.intent?.data?.alertId — 푸시 클릭 진입용 예약 (목록 최신순 표시로 충족)
    }

    onShow(handle) {
        ltncRenderAlerts();
        ltncSyncPushPanel();
    }

}


// ── M2-5. 페이지 핸들러: 컷오버 워룸 (instant) ──
// ① 복제 지연(복제본 자동 발견 · exec.mysql_replica_lag) ② 양측 응답시간 비교(@checks · /api/checks 동적)
// ③ 4대 + @checks 상태 요약 스트립. 차트 = LTNCCharts 재사용(scaleMode 등 기존 prefs).
class LTNCWarroomPage extends EstrePageHandler {

    #charts = [];       // LTNCCharts 핸들
    #unsubs = [];       // LTNC.on 해제 함수
    #timers = [];       // 재확인 타이머
    #rangeSec = LTNC_DEFAULT_RANGE_SEC;
    #checks = [];       // /api/checks 최신 상태 캐시 (스트립 칩용)
    #floatCleanup = null;   // 와이드 화면 드래그 이동 리스너 해제

    onBring(handle) {
        this.#teardown();
        this.#rangeSec = LTNC_DEFAULT_RANGE_SEC;
        this.#bindRangeButtons();
        this.#renderStrip();
        // 실시간 갱신 구독 (페이지 닫힐 때 해제)
        this.#unsubs.push(LTNC.on("init", () => this.#renderStrip()));
        this.#unsubs.push(LTNC.on("metrics", () => this.#renderStrip()));
        this.#unsubs.push(LTNC.on("presence", () => this.#renderStrip()));
        this.#mountReplica();
        this.#mountChecks();
        this.#enableFloating();   // 와이드 화면: 상세바 드래그로 다이얼로그 이동 (리사이즈는 CSS resize)
    }

    onClose(handle) {
        this.#teardown();
    }

    #teardown() {
        if (this.#floatCleanup != null) { try { this.#floatCleanup(); } catch (exc) { /* 무시 */ } this.#floatCleanup = null; }
        for (const chart of this.#charts) { try { chart.destroy(); } catch (exc) { /* 이미 해제 — 무시 */ } }
        this.#charts = [];
        for (const off of this.#unsubs) { try { off(); } catch (exc) { /* 무시 */ } }
        this.#unsubs = [];
        for (const timer of this.#timers) clearTimeout(timer);
        this.#timers = [];
    }

    // ③ 상태 요약 스트립 — 서버 4대(online·CPU·메모리) + @checks(업/다운 칩)
    #renderStrip() {
        const strip = document.getElementById("warroomStrip");
        if (strip == null || window.LTNC == null) return;
        strip.innerHTML = "";

        for (const s of LTNC.servers()) {
            if (s.id === "@checks") continue;   // 가상 서버는 체크 칩으로 별도 표시
            const item = document.createElement("span");
            item.className = "ltnc_strip_item";
            item.dataset.online = s.online ? "1" : "";
            const cpu = s.latest?.["cpu.pct"]?.value;
            const mem = s.latest?.["mem.used_pct"]?.value;
            const stat = (Number.isFinite(cpu) ? " CPU " + Math.round(cpu) + "%" : "")
                + (Number.isFinite(mem) ? " · 메모리 " + Math.round(mem) + "%" : "");
            const dot = document.createElement("i");
            dot.className = "ltnc_strip_dot";
            item.appendChild(dot);
            item.appendChild(document.createTextNode(s.id + (s.online ? stat : " 오프라인")));
            strip.appendChild(item);
        }
        // HTTP 체크(외부 응답 확인) 상태 칩
        for (const chk of this.#checks) {
            if (chk?.id == null) continue;
            const chip = document.createElement("span");
            chip.className = "ltnc_strip_check";
            const isUp = chk.up === 1 || chk.up === true;
            chip.dataset.up = isUp ? "1" : "0";
            chip.textContent = chk.id + (isUp
                ? (Number.isFinite(chk.ms) ? " " + Math.round(chk.ms) + "ms" : " 정상")
                : " 응답없음");
            strip.appendChild(chip);
        }
        if (strip.childElementCount === 0) {
            const empty = document.createElement("span");
            empty.className = "ltnc_warroom_note";
            empty.textContent = "서버 목록을 불러오는 중…";
            strip.appendChild(empty);
        }
    }

    // ① 복제 지연 차트 — 일반화: 특정 서버 하드코딩 없이 어떤 서버 이전/컷오버 시나리오에도 적용.
    //   대상 = (a) window.LTNC_WARROOM.replicaServers[] 명시 우선, 없으면
    //          (b) replicaMetric(기본 'exec.mysql_replica_lag') 을 보고하는 서버를 자동 발견 → 발견된 복제본 모두 차트.
    //   데이터가 아직 없으면 '대기중' 안내 + 60초 주기 재확인.
    //   (예: 에이전트 agent.yaml 의 execMetrics 로 mysql_replica_lag 를 보고하거나, index.html 에
    //        window.LTNC_WARROOM = { replicaServers:['db-standby'], replicaMetric:'exec.pg_replica_lag' } 식으로 지정)
    async #mountReplica() {
        const wrap = document.getElementById("warroomReplica");
        if (wrap == null || window.LTNC == null) return;
        const cfg = window.LTNC_WARROOM || {};
        const metric = cfg.replicaMetric || "exec.mysql_replica_lag";
        const servers = (Array.isArray(cfg.replicaServers) && cfg.replicaServers.length)
            ? cfg.replicaServers.slice()
            : LTNC.servers().filter(s => s && s.id !== "@checks" && s.latest && s.latest[metric] != null).map(s => s.id);
        if (!wrap.isConnected) return;   // 페이지가 이미 닫힘 (instant DOM 해제)

        wrap.innerHTML = "";
        if (servers.length === 0) {
            const notice = document.createElement("div");
            notice.className = "ltnc_warroom_wait";
            notice.textContent = "복제 지연 데이터 대기중 — 에이전트가 '" + metric + "' 수치를 보고하면 자동으로 표시됩니다 (agent.yaml 의 execMetrics 또는 window.LTNC_WARROOM 으로 지정).";
            wrap.appendChild(notice);
            this.#timers.push(setTimeout(() => this.#mountReplica(), 60000));
            return;
        }
        if (window.LTNCCharts == null) {
            wrap.innerHTML = '<div class="ltnc_warroom_note">차트 모듈(ltnc-charts.js)을 불러오지 못했어요</div>';
            return;
        }
        const unit = (window.LTNC ? LTNC.label(metric).unit : "") || "";
        for (const sid of servers) {
            const cell = document.createElement("div");
            cell.className = "ltnc_chart_cell";
            const title = document.createElement("h3");
            title.textContent = "복제 지연 — " + sid + (unit ? " (" + unit + ")" : "");
            cell.appendChild(title);
            const mountEl = document.createElement("div");
            mountEl.className = "ltnc_chart_mount";
            cell.appendChild(mountEl);
            wrap.appendChild(cell);
            try {
                this.#charts.push(LTNCCharts.create(mountEl, {
                    server: sid,
                    metric: metric,
                    rangeSec: this.#rangeSec,
                    height: 200,
                    scaleMode: ltncChartPrefs.scaleMode,
                }));
            } catch (exc) { console.error("[LTNC] 복제 지연 차트 생성 실패:", sid, exc); }
        }
    }

    // ② 양측 응답시간 비교 — /api/checks 로 체크 id 동적 발견 → check.<id>.ms 차트들
    async #mountChecks() {
        const grid = document.getElementById("warroomChecks");
        if (grid == null) return;
        grid.innerHTML = '<div class="ltnc_warroom_note">HTTP 체크 목록을 불러오는 중…</div>';
        let list = [];
        try {
            const r = await fetch("/api/checks");
            if (r.status === 401) { ltncShowLoginOverlay(); return; }
            if (!r.ok) throw new Error("checks " + r.status);
            const data = await r.json();
            list = Array.isArray(data) ? data : (Array.isArray(data?.checks) ? data.checks : []);
        } catch (exc) {
            if (!grid.isConnected) return;
            grid.innerHTML = '<div class="ltnc_warroom_note">체크러너 상태를 불러오지 못했어요 — 허브의 checks 설정을 확인해 주세요</div>';
            return;
        }
        if (!grid.isConnected) return;

        this.#checks = list;
        this.#renderStrip();   // 체크 칩 반영

        grid.innerHTML = "";
        if (list.length === 0) {
            grid.innerHTML = '<div class="ltnc_warroom_note">등록된 HTTP 체크가 없어요 — 허브 config 의 checks 항목에 양측(현행/신규) URL 을 등록해 주세요</div>';
            return;
        }
        if (window.LTNCCharts == null) {
            grid.innerHTML = '<div class="ltnc_warroom_note">차트 모듈(ltnc-charts.js)을 불러오지 못했어요</div>';
            return;
        }
        for (const chk of list) {
            const id = chk?.id;
            if (id == null) continue;
            const cell = document.createElement("div");
            cell.className = "ltnc_chart_cell";
            const title = document.createElement("h3");
            title.textContent = "응답시간 — " + id + " (ms)";
            cell.appendChild(title);
            const mountEl = document.createElement("div");
            mountEl.className = "ltnc_chart_mount";
            cell.appendChild(mountEl);
            grid.appendChild(cell);
            try {
                // 외부체크(대시보드 @checks) 그래프와 동일 세팅 — 임계 띠(good/fine/bad/issue/failure) + 2000ms 풀스케일 floor + axisUnit + scaleMode 를 ltncChartOpts 공유
                this.#charts.push(LTNCCharts.create(mountEl, ltncChartOpts("@checks", "check." + id + ".ms", 160, this.#rangeSec)));
            } catch (exc) { console.error("[LTNC] 체크 차트 생성 실패:", id, exc); }
        }
    }

    // 와이드(≥740px) 화면에서 상세바 드래그로 다이얼로그 이동. (리사이즈는 CSS resize:both 네이티브)
    //  · 좁은 화면(<740)은 풀스크린이라 드래그 비활성 · 버튼/범위 클릭은 드래그로 안 잡음 · onClose 시 리스너 해제.
    #enableFloating() {
        const dialog = document.querySelector("#warroom .ltnc_warroom_dialog");
        const bar = dialog?.querySelector(".ltnc_detail_bar");
        if (dialog == null || bar == null) return;
        const isWide = () => window.matchMedia?.("(min-width: 740px)")?.matches === true;
        const RECT_KEY = "ltnc_warroom_rect";
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // 마지막 크기·위치 저장/복원 (localStorage)
        const saveRect = () => {
            if (!isWide()) return;
            try {
                const r = dialog.getBoundingClientRect();
                localStorage.setItem(RECT_KEY, JSON.stringify({
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(dialog.offsetWidth), h: Math.round(dialog.offsetHeight),
                }));
            } catch (exc) { /* 저장소 불가 — 무시 */ }
        };
        const restoreRect = () => {
            if (!isWide()) return;
            let s = null;
            try { s = JSON.parse(localStorage.getItem(RECT_KEY) || "null"); } catch (exc) { s = null; }
            if (s == null || ![s.x, s.y, s.w, s.h].every(Number.isFinite)) return;
            const w = clamp(s.w, 360, Math.round(window.innerWidth * 0.96));
            const h = clamp(s.h, 220, Math.round(window.innerHeight * 0.92));
            const x = clamp(s.x, 12 - w + 96, window.innerWidth - 96);
            const y = clamp(s.y, 0, window.innerHeight - 44);
            dialog.style.width = w + "px"; dialog.style.height = h + "px";
            dialog.style.left = x + "px"; dialog.style.top = y + "px";
            dialog.style.transform = "none";
        };
        restoreRect();   // 열 때 마지막 상태 복원

        // 네이티브 리사이즈는 JS 이벤트가 없어 ResizeObserver 로 크기 변화 포착 → 디바운스 저장
        let rzTimer = 0;
        const ro = new ResizeObserver(() => {
            if (rzTimer !== 0) clearTimeout(rzTimer);
            rzTimer = setTimeout(saveRect, 250);
        });
        try { ro.observe(dialog); } catch (exc) { /* 무시 */ }

        let st = null;     // 드래그 상태: {sx,sy=시작포인터, bl,bt=기준좌표, w,h=캐시크기, dx,dy=델타}
        let raf = 0;
        const apply = () => {                          // 프레임당 1회만 transform 갱신(리플로우 없음 = 컴포지터 전용)
            raf = 0;
            if (st != null) dialog.style.transform = "translate(" + st.dx + "px," + st.dy + "px)";
        };
        const onDown = (e) => {
            if (!isWide()) return;                                                       // 좁은 화면=풀스크린: 드래그 비활성
            if (e.target.closest?.("button, input, a, .ltnc_range_set") != null) return; // 버튼/범위 클릭은 이동 아님
            const r = dialog.getBoundingClientRect();    // 레이아웃 읽기는 시작 시 1회만(이후 캐시 사용 = thrash 없음)
            dialog.style.left = r.left + "px";           // 기준 좌표를 명시 px 로 고정
            dialog.style.top = r.top + "px";
            dialog.style.transform = "none";
            st = { sx: e.clientX, sy: e.clientY, bl: r.left, bt: r.top, w: r.width, h: r.height, dx: 0, dy: 0 };
            dialog.classList.add("ltnc_dragging");
            bar.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        };
        const onMove = (e) => {
            if (st == null) return;
            let dx = e.clientX - st.sx, dy = e.clientY - st.sy;
            // 캐시된 크기로 클램프(최소 96px 가시) — move 중 offsetWidth 읽기 없음
            dx = Math.max((12 - st.w + 96) - st.bl, Math.min((window.innerWidth - 96) - st.bl, dx));
            dy = Math.max(0 - st.bt, Math.min((window.innerHeight - 44) - st.bt, dy));
            st.dx = dx; st.dy = dy;
            if (raf === 0) raf = requestAnimationFrame(apply);
        };
        const onUp = (e) => {
            if (st == null) return;
            if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
            dialog.style.left = (st.bl + st.dx) + "px";   // 커밋: 명시 좌표 확정 + transform 제거(리사이즈가 좌표 안 흔들게)
            dialog.style.top = (st.bt + st.dy) + "px";
            dialog.style.transform = "none";
            st = null;
            dialog.classList.remove("ltnc_dragging");
            try { bar.releasePointerCapture?.(e.pointerId); } catch (exc) { /* 무시 */ }
            saveRect();   // 이동 끝 → 위치 저장
        };
        bar.addEventListener("pointerdown", onDown);
        bar.addEventListener("pointermove", onMove);
        bar.addEventListener("pointerup", onUp);
        bar.addEventListener("pointercancel", onUp);
        this.#floatCleanup = () => {
            if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
            if (rzTimer !== 0) { clearTimeout(rzTimer); rzTimer = 0; }
            try { ro.disconnect(); } catch (exc) { /* 무시 */ }
            bar.removeEventListener("pointerdown", onDown);
            bar.removeEventListener("pointermove", onMove);
            bar.removeEventListener("pointerup", onUp);
            bar.removeEventListener("pointercancel", onUp);
        };
    }

    // 조회 범위 버튼(1시간/6시간/24시간) — 워룸 내 모든 차트 일괄 적용
    #bindRangeButtons() {
        const bar = document.getElementById("warroomRangeSet");
        if (bar == null) return;
        bar.querySelectorAll("button[data-range]").forEach(btn => {
            btn.addEventListener("click", () => {
                const sec = parseInt(btn.dataset.range, 10);
                if (!Number.isFinite(sec)) return;
                this.#rangeSec = sec;
                bar.querySelectorAll("button[data-range]").forEach(b => b.dataset.active = b === btn ? "1" : "");
                for (const chart of this.#charts) {
                    try { chart.setRange(sec); } catch (exc) { console.error("[LTNC] setRange 실패:", exc); }
                }
            });
        });
    }

}


// ── M2-6. 문서 레벨 글루 (위임 바인딩 + 데이터 구독) ──

// 1) 로그인 필요 감지(401/4401) → 오버레이 · 재연결 성공 → 알림 보충 로드
if (window.LTNC != null) {
    LTNC.on("connection", d => {
        if (d?.authRequired) ltncShowLoginOverlay();
        else if (d?.connected) ltncLoadAlerts();   // 연결(재연결) 성공 시 보충 로드 (loaded 면 no-op)
    });
    // 2) WS 실시간 알림 수신 → 스토어 병합 + 뱃지 갱신
    LTNC.on("alert", m => ltncUpsertAlert(m?.alert));
}

// 3) 앱바 벨 버튼 → 알림센터 페이지
document.addEventListener("click", e => {
    if (e.target.closest?.(".ltnc_bell_btn") != null) appPageManager.bringPage("alerts");
});

// 4) 메인 메뉴 항목 동작 (컷오버 워룸 · 알림센터 · 업데이트 확인 · 로그아웃) — mainMenu.html 의 인라인 onclick 에서 호출.
//   EstreUI 가 메뉴 섹션의 클릭 전파를 차단해 document 위임 바인딩이 안 먹힘(back_navigation 과 동일 패턴).
//   인라인 onclick 은 타깃에서 직접 실행돼 확실히 동작 — window 노출로 인라인 스코프에서 접근.
window.ltncMenuAction = (action) => {
    try { estreUi.closeMainMenu(); } catch (exc) { /* 메뉴 닫기 실패해도 동작 진행 */ }
    if (action === "warroom") appPageManager.bringPage("warroom");
    else if (action === "alerts") appPageManager.bringPage("alerts");
    else if (action === "update") Promise.resolve(appActionManager.checkUpdate()).catch(exc => window.note?.("업데이트 확인에 실패했어요 — 네트워크 상태를 확인해 주세요"));
    else if (action === "logout") ltncLogout();
};

// 5) 서비스 워커 → 푸시 알림 클릭 라우팅 (기존 창 포커스 — iOS scope 제약 대응: data 기반 메시지)
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => {
        if (e.data?.type === "ltnc:open-alerts") {
            appPageManager.bringPage("alerts", { data: { alertId: e.data.alertId ?? null } });
        }
    });
}

// 6) 새 창 진입 파라미터 라우팅 (?ltncOpen=alerts — 푸시 클릭으로 새 창이 열린 경우, main.js 가 림 준비 후 호출)
function ltncRouteFromParams() {
    try {
        const params = new URLSearchParams(location.search);
        const open = params.get("ltncOpen");
        if (open === "alerts") appPageManager.bringPage("alerts", { data: { alertId: params.get("ltncAlertId") } });
        else if (open === "warroom") appPageManager.bringPage("warroom");
    } catch (exc) { console.error("[LTNC] 진입 라우팅 실패:", exc); }
}

// 7) 알림 초기 로드 (인증 만료 상태면 401 → 로그인 오버레이로 자연 전환)
ltncLoadAlerts();

// 8) 벨 뱃지 초기 동기화 — 앱바(fixedTop) 마운트가 알림 로드보다 늦을 수 있어 마운트 감지 후 1회 갱신
(function ltncWatchAppbarMount() {
    const host = document.getElementById("fixedTop");
    if (host == null) return;
    if (host.querySelector(".ltnc_bell_badge") != null) { ltncUpdateAlertBadge(); return; }
    const observer = new MutationObserver(() => {
        if (host.querySelector(".ltnc_bell_badge") != null) {
            observer.disconnect();
            ltncUpdateAlertBadge();
        }
    });
    observer.observe(host, { childList: true, subtree: true });
})();
