# Phase 1 검증 문서

## 검증 항목

- [ ] `src/renderer/viewer.html` 에 `#btn-sidebar-collapse-all`, `#btn-sidebar-expand-all` 2개 버튼 존재
- [ ] 두 버튼 모두 `disabled` 속성 기본 포함
- [ ] 두 버튼 내부에 `<svg viewBox="0 0 24 24">` + 2개 `<polyline>` 존재
- [ ] 접기 버튼: 상단 `points="6 5 12 9 18 5"` + 하단 `points="6 19 12 15 18 19"` (∨∧)
- [ ] 펼치기 버튼: 상단 `points="6 9 12 5 18 9"` + 하단 `points="6 15 12 19 18 15"` (∧∨)
- [ ] 두 버튼에 `data-i18n-aria-label`, `data-i18n-title` 속성 존재
- [ ] `src/renderer/viewer.css` 에 두 버튼 ID 선택자 또는 공통 클래스 스타일 존재
- [ ] 기존 `#btn-sidebar-name-toggle` 스타일과 시각적 일관성 (opacity/padding/font-size)
- [ ] `src/locales/ko.json`, `en.json`, `ja.json`, `es.json` 모두에 다음 4개 키 존재:
  - `sidebar.collapseAll`, `sidebar.expandAll`, `sidebar.collapseAllTitle`, `sidebar.expandAllTitle`

## 증거 수집 명령

```bash
# HTML 버튼 존재 확인
grep -n "btn-sidebar-collapse-all\|btn-sidebar-expand-all" src/renderer/viewer.html

# CSS selector 확인
grep -n "sidebar-collapse-all\|sidebar-expand-all\|sidebar-header-btn" src/renderer/viewer.css

# i18n 키 4개 × 4개 파일 확인
node -e "
const locales = ['ko','en','ja','es'];
const keys = ['collapseAll','expandAll','collapseAllTitle','expandAllTitle'];
for (const l of locales) {
  const j = require('./src/locales/' + l + '.json');
  for (const k of keys) {
    if (!j.sidebar || !j.sidebar[k]) console.log('MISSING:', l, 'sidebar.' + k);
  }
}
console.log('OK if no MISSING lines above');
"

# Phase 1 단계에서는 Node 레벨 테스트 영향 없음
node test/test-link-tree.js 2>&1 | tail -3
```

## 합격 기준

- HTML/CSS/i18n 3종 모두 구현 완료
- `npm start` 부팅 시 오류 없음, 두 버튼이 disabled 상태로 표시됨
- 기존 단위 테스트 4건 PASS 유지
