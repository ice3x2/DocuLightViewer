# DocuLight Step 8.1: Config Hot Reload — 재시작(백업/복원) 기반 플랜

작성일: 2025-10-25

## 개요

이 문서는 `config.json5` 변경 시 프로세스 내에서 안전하게 서버를 중지(stop)하고 다시 시작(start)하는 흐름을 상세히 설계합니다. 핵심 아이디어는 "start 성공 시 설정을 백업하고, watcher에 의한 설정 변경에서 재시작이 실패하면 백업을 복원하여 복구하는" 패턴입니다.

## 목표

- `app.js`에 `start()`, `stop()`, `restart()` 공개 API를 추가
- 최초 정상 시작 시 기존 백업 제거
- `start()`가 성공하면 현재 설정을 백업(`config.json5.bak`)
- watcher가 설정 변경을 감지하면 stop→start 흐름을 시도
- 재시작 실패 시 백업으로 복원하고 재시도, 복원 후에도 실패하면 운영자에 알림
- 포트/SSL 변경처럼 즉시 적용 불가능한 항목은 기본적으로 자동 재시작하지 않도록 옵션화

## 설계 요약

- start/stop/restart API 계약
- 백업/복원 전략(원자적 파일 교체, tmp 파일 사용)
- watcher와 재시작 코디네이터의 상호작용
- 동시성/락, 타임아웃, 실패 정책
- 변경 가능한 설정 vs 재시작 필요 설정 구분

## API 계약

- start(options?: { forceConfigPath?: string }) : Promise<{ success: boolean, error?: string }>
  - 동작: `loadConfig()` 호출 → 앱/로거 초기화 → HTTP/HTTPS 서버 바인딩
  - 성공 시: 현재 `config.json5`를 백업(원자 복사) → `app.emit('server:started', { config })`
  - 실패 시: 에러 반환(또는 reject)

- stop(timeoutMs = 30000) : Promise<{ success: boolean, error?: string }>
  - 동작: server.close(), 타임아웃 후 강제 종료 실패 처리
  - 성공 시: `app.emit('server:stopped', { reason })`

- restart() : Promise<{ success: boolean, error?: string }>
  - 동작: 내부적으로 stop() 후 start(); 재시도/복원 로직은 코디네이터가 담당

이벤트(emit):
- `server:started`, `server:stopped`, `server:restart:failed` (payload에 attemptedConfig, restored 플래그, error 포함)

## 백업/복원 전략

- 기본 백업 파일명: `config.json5.bak` (최신 백업만 유지)
- 원자적 교체 패턴:
  1. 백업 생성: `fs.copyFileSync(configPath, backupPath)` (또는 tmp후 rename)
  2. 복원: `fs.copyFileSync(backupPath, configPath)` (또는 tmp+rename)
  3. 윈도우 환경의 특수성: 가능하면 tmp 파일에 쓰고 `fs.renameSync`로 교체
- 최초 start 시 기존 `config.json5.bak`가 있으면 삭제(요청사항)

## 재시작/롤백 시퀀스

1. watcher가 변경을 디바운스(예: 1s) 후 `coordinator.restartFromWatcher()` 호출
2. coordinator가 새 설정을 `loadConfig()`로 시도(검증 포함)
3. 변경사항 중 재시작 필요 항목(port/ssl 등)이 있는지 판단
   - 만약 재시작 필요 항목만 있고 자동 재시작이 비활성화이면 로그만 남기고 종료
4. 재시작 가능 판단 시:
   - 재시작 락(restartLock)을 얻음
   - await stop(timeout)
   - await start()
   - 만약 start() 성공 → backup new config
   - 실패 시 → 로그, 복원(backup -> config), await start() (단 1회만)
   - 복원 후 start 성공이면 restored=true 이벤트 발행
   - 복원 후에도 실패하면 restored=false 이벤트 발행, 자동 추가 재시도 없음

## 변경 가능 항목 vs 재시작 필요 항목

