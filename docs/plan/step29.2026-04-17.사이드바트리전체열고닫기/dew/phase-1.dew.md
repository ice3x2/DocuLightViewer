---
stage: Phase 1
title: DOM · CSS · i18n 토대
remaining_findings:
  critical: 0
  high: 0
  medium: 0
  low: 8
decisions:
  - "SVG inline 채택 (이모지 대신) — ADR-2 확정, FAB 버튼 패턴 일관"
  - "CSS 공통 그룹 셀렉터(#btn-sidebar-search, #btn-sidebar-collapse-all, #btn-sidebar-expand-all) 도입 — 기존 name-toggle과 분리하여 hover:not(:disabled) 처리"
  - "i18n 평탄 키(sidebar.collapseAll 등) 관행 유지 — nested object 구조 미사용"
  - "disabled 기본값으로 HTML에 선언 — JS 로드 지연 시에도 안전하게 비활성 표시"
artifacts:
  - src/renderer/viewer.html
  - src/renderer/viewer.css
  - src/locales/ko.json
  - src/locales/en.json
  - src/locales/ja.json
  - src/locales/es.json
warnings_for_next:
  - "Phase 2에서 `_sidebarSearchModeActive`는 `_currentTreeLoadId` 바로 아래 IIFE 내부에 선언"
  - "Phase 2 `updateSidebarToggleButtons()`는 OR 논리(검색모드 || 로딩 || 트리부재) 엄수"
  - "기존 onSidebarTreeStart/Done/Error 핸들러 본문 끝에 update 호출 1줄만 주입 — 별도 리스너 추가 금지 (ADR-5)"
  - "초기화 종료 시점(notifyReady 직후)에 updateSidebarToggleButtons() 1회 호출 필수"
summary: 사이드바 헤더에 2개 버튼(SVG 인라인 chevron) + 공통 CSS + 16 i18n 키(4 로케일 × 4 키) 완비. 기본 disabled 상태.
completed_at: 2026-04-17
---
