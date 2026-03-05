# Phase 1 검증: MCP Stdio 번들링

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | esbuild devDependency 설치 | [ ] | `npm ls esbuild` 출력 |
| 2 | zod dependency 선언 | [ ] | `npm ls zod` — 직접 의존성으로 표시 |
| 3 | `bundle:mcp` 스크립트 동작 | [ ] | `npm run bundle:mcp` 에러 없이 완료 |
| 4 | 번들 파일 생성 | [ ] | `ls -la src/main/mcp-server.bundle.cjs` |
| 5 | 번들 파일 크기 | [ ] | < 2MB |
| 6 | shebang 포함 | [ ] | `head -1 src/main/mcp-server.bundle.cjs` → `#!/usr/bin/env node` |
| 7 | 번들 단독 실행 | [ ] | `node src/main/mcp-server.bundle.cjs` 시작 메시지 |
| 8 | asarUnpack 축소 | [ ] | electron-builder.yml에 `node_modules/**` 없음 |
| 9 | .gitignore 추가 | [ ] | `git status` — bundle.cjs 추적 안 됨 |
| 10 | 빌드 성공 | [ ] | `npm run build:win` 에러 없이 완료 |
| 11 | 패키징 후 번들 존재 | [ ] | `ls dist/win-unpacked/resources/app.asar.unpacked/src/main/` |
| 12 | node_modules unpack 없음 | [ ] | `ls dist/win-unpacked/resources/app.asar.unpacked/` — node_modules 없음 |
| 13 | 인스톨러 크기 | [ ] | Setup exe < 120MB |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-1-001 | 번들 빌드 성공 | [ ] Pass / [ ] Fail | |
| TC-1-002 | 번들 서버 시작 | [ ] Pass / [ ] Fail | |
| TC-1-003 | 패키징 후 번들 경로 | [ ] Pass / [ ] Fail | |
| TC-1-004 | 번들 내 의존성 자체 포함 | [ ] Pass / [ ] Fail | |
| TC-1-005 | 인스톨러 크기 검증 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| `npx playwright test` | [ ] Pass / [ ] Fail | |
| `npm run mcp` (원본 .mjs) | [ ] Pass / [ ] Fail | |
| `npm start` | [ ] Pass / [ ] Fail | |
| HTTP MCP curl | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-1-001 번들 빌드 실패 | esbuild 설치 여부, `import.meta.url` 변환 | `npm ls esbuild` 확인, `--platform=node` 플래그 확인 |
| TC-1-002 번들 서버 시작 실패 | 번들 내 의존성 누락 | `node --inspect mcp-server.bundle.cjs`로 에러 스택 확인 |
| TC-1-003 패키징 후 번들 미존재 | `asarUnpack` 경로 불일치 | `electron-builder.yml`의 `asarUnpack` 경로와 실제 번들 경로 비교 |
| TC-1-005 인스톨러 > 120MB | `node_modules` 여전히 unpack | `app.asar.unpacked/` 내 `node_modules/` 존재 여부 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
