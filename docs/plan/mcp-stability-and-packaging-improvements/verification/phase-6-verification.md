# Phase 6 검증: 플랫폼별 개선

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | Linux 아이콘 경로 수정 | [ ] | `app.isPackaged` 분기 확인 |
| 2 | extraResources 아이콘 추가 | [ ] | 빌드 후 `resources/icon.png` 존재 |
| 3 | macOS hardenedRuntime 설정 | [ ] | electron-builder.yml 확인 |
| 4 | entitlements.mac.plist 생성 | [ ] | 파일 존재 확인 |
| 5 | ARM64 타겟 추가 | [ ] | electron-builder.yml 확인 |
| 6 | Linux artifactName에 arch 포함 | [ ] | 빌드 산출물 파일명 확인 |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-6-001 | Linux deb 아이콘 표시 | [ ] Pass / [ ] Fail | |
| TC-6-002 | AppImage 아이콘 경로 | [ ] Pass / [ ] Fail | |
| TC-6-003 | macOS hardenedRuntime 빌드 | [ ] Pass / [ ] Fail | |
| TC-6-004 | artifactName 아키텍처 구분 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| `npm run build:win` | [ ] Pass / [ ] Fail | |
| `npm run build:mac` | [ ] Pass / [ ] Fail | |
| `npm run build:linux` | [ ] Pass / [ ] Fail | |
| 트레이 아이콘 표시 | [ ] Pass / [ ] Fail | |
| `npx playwright test` | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-6-001 아이콘 미표시 | `extraResources` 설정 | `electron-builder.yml`의 `extraResources` 경로가 올바른지, `resources/icon.png` 존재 확인 |
| TC-6-002 AppImage 아이콘 | `process.resourcesPath` 값 | AppImage 실행 시 `resourcesPath`가 마운트 경로 내부를 가리키는지 확인 |
| TC-6-003 macOS 빌드 실패 | entitlements 파일 | `build/entitlements.mac.plist` 파일이 유효한 XML인지, `build/` 디렉토리 존재 확인 |
| TC-6-004 파일명 충돌 | `artifactName`에 `${arch}` | `electron-builder.yml`의 Linux `artifactName` 패턴 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
