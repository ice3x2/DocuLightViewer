# Phase 1 검증 문서

## 검증 항목

- [ ] `link-parser.js` 에서 `readdirSync`/`readFileSync` 호출 0건 (step27 Phase 2로 기 확보)
- [ ] `buildDirectoryTree` 시그니처에 `options` 파라미터 추가됨
- [ ] `BATCH_SIZE = 50` 상수 사용
- [ ] `Promise.all` 기반 파일 병렬 readFile 동작
- [ ] `onBatch(nodes)` 콜백이 각 배치마다 호출됨 (파일 수 / 50 만큼)
- [ ] AbortSignal aborted 시 `AbortError` throw
- [ ] `onBatch` 미지정 호출이 step27 Phase 2 완료 시점 출력과 100% 동일

## 증거 수집 명령

```bash
# 동기 I/O 잔존 확인
grep -n "readdirSync\|readFileSync" src/main/link-parser.js

# Phase 1 smoke test
node test/test-link-tree.js
```

## 합격 기준

- 동기 I/O 호출 0건
- smoke test의 `onBatch` 카운트 로그가 기대 배치 수와 일치
- 기존 트리 구조 회귀 없음
