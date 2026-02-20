# Phase 1 검증: i18n 인프라 구축

## 완료 체크리스트

- [ ] `src/locales/en.json` 존재하며 모든 i18n 키 포함
- [ ] `src/locales/ko.json` 존재하며 동일 키에 한국어 값
- [ ] `src/main/strings.js` 모듈 존재
- [ ] `init()` 호출 시 시스템 locale 감지
- [ ] `t(key)` 호출 시 올바른 문자열 반환
- [ ] `t(key, vars)` 호출 시 변수 치환 동작
- [ ] `getAll()` 호출 시 전체 strings 객체 반환
- [ ] `ipcMain.handle('get-strings')` 등록됨
- [ ] `preload.js`에 `getStrings` bridge 추가됨
- [ ] 앱 시작 시 크래시 없음

## 테스트 결과

| TC | 설명 | 결과 | 비고 |
|----|------|------|------|
| TC-1.1 | 한국어 시스템 locale 감지 | | |
| TC-1.2 | 영어 시스템 locale 감지 | | |
| TC-1.3 | 미지원 언어 폴백 | | |
| TC-1.4 | 손상된 locale 파일 폴백 | | |
| TC-1.5 | 변수 치환 동작 | | |

## 키 일관성 검증

- [ ] en.json과 ko.json의 키 목록이 동일
- [ ] 누락된 키 없음
- [ ] 빈 값("") 없음

## 회귀 테스트

- [ ] `npm start` 정상 실행
- [ ] 기존 기능 (창 열기, 설정, 트레이) 변화 없음
- [ ] Playwright E2E 테스트 통과 (해당 시)
