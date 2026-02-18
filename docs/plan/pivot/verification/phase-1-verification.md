# Phase 1 검증: 기존 코드 정리 및 프로젝트 초기화

검증일: ____-__-__
검증자: ________________

## 참조 문서

- 구현 계획: [01.phase-1-cleanup.md](../01.phase-1-cleanup.md)
- SRS: [srs.pivot.md](../../srs.pivot.md) (FR-P-005)
- 아키텍처: [00-1.architecture.md](../00-1.architecture.md) Section 6

---

## 1. 파일 삭제 검증

### 1.1 디렉토리 단위 삭제 (170+ 파일)

| # | 검증 항목 | 확인 명령 | 결과 |
|---|-----------|-----------|------|
| 1 | [ ] `src/controllers/` 전체 삭제 (15개 파일) | `ls src/controllers/ 2>&1` → "No such file" | |
| 2 | [ ] `src/middleware/` 전체 삭제 (5개 파일) | `ls src/middleware/ 2>&1` → "No such file" | |
| 3 | [ ] `src/routes/` 전체 삭제 (5개 파일) | `ls src/routes/ 2>&1` → "No such file" | |
| 4 | [ ] `src/services/` 전체 삭제 (chatbot 33개 + mcp 5개 + 루트 11개) | `ls src/services/ 2>&1` → "No such file" | |
| 5 | [ ] `src/views/` 전체 삭제 (6개 파일) | `ls src/views/ 2>&1` → "No such file" | |
| 6 | [ ] `src/utils/` 전체 삭제 (10개 파일) | `ls src/utils/ 2>&1` → "No such file" | |
| 7 | [ ] `data/vector/` 전체 삭제 | `ls data/vector/ 2>&1` → "No such file" | |
| 8 | [ ] `scripts/` 전체 삭제 | `ls scripts/ 2>&1` → "No such file" | |
| 9 | [ ] `public/` 전체 삭제 (이동 완료 후) | `ls public/ 2>&1` → "No such file" | |
| 10 | [ ] `test/chatbot/` 전체 삭제 | `ls test/chatbot/ 2>&1` → "No such file" | |
| 11 | [ ] `test/mcp/` 전체 삭제 | `ls test/mcp/ 2>&1` → "No such file" | |

### 1.2 개별 파일 삭제

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 12 | [ ] `src/app.js` 삭제 | |
| 13 | [ ] `config.json5` 삭제 | |
| 14 | [ ] `config.json5.bak` 삭제 | |
| 15 | [ ] `config.example.json5` 삭제 | |
| 16 | [ ] `start.bat`, `stop.bat`, `start.sh`, `stop.sh` 삭제 | |
| 17 | [ ] Express 관련 테스트 파일 전체 삭제 (test/ 내 40+ 파일) | |

---

## 2. package.json 검증

