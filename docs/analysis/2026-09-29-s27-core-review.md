# S27 핵심 통합 검토 — 독립 판정 전 자료

이슈: #50 · 현재 통합 커밋: `190ee23fb6a0f5084e13ebe4d8ae7ad021d008c2` · 작업 파일 sourceHash: `bdbc098d1d4785584e4e8bf4a0f73e1678014fef7373f10d08cad15ce6b86719` · 활성 target: `0.11.0-w2` · work mode: `wait`.

공개 기준 `12d312cea07d530c7aa28ffb849575ea3d94b459` 대비 [변경 파일 314개](./2026-09-29-s27-baseline-changed-files.txt), [diff stat](./2026-09-29-s27-baseline-diff-stat.txt)은 102,960 insertions/2,883 deletions이다. `git diff --check <기준> <현재>`는 exit 0이었다. 원래 사용자 작업트리는 건드리지 않았고, 이 자료는 격리 통합 브랜치의 공개 기준 diff만 다룬다. 설계의 180분은 핵심 경로 예산이지 전체 패키지·릴리스 완료 약속이 아니다.

| 요구사항/AC | 구현·실행 근거 | 현재 판정 경계 |
|---|---|---|
| `FR-DOC-019` AC-2/3/11 | `source-ledger-store.js`의 desired revision/accepted intent, `index-ingress-store.js`의 intent-before-file, `desired-job-processor.js`의 final revalidation/CAS; [현재 S25/S26](./2026-09-29-s27-current-core-runs.json)와 S10/S11/S17/S19 기록 | 저장된 파일과 intent/revision의 최신 승자·재시도 부분만 입증한다. #55에서 발견한 활성 파생 작업 중 다른 문서 save의 `publication_busy`는 별도 제품 결함으로 열려 있다. |
| `FR-DOC-019` AC-6/10 | [통합 S23d 원시 감사](./2026-09-29-s23d-ecfbbd96baaf-1790626302867.json) 및 [동일 해시 회귀](./2026-09-29-s23d-integrated-regressions-ecfbbd96.json); owner writable 14/main·short 0, 실패·취소 세대 보존 | 제품 writer 감사 해시 `ecfbbd96...`는 현재와 다르다. #63 통합 이후 이 코드 경로의 Git blob diff는 없지만 전체 요구사항 Status는 `in_progress`다. |
| `FR-DOC-019` AC-7 | S17/S19 migration/recovery 독자, S20 paged startup, [현재 S25/S26](./2026-09-29-s27-current-core-runs.json) | 구형 journal과 중단 job의 경로·시작 복구 부분을 입증한다. SRS 전체 verified 승급은 하지 않는다. |
| `FR-DOC-033` AC-1~10/11 | 기존 SRS의 AC-1~10은 체크됨. [현재 S26](./2026-09-29-s27-current-core-runs.json), [사전 등록 8회 결과](./2026-09-29-s26r-eight-run-result.json)에서 각 import 2/누락 1, 완료 파일, 재시작 latest/revision 2/alias 2를 확인했다. | AC-11은 SRS에서 아직 unchecked. 8/8 통과는 간헐 원인 제거의 증명이 아니다. `missing>=1` 하니스와 정확히 1을 요구한 manifest의 차이는 관측 결과가 모두 1이라 이번 시리즈를 무효화하지 않지만 MEDIUM 잔존 위험이다. |
| `FR-DOC-035` AC-4/6/7/13 | S23c contained owner adoption, S25 원본/저장소 분리·1:N alias, S26 실제 원본 열기/재시작, S29 다섯 태그 forward-open | 요구사항은 `implemented/evolving`; 다른 AC와 제품 설정/보안 전체를 이 표로 검증했다고 주장하지 않는다. |
| `DR-DOC-014` AC-1/2/3/8/9 | S25 source/store 별도 경로와 alias, S29 tag 원장 migration, S23d sole-writer 원장, 현재 S26 alias/restart | 요구사항은 `in_progress/evolving`; unchecked AC에 대한 SRS 검증 승급은 별도다. Raw 원본 경로는 외부 응답에 넣지 않는다. |
| `IR-APP-013` AC-1/13 부분 | S21 Settings·viewer 작업과 S23d DB-free status/cancel, 현재 S26 제품 handler | 요구사항은 `planned/evolving`; AC-4/6/10/11/13/14/15/16의 실제 용량·네 언어·30상태·접근성·패키지 응답성 전체는 열린 #44/#65의 별도 UX/릴리스 게이트다. |

[#63의 독립 수용 기록](https://github.com/ice3x2/DocuLightViewer/issues/50#issuecomment-5878632103)은 연결 문서 import의 간헐 결함을 재현하지 못한 **제한적 감사**를 받아들였다. 작성 브랜치의 frozen sourceHash `42e4e6187a28de0a2d5cbf970a83036b189a2184cf0fc52a8a84d135842ec571`와 현재 Windows checkout의 `bdbc098d...`는 줄바꿈 때문에 다르다. 제품·테스트 Git blob은 frozen product commit `65a6b38cd37a4aa259902a5e1bc17929ce87ec84`와 현재 사이에 변경이 없다. 8회 중 실패 0건의 one-sided 95% 상한 약 31.2%는 IID 가정에만 해당하고 IID가 입증되지 않았다. 원인은 계속 미상이다.

[현재 S25/S26 실행 기록](./2026-09-29-s27-current-core-runs.json)은 각각 exit 0, PASS 16/49, 현재 sourceHash `bdbc098d...`, 시작·종료 시각·테스트 Git blob·원시 개인 로그 SHA-256·필수 표식을 보존한다. 통합 브랜치에서 원본 증거 파일을 수정하는 S26 테스트의 역사적 sample 파일은 실행 후 HEAD 내용으로 복원했다. 개인 원시 로그에는 호스트 경로가 포함될 수 있으므로 저장소에는 표식과 해시만 올린다.

| 기준 커밋 `749b805`(2026-09-24 20:01:21 KST)에서의 경과 | Git 이력으로 확인되는 직전 완료 커밋·시각 | 당시 다음 작업 |
|---|---|---|
| 55분, 20:56:21 | S03 하네스 `0bfb5d8` 20:53:58 | S04 #27 원본 alias migration |
| 100분, 21:41:21 | S05 읽기 전용 원본 열기 `1377cfe` 21:19:26 | S06 #29 장기 owner lifecycle |
| 180분, 23:01:21 | S08 영속 intent·원자 게시 `11be245` 22:51:44 | S09 #32 원장 수락 |

위 표는 **사후 Git 커밋 시각 복원**이며 당시 실시간 체크포인트 기록이 있었다고 주장하지 않는다. 핵심 경로 180분 내 전체 구현은 완료되지 않았다. #50의 다음 행동은 독립 검토자가 이 AC·D1 매핑과 현재 S25/S26 결과를 확인하고 CRITICAL/HIGH를 판정하는 것이다. #44의 용량/UX, #55 PG-04, #56 PG-09, #21 실제 세 플랫폼 CI와 릴리스 승인은 열린 상태로 인계한다.
