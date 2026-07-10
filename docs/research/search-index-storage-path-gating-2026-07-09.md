# 검색 인덱스 저장 경로 미설정 상태 게이트 조사

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Target | 0.11.0-w2 |
| Related Requirements | IR-APP-010, IR-APP-011, FR-APP-012, FR-DOC-001, FR-DOC-018, FR-DOC-019, FR-DOC-028, FR-DOC-035, REL-DOC-008 |
| Research Method | 3 sub-agent static investigation + main-agent source trace |

## 1. 사용자 증상

1. Settings에서 문서 저장 경로(`mcpAutoSavePath`)가 비어 있어도 `검색 인덱스 관리` 버튼이 활성화된다.
2. 같은 상태에서 `자동 저장` 체크박스도 활성화된다.
3. 임베딩 모델을 추가한 뒤 검색 인덱스 관리 화면에 들어가면 `인덱싱됨: 0`, `인덱스 상태: uninitialized`가 표시된다.
4. 이 상태에서 `검색 인덱스 다시 만들기`를 누르면 상태가 `degraded`로 바뀌고 `mcpAutoSavePath not configured` 오류가 표시된다.

## 2. 조사 결과 요약

세 서브에이전트 조사 결과는 같은 결론으로 수렴했다.

- `src/renderer/settings.js`의 `updateAutoSavePathState()`는 저장 경로 존재 여부를 계산하지만 `registerOpenedMarkdown` 옵션만 비활성화한다.
- `mcpAutoSave-checkbox`와 `indexing-manage-btn`은 저장 경로 미설정 상태를 반영하지 않는다.
- `showIndexingManagementView()`는 저장 경로 미설정 상태에서도 관리 화면으로 진입한다.
- `indexing:start-rebuild` IPC는 저장 경로 확인 없이 `searchEngine.startRebuild()`를 호출한다.
- `SearchEngine.startRebuild()`는 worker enqueue 전에 source root를 검사하지 않는다.
- worker 내부 `SearchEngine.rebuild()`에서 뒤늦게 `mcpAutoSavePath not configured` 예외가 발생하고, public status에서 `failed`가 `degraded`로 매핑된다.

## 3. 원인

### 3.1 UI 게이트 누락

현재 경로 기반 UI 게이트는 opened Markdown 등록 옵션에만 적용되어 있다. 따라서 문서 저장소가 없는데도 사용자가 인덱스 관리 화면과 rebuild 액션에 접근할 수 있다.

수정 대상:

- `src/renderer/settings.js`
  - `updateAutoSavePathState()`
  - `showIndexingManagementView()`
  - `collectFormValues()`
  - `renderIndexingStatus()`
- `src/renderer/settings.html`
  - 초기 disabled 상태와 안내 연결
- `src/renderer/settings.css`
  - disabled 버튼 시각 상태

### 3.2 backend 시작점 방어 누락

UI를 막아도 IPC나 내부 호출은 `searchEngine.startRebuild()`에 직접 도달할 수 있다. 현재 이 시작점은 source root가 비어 있어도 worker job을 만든다. 이 job은 의미 있는 rebuild가 아니며 `REL-DOC-008`의 interrupted rebuild recovery 의미도 흐린다.

수정 대상:

- `src/main/search-engine.js`
  - `startRebuild()` 초입에서 source root 미설정이면 worker enqueue 없이 non-start 결과 반환
- `src/main/search-index-worker-controller.js`
  - 방어적으로 rebuild job config의 `sourceRoot`가 없으면 worker와 ledger job을 만들지 않음
- `src/main/index.js`
  - Settings status/action IPC에 `sourceRootConfigured` 또는 `canRebuild` 진단을 포함

### 3.3 임베딩 모델 상태와 저장소 상태 혼합

임베딩 모델 연결 성공은 문서 저장소 경로와 독립적인 설정 성공이다. 저장소 경로가 없으면 semantic reindex는 skipped/idle이어야 하지만, 모델 상태 자체는 `connected`로 유지되어야 한다.

수정 원칙:

- 임베딩 모델 저장 성공은 `FR-APP-012`에 따라 `connected`를 유지한다.
- 저장소 경로가 없으면 semantic reindex는 `source-root-unconfigured`로 skipped 처리한다.
- 검색 인덱스 관리/rebuild는 저장소 경로가 설정될 때까지 진입 또는 시작되지 않는다.

## 4. 기대 동작

### 4.1 저장 경로가 없는 경우