### 2.1 제거된 패키지 (24개)

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 18 | [ ] `dependencies`에서 제거: express, ejs, multer, archiver, adm-zip, ignore, winston, winston-daily-rotate-file, json5, async-lock, puppeteer, cookie-parser, jsdom | |
| 19 | [ ] `dependencies`에서 제거: @langchain/*, langchain, hnswlib-node, zod | |
| 20 | [ ] `optionalDependencies`에서 제거: chokidar | |
| 21 | [ ] `devDependencies`에서 제거: nodemon, @playwright/test, playwright, cross-env | |

### 2.2 추가된 패키지 (5개)

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 22 | [ ] `dependencies`에 추가: `@modelcontextprotocol/sdk` | |
| 23 | [ ] `dependencies`에 추가: `electron-store`, `uuid` | |
| 24 | [ ] `devDependencies`에 추가: `electron`, `electron-builder` | |

### 2.3 유지 패키지

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 25 | [ ] `dependencies` 유지: `marked`, `dompurify`, `highlight.js` | |

### 2.4 package.json 필드

| # | 검증 항목 | 기대값 | 결과 |
|---|-----------|--------|------|
| 26 | [ ] `main` 필드 | `"src/main/index.js"` | |
| 27 | [ ] `scripts.start` | `"electron ."` | |
| 28 | [ ] `scripts.mcp` | `"node src/main/mcp-server.js"` | |
| 29 | [ ] `engines.node` | `">=20.0.0"` | |

---

## 3. npm install 검증

| # | 검증 항목 | 확인 방법 | 결과 |
|---|-----------|-----------|------|
| 30 | [ ] `node_modules/` 삭제 후 `npm install` 성공 | 종료 코드 0, 에러 없음 | |
| 31 | [ ] 필수 패키지 설치 확인 | `ls node_modules/electron` 존재 | |
| 32 | [ ] 제거 패키지 부재 확인 | `ls node_modules/express 2>&1` → "No such file" | |
| 33 | [ ] `npm audit` 실행 | critical/high 취약점 0건 (권장) | |

---

## 4. 댕글링 임포트 검증

| # | 검증 항목 | 확인 명령 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 34 | [ ] `require('express')` 참조 없음 | `grep -r "require.*express" src/` | 0건 | |
| 35 | [ ] `import express` 참조 없음 | `grep -r "import.*express" src/` | 0건 | |
| 36 | [ ] 삭제된 모듈 참조 없음 | `grep -rE "require\(.*(ejs|multer|winston|archiver)" src/` | 0건 | |
| 37 | [ ] 삭제된 파일 참조 없음 | `grep -rE "require\(.*(config-loader|path-validator|lock-manager)" src/` | 0건 | |

---

## 5. 디렉토리 구조 검증

### 5.1 신규 디렉토리

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 38 | [ ] `src/main/` 디렉토리 존재 (빈 디렉토리) | |
| 39 | [ ] `src/renderer/` 디렉토리 존재 | |
| 40 | [ ] `src/renderer/lib/` 디렉토리 존재 | |
| 41 | [ ] `assets/` 디렉토리 존재 | |

### 5.2 라이브러리 파일 이동

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 42 | [ ] `src/renderer/lib/marked.min.js` 존재 | |
| 43 | [ ] `src/renderer/lib/mermaid.min.js` 존재 | |
| 44 | [ ] `src/renderer/lib/highlight.min.js` 존재 | |
| 45 | [ ] `src/renderer/lib/highlight-github.min.css` 존재 | |
| 46 | [ ] `src/renderer/lib/purify.min.js` 존재 | |

### 5.3 아이콘 이동

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 47 | [ ] `assets/icon.png` 존재 (유효한 PNG) | |
| 48 | [ ] `public/images/icon.png` 원본 삭제됨 | |

### 5.4 유지 파일

| # | 검증 항목 | 결과 |
|---|-----------|------|
| 49 | [ ] `docs/` 디렉토리 유지 (plan/, pivot/ 포함) | |
| 50 | [ ] `CLAUDE.md` 유지 | |
| 51 | [ ] `README.md` 유지 | |
| 52 | [ ] `package.json` 유지 (정리 완료) | |

---

## 6. 품질 평가

### 6.1 Plan-Code 정합성

| 평가 항목 | 기준 | 점수 (1-5) | 비고 |
|-----------|------|-----------|------|
| 삭제 목록 일치 | Phase 1 체크리스트 대비 누락 파일 0개 | | |
| 보존 목록 일치 | 보존 대상 7개 항목 모두 정상 이동/유지 | | |
| 디렉토리 구조 | 아키텍처 문서 Section 6과 일치 | | |

### 6.2 구조적 일관성

| 평가 항목 | 기준 | 점수 (1-5) | 비고 |
|-----------|------|-----------|------|
| 잔여 코드 없음 | Express/챗봇/기존 MCP 코드 흔적 0건 | | |
| 의존성 정합 | package.json 의존성과 실제 코드 일치 | | |
| 빈 디렉토리 없음 | 불필요한 빈 디렉토리 0개 (src/main/은 Phase 2용으로 허용) | | |

---

## 7. 검증 결과 요약

| 항목 | 전체 | 통과 | 실패 | 미검증 |
|------|------|------|------|--------|
| 파일 삭제 | 17 | | | |
| package.json | 12 | | | |
| npm install | 4 | | | |
| 댕글링 임포트 | 4 | | | |
| 디렉토리 구조 | 15 | | | |
| **합계** | **52** | | | |

### 최종 판정

- [ ] **PASS**: 모든 검증 항목 통과
- [ ] **FAIL**: 실패 항목 존재 → 수정 후 재검증 필요

실패 항목 (있을 경우):

| # | 항목 | 실패 사유 | 수정 조치 |
|---|------|-----------|-----------|
| | | | |
