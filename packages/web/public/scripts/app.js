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
        "stats": "&m=stats",        // 통계 (staticDoc rootbar 탭 — config.stats 활성 시 사용)
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
    "stats" = LTNCStatsPage;        // 통계 (클래스 정의는 아래 블록 — 인스턴스화 시점엔 완료)

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
            // 계정별 홈탭(home, 예 mpsol→stats) — 로그인 직후 해당 루트탭으로 전환
            try { const me = await r.json(); if (me?.home) ltncGoHomeTab(me.home); } catch (exc) { /* 응답 파싱 실패 무시 */ }
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


// ══ 통계 (ClickHouse /api/stats/*) — 현황/추세/분포/패턴 4섹션 (예시) ══════════════
// hub stats.mjs 응답(kind: table|dist|series|bars) 렌더. 추세는 공통 일/주/월/분기/년 셀렉터(추세 섹션 헤더). uPlot 직접.
// 요일/월중일자: 섹션 헤더 토글(단위추세=기본/누적평균). 각 그래프 ⛶ 전체화면. 상단 고정 섹션 네비.
const LTNC_STATS_BUCKETS = [["일", "d"], ["주", "w"], ["월", "m"], ["분기", "q"], ["년", "y"]];
const LTNC_STATS_PALETTE = ["#ff9500", "#4a9eff", "#34c759", "#ff375f", "#af52de", "#00c7be", "#ffcc00", "#a2845e", "#5ac8fa", "#ff6482", "#30d158", "#bf5af2"];
let ltncStatsBucket = "w";   // 추세 기본 단위 = 주
// 그래프 크기 프리셋 — 기본(그리드 col+높이 s/m/l) / 전체폭(1열, 높이만 fs/fm/fl). col=100% → 1열.
const LTNC_STATS_SIZES = {
    s: { label: "소", col: "340px", h: 200, cbars: 150 },
    m: { label: "중", col: "520px", h: 300, cbars: 220 },
    l: { label: "대", col: "760px", h: 420, cbars: 300 },
    fs: { label: "소", col: "100%", h: 260, cbars: 190 },
    fm: { label: "중", col: "100%", h: 440, cbars: 300 },
    fl: { label: "대", col: "100%", h: 640, cbars: 440 },
};
let ltncStatsSize = LTNC_STATS_SIZES[localStorage.getItem("ltnc.statsSize")] ? localStorage.getItem("ltnc.statsSize") : "s";
// 추세 구간(일수) 선택지 + 단위별 기본값(일→32·주→96·월→192·분기→384·년→1280).
const LTNC_STATS_RANGES = [8, 16, 32, 96, 192, 384, 1280];
const LTNC_STATS_RANGE_DEFAULT = { d: 32, w: 96, m: 192, q: 384, y: 1280 };
let ltncStatsRange = LTNC_STATS_RANGE_DEFAULT[ltncStatsBucket] || 192;