- `자동 저장` 체크박스는 disabled이고 unchecked이다.
- `검색 인덱스 관리` 버튼은 disabled이다.
- 검색 인덱스 관리 화면으로 진입하지 않는다.
- backend `startRebuild()`는 worker job을 만들지 않고 `{ started:false, scheduled:false, reason:'source-root-unconfigured' }` 계열 결과를 반환한다.
- 상태는 사용자가 조치할 수 있는 저장소 미설정 상태를 나타내며, rebuild 실패로 인한 `degraded`나 `mcpAutoSavePath not configured`를 표시하지 않는다.

### 4.2 저장 경로가 지정된 경우

- `자동 저장` 체크박스는 enabled 상태가 되며, checked/unchecked 사용자 선택은 보존된다.
- `검색 인덱스 관리` 버튼은 현재 입력값이 저장된 사용 가능한 문서 저장소 경로와 일치할 때 enabled 상태가 된다.
- explicit Settings rebuild는 기존 `REL-DOC-008` 동작을 유지한다.
- rebuild 중 indexed count는 0에서 시작하고 pending/current file/progress가 갱신된다.

### 4.3 임베딩 모델만 연결된 경우

- 모델 상태는 `connected`로 유지된다.
- 문서 저장소 경로가 없으면 semantic indexing은 `idle` 또는 skipped reason `source-root-unconfigured`로 남는다.
- 검색 인덱스 rebuild는 저장소 경로가 생기기 전까지 시작되지 않는다.

## 5. TDD 계획

1. `test/test-settings-indexing-contract.js`
   - 저장 경로가 없으면 `mcpAutoSaveCheckbox.disabled`, unchecked, `indexingManageBtn.disabled` 계약을 먼저 실패시키기.
   - 경로가 생기면 자동 저장 체크박스가 enabled 되고 기존 사용자 checked 상태는 강제로 바뀌지 않는 계약을 먼저 실패시키기.
   - `showIndexingManagementView()`가 저장된 문서 저장소 경로를 guard로 사용하는 정적 계약 추가.

2. `test/test-search-engine-lifecycle.js`
   - `mcpAutoSavePath=''`인 `SearchEngine.startRebuild()`가 worker를 시작하지 않고 degraded/error 상태를 만들지 않는 회귀 테스트 추가.

3. `test/test-search-index-worker-contract.js`
   - source root 없는 rebuild가 worker/controller job을 만들지 않는 방어 계약 추가.

4. 필요 시 `test/test-wave2-embedding-settings-contract.js`
   - 저장소 경로 없이 임베딩 모델 연결 성공 시 모델 `connected`와 semantic indexing skipped 상태가 분리되는 계약 보강.

## 6. 구현 전략

1. UI는 저장 경로 입력값을 단일 source로 삼아 `hasDocumentStorePath()` 또는 동등한 helper를 만든다.
2. `updateAutoSavePathState()`는 다음을 함께 갱신한다.
   - `mcpAutoSaveCheckbox.disabled`
   - `mcpAutoSaveCheckbox.checked`는 경로가 없을 때만 false로 정리하고, 경로가 있을 때는 강제로 켜지 않는다.
   - `indexingManageBtn.disabled`
   - `registerOpenedMarkdownCheckbox.disabled`
3. `collectFormValues()`는 저장 경로가 없으면 `mcpAutoSave=false`, 저장 경로가 있으면 체크박스의 사용자 선택값을 저장한다.
4. `showIndexingManagementView()`는 현재 입력값이 저장된 문서 저장소 경로와 일치하지 않으면 return한다.
5. backend는 `SearchEngine.startRebuild()`와 worker controller 시작점에서 source root 미설정 또는 사용할 수 없는 상태를 non-start 결과로 반환한다.
6. status payload에는 UI가 저장된 설정 기준으로 해석할 수 있도록 `sourceRootConfigured`와 `canRebuild`를 포함한다.

## 7. 서브에이전트별 기여

- Carver: Settings renderer/UI에서 경로 기반 disabled 처리 누락을 확인했다.
- Turing: Settings IPC, 임베딩 등록, 저장소 미설정 상태의 backend 누수 경로를 확인했다.
- Dewey: SearchEngine/worker rebuild 시작점에서 source root guard가 없어 failed/degraded job이 생기는 경로를 재현하고 분석했다.

## 8. 결론

이 문제는 단일 오류가 아니라 UI gate와 backend guard가 동시에 빠진 상태다. 올바른 해결은 저장 경로가 없을 때 사용자에게 rebuild 진입 자체를 막고, IPC나 내부 호출이 우회하더라도 worker job을 만들지 않도록 시작점에서 방어하는 것이다. 임베딩 모델 연결 상태는 문서 저장소 설정 상태와 분리해 유지해야 한다.
