# 색인 재설계 실행 기록

에픽 [#3](https://github.com/ice3x2/DocuLightViewer/issues/3) · 현재 실행 이슈 [S01 #24](https://github.com/ice3x2/DocuLightViewer/issues/24) · 다음 [S02 #25](https://github.com/ice3x2/DocuLightViewer/issues/25).
요구사항 원본은 `docs/spec/`이며 관련 ID는 `FR-DOC-019`, `REL-DOC-009`, `DR-DOC-014`, `FR-DOC-033`, `FR-DOC-035`, `FR-DOC-036`, `IR-APP-013`, `FR-APP-013`이다.

## S01 기준과 보존 경계

- [x] 공개 기준 커밋 `12d312cea07d530c7aa28ffb849575ea3d94b459`에서 `C:\Work\git\_Snoworca\DocuLightViewer-r3` 격리 작업 공간과 `feature/issue-24-s01-sol-medium` 브랜치를 만들었다. 생성 직후 `git status --short`는 빈 출력이었다.
- [x] 기존 루트 `C:\Work\git\_Snoworca\DocuLightViewer`의 HEAD는 `080ebf62736855b2ee8fc9e2f77ffbbd3a937161`이다. 해당 작업 공간과 다른 P0 작업 공간의 변경 파일을 이동·삭제·stash·병합하지 않았다.
- [x] 기준 대비 파일별 이월 후보를 [S01 전체 목록](../analysis/2026-09-24-s01-carryover-inventory.json)에 한 번씩 기록했다. 공개 기준 이후 루트의 커밋 변경 180개, 루트의 tracked 작업 변경 13개, untracked 파일 664개이며 고유 경로는 848개다. 겹친 경로는 하나의 레코드에 두 출처를 표시한다.
- [x] 분류는 **파일 경로에 따른 검토 출발점**이다. 코드 의미를 검증하거나 채택한 결과가 아니다. 현재 루트의 작업 변경 677개는 사용자 변경으로 보존한다. 다른 171개는 채택 후보 59개와 SRS·증거 충돌 검토 112개다. 독립 검토에서 848개 경로의 누락·중복·분류 오류가 없음을 확인했다.

## 격리 환경 관측

- [x] Windows 10.0.26200 x64, Node `v24.16.0`(Node ABI `137`), npm `11.5.2`; `npm ci`는 격리 작업 공간에서 exit `0`, 570개 패키지 추가였다.
- [x] Electron 패키지 `33.4.11`의 최초 설치에는 실행 파일이 없어 `npx electron --version`이 실패했다. 설치 스크립트를 한 번 재실행해도 복구되지 않았다. 검증된 로컬 Electron `33.4.11` zip의 모든 멤버가 격리된 `node_modules/electron/dist` 아래에 머무는지 확인한 뒤 그 디렉터리에 풀고 `path.txt`를 복원했다. 이후 `npx electron --version`은 `v33.4.11`을 출력했다.
- [x] `npm ci`는 기존 lockfile의 의존성 경고와 취약점 31건을 보고했다. S01에서는 의존성 버전·lockfile을 변경하지 않았다. Node와 Electron의 native 모듈 호환성은 S03 테스트 환경 이슈에서 별도로 확인한다.

## 공개 기준의 요구사항 차이

SpecKiwi MCP를 `workspaceRoot=C:\Work\git\_Snoworca\DocuLightViewer-r3`로 조회한 결과, 활성 target은 `0.11.0-w2`이고 Stability 차단 항목은 없다.

| 요구사항 | 공개 기준 상태 / Stability | 미완 AC | S02에서 확인할 차이 |
|---|---|---|---|
| `FR-DOC-019` | verified / stable | 없음 | 승인된 저장 성공·색인 수락 분리 및 최신 revision 계약 |
| `REL-DOC-009` | 없음 | 요구 블록 없음 | 공개 기준에 요구 블록이 없다. 기존 ID를 수동으로 쓰지 말고 SpecKiwi로 등록·동기화 |
| `DR-DOC-014` | verified / evolving | 없음 | 실제 원본 lexical/canonical 경로와 1:N alias, 복구 정보 |
| `FR-DOC-033` | verified / stable | 없음 | 승인된 문서별 import 보존 정책 |
| `FR-DOC-035` | implemented / evolving | AC-1~AC-12 | source-backed 등록과 원본 참조 유지 |
| `FR-DOC-036` | verified / evolving | 없음 | 조회 시 원본 검증과 저장소 복사본 fallback |
| `IR-APP-013` | 없음 | 요구 블록 없음 | 공개 기준에 요구 블록이 없다. 네 언어 상태 UI 계약 동기화 |
| `FR-APP-013` | 없음 | 요구 블록 없음 | 현재 루트에서는 승인된 embedding 등록 제거가 기록되어 있다. 공개 기준에 요구 블록이 없으므로 S02에서 S24의 유지 범위를 명시 |

현재 루트의 요구사항 상태는 공개 기준과 다르다. 이 표는 두 작업 공간을 구분하기 위한 관측 기록이며, 어느 요구사항도 이 문서만으로 verified로 승급하지 않는다. S02가 `docs/spec/`에 승인된 정책과 필요한 요구 블록을 반영하기 전에는 동작 변경을 시작하지 않는다.

## 재개 순서

- [x] 다른 에이전트가 S01의 SHA·파일별 목록 전수성·환경 관측·기존 사용자 변경 보존을 독립 검토했다. 지적된 미완 AC를 위 표에 반영했다.
- [ ] 검토 증거와 완료 SHA를 #24에 남기고 S01을 닫는다.
- [ ] S02는 이 브랜치의 완료 SHA에서 시작해 사용자 승인 D1과 단일 writer·save-intent·원본 alias 계약을 SpecKiwi MCP로 기존/누락 요구사항에 동기화한다.

현재 제품 구현 완료 이슈는 `0/36`이다. 이 문서 작성, 패키지 설치와 작업 공간 생성은 기능 구현 완료로 세지 않는다.