function ltncStatsEnsureCss() {
    if (document.getElementById("ltncStatsCss")) return;
    const s = document.createElement("style");
    s.id = "ltncStatsCss";
    s.textContent =
        ".ltnc_stats_section{margin:0 0 4px}" +
        ".ltnc_stats_sechead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0 2px;padding:6px 12px;border-bottom:1px solid var(--ltnc-border,rgba(127,127,127,.22));position:sticky;top:var(--ltnc-nav-h,46px);z-index:15;background:color-mix(in srgb,var(--ltnc-bg,#101216) 92%,transparent);backdrop-filter:blur(4px)}" +
        ".ltnc_stats_sechead h2{margin:0;border:0;padding:0;font-size:15px;color:var(--ltnc-text,#e8eaed)}" +
        ".ltnc_stats_sechead .ltnc_stats_ctl{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
        ".ltnc_stats_section>.desc{margin:2px 12px 4px;font-size:12px;color:var(--ltnc-dim,#9aa0a6)}" +
        ".ltnc_stats_seg{display:flex;gap:4px;align-items:center}" +
        ".ltnc_stats_seg .ltnc_ctl_label{color:var(--ltnc-dim,#9aa0a6);font-size:12px;margin-right:2px}" +
        ".ltnc_stats_seg button{padding:4px 10px;border:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 42%,transparent);border-radius:7px;background:transparent;color:var(--ltnc-text,#e8eaed);font-size:12px;cursor:pointer}" +
        ".ltnc_stats_seg button[data-active='1']{border-color:var(--ltnc-accent,#ff9500);color:var(--ltnc-accent,#ff9500);background:color-mix(in srgb,var(--ltnc-accent,#ff9500) 16%,transparent);font-weight:600}" +
        ".ltnc_stats_nav{position:sticky;top:0;z-index:20;display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;margin-bottom:2px;background:color-mix(in srgb,var(--ltnc-bg,#101216) 92%,transparent);backdrop-filter:blur(4px);border-bottom:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 20%,transparent)}" +
        ".ltnc_stats_nav button{padding:4px 12px;border:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 42%,transparent);border-radius:16px;background:transparent;color:var(--ltnc-dim,#9aa0a6);font-size:12px;cursor:pointer}" +
        ".ltnc_stats_nav button[data-active='1']{border-color:var(--ltnc-accent,#ff9500);color:var(--ltnc-accent,#ff9500);background:color-mix(in srgb,var(--ltnc-accent,#ff9500) 12%,transparent);font-weight:600}" +
        ".ltnc_stats_sizectl{margin-left:auto;display:flex;gap:12px;align-items:center;flex-wrap:wrap}" +
        ".ltnc_stats_szgroup{display:flex;gap:3px;align-items:center}" +
        ".ltnc_stats_szgroup button{padding:3px 9px;border:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 40%,transparent);border-radius:6px;background:transparent;color:var(--ltnc-dim,#9aa0a6);font-size:11px;cursor:pointer}" +
        ".ltnc_stats_szgroup button[data-active='1']{border-color:var(--ltnc-accent,#ff9500);color:var(--ltnc-accent,#ff9500);background:color-mix(in srgb,var(--ltnc-accent,#ff9500) 14%,transparent);font-weight:600}" +
        ".ltnc_stats_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--ltnc-stats-col,340px),1fr));gap:14px;padding:8px 12px}" +
        // 최신현황: 크기선택 무관 고정 3분할(반응형 3 → 2+1→ 1). auto-fit + 3개 항목이라 최대 3열.
        ".ltnc_stats_grid_fixed3{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}" +
        ".ltnc_stats_card{background:var(--ltnc-card,rgba(127,127,127,.06));border:1px solid var(--ltnc-border,rgba(127,127,127,.18));border-radius:12px;padding:12px 14px;min-height:110px;overflow:hidden}" +
        ".ltnc_stats_card_head{display:flex;align-items:center;gap:8px;margin:0 0 8px}" +
        ".ltnc_stats_card_head h3{margin:0;font-size:14px;color:var(--ltnc-text,#e8eaed);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".ltnc_stats_expand{flex:none;padding:1px 7px;border:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 40%,transparent);border-radius:6px;background:transparent;color:var(--ltnc-dim,#9aa0a6);font-size:12px;line-height:1.4;cursor:pointer}" +
        ".ltnc_stats_expand:hover{border-color:var(--ltnc-accent,#ff9500);color:var(--ltnc-accent,#ff9500)}" +
        ".ltnc_stats_table{width:100%;border-collapse:collapse;font-size:13px}" +
        ".ltnc_stats_table th,.ltnc_stats_table td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--ltnc-border,rgba(127,127,127,.12))}" +
        ".ltnc_stats_table td.num,.ltnc_stats_table th.num{text-align:right;font-variant-numeric:tabular-nums}" +
        ".ltnc_stats_bar{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;margin:6px 0;font-size:13px}" +
        ".ltnc_stats_bar .k{color:var(--ltnc-text,#e8eaed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".ltnc_stats_bar .v{color:var(--ltnc-dim,#9aa0a6);font-variant-numeric:tabular-nums}" +
        ".ltnc_stats_bar .track{grid-column:1/-1;height:6px;border-radius:4px;background:var(--ltnc-border,rgba(127,127,127,.15));overflow:hidden}" +
        ".ltnc_stats_bar .fill{height:100%;background:var(--ltnc-accent,#ff9500);border-radius:4px}" +
        ".ltnc_stats_empty{color:var(--ltnc-dim,#9aa0a6);font-size:13px;padding:8px 0}" +
        ".ltnc_stats_chart{width:100%}" +
        ".ltnc_cbars{display:flex;align-items:flex-end;gap:3px;height:var(--ltnc-cbars-h,150px);padding-top:6px}" +
        ".ltnc_cbar{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%}" +
        ".ltnc_cbar i{width:78%;background:var(--ltnc-accent,#ff9500);border-radius:3px 3px 0 0;min-height:1px}" +
        ".ltnc_cbar span{font-size:10px;color:var(--ltnc-dim,#9aa0a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}" +
        // 컨텐츠 세로 스크롤 허용: 차트는 높이=컨텐츠에 딱 맞아 스크롤 안 생기고(범례는 absolute), 기기분포 등 긴 목록은 스크롤.
        ".ltnc_stats_dv_body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px;position:relative}" +
        // 상세뷰: uPlot 범례를 우상단 떠있는 박스로(차트 아래 배치 → 스크롤 방지). 대시보드 단독뷰와 동일 패턴.
        ".ltnc_stats_dv_body .ltnc_stats_chart{height:100%}" +
        ".ltnc_stats_dv_body .u-legend{display:block;position:absolute;top:10px;right:14px;margin:0;max-width:46%;max-height:74%;overflow:auto;background:color-mix(in srgb,var(--ltnc-card,#1a1d23) 90%,transparent);border:1px solid color-mix(in srgb,var(--ltnc-border,#9aa0a6) 24%,transparent);border-radius:8px;padding:5px 11px;z-index:5;font-variant-numeric:tabular-nums;text-align:left;white-space:nowrap;pointer-events:none}" +
        // 범례: 항목(시리즈)마다 한 줄씩 — u-inline(한 줄 나열) 모드여도 강제 세로 스택. th=마커+라벨(좌), 값(우).
        ".ltnc_stats_dv_body .u-legend tr,.ltnc_stats_dv_body .u-legend .u-series{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0}" +
        ".ltnc_stats_dv_body .u-legend .u-value{text-align:right;min-width:70px}" +
        // 히트맵(시간대×요일) — 셀 배경 = 값 비례 accent 알파
        ".ltnc_heat{width:100%;border-collapse:collapse;font-size:10px;table-layout:fixed}" +
        ".ltnc_heat th{padding:1px 2px;text-align:center;color:var(--ltnc-dim,#9aa0a6);font-weight:500}" +
        ".ltnc_heat th.h{width:32px;text-align:right;padding-right:4px}" +
        ".ltnc_heat td{padding:1px 2px;text-align:center;color:var(--ltnc-text,#e8eaed);font-variant-numeric:tabular-nums;overflow:hidden;white-space:nowrap}";
    document.head.appendChild(s);
}

async function ltncStatsFetch(name, params) {
    const qs = (params && Object.keys(params).length) ? "?" + new URLSearchParams(params) : "";
    const r = await fetch("/api/stats/" + name + qs);
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
}

// 동시 요청 제한(허브·CH 과부하 방지)
async function ltncStatsPool(tasks, concurrency) {
    let i = 0;
    const run = async () => { while (i < tasks.length) { const t = tasks[i++]; try { await t(); } catch (e) { /* 무시 */ } } };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, run));
}

// title + (redraw 있으면) ⛶ 전체화면 버튼. redraw(container, {height}) 로 상세뷰에서 재렌더.
function ltncStatsCardEl(title, redraw) {
    const card = document.createElement("div"); card.className = "ltnc_stats_card";
    const head = document.createElement("div"); head.className = "ltnc_stats_card_head";
    const h = document.createElement("h3"); h.textContent = title || ""; h.title = title || ""; head.appendChild(h);
    if (typeof redraw === "function") {
        const ex = document.createElement("button"); ex.type = "button"; ex.className = "ltnc_stats_expand";
        ex.textContent = "⛶"; ex.title = "전체화면으로 보기";
        ex.addEventListener("click", (e) => { e.stopPropagation(); ltncStatsOpenDetail(title, redraw); });
        head.appendChild(ex);
    }
    const body = document.createElement("div");
    card.append(head, body);
    return { card, head, body };
}

function ltncStatsRenderTable(body, d) {
    const cols = d.columns || [];
    const numCols = d.numCols || (cols.length ? [cols.length - 1] : []);   // 미지정 시 마지막 열만 우측정렬(하위호환)
    const isNum = (i) => numCols.indexOf(i) !== -1;
    const t = document.createElement("table"); t.className = "ltnc_stats_table";
    const htr = document.createElement("tr");
    cols.forEach((c, i) => { const th = document.createElement("th"); if (isNum(i)) th.className = "num"; th.textContent = c; htr.appendChild(th); });
    const thead = document.createElement("thead"); thead.appendChild(htr); t.appendChild(thead);
    const tb = document.createElement("tbody");
    for (const row of (d.rows || [])) {
        const tr = document.createElement("tr");
        row.forEach((v, i) => { const td = document.createElement("td"); if (isNum(i)) td.className = "num"; td.textContent = (typeof v === "number") ? v.toLocaleString("ko-KR") : v; tr.appendChild(td); });
        tb.appendChild(tr);
    }
    t.appendChild(tb); body.appendChild(t);
}

// opts.max = 인라인 표시 최대 항목수(초과분은 접고 ⛶ 안내). 상세뷰는 max 없이 전체.
function ltncStatsRenderDist(body, d, opts) {
    opts = opts || {};
    const all = d.items || [];
    const items = opts.max ? all.slice(0, opts.max) : all;
    const max = items.reduce((m, x) => Math.max(m, x.cnt), 0) || 1;
    for (const it of items) {
        const row = document.createElement("div"); row.className = "ltnc_stats_bar";
        const k = document.createElement("span"); k.className = "k"; k.textContent = it.key;
        const v = document.createElement("span"); v.className = "v"; v.textContent = it.cnt.toLocaleString("ko-KR") + (it.pct != null ? " · " + it.pct + "%" : "");
        const track = document.createElement("div"); track.className = "track";
        const fill = document.createElement("div"); fill.className = "fill"; fill.style.width = Math.round(it.cnt * 100 / max) + "%";
        track.appendChild(fill); row.append(k, v, track); body.appendChild(row);
    }
    if (!all.length) { const e = document.createElement("div"); e.className = "ltnc_stats_empty"; e.textContent = "데이터 없음"; body.appendChild(e); return; }
    if (opts.max && all.length > opts.max) { const e = document.createElement("div"); e.className = "ltnc_stats_empty"; e.textContent = "⛶ 크게보기에서 전체 항목 표시"; body.appendChild(e); }
    if (d.total != null) { const tot = document.createElement("div"); tot.className = "ltnc_stats_empty"; tot.textContent = "합계 " + d.total.toLocaleString("ko-KR"); body.appendChild(tot); }
}

// 상세뷰 전용 — 각 시리즈명을 마지막 데이터점 옆(선 끝)에 라벨로 그림(그래프 내 라벨). 캔버스px = pxRatio 반영.
function ltncStatsLabelPlugin() {
    return { hooks: { draw: (u) => {
        const ctx = u.ctx; if (!ctx || !u.bbox) return;
        const dpr = u.pxRatio || 1, bb = u.bbox;
        ctx.save();
        ctx.font = Math.round(11 * dpr) + "px sans-serif"; ctx.textBaseline = "middle";
        for (let i = 1; i < u.series.length; i++) {
            const s = u.series[i]; if (s.show === false) continue;
            const yd = u.data[i]; if (!yd) continue;
            let idx = -1; for (let j = yd.length - 1; j >= 0; j--) { if (yd[j] != null) { idx = j; break; } }
            if (idx < 0) continue;
            const cx = u.valToPos(u.data[0][idx], "x", true), cy = u.valToPos(yd[idx], "y", true);
            const label = String(s.label || "").replace(/\s*\(.*\)$/, "");   // 단위 괄호 제거
            ctx.fillStyle = LTNC_STATS_PALETTE[(i - 1) % LTNC_STATS_PALETTE.length];
            const tw = ctx.measureText(label).width;
            let tx = cx + 4 * dpr; ctx.textAlign = "left";
            if (tx + tw > bb.left + bb.width) { tx = cx - 4 * dpr; ctx.textAlign = "right"; }
            const yy = Math.max(bb.top + 7 * dpr, Math.min(bb.top + bb.height - 7 * dpr, cy));
            ctx.fillText(label, tx, yy);
        }
        ctx.restore();
    } } };
}

// 시계열(멀티 라인) — uPlot. d = {unit, series:[{name,points:[[unixSec,val]]}]}. opts.height 확대 · opts.detail 상세뷰(선끝 라벨).
function ltncStatsRenderChart(body, d, opts) {
    opts = opts || {};
    const ser = d.series || [];
    if (!window.uPlot) { const e = document.createElement("div"); e.className = "ltnc_stats_empty"; e.textContent = "차트 모듈 미로드"; body.appendChild(e); return null; }
    const xset = new Set(); ser.forEach(s => (s.points || []).forEach(p => xset.add(p[0])));
    const xs = [...xset].sort((a, b) => a - b);
    if (xs.length < 2 && ser.reduce((n, s) => n + (s.points || []).length, 0) < 2) {
        const e = document.createElement("div"); e.className = "ltnc_stats_empty";
        e.textContent = xs.length ? "데이터 누적 중 (기간이 쌓이면 추세 표시)" : "데이터 없음"; body.appendChild(e); return null;
    }
    const idx = new Map(xs.map((t, i) => [t, i]));
    const cols = ser.map(s => { const a = new Array(xs.length).fill(null); (s.points || []).forEach(p => { a[idx.get(p[0])] = p[1]; }); return a; });
    const p2 = n => String(n).padStart(2, "0");
    // ISO 주차(년-주차) — 주 단위 추세용. 목요일 기준 표준 ISO week.
    const isoWeek = t => {
        const dt = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
        const dn = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dn + 3);
        const thu = dt.getTime(); dt.setUTCMonth(0, 1);
        if (dt.getUTCDay() !== 4) dt.setUTCMonth(0, 1 + ((4 - dt.getUTCDay()) + 7) % 7);
        return [new Date(thu).getUTCFullYear(), 1 + Math.round((thu - dt.getTime()) / 604800000)];
    };
    // x축 눈금 표기: xunit 우선(isoweek=년-주차 / month=년-월), 없으면 버킷 간격 자동(년→YYYY / 월·분기→YYYY-MM / 주·일→MM-DD, 단 다년치면 YY-MM-DD 로 년도 표기)
    const DAY = 86400;
    const step = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 0;
    // 전 기간처럼 데이터가 여러 해에 걸치면 일/주 라벨에도 년도(YY)를 붙여 연도 구분 (예: 24-07-15)
    const multiYear = xs.length > 1 && new Date(xs[0] * 1000).getFullYear() !== new Date(xs[xs.length - 1] * 1000).getFullYear();
    const fmt = ts => { if (ts == null) return ""; const t = new Date(ts * 1000);
        if (d.xunit === "isoweek") { const [y, w] = isoWeek(t); return (y % 100) + "-" + w + "주"; }
        if (d.xunit === "month" || (step >= 24 * DAY && step < 300 * DAY)) return t.getFullYear() + "-" + p2(t.getMonth() + 1);
        if (step >= 300 * DAY) return String(t.getFullYear());
        return (multiYear ? (t.getFullYear() % 100) + "-" : "") + p2(t.getMonth() + 1) + "-" + p2(t.getDate()); };
    // 눈금(세로줄)은 선택한 단위 시점(각 버킷)에만 = splits=xs. 라벨은 과밀 방지 stride 적용(세로줄은 유지).
    const xSplits = () => xs;
    const xValues = (u, sp) => { const stride = Math.max(1, Math.ceil(sp.length / 12)); return sp.map((ts, i) => (i % stride === 0) ? fmt(ts) : ""); };
    const dim = (getComputedStyle(document.body).getPropertyValue("--ltnc-dim") || "#9aa0a6").trim();
    const mount = document.createElement("div"); mount.className = "ltnc_stats_chart"; body.appendChild(mount);
    const H = opts.height || 200;
    const uo = {
        width: Math.max(mount.clientWidth || body.clientWidth || 300, 240), height: H,
        series: [{ value: (u, ts) => ts == null ? "" : fmt(ts) }].concat(ser.map((s, i) => ({
            label: s.name + (d.unit ? " (" + d.unit + ")" : ""), stroke: LTNC_STATS_PALETTE[i % LTNC_STATS_PALETTE.length],
            width: 1.5, points: { show: xs.length < 8 }, value: (u, v) => v == null ? "–" : v.toLocaleString("ko-KR"),
        }))),
        scales: { x: { time: true } },
        axes: [
            { stroke: dim, grid: { stroke: "rgba(127,127,127,.14)" }, ticks: { stroke: "rgba(127,127,127,.25)" }, font: "11px sans-serif", splits: xSplits, values: xValues },
            { stroke: dim, grid: { stroke: "rgba(127,127,127,.14)" }, ticks: { stroke: "rgba(127,127,127,.25)" }, font: "11px sans-serif", size: 54, values: (u, sp) => sp.map(v => v == null ? "" : v.toLocaleString("ko-KR")) },
        ],
        legend: { live: true }, cursor: { points: { size: 6 }, drag: { x: false, y: false, setScale: false } },   // 드래그 확대(zoom) 비활성
        plugins: opts.detail ? [ltncStatsLabelPlugin()] : [],
    };
    const u = new uPlot(uo, [xs, ...cols], mount);
    return { u, mount, h: H };
}

