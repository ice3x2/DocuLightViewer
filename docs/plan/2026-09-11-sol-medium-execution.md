# 색인 재설계 실행 기록

에픽 [#3](https://github.com/ice3x2/DocuLightViewer/issues/3) · 완료된 마지막 실행 이슈 [S19 #42](https://github.com/ice3x2/DocuLightViewer/issues/42) · 다음 [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43).
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

실행 이슈는 `19/36` 완료(S01~S19)다. 공개 baseline SQLite job의 안전 전환과 blocked 구형 행 보존·새 저장 복구를 검증했다. 다음은 [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43)의 시작 복구·owner 독점성·기존 검색 index 보존이다.

## S17 진행 기록 — 독립 검토 완료

- 시작 SHA `87c21a439dd78cb73696df7a7fe38d4b490aa2fd`, 격리 worktree `DocuLightViewer-r3`. 관련 `FR-DOC-033`, `DR-DOC-013`, `DR-DOC-014`, `FR-DOC-019`, `REL-DOC-009`의 Stability 차단 없음.
- [x] [S17 RED/GREEN 증거](../analysis/2026-09-25-s17-import-evidence.md): 실제 파일·SQLite·owner worker에서 C intent/rename/post-publish/ACK/cancel fault의 부분 완료 보존과 retry, 변경 본문 replay·다른 intent 거절, lexical alias, `.markdown`, owner graph 파생을 test-first로 검증했다. 최종 Node ABI 137 `s17` 32 assertions, Wave 2 import/ledger 계약, S08 53·S13 20·S15 49·S16 24 assertions 통과.
- [x] 작성자가 아닌 독립 검토자의 [import·데이터 검토](../analysis/2026-09-25-s17-import-review.json)와 [TDD·복구 검토](../analysis/2026-09-25-s17-tdd-review.json)를 소스 해시 `1192d04e1c2c45a6c34b5a55ee71556578146a6d140acf05ee72ca1b0b6a8203`에서 마쳤다. 기존에 실패하던 게시 후 owner 오류·재시도가 원장 revision 1→2로 수렴하는 것을 독립 재현했으며 차단 결함 0건이다.
- [x] #40 완료 조건·이슈 체크박스·댓글·close·최종 SHA를 연결한다. 다음은 [S18 #41](https://github.com/ice3x2/DocuLightViewer/issues/41)이다.

## S18 진행 기록 — 독립 검토 완료

- 시작 SHA `eca8b2c4c285fdfa505868edbda6fb3270bc6340`, 격리 worktree `DocuLightViewer-r3`. `FR-DOC-033`, `DR-DOC-013`, `CON-DOC-006`, `SEC-DOC-003`, `REL-DOC-009`의 Stability 차단 없음.
- [x] [S18 RED/GREEN 및 실제 FS·SQLite 행렬](../analysis/2026-09-25-s18-import-limits-evidence.md): `s18` semantic RED 뒤 depth/files/bytes exact limit, rejected candidate budget, 순환·깨진 링크·junction 탈출·취소와 owner ACK 후 부분 완료를 검증했다. ACK 1회 유실은 동일 7필드 intent 재접수로 receipt를 확인해 C를 1회만 세고, 지속 유실은 `ack_unknown`/`unconfirmedCount=1`로 별도 보고한다. Settings의 거짓 완료 문구도 renderer semantic RED 뒤 4개 언어의 일부 완료·재확인 안내로 수정했다.
- [x] 작성자가 아닌 독립 검토자의 [한도·데이터 검토](../analysis/2026-09-25-s18-limits-review.json)와 [TDD·UX 검토](../analysis/2026-09-25-s18-tdd-review.json)를 소스 해시 `d0b43e7c1ae1aeb004c70f0ea1c1552ae486f99924b326df5f01c309ce4e9cb8`에서 마쳤다. S18 19, S17 32, Settings 두 계약, Wave 2 import-adoption/smart-search가 통과했고 차단 결함 0건이다.
- [x] #41 완료 조건·이슈 체크박스·댓글·close·최종 SHA를 연결한다. 다음은 [S19 #42](https://github.com/ice3x2/DocuLightViewer/issues/42)이다.

## S19 진행 기록 — 독립 검토 완료

- [x] [S19 공개 baseline SQLite job 전환 증거](../analysis/2026-09-25-s19-legacy-migration-evidence.md): `REL-DOC-009`, `FR-DOC-019`, `DR-DOC-014`, `SEC-DOC-003`; 시작 SHA `a4c78f84b9c8de6c96e7e9a02e9f971f65e8d6b3`. Semantic RED 뒤 공개 SHA가 생성한 SQLite fixture에서 `s19` 47 assertions GREEN, S10 fixture semantic RED 뒤 47 assertions GREEN, search-engine lifecycle/startup memory 및 S09/S11/S17/S18 통과.
- [x] [공개 DB 전환·데이터 검토](../analysis/2026-09-25-s19-migration-review.json)와 [TDD·시작 복구 검토](../analysis/2026-09-25-s19-tdd-review.json)는 소스 해시 `503540cf3d1b99ef69624ae6f599dc8060e1be5548fd232f12e5846a720ec901`에서 차단 결함 0건이다. 공개 fixture checksum, 새 쓰기 gate, 차단된 구형 job 뒤 새 저장 완료, S10 기준 fixture 교정을 독립 확인했다.
- [x] #42 완료 조건·이슈 체크박스·댓글·close·최종 SHA를 연결한다. 다음은 [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43)이다.

## S03 진행 기록 — 독립 검토 완료

- [x] 시작 SHA `7db991d5c76259435c80a8ce1ed2d925fcbd1e78`, 같은 통합 브랜치와 격리 작업 트리에서 시작했다. 관련 SRS `FR-DOC-019`, `DR-DOC-014`, `REL-DOC-009`, `IR-APP-013`의 Stability 차단이 없음을 확인했다.
- [x] 하네스 계약 테스트를 먼저 작성해 실제 assertion RED를 확인하고 최소 dispatcher/fixture/runner를 구현했다. 독립 검토에서 발견된 HIGH 4건도 각각 assertion RED 뒤에 수정했다. 최종 `node --test test/r3/test-harness-contract.cjs`는 exit 0, 17/17, 1234 ms다.
- [x] Node ABI 137과 Electron ABI 130을 분리한 source-hash snapshot을 만들고 각 root에서 실제 `better-sqlite3`를 열었다. `run-node.cjs --case harness-self`와 `run-electron.cjs --scenario harness-self`는 각각 exit 0, assertions=3, terminal PASS였다. 선택된 case 모듈은 해당 snapshot의 60초 제한 Node child 또는 Electron child에서 로드한다.
- [x] 소스만 바뀌면 기존 dependency root를 재사용해 snapshot/manifest를 갱신한다. `npm ci`/native rebuild 없이 1.1초에 갱신했고 Node native 파일 mtime이 유지되었다. 전체 명령과 환경은 [S03 증거](../analysis/2026-09-24-s03-harness-evidence.md)에 있다.
- [x] 작성자가 아닌 독립 검토자의 요구사항·diff·RED/GREEN 증거 검토와 수정 루프. [TDD 검토](../analysis/2026-09-24-s03-tdd-review.json)와 [native 격리 검토](../analysis/2026-09-24-s03-native-review.json)는 현재 구현에서 남은 지적 0건이다. 최초 RED의 원본 transcript가 보존되지 않은 한계는 증거 문서에 명시한다.
- [x] 이슈 체크박스, 완료 댓글, close 및 최종 SHA를 이 브랜치의 S03 완료 SHA로 연결했다. 다음 [S04 #27](https://github.com/ice3x2/DocuLightViewer/issues/27)은 별도 case로 registry에 등록됐다.

## S04 진행 기록 — 독립 검토 완료

- [x] S03 인계 SHA `0bfb5d803ced0e451cd105bed9034b89ed466798`에서 시작했다. 관련 SRS `DR-DOC-014`, `FR-DOC-035`, `DR-DOC-013`을 읽고 Stability 차단이 없음을 확인했다.
- [x] 실제 구형 SQLite alias 스키마, 원본 경로 두 개, 기존 document/job/chunk/embedding/ANN 데이터에 대한 `test/r3/cases/s04.cjs`를 먼저 등록했다. [RED/GREEN 증거](../analysis/2026-09-24-s04-alias-evidence.md)의 assertion RED 뒤 최소 alias migration/upsert를 구현했다.
- [x] Node ABI 137 런타임에서 focused S04 GREEN과 기존 Wave 2 ledger contract PASS를 확인했다. 최종 보존 assertion 추가 뒤 focused case 재실행 결과는 증거 문서를 따른다.
- [x] 작성자가 아닌 독립 검토자가 요구사항·diff·RED/GREEN 증거와 migration 안전성을 검토했다. [마이그레이션 검토](../analysis/2026-09-24-s04-data-review.json)와 [TDD 검토](../analysis/2026-09-24-s04-tdd-review.json)는 남은 지적 0건이다.
- [x] 최종 SHA, 이슈 체크박스·완료 댓글·close를 연결하고 [S05 #28](https://github.com/ice3x2/DocuLightViewer/issues/28)에 alias 조회 계약을 인계한다.

## S05 진행 기록 — 독립 검토 완료

- [x] S04 인계 SHA `f29e34fbd401806ba30bfe2deaaaa2c66f79a036`에서 시작했다. `FR-DOC-036`, `DR-DOC-014`, `IR-MCP-019`는 모두 `in_progress/evolving`이다.
- [x] [S05 RED/GREEN 증거](../analysis/2026-09-24-s05-origin-evidence.md)에 실제 Node assertion RED exit 1, 최종 focused GREEN exit 0(23 assertions), 기존 origin 계약 GREEN, 읽기 전용 DB·FS byte 비교를 기록했다.
- [x] 작성자가 아닌 독립 검토자가 원 요구사항·diff·TDD 증거·기존 계약 oracle 갱신을 확인했다. [원본 보안 검토](../analysis/2026-09-24-s05-origin-review.json)와 [TDD·회귀 검토](../analysis/2026-09-24-s05-tdd-review.json)는 남은 지적 0건이다.
- [x] #28 체크박스·완료 댓글·close와 인계 SHA를 연결한다. 다음 작업은 [S06 #29](https://github.com/ice3x2/DocuLightViewer/issues/29)이다.

## S06 진행 기록 — 독립 검토 완료

- [x] S05 인계 SHA `1377cfe547aba663d554978be1a000c993b93c88`에서 시작했다. 관련 요구사항은 `FR-DOC-019`, `REL-DOC-007`, `DR-DOC-014`, `IR-APP-013`이고 Stability 차단은 없다.
- [x] [S06 RED/GREEN 증거](../analysis/2026-09-24-s06-owner-evidence.md)에 실제 Node/Electron assertion RED와 최종 focused GREEN(각 42 assertions)을 기록했다. 두 SQLite 연결은 새 owner worker에서 열리고 READY 전에 migration/integrity 및 keyword root/tokenizer gate를 통과한다. 빈 root/이전 root/없는 keyword generation은 stale 상태에서 검색 결과를 차단하고 자동 재빌드하지 않는다. 실제 garu committed cache는 검색 가능하며 진짜 tokenizer 불일치는 차단한다. Worker 재시작 뒤 cached STATUS sequence도 단조 증가하고 error/exit interleaving은 두 owner를 겹치지 않는다. S05의 private `documentId`/indexed `filePath` 조회는 같은 문서 ID·실제 indexed copy·root·relative locator를 반환한다.
- [x] 작성자가 아닌 독립 검토자가 요구사항·diff·실행 증거를 확인했다. [owner 아키텍처 검토](../analysis/2026-09-24-s06-architecture-review.json)와 [TDD·runtime 검토](../analysis/2026-09-24-s06-tdd-review.json)는 남은 지적 0건이다. `accept_save` durable write와 모든 producer migration은 S08 이후에 남아 있으며 S06에서 전역 sole-writer 완료를 주장하지 않는다.
- [x] 독립 검토 지적을 해결하고 S06 완료 조건을 판정해 #29 상태와 다음 [S07 #30](https://github.com/ice3x2/DocuLightViewer/issues/30) 인계 계약을 갱신한다. 실제 두 저장의 write audit는 S08~S12, 기존 경로 제거는 S23, 실제 앱 통합은 S26에서 검증한다.

## S07 진행 기록 — 독립 검토 완료

- [x] 시작 SHA `00dfa538c85d19cd605e18881dfa5f543182629d`와 `FR-DOC-019`, `REL-DOC-007`, `IR-APP-013` 계약을 확인했다. 새 owner의 실제 저장 job은 S08에서 구현된다.
- [x] 새 owner route의 SQLite+CPU work-unit overlap assertion RED 뒤 최소 scheduler를 구현했다. 비동기 unit 거부, cancel status progress 보존, callback 중복 방지, FIFO work-unit rotation, 590.760 ms active Electron 측정도 각각 assertion RED 뒤 수정했다. Node S07 15 assertions, Electron S07 20 assertions, S06 Node/Electron 각 42 assertions가 통과했다. [원시 측정 및 전환 범위](../analysis/2026-09-24-s07-scheduler-evidence.md)에 기록했다.
- [x] 작성자가 아닌 독립 검토자가 원 이슈·diff·runtime 증거를 확인했다. [TDD·측정 검토](../analysis/2026-09-24-s07-tdd-review.json)와 [owner 실행 검토](../analysis/2026-09-24-s07-runtime-review.json)는 남은 지적 0건이다.
- [x] #30 체크박스·완료 댓글·close 및 최종 SHA를 연결한다. 다음 작업은 [S08 #31](https://github.com/ice3x2/DocuLightViewer/issues/31)이다.

## S08 진행 기록 — 독립 검토 완료

- [x] S07 인계 SHA `1919a335bccc429f0e378e08d8c5f8cbb238e890`에서 시작했다. `REL-DOC-009`, `FR-DOC-019`, `FR-DOC-028`, `DR-DOC-014`를 확인했고 Stability 차단은 없다. #31의 최종 FILE/INTENT 경계에 따라 S09 authoritative commit은 구현하지 않았다.
- [x] S08 Node case를 먼저 등록하고 의미 있는 `ASSERTION_FAIL` RED(exit 1) 뒤 private intent와 atomic file publisher를 구현했다. 독립 검토가 찾은 동일 문서 update, unsafe replay, 오래된 intent provenance 손실, 무제한 final-file read도 각 assertion RED 뒤 수정했다. [S08 증거](../analysis/2026-09-24-s08-intent-evidence.md)에 실제 FS fault matrix와 Windows directory flush 한계를 기록했다. Focused Node case 53 assertions 및 기존 MCP save parity가 통과했다. SpecKiwi로 `REL-DOC-009 AC-2`와 변경 이유를 갱신했고 SRS validate는 errors 0이다.
- [x] 작성자가 아닌 독립 검토자가 원 요구사항·diff·RED/GREEN 증거와 durability, provenance, path containment, 공개 호환성을 확인했다. [durability·보안 검토](../analysis/2026-09-24-s08-durability-review.json)와 [TDD·호환성 검토](../analysis/2026-09-24-s08-tdd-review.json)는 남은 지적 0건이다.
- [x] 검토 지적을 수정하고 focused regression을 확인한 뒤 #31 체크박스·완료 댓글·close와 [S09 #32](https://github.com/ice3x2/DocuLightViewer/issues/32) 인계 SHA를 연결한다.

## S09 진행 기록 — 독립 검토 완료

- [x] S08 인계 SHA `11be24519754e14d6e4af1b9f4e22c300476ac86`에서 시작했다. `FR-DOC-019`, `REL-DOC-009`, `DR-DOC-014`, `IR-MCP-018`, `IR-APP-013` 및 활성 target의 Stability 차단 없음 확인.
- [x] [S09 RED/GREEN 및 결함 주입 증거](../analysis/2026-09-24-s09-accept-evidence.md): 실제 FS+SQLite assertion RED 뒤 owner의 metadata·alias·revision·job 원자 수락을 구현했다. 독립 검토 지적에 따라 per-intent receipt, 동일 본문 다중 alias, transient 이전 intent 오류, authoritative dirty 필드 및 ACK 이후 private intent 정리를 test-first로 보강했다. Focused Node case 37 assertions, MCP 계약, 네 locale key 일치 확인.
- [x] S08 private intent의 `createdTime`은 밀리초 정밀도다. 동일 문서의 미수락 intent 두 개가 같은 시각이면 S09은 어느 쪽도 current job으로 ACK하지 않고 retryable로 남긴다. S10은 사용자 재저장 없이 수렴하도록 durable 게시 순서 증거나 owner의 동등한 tie 해결 계약을 추가해야 한다.
- [x] 작성자가 아닌 독립 검토자가 원 요구사항·diff·실행 증거를 확인했다. [원장·복구 검토](../analysis/2026-09-24-s09-data-review.json)와 [TDD·공개 계약 검토](../analysis/2026-09-24-s09-tdd-review.json)는 남은 지적 0건이다. 전체 S10 latest-winner 및 #37 공개 producer 연결을 S09 완료로 주장하지 않는다.
- [x] #32 체크박스·완료 댓글·close, 최종 SHA 및 다음 [S10 #33](https://github.com/ice3x2/DocuLightViewer/issues/33) 인계를 연결한다.

## S10 진행 기록 — 독립 검토 완료

- [x] S09 인계 SHA `780e623a5b46717f74e931952fff86e6bbb98b66`에서 시작했다. `FR-DOC-019`, `REL-DOC-009`, `DR-DOC-014`를 확인하고 SpecKiwi로 `REL-DOC-009 AC-1`에 private 게시 순서 증거를 반영했다.
- [x] [S10 실제 FS·SQLite RED/GREEN 및 결함 행렬](../analysis/2026-09-24-s10-revision-evidence.md): 같은 밀리초/clock rollback/동시 저장·수락, owner 재시작 자동 수렴, active 중 D, 취소·재시도, 페이지 크기 초과 keyset, 오래된 intent replay와 A→B→A, crash lock 복구를 확인했다. Focused S10 Node 46 assertions, S09 37, S08 53, S06 42가 통과했다.
- [x] 작성자가 아닌 독립 검토자가 원 요구사항·diff·실행 증거를 확인했다. [순서·데이터 검토](../analysis/2026-09-24-s10-order-review.json)와 [TDD·신뢰성 검토](../analysis/2026-09-24-s10-tdd-review.json)는 차단 결함 0건이다. 종료된 잠금 소유자의 PID 재사용 때 안전하게 차단되는 낮은 위험도는 [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43)의 시작 복구 검증에 명시했다.
- [x] #33 체크박스·완료 댓글·close 및 최종 SHA를 연결한다. 다음 작업은 [S11 #34](https://github.com/ice3x2/DocuLightViewer/issues/34)이다.

## S11 진행 기록 — 독립 검토 완료

- [x] S10 인계 SHA `2b918e6ad4bedf3f62f2802ca7151edcf962e948`에서 시작했다. 관련 요구사항 `FR-DOC-019`, `REL-DOC-009`와 활성 target의 Stability 차단 없음 확인.
- [x] [S11 실제 FS·SQLite RED/GREEN 및 독립 검토 보완](../analysis/2026-09-25-s11-revision-evidence.md): claim revision/hash, S08 root 게시 잠금 아래 최종 파일 재검증과 완료 CAS, 새 desired revision, 실패·취소·중단된 claim의 재시작 retry를 확인했다. 문서 외 `keyword_rebuild` job 불변 조건도 RED/GREEN으로 검증했다. S11 24, S10 46, S09 37, S08 53 assertions가 통과했다. S20 #43의 cross-controller owner exclusivity와 첫 복구 페이지의 START-ready 이전 실행은 별도 후속 범위다.
- [x] 작성자가 아닌 독립 검토자가 원 요구사항·diff·실행 증거를 확인했다. [최신 revision 검토](../analysis/2026-09-25-s11-latest-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s11-tdd-review.json)는 차단 결함 0건이다. S12가 parser/classifier/chunks/FTS derivative write를 소유하며 S11은 검증된 입력만 인계한다.
- [x] #34 완료 조건 검토 뒤 이슈 본문·댓글·close와 최종 SHA를 연결한다. 다음 작업은 [S12 #35](https://github.com/ice3x2/DocuLightViewer/issues/35)이다.

## S12 진행 기록 — 독립 검토 완료

- 시작 SHA `d421a49730d635b75cf58c3eda4bbdccfc28605e`; 격리 worktree `DocuLightViewer-r3`.
- [x] [S12 RED/GREEN 및 파생 색인 증거](../analysis/2026-09-25-s12-derivation-evidence.md): 문서별 ledger transaction, revision guard, keyword FTS replace, durable dirty retry, 원본 alias/사용자 metadata 보존을 확인했다.
- [x] 원 요구사항·diff·실행 증거에 대한 작성자 외 [데이터 정합성 검토](../analysis/2026-09-25-s12-data-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s12-tdd-review.json)를 마쳤다. 출발점의 캐시 호환성·메타데이터·revision 문제와 인라인 태그 파서 회귀를 고친 최종 해시에서 차단 결함 0건이다. S12 28 assertions, S11/S10/S09/S08/S06와 keyword·ledger 계약 검증이 통과했다.
- [x] #35 완료 판정, 체크박스·댓글·close, 최종 SHA 연결. 다음 작업 [S13 #36](https://github.com/ice3x2/DocuLightViewer/issues/36).

## S13 진행 기록 — 독립 검토 완료

- 시작 SHA `d7e4e9ea204916b7746b193a88d225bee9c11a32`, 격리 worktree `DocuLightViewer-r3`. 관련 요구사항 `DR-DOC-013`, `CON-DOC-006`, `FR-TREE-009`, `FR-DOC-025`, `FR-DOC-019`의 Stability 차단 없음.
- [x] [S13 실제 SQLite RED/GREEN](../analysis/2026-09-25-s13-link-evidence.md): target 추가 후 missing edge 미복구 assertion RED 뒤 durable target reconciliation과 active resolved-only 조회 구현. 독립 검토의 popular-target 무제한 transaction 및 ambiguous 승급 지적은 130-edge assertion RED 뒤 bounded cursor 처리로 개선했다. 첫 linked smart-search 조회 및 candidate identity 복원이 구형 DB schema를 변경하는 결함도 실제 SQLite RED 뒤 read-only connection으로 수정했다. S13 20 assertions, S12 28 assertions, Wave 2 ledger/smart-search 및 sidebar/link tree 검증 통과.
- [x] 작성자가 아닌 독립 검토자의 [그래프·데이터 검토](../analysis/2026-09-25-s13-graph-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s13-tdd-review.json)를 최종 소스 해시에서 마쳤다. 차단 결함 0건이며 첫 검색 읽기·301-edge 재시작 복구를 실제 SQLite로 확인했다.
- [x] #36 완료 판정, 이슈 체크박스·댓글·close, 최종 SHA 및 [S14 #37](https://github.com/ice3x2/DocuLightViewer/issues/37) 인계.

## S14 진행 기록 — 독립 검토 완료

- 시작 SHA `d4b4eaf41b1884bf1ab3f12ad632d6b5316ab8f5`, 격리 worktree `DocuLightViewer-r3`; 관련 요구사항 `FR-DOC-028`, `IR-MCP-018`, `FR-DOC-019`, `REL-DOC-009`, `SEC-DOC-003`의 Stability 차단 없음.
- [x] [S14 RED/GREEN 및 저장 증거](../analysis/2026-09-25-s14-mcp-save-evidence.md): 실제 assertion RED 뒤 S08 durable intent·atomic file publisher와 owner ACK를 `save_document`에 연결했다. 독립 검토의 같은 millisecond 중복 저장, junction root source identity, private provenance 중복 지적도 각각 assertion RED 뒤 수정했다. Focused S14 20 assertions, Wave 2 MCP, autosave, HTTP save parity, S08/S09/S10/S12/S13 회귀가 통과했다.
- [x] 작성자가 아닌 독립 검토자의 [공개 계약·보안 검토](../analysis/2026-09-25-s14-contract-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s14-tdd-review.json)를 소스 해시 `217cef8640c912c70a463d3eb258fa2c23138d94f2ecf9cf35b47048c9a10939`에서 마쳤다. 차단 결함 0건이다.
- [x] #37 완료 판정, 이슈 체크박스·댓글·close, 최종 SHA 및 [S15 #38](https://github.com/ice3x2/DocuLightViewer/issues/38) 인계.
- 현재 S14의 공개 `save_document` 경로만 owner를 사용한다. 다른 legacy producer의 owner 전환 및 full app session은 S15/S23/S26 후속 범위이며 이 작업의 완료로 주장하지 않는다.

## S15 진행 기록 — 독립 검토 완료

- 시작 SHA `81cfbda20ba53d87335a30ba93289d24c0739104`, 격리 worktree `DocuLightViewer-r3`. 관련 요구사항 `FR-DOC-019`, `FR-DOC-035`, `IR-MCP-018`, `IR-MCP-019`, `REL-DOC-009`, `SEC-DOC-003`의 Stability 차단 없음.
- [x] [S15 RED/GREEN 및 producer 호출표](../analysis/2026-09-25-s15-producer-evidence.md): MCP HTTP/source open·update, renderer 수동 저장 및 설정 저장소 내부 save-as/quick-save를 공용 durable publisher와 owner accept 경로에 연결했다. 실제 HTTP/renderer entrypoint와 real owner의 2회 update revision·job·SQLite hash를 검증했다. Owner 시작 실패 시 private intent 보존과 Windows 임시 파일 점유 retry도 assertion RED 뒤 수정했다. Node ABI 137 S15 25 assertions, S14 20 assertions와 MCP tool/HTTP parity·origin/registrar 회귀가 통과했다.
- [x] 작성자가 아닌 독립 검토자의 [producer·공개 계약 검토](../analysis/2026-09-25-s15-contract-review.json)와 [TDD·복구 검토](../analysis/2026-09-25-s15-tdd-review.json)를 소스 해시 `014cb0aa845bbb12f6e5cdbfcb3783f4b821d094c06d17ad7cc5a763911d65bc`에서 마쳤다. 현재 구현 부분은 커밋 가능하되 #38 전체는 미완료라는 공통 판정이다.
- [x] [S16 #39](https://github.com/ice3x2/DocuLightViewer/issues/39)에서 외부 save-as의 선택 파일을 유지하고 설정 저장소 복사본·원본 alias를 owner로 접수한 뒤 외부 legacy markDirty를 제거했다.
- [x] S16 checkpoint `62dc1d289735c4481cf5ad47fba8273bac147bb5`에서 [S15 완료 증거 추가](../analysis/2026-09-25-s15-producer-evidence.md): 실제 source와 generated bundle stdio 도구가 main `handleIpcMessage` 분기를 호출하고, renderer 수동 저장의 등록된 IPC callback과 owner 실패 후 windowId/title/file/intent 보존을 검증했다. 새 source dispatcher assertion RED는 동작 수정이 아니라 실제 진입점 증거를 추가한 coverage RED로 기록했다.
- [x] #38의 private `accept_save` 입력을 정확히 7필드로 정렬했다. S14/S15 assertion RED 뒤 producer의 raw root 인자를 제거하고 owner가 설정된 ingress/publication root로 검증한다. S02의 `contentBytes`는 S08 파일 publisher 전용 ephemeral 입력이며 owner command에는 포함하지 않는다. S09 test-only startup replay 제어를 포함한 S09/S10/S12/S14/S15/S16 회귀와 MCP parity 통과. 최종 검토 해시 `2999c73c686c7b28171d46d8346011c0b6ddf671ca047aaee2517e1f866c4131`.
- [x] 추가 증거를 [공개 계약 검토](../analysis/2026-09-25-s15-contract-review.json)와 [TDD·복구 검토](../analysis/2026-09-25-s15-tdd-review.json)에서 최종 소스 해시 `2999c73c686c7b28171d46d8346011c0b6ddf671ca047aaee2517e1f866c4131`로 재검토했다. S15 49, S14 23, S16 24, S09 37, S10 46, S12 28 assertions 및 MCP/HTTP/Wave2 parity가 통과했고 차단 결함 0건이다. #38을 먼저 닫고 #39를 이어 닫는다.

## S16 진행 기록 — provenance·외부 save-as 구현, 독립 검토 완료

- [x] [S16 RED/GREEN 증거](../analysis/2026-09-25-s16-origin-evidence.md): `FR-DOC-035`, `DR-DOC-014`, `FR-DOC-036`, `FR-DOC-019`, `REL-DOC-009`, `SEC-DOC-003` 범위에서 실제 외부 원본의 lexical/canonical alias를 body-free intent와 owner transaction에 연결했다. Renderer 외부 save-as/quick-save는 선택한 파일과 응답을 유지하고 설정 저장소 복사본을 owner로 접수한다. 외부 legacy markDirty 호출을 제거했다.
- [x] `s16` RED exit 1, GREEN 23 assertions; S08 53, S14 20, S15 26, opened registrar·indexed origin·MCP tool/HTTP parity 통과. 기존 `.markdown` 복사본의 locator/ID 재사용, 변조된 사본 보호, 게시 전 실패의 private retry marker를 test-first로 보강했다. 시작 SHA `0bc5d11b404d0499ebd4e0daefc244c1f18dfada`, 소스 해시 `569dffbfd666b8b73b57cfa2670f75883e9c21dd652111ec30a5c60fa756f9f5`.
- [x] [원본 provenance 검토](../analysis/2026-09-25-s16-provenance-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s16-tdd-review.json)는 최종 소스 해시에서 차단 결함 0건이다. 이전 `.markdown` copy/alias를 재열기·수정할 때 같은 문서 ID와 locator가 유지되고, 변조된 사본을 덮어쓰지 않는 것을 실제 SQLite로 확인했다.
- [x] #38의 실제 stdio/manual IPC/window failure 증거를 완료했다. [S16 최종 provenance 교차검토](../analysis/2026-09-25-s16-final-review.json)와 [최종 TDD 교차검토](../analysis/2026-09-25-s16-final-tdd-review.json)는 7필드 owner 계약 변경 후에도 원본 alias·복사본·기존 `.markdown` ID·읽기 전용 조회가 유지됨을 확인했다. #38을 먼저 닫은 다음 #39를 닫는다.
## S20 진행 기록 — startup recovery

- 시작 SHA `12d176cbcd84e56aba820a13fbec43ac9dedbd26`; 격리 worktree `DocuLightViewer-r3`. 요구사항 `FR-DOC-019`, `REL-DOC-009`, `IR-APP-013`, `IR-APP-010`의 Stability 차단 없음.
- [x] [S20 RED/GREEN 및 실제 SQLite pending/legacy 각 3,101개 증거](../analysis/2026-09-25-s20-startup-evidence.md): sidecar 직렬화와 PID+start identity로 dead-owner/publication race를 막고, START-ready 후 32-job recovery/migration page를 실행한다. query/cancel 및 migration 중 deferred save/replay, streaming private ingress를 확인했다. S20 21 assertions, S09/S10/S11/S17/S19 및 lifecycle/startup-memory/search-index-worker 회귀 통과.
- [x] [owner·잠금 독립 검토](../analysis/2026-09-25-s20-owner-review.json)와 [TDD·시작 복구 검토](../analysis/2026-09-25-s20-tdd-review.json)는 소스 해시 `36ca3047485ec1790a914d227e0b764d804f6d77b4dfb51384885481a9877501`의 잠금·페이지 복구 변경을 안전한 부분 커밋으로 판정했다.
- [ ] #43 전체 완료 판정은 보류한다. Product main의 legacy `SearchEngine.initialize()`가 main-thread SQLite reconciliation을 예약한다. [S23 #46](https://github.com/ice3x2/DocuLightViewer/issues/46)·[S26 #49](https://github.com/ice3x2/DocuLightViewer/issues/49) owner cutover에서 제품 cold route의 DB-free 동작과 기존 committed keyword index checksum의 실패·취소 뒤 보존, 중단된 sidecar gate의 안전한 복구 안내를 검증한 뒤 #43을 닫는다. 완료 이슈 수에는 포함하지 않는다.

## S21 진행 기록 — Settings·viewer 상태 UX

- 시작 SHA `8a098e3d9fdfa22abff84b67e157e05130ec3a8c`, 격리 worktree `DocuLightViewer-r3`. `IR-APP-013`, `IR-APP-010`, `FR-APP-006`, `FR-APP-007`, `FR-DOC-019`, `REL-DOC-009`에 Stability 차단 없음.
- [x] [S21 Electron RED/GREEN 및 4개 locale 증거](../analysis/2026-09-25-s21-status-ux-evidence.md): Settings·viewer 실제 renderer/preload/private IPC, 상태·10% 진행률·heartbeat ARIA 중복 억제, 저장 성공과 색인 지연/접수 구분을 확인했다. 독립 검토가 찾은 canonical cancel/retry 오배선과 Settings capacity 저장 성공 오표시를 assertion RED 뒤 고쳤고 viewer 기존 저장 경로 표시도 복원했다. 후속 검토의 owner 상태가 legacy rebuild 취소·실패 재시도 및 상태 안내를 가리는 회귀, 전체 rebuild 중 Cancel 허용 회귀도 실제 혼합 payload와 SearchEngine 메서드 기반 assertion RED 뒤 고쳤다. S21 Electron 23 assertions, 30-state registry/locale parity, Settings status poller/coalescer, MCP 계약, S18 19 및 S20 21 assertions 통과. 검토용 sourceHash `324e8edff76aae5c0a25182f62da7f43bdaa1f7cdf5059d9ca5fd4836788078b`.
- [x] [UI·i18n·접근성 검토](../analysis/2026-09-25-s21-ux-review.json)와 [TDD·호환 검토](../analysis/2026-09-25-s21-tdd-review.json)는 최종 소스 해시 `324e8edff76aae5c0a25182f62da7f43bdaa1f7cdf5059d9ca5fd4836788078b`의 변경을 안전한 부분 커밋으로 판정했다.
- [ ] #44 전체 완료 판정은 보류한다. [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43)의 product main DB-free status/focus/close와 실제 owner action/capacity 동작, [S24 #47](https://github.com/ice3x2/DocuLightViewer/issues/47)의 embedding registration UI 제거, [S23 #46](https://github.com/ice3x2/DocuLightViewer/issues/46)·[S26 #49](https://github.com/ice3x2/DocuLightViewer/issues/49)의 제품 경로 검증 전에는 이슈를 닫거나 완료율에 넣지 않는다.
