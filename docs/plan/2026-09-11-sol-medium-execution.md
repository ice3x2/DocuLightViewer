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
- [x] [검토 증거](../analysis/2026-09-24-s01-independent-review.json)와 완료 SHA를 #24에 연결하고 S01을 닫았다. 최초 기록 커밋은 `749b805e66ea714514b9b0b7e9e34532be53ac93`이며, 이 체크 변경을 포함한 최종 인계 SHA는 해당 브랜치 HEAD를 따른다.
- [x] S02는 이 브랜치의 완료 SHA에서 시작해 사용자 승인 D1과 단일 writer·save-intent·원본 alias 계약을 SpecKiwi로 기존/누락 요구사항에 동기화했다. [데이터·복구 독립 검토](../analysis/2026-09-24-s02-data-review.json)와 [공개 계약 독립 검토](../analysis/2026-09-24-s02-contract-review.json)는 모두 남은 지적 0건이다.

## S02 공유 계약 — 독립 검토 완료

시작 SHA `28acd4f038fac91ddc28a7502edef05135a66409`. 사용자 승인 D1은 저장된 Markdown 파일과 완료된 import 문서를 색인 실패·취소 시 보존하고 색인만 재시도한다. `docs/spec/`가 유일한 요구사항 원본이다. 작업 브랜치 지정이 가능한 MCP mutation이 없어 `speckiwi --root C:/Work/git/_Snoworca/DocuLightViewer-r3`의 dry-run과 실제 mutation을 사용했다. 기존 verified 증거는 과거 범위의 증거로 남기고 변경된 네 요구사항을 `in_progress`로 재개했다. 새 AC는 미검증 상태다.

| REQ | S02 변경 | 경계 |
|---|---|---|
| `FR-DOC-019` | 저장 성공과 색인 수락·완료 분리, 단일 장기 writer, 최신 revision 판정, 정확한 worker envelope/registry와 `accept_save` 입력·결과 | 핵심 3시간 경로: S03 이후 RED/GREEN. 새 AC 2개와 변경 AC는 재검증 필요 |
| `REL-DOC-009` | body 없는 bounded private intent → atomic final Markdown → source metadata/job commit → ACK; post-publication failure는 `enqueue_failed`, jobId 없음, `index_enqueue_failed` 유지, 파일 보존 | 핵심 경로. Crash, capacity, redaction, 재시작의 전체 release fault matrix는 별도 gate |
| `DR-DOC-014` | 문서 ID와 1:N original alias, lexical/canonical original 및 `documents.relative_path` store copy 분리; `desired_revision`, `desired_content_hash`, `active_requested_revision`, `dirty`, `keyword_dirty`, `accepted_intent_id` | 핵심 경로. 기존 alias/metadata/history 보존 및 migration 검증은 release gate |
| `FR-DOC-033` | linked import를 문서별 확정하고 이미 완료한 문서는 오류·취소 뒤에도 보존 | 핵심 경로, 전체 bounded traversal 회귀는 release gate |
| `FR-DOC-035` | opt-in registrar의 source-backed provenance 확보, copy 게시 뒤 job commit, 실패 시 원본 참조·파일 보존 | 핵심 경로, 모든 open entrypoint·path alias 회귀는 release gate |
| `FR-DOC-036` | 유효한 original을 same-handle read-only로 열고 무효하면 검증된 indexed copy fallback; 1:N 후보 조회는 mutation 없음 | 핵심 경로, TOCTOU·transport parity는 release gate |
| `IR-APP-013` | 16개 AC로 canonical cached ledger status, 저장 성공과 색인 지연, 기존 `ko/en/ja/es` strings·접근성·cold responsiveness·8-tool 및 P0/P1 action 경계 유지 | 핵심 상태 표시; packaged process-cold 증거는 release gate이고 D4 완화 없음 |
| `FR-APP-012` → `FR-APP-013` | 검증된 기존 등록 계약은 guarded supersede로 `discarded/stable` 처리하고 successor metadata/trace를 연결했다. S24의 등록 제거와 legacy 설정 호환은 `FR-APP-013 planned/evolving`의 8개 AC에 명시 | S24 범위. 기존 등록 검증은 역사적 증거이고 S02에서 제거 구현 완료를 주장하지 않음 |

내부 wire envelope tag는 `START|COMMAND|QUERY|CANCEL|RESULT|STATUS|SHUTDOWN`, `COMMAND/QUERY` registry는 `accept_save|resolve_origin|query_keyword|get_status|cancel_job|shutdown`이다. `accept_save`의 private ephemeral 입력은 `{intentId, operation, sourceId, rootFingerprint, sourceRelativeLocator, contentHash, provenance, contentBytes}`이고 결과는 `{accepted, desiredRevision?, indexingState, jobId?, warningCode?}`다. `contentBytes` 또는 동등한 contained staging locator는 worker의 파일 게시에만 쓰며 durable intent에는 본문·bytes가 없다. 이 입력은 issue #25의 최초 draft에서 파일 게시에 필요한 bytes가 빠진 부분을 수정한 계약이다. `indexingState`는 기존 public `indexing.state`로 mapping하는 내부 값이다. Durable provenance는 실제 original lexical/canonical identity 또는 lossless private manifest reference와 최종 frontmatter에서 byte-equivalent 복원할 수 없는 사용자 metadata만 담는다. Alias의 raw original 필드는 `origin_lexical_path_internal`, `origin_path_internal`이며 store copy는 별도 `documents.relative_path`다. Source identity의 relative key는 `DR-DOC-013`을 따른다. 일반 enqueue failure는 기존 `warnings[{code=index_enqueue_failed,message,retryable}]`를 유지하고 ingress capacity 초과일 때에만 기존 warnings[] shape에 `indexing_ingress_capacity` 진단을 추가할 수 있다. 완료 판정은 `requestedRevision == desiredRevision && actualFileHash == desiredContentHash`이며 단일 owner만 revision을 멱등 할당한다.

S02에서 동작 코드·테스트·CLI behavior는 변경하지 않았다. SpecKiwi `validate --json`은 exit 0, errors 0, warnings 6이었다. `SRS-W015` 4건은 기존 완료 로그가 재개되거나 supersede된 요구사항을 가리키는 이력 경고이고 `SRS-W073` 2건은 기존 index의 규칙 파일 버전 경고다. `FR-APP-012`는 verified-discard guard를 명시적으로 통과하는 `supersede --confirm-discard-verified`로 폐기했고, 정확히 `FR-APP-013`을 후속 요구로 할당했다. `IR-APP-013`은 16개 AC를 가진 `planned/evolving`으로 등록했다. 두 독립 검토가 승인 문장별 mapping, 기존 AC 의미, 새 ID·Status/Stability, 공개 8-tool·redaction·네 locale·저장 파일 보존, 3시간 핵심과 release gate의 구분을 확인했다.

실행 이슈는 `2/36` 완료(S01·S02)이고 제품 기능 구현 완료는 `0/36`이다. 문서 작성과 환경 준비는 기능 구현 완료로 세지 않는다. 다음 이슈 [S03 #26](https://github.com/ice3x2/DocuLightViewer/issues/26)은 이 브랜치의 S02 인계 SHA에서 Node/Electron 단일 케이스 테스트 하네스를 먼저 만든다.