// 히트맵(시간대×요일) — d = {xcats, ycats, values[y][x]}. 셀 배경 = 값/최대 비례 accent.
function ltncStatsCompactNum(v) {
    return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k" : String(v);
}
function ltncStatsRenderHeat(body, d, opts) {
    opts = opts || {};
    const vals = d.values || [];
    const max = Math.max(1, ...vals.flat());
    const t = document.createElement("table"); t.className = "ltnc_heat";
    const trh = document.createElement("tr");
    trh.appendChild(document.createElement("th"));
    (d.xcats || []).forEach(x => { const th = document.createElement("th"); th.textContent = x; trh.appendChild(th); });
    t.appendChild(trh);
    (d.ycats || []).forEach((y, yi) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th"); th.className = "h"; th.textContent = y; tr.appendChild(th);
        (d.xcats || []).forEach((x, xi) => {
            const v = (vals[yi] || [])[xi] || 0;
            const td = document.createElement("td");
            td.style.background = "color-mix(in srgb, var(--ltnc-accent,#ff9500) " + Math.round(v * 72 / max) + "%, transparent)";
            td.textContent = opts.detail ? v.toLocaleString("ko-KR") : ltncStatsCompactNum(v);
            td.title = y + " " + x + ": " + v.toLocaleString("ko-KR");
            tr.appendChild(td);
        });
        t.appendChild(tr);
    });
    body.appendChild(t);
}

