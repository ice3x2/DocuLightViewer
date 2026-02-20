# 이미지 출력 테스트

이 문서는 DocuLight의 이미지 렌더링을 테스트합니다.

---

## SVG 이미지

### 상대 경로 참조

![DocuLight Logo](./doculight-logo.svg)

### 절대 경로 참조 (Windows)

<!-- 절대 경로가 필요한 경우 아래 주석을 해제하고 경로를 수정하세요 -->
<!-- ![DocuLight Logo](C:/Work/git/_Snoworca/DocuLightViewer/docs/doculight-logo.svg) -->

---

## 이미지 크기 조절 테스트

HTML 태그를 사용한 크기 지정:

<img src="./doculight-logo.svg" width="200" alt="DocuLight Logo (small)">

<img src="./doculight-logo.svg" width="100" alt="DocuLight Logo (tiny)">

---

## 마크다운 기본 문법

| 구문 | 예시 |
|------|------|
| `![alt](path)` | 기본 이미지 |
| `<img src="..." width="N">` | 크기 지정 |

---

*이미지가 정상 표시되면 상대 경로 이미지 로딩이 작동하는 것입니다.*