- 런타임 반영 가능(자동 적용 권장): `ui.*`, `excludes`, `maxUploadMB`, `logLevel`, 일부 `apiKey`(주의)
- 재시작 필요(기본 자동 재시작 금지): `port`, `ssl.enabled`, `ssl.certPath`, `ssl.keyPath`

## 동시성·안전장치

- restartLock: 재시작 중복 방지(Promise 기반)
- debounce(1s) + 파일 해시(stat/mtime+size 또는 내용 해시) 비교하여 실제 변화만 처리
- stop()의 타임아웃(기본 30s)
- 자동 복원은 1회만 수행

## 실패 정책

- start 실패 시:
  - 에러 로그 기록 및 반환
  - watcher 주도 재시작에서 실패하면 백업 복원 시도 1회
  - 복원 후에도 실패하면 추가 자동 시도 없음(수동 개입 필요)

## 파일/모듈 변경 목록(계획)

- 신규 파일:
  - `src/utils/config-watcher.js` (watcher가 이미 존재하면 확장)
  - `src/utils/backup-utils.js` (원자적 백업/복원 유틸, 선택적)
- 수정 파일:
  - `src/app.js` (start/stop/restart 공개 API 추가, watcher 연동, 프로세스 종료 시 watcher 정리)
  - `src/utils/config-loader.js` (`process.exit` 사용 제거 → throw로 변경)
  - `src/middleware/ip-whitelist.js` 등: 필요 시 런타임 갱신을 반영하도록 리팩터링 권장

## 테스트 시나리오

- 정상 흐름: start 성공 → backup 생성 → watcher 변경 감지 → 자동 restart 성공 → 새 backup
- 잘못된 설정(파싱 에러): watcher 트리거 → start 실패 → 복원 → 복원 후 start 성공
- 잘못된 설정(존재하지 않는 docsRoot): 위와 동일
- 포트 변경: 재시작 필요 로그만 남기고 자동 재시작 금지(옵션으로 동작 가능)
- 동시 변경: 여러 파일 저장 → debounce로 단일 재시작

## 구현 단계(권장 순서, 각 단계 소요 시간 추정)

1. `config-loader.js` 안전성 수정 — `process.exit` 제거 및 예외 throw 정리 (0.25h)
2. `app.js`에 `start/stop/restart` 스켈레톤 구현(서버 변수 관리, graceful shutdown, 이벤트 발행) (1.0h)
3. `backup-utils.js`(또는 스몰 유틸) 추가 및 최초 start에서 기존 백업 삭제 로직 구현 (0.5h)
4. `config-watcher.js`와 재시작 코디네이터 연동(데바운스, 해시 비교, restart 호출) (1.0h)
5. 오류 시 복원 로직 구현(복원 후 재시작 1회) 및 로그/이벤트 정리 (0.5h)
6. 미들웨어/라우터의 런타임 반영 검토 및 최소한의 리팩터링(예: `createIpWhitelist`) (0.5~1.0h)
7. 테스트 케이스 및 수동 검증, 문서 업데이트 (0.5~1.0h)

총계: 약 3.25 ~ 5.25 시간(리팩터링 범위에 따라 변동)

## 운영 권고

- 프로덕션에서는 자동 재시작을 기본으로 두지 말고 관리자 승인 또는 컨테이너 재배포를 권장
- 백업 파일 권한 정책 및 주기적 정리 필요
- 민감정보(API 키 등)는 로그와 백업에서 마스킹/암호화 고려

## 다음 단계(제가 바로 할 작업)

1. 요청하시면 우선 `config-loader.js`의 `process.exit` 제거와 `app.js`에 start/stop 스켈레톤을 추가하겠습니다(작은 변경으로 안전성 즉시 개선).
2. 그 후 `backup-utils.js`와 `config-watcher` 연동을 진행하겠습니다.

---

문의: 바로 코드 적용을 원하시면 어떤 단계(1, 2, 전체)를 먼저 진행할지 알려주세요.