// 카테고리 막대(요일/월중일자) — HTML. oneSeries = {name, values:[...]}. opts.height 로 상세뷰 확대.
function ltncStatsRenderBars(body, categories, oneSeries, opts) {
    opts = opts || {};
    const vals = oneSeries.values || [];
    const max = vals.reduce((m, v) => Math.max(m, v || 0), 0) || 1;
    const wrap = document.createElement("div"); wrap.className = "ltnc_cbars";
    if (opts.height) wrap.style.height = opts.height + "px";
    (categories || []).forEach((cat, i) => {
        const v = vals[i] || 0;
        const col = document.createElement("div"); col.className = "ltnc_cbar"; col.title = cat + ": " + v.toLocaleString("ko-KR");
        const bar = document.createElement("i"); bar.style.height = Math.round(v * 100 / max) + "%";
        const lbl = document.createElement("span"); lbl.textContent = cat;
        col.append(bar, lbl); wrap.appendChild(col);
    });
    body.appendChild(wrap);
    if (!vals.length) { const e = document.createElement("div"); e.className = "ltnc_stats_empty"; e.textContent = "데이터 없음"; body.appendChild(e); }
}

// 전체화면 단독 그래프 오버레이 — redraw(container,{height}) 로 큰 사이즈 재렌더. uPlot 은 리사이즈 추종.
function ltncStatsOpenDetail(title, redraw) {
    const overlay = document.createElement("div"); overlay.className = "ltnc_dv_overlay";
    const panel = document.createElement("div"); panel.className = "ltnc_dv_panel";
    const head = document.createElement("div"); head.className = "ltnc_dv_head";
    const ttl = document.createElement("div"); ttl.className = "ltnc_dv_title"; ttl.textContent = title || "";
    const close = document.createElement("button"); close.type = "button"; close.className = "ltnc_dv_btn ltnc_dv_close"; close.textContent = "✕";
    close.style.marginLeft = "auto";   // 닫기 버튼 우측 끝
    head.append(ttl, close);
    const bodyWrap = document.createElement("div"); bodyWrap.className = "ltnc_stats_dv_body";
    panel.append(head, bodyWrap); overlay.appendChild(panel); document.body.appendChild(overlay);

    let handle = null;
    // 범례가 우상단 떠있는 박스(absolute)라 세로공간 안 먹음 → 컨텐츠 높이 꽉 채워 스크롤 없음.
    const avail = () => Math.max((bodyWrap.clientHeight || 420) - 28, 260);
    const draw = () => { bodyWrap.innerHTML = ""; handle = redraw(bodyWrap, { height: avail(), detail: true }); };
    draw();

    const onResize = () => {
        if (handle && handle.u) { try { handle.u.setSize({ width: Math.max((bodyWrap.clientWidth || 300) - 2, 240), height: avail() }); } catch (e) { /* 무시 */ } }
        else draw();   // 막대/분포 등 비 uPlot 은 재렌더로 리핏
    };
    const onKey = (e) => { if (e.key === "Escape") done(); };
    function done() {
        window.removeEventListener("resize", onResize);
        document.removeEventListener("keydown", onKey);
        if (handle && handle.u) { try { handle.u.destroy(); } catch (e) { /* 무시 */ } }
        overlay.remove();
    }
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(); });
    close.addEventListener("click", done);
}

