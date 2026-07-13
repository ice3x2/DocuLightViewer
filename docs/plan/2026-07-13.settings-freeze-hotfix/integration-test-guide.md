# Integration Test Guide

## 1. Safety

- 설치판 `%APPDATA%` DB를 열거나 쓰지 않는다.
- temp directory를 사용하는 contract/benchmark만 실행한다.
- 실행 중인 Electron/Node process를 광범위하게 종료하지 않는다.

## 2. Focused Sequence

```powershell
node test/test-indexing-status-performance-contract.js
node test/test-settings-indexing-contract.js
node test/test-settings-status-poller-contract.js
node test/test-wave2-embedding-settings-contract.js
node test/test-search-index-worker-contract.js
node test/test-status-coalescer-contract.js
node test/test-startup-index-recovery-memory-contract.js
node test/test-search-index-worker-benchmark-contract.js
```

## 3. Regression Sequence

```powershell
npm run test:release-regression
```

`test:release-regression`은 Wave 1, Wave 2, worker contract, worker benchmark를 순서대로 실행한다. `test:wave1`에 Settings static contract가 포함되고 `test:wave2`에는 신규 aggregate/poller/coalescer/recovery/release-workflow 실행형 contract를 직접 편입한다. focused sequence는 실패 위치와 RED/GREEN evidence를 명확히 하기 위해 별도로 실행한다.

## 4. Performance Evidence

신규 performance contract는 다음을 출력해야 한다.

- synthetic terminal/unrelated/active job count.
- aggregate elapsed time.
- pending/current/total 결과.
- query index existence.
- legacy whole-row API 미호출 증거.
- `EXPLAIN QUERY PLAN` index 사용과 bounded result JSON size.
- embedding IPC-equivalent path의 반복 latency 및 heap/RSS delta.

worker benchmark는 REL-DOC-007 기존 p95/p99/max/main heartbeat budget을 계속 검증한다.

## 5. Optional Packaged Smoke

runtime 코드가 package/native boundary를 바꾸지 않으므로 CI regression gate에는 full package build를 중복하지 않는다. 이번 검증에서는 Windows x64 portable을 생성하고 native repair 후 `npm run smoke:package`를 통과시켰다. 로컬 Windows ARM64 전체 build는 설치된 Visual Studio에 v143 ARM64 toolset이 없어 optional `hnswlib-node` 재빌드에서 중단되었으며, x64 artifact와 Node ABI는 각각 `npm run repair:package:native`, `npm run rebuild:native:node`로 복원·검증했다.

## 6. Manual Reproduction Check

자동 검증 후 선택적으로 별도 temp userData/profile fixture script로 앱을 실행해 다음을 확인한다. fixture command와 cleanup은 구현 시 이 문서에 실제 경로로 기록하며, 설치 `%APPDATA%`를 사용하지 않는다.

1. 3,600개 이상 synthetic queued job 상태에서 Settings가 즉시 열린다.
2. 작업 중 status text가 약 500 ms 간격으로 갱신된다.
3. 창 이동/닫기, tray interaction이 멈추지 않는다.
4. Settings 종료 후 timer/IPC error가 발생하지 않는다.
