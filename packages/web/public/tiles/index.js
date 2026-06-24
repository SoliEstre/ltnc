// LTNC UV 타일 전체 import 진입점 — Lane A 의 index.html 이 이 파일 하나만 로드:
//   <script type="module" src="/tiles/index.js"></script>
// 각 타일은 import 부수효과로 customElements 에 자동 등록(self-registering).
// 선행 조건: import map(/tiles/IMPORTMAP.json 내용)이 본 모듈보다 먼저 문서에 있어야 함.

import './ltnc-stat-gauge.js';   // <ltnc-stat-gauge>  — 소형 SVG 링 게이지
import './ltnc-server-card.js';  // <ltnc-server-card> — 서버 상태 카드 (게이지 포함)
import './ltnc-checks-card.js';  // <ltnc-checks-card> — 외부 HTTP 체크(@checks) 전용 카드
import './ltnc-conn-badge.js';   // <ltnc-conn-badge>  — 허브 연결 상태 뱃지