// ── 페이지 핸들러: 통계 (staticDoc rootbar 탭) ──
class LTNCStatsPage extends EstrePageHandler {

    #charts = [];       // [{u, mount, h, sec}] — sec 로 섹션별 파기
    #ro = null;
    #navObs = null;
    #loaded = false;
    #lastLoad = 0;
    #dowMode = "trend";   // 단위추세(기본) | avg(누적평균)
    #domMode = "trend";
    #savedScroll = 0;
    #onScroll = null;
    #onWinFocus = null;

    onBring(handle) { ltncStatsEnsureCss(); this.#buildFrame(); this.#installScrollGuard(); }

    onShow(handle) {   // 탭 열릴 때마다 (최초 or 5분 초과 시 새로고침 — 과다 방지)
        if (!this.#loaded || (Date.now() - this.#lastLoad) > 300000) this.#loadAll();
    }

    onClose(handle) {
        this.#destroyCharts();
        if (this.#navObs) { try { this.#navObs.disconnect(); } catch (e) { /* 무시 */ } this.#navObs = null; }
        this.#removeScrollGuard();
    }

    // 스크롤 컨테이너(정적 탭 뷰포트)
    #scrollEl() { const g = document.getElementById("statsGrid"); return g ? g.closest(".vfv_scroll") : null; }
    // 다른 창 갔다 돌아올 때(window focus) 자동 focus 로 스크롤이 위로 튀는 것 방지 — 마지막 위치 복원.
    #installScrollGuard() {
        if (this.#onWinFocus) return;
        this.#onScroll = () => { const el = this.#scrollEl(); if (el) this.#savedScroll = el.scrollTop; };
        this.#onWinFocus = () => {
            const el = this.#scrollEl(); if (!el) return; const y = this.#savedScroll;
            requestAnimationFrame(() => { el.scrollTop = y; requestAnimationFrame(() => { el.scrollTop = y; }); });
        };
        const el = this.#scrollEl(); if (el) el.addEventListener("scroll", this.#onScroll, { passive: true });
        window.addEventListener("focus", this.#onWinFocus);
    }
    #removeScrollGuard() {
        const el = this.#scrollEl(); if (el && this.#onScroll) el.removeEventListener("scroll", this.#onScroll);
        if (this.#onWinFocus) window.removeEventListener("focus", this.#onWinFocus);
        this.#onScroll = null; this.#onWinFocus = null;
    }

    // 섹션 네비 실제 높이 → 섹션 제목줄 sticky top 오프셋(CSS 변수)
    #syncNavHeight() {
        const grid = document.getElementById("statsGrid"), nav = document.getElementById("statsSectionNav");
        if (grid && nav) grid.style.setProperty("--ltnc-nav-h", nav.offsetHeight + "px");
    }

    #destroyCharts() {
        for (const c of this.#charts) { try { c.u.destroy(); } catch (e) { /* 무시 */ } }
        this.#charts = [];
    }
    #destroySection(sec) {   // 섹션 재렌더 전 그 섹션 차트만 파기
        this.#charts = this.#charts.filter(c => { if (c.sec === sec) { try { c.u.destroy(); } catch (e) { /* 무시 */ } return false; } return true; });
    }

    #buildFrame() {
        const grid = document.getElementById("statsGrid");
        if (grid && typeof ResizeObserver !== "undefined" && !this.#ro) {
            this.#ro = new ResizeObserver(() => {
                this.#syncNavHeight();   // 네비 rewrap 대응
                for (const c of this.#charts) { try { c.u.setSize({ width: Math.max(c.mount.clientWidth || 0, 240), height: c.h || 200 }); } catch (e) { /* 무시 */ } }
            });
            this.#ro.observe(grid);
        }
    }

    // 섹션 셸(제목줄 + 컨트롤 슬롯 + 카드 그리드)
    #makeSection(id, title, desc) {
        const sec = document.createElement("div"); sec.className = "ltnc_stats_section"; sec.dataset.sec = id;
        const head = document.createElement("div"); head.className = "ltnc_stats_sechead";
        const h = document.createElement("h2"); h.textContent = title; head.appendChild(h);
        const ctl = document.createElement("div"); ctl.className = "ltnc_stats_ctl"; head.appendChild(ctl);
        sec.appendChild(head);
        if (desc) { const dsc = document.createElement("div"); dsc.className = "desc"; dsc.textContent = desc; sec.appendChild(dsc); }
        const g = document.createElement("div"); g.className = "ltnc_stats_grid"; sec.appendChild(g);
        return { sec, ctl, grid: g, title };
    }

    // 상단 고정 섹션 이동 네비 + 현재 섹션 강조(IntersectionObserver)
    #buildNav(sections) {
        const nav = document.createElement("nav"); nav.className = "ltnc_stats_nav"; nav.id = "statsSectionNav";
        const map = [];
        for (const s of sections) {
            const b = document.createElement("button"); b.type = "button"; b.textContent = s.title;
            b.addEventListener("click", () => s.sec.scrollIntoView({ behavior: "smooth", block: "start" }));
            nav.appendChild(b); map.push({ b, id: s.sec.dataset.sec });
        }
        if (this.#navObs) { try { this.#navObs.disconnect(); } catch (e) { /* 무시 */ } this.#navObs = null; }
        if (typeof IntersectionObserver !== "undefined") {
            this.#navObs = new IntersectionObserver((entries) => {
                for (const en of entries) if (en.isIntersecting) {
                    const id = en.target.dataset.sec;
                    map.forEach(x => x.b.dataset.active = x.id === id ? "1" : "");
                }
            }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
            for (const s of sections) this.#navObs.observe(s.sec);
        }
        nav.appendChild(this.#buildSizeCtl());   // 네비 우측: 그래프 크기 선택
        return nav;
    }

    // 추세 단위(일/주/월/분기/년) + 구간(일수) 셀렉터 — 추세 섹션 헤더. 단위 변경 시 구간=단위 기본값으로 리셋.
    #buildTrendCtl(ctl, onChange) {
        const uSeg = document.createElement("div"); uSeg.className = "ltnc_stats_seg";
        const uLbl = document.createElement("span"); uLbl.className = "ltnc_ctl_label"; uLbl.textContent = "단위:"; uSeg.appendChild(uLbl);
        const rSeg = document.createElement("div"); rSeg.className = "ltnc_stats_seg";
        const rLbl = document.createElement("span"); rLbl.className = "ltnc_ctl_label"; rLbl.textContent = "구간:"; rSeg.appendChild(rLbl);
        const syncRange = () => rSeg.querySelectorAll("button[data-r]").forEach(x => x.dataset.active = Number(x.dataset.r) === ltncStatsRange ? "1" : "");
        for (const [t, b] of LTNC_STATS_BUCKETS) {
            const btn = document.createElement("button"); btn.type = "button"; btn.dataset.b = b; btn.textContent = t;
            if (b === ltncStatsBucket) btn.dataset.active = "1";
            btn.addEventListener("click", () => {
                if (ltncStatsBucket === b) return;
                ltncStatsBucket = b;
                ltncStatsRange = LTNC_STATS_RANGE_DEFAULT[b] || ltncStatsRange;   // 단위 기본 구간으로 리셋
                uSeg.querySelectorAll("button[data-b]").forEach(x => x.dataset.active = x === btn ? "1" : "");
                syncRange();
                onChange();
            });
            uSeg.appendChild(btn);
        }
        for (const r of LTNC_STATS_RANGES) {
            const btn = document.createElement("button"); btn.type = "button"; btn.dataset.r = r; btn.textContent = r + "일";
            if (r === ltncStatsRange) btn.dataset.active = "1";
            btn.addEventListener("click", () => {
                if (ltncStatsRange === r) return;
                ltncStatsRange = r; syncRange(); onChange();
            });
            rSeg.appendChild(btn);
        }
        ctl.append(uSeg, rSeg);
    }

    // 단위추세/누적평균 토글(요일·월중일자) — 단위추세 기본
    #buildModeToggle(ctl, getMode, setMode, onChange) {
        const seg = document.createElement("div"); seg.className = "ltnc_stats_seg";
        const btns = [];
        for (const [t, m] of [["단위추세", "trend"], ["누적평균", "avg"]]) {
            const btn = document.createElement("button"); btn.type = "button"; btn.dataset.m = m; btn.textContent = t;
            if (getMode() === m) btn.dataset.active = "1";
            btn.addEventListener("click", () => {
                if (getMode() === m) return;
                setMode(m);
                btns.forEach(x => x.dataset.active = x === btn ? "1" : "");
                onChange();
            });
            seg.appendChild(btn); btns.push(btn);
        }
        ctl.appendChild(seg);
    }

    // 현재 크기 프리셋의 차트 높이(신규 카드 생성 시 사용)
    #chartH() { return (LTNC_STATS_SIZES[ltncStatsSize] || LTNC_STATS_SIZES.s).h; }

    // 크기 프리셋 적용 — 그리드 열폭/막대높이 = CSS 변수(#statsGrid 에 세팅, 하위 상속), 차트 = setSize.
    #applySize() {
        const p = LTNC_STATS_SIZES[ltncStatsSize] || LTNC_STATS_SIZES.s;
        const grid = document.getElementById("statsGrid");
        if (grid) { grid.style.setProperty("--ltnc-stats-col", p.col); grid.style.setProperty("--ltnc-cbars-h", p.cbars + "px"); }
        for (const c of this.#charts) { c.h = p.h; try { c.u.setSize({ width: Math.max(c.mount.clientWidth || 0, 240), height: p.h }); } catch (e) { /* 무시 */ } }
    }

    // 그래프 크기 선택(네비 우측): 기본 소/중/대(그리드) · 전체 폭 소/중/대(1열, 높이만)
    #buildSizeCtl() {
        const wrap = document.createElement("div"); wrap.className = "ltnc_stats_sizectl";
        const mkGroup = (labelText, keys) => {
            const g = document.createElement("div"); g.className = "ltnc_stats_szgroup";
            const l = document.createElement("span"); l.className = "ltnc_ctl_label"; l.textContent = labelText; g.appendChild(l);
            for (const k of keys) {
                const btn = document.createElement("button"); btn.type = "button"; btn.dataset.sz = k; btn.textContent = LTNC_STATS_SIZES[k].label;
                if (k === ltncStatsSize) btn.dataset.active = "1";
                btn.addEventListener("click", () => {
                    if (ltncStatsSize === k) return;
                    ltncStatsSize = k; try { localStorage.setItem("ltnc.statsSize", k); } catch (e) { /* 무시 */ }
                    wrap.querySelectorAll("button[data-sz]").forEach(x => x.dataset.active = x === btn ? "1" : "");
                    this.#applySize();
                });
                g.appendChild(btn);
            }
            return g;
        };
        wrap.append(mkGroup("기본", ["s", "m", "l"]), mkGroup("전체 폭", ["fs", "fm", "fl"]));
        return wrap;
    }

    #loadAll() {
        const grid = document.getElementById("statsGrid");
        if (!grid) return;
        this.#loaded = true; this.#lastLoad = Date.now();
        this.#destroyCharts();
        grid.innerHTML = "";

        const latest = this.#makeSection("latest", "현황", "현재 상태 스냅샷");
        const trend = this.#makeSection("trend", "추세", "기간 단위 변동 (우측 단위·구간 선택)");
        const dist = this.#makeSection("dist", "분포", "최근 분포 (예시)");
        const pattern = this.#makeSection("pattern", "패턴", "요일·시간대 활동 패턴");

        const sections = [latest, trend, dist, pattern];
        grid.appendChild(this.#buildNav(sections));
        grid.append(...sections.map(s => s.sec));
        this.#applySize();   // 저장된 크기 프리셋 → 그리드 열폭/막대높이 CSS 변수 세팅(차트 생성 전)
        this.#syncNavHeight();   // 섹션 제목줄 sticky top 오프셋

        // 추세 단위·구간 변경 → 추세 재렌더
        this.#buildTrendCtl(trend.ctl, () => { this.#renderTrend(trend.grid); });

        this.#renderLatest(latest.grid);
        this.#renderTrend(trend.grid);
        this.#renderDist(dist.grid);
        this.#renderPattern(pattern.grid);
    }

    #runSection(grid, sec, cards) {
        // 카드 슬롯을 정의 순서대로 먼저 배치(display:contents) → 비동기 완료 순서와 무관하게 표시 순서 고정.
        const tasks = cards.map(c => {
            const slot = document.createElement("div"); slot.style.display = "contents";
            grid.appendChild(slot);
            return () => this.#renderCard(slot, c, sec);
        });
        ltncStatsPool(tasks, 4).catch(e => console.error("[stats]", e));
    }

    #renderLatest(grid) {
        this.#runSection(grid, "latest", [
            { stat: "events_today" },
        ]);
    }
    #renderTrend(grid) {
        this.#destroySection("trend"); grid.innerHTML = "";
        const b = ltncStatsBucket, days = ltncStatsRange;
        this.#runSection(grid, "trend", [
            { stat: "events_trend", params: { b, days } },
            { stat: "active_users_trend", params: { b, days } },
            { stat: "events_by_type_trend", params: { b, days } },
        ]);
    }
    #renderDist(grid) {
        this.#runSection(grid, "dist", [
            { stat: "event_type_dist" }, { stat: "status_dist" }, { stat: "top_paths" },
        ]);
    }
    #renderPattern(grid) {
        this.#runSection(grid, "pattern", [
            { stat: "dow_bars" }, { stat: "hourly_heatmap" },
        ]);
    }

    async #renderCard(grid, c, sec) {
        let d;
        try { d = await ltncStatsFetch(c.stat, c.params); }
        catch (e) {
            const cell = ltncStatsCardEl(c.title || c.stat, null); grid.appendChild(cell.card);
            const em = document.createElement("div"); em.className = "ltnc_stats_empty"; em.textContent = "불러오기 실패 (" + e.message + ")"; cell.body.appendChild(em);
            return;
        }
        if (!grid.isConnected) return;
        const push = (r) => { if (r) { r.sec = sec; this.#charts.push(r); } };
        const mk = (title, redraw) => { const cell = ltncStatsCardEl(title, redraw); grid.appendChild(cell.card); return cell; };

        if (d.kind === "table") {
            const redraw = (cont) => { ltncStatsRenderTable(cont, d); return null; };   // 넓은 표 크게보기
            redraw(mk(c.title || d.title, redraw).body);
        }
        else if (d.kind === "heat") {
            const redraw = (cont, o) => { ltncStatsRenderHeat(cont, d, o); return null; };
            redraw(mk(c.title || d.title, redraw).body, {});
        }
        else if (d.kind === "dist") {
            // 인라인=상위 12개만, 상세(크게보기)=전체 재조회(limit 크게)해서 모든 항목 표시.
            let full = null;
            const redraw = async (cont, o) => {
                if (o && o.detail) {
                    if (!full) { try { full = await ltncStatsFetch(c.stat, Object.assign({}, c.params, { limit: 1000 })); } catch (e) { full = d; } }
                    ltncStatsRenderDist(cont, full);
                } else ltncStatsRenderDist(cont, d, { max: 12 });
                return null;
            };
            redraw(mk(c.title || d.title, redraw).body, {});
        }
        else if (d.kind === "series") {
            // split → 시리즈별 카드(묶음 prefix 생략, 시리즈명만). 단일 → 카드 제목 = c.title || d.title.
            const list = (d.split && (d.series || []).length > 1)
                ? d.series.map(s => ({ title: s.name, dd: { unit: d.unit, series: [s] } }))
                : [{ title: c.title || d.title, dd: d }];
            for (const it of list) {
                const redraw = (cont, o) => ltncStatsRenderChart(cont, it.dd, o);
                push(redraw(mk(it.title, redraw).body, { height: this.#chartH() }));
            }
        }
        else if (d.kind === "bars") {
            if (d.split) {
                for (const s of d.series || []) {
                    const redraw = (cont, o) => { ltncStatsRenderBars(cont, d.categories, s, o); return null; };
                    redraw(mk(s.name, redraw).body, {});
                }
            } else {
                const redraw = (cont, o) => { (d.series || []).forEach(s => ltncStatsRenderBars(cont, d.categories, s, o)); return null; };
                redraw(mk(c.title || d.title, redraw).body, {});
            }
        }
    }

}


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
//    + 계정별 홈탭: 세션 계정에 home(예 mpsol→stats)이 있으면 부팅 직후 해당 루트탭으로 전환.
function ltncRouteFromParams() {
    let routed = false;
    try {
        const params = new URLSearchParams(location.search);
        const open = params.get("ltncOpen");
        if (open === "alerts") { appPageManager.bringPage("alerts", { data: { alertId: params.get("ltncAlertId") } }); routed = true; }
        else if (open === "warroom") { appPageManager.bringPage("warroom"); routed = true; }
    } catch (exc) { console.error("[LTNC] 진입 라우팅 실패:", exc); }
    if (!routed) ltncApplyHomeTab();   // 명시 진입 라우팅(푸시 클릭)이 우선
}

// 계정 홈탭 조회·적용 — /api/me 의 home. 미로그인(401)·미설정이면 아무것도 안 함.
async function ltncApplyHomeTab() {
    try {
        const r = await fetch("/api/me");
        if (!r.ok) return;
        const me = await r.json();
        if (me?.home) ltncGoHomeTab(me.home);
    } catch (exc) { /* 네트워크 실패 — 홈탭 이동 생략 */ }
}

function ltncGoHomeTab(tabId) {
    try { estreUi.switchRootTab(String(tabId)); }
    catch (exc) { console.error("[LTNC] 홈탭 전환 실패:", tabId, exc); }
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
