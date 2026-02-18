## Step 8.2: MCP Tools 확장 — 상세 구현 계획

작성일: 2025-10-27

### 한 줄 요약
AI 에이전트용 MCP 도구를 확장하여 (1) 전체 문서 트리 조회, (2) 현재 설정 조회, (3) 문서 내용 검색 기능을 추가한다. 이 문서는 설계, 구현 단계, 보안·예외 처리, 테스트 전략을 상세히 기술한다.

### 현재 구현 상태(중요)
- 이미 구현된 항목: MCP 엔드포인트 자체와 도구 호출 인프라(도구 목록 조회/도구 실행)는 현재 저장소에 구현되어 있습니다. 구현 위치 및 참고 파일:
  - `src/routes/mcp.js` — MCP 엔드포인트(`POST /mcp`) 및 메서드 처리(예: `tools/list`, `tools/call`)가 구현되어 있습니다.
  - 문서: `docs/api/mcp.md`, `public/mcp-doc.md` — MCP 사용법과 예제가 존재합니다.
  - (결론) 2.1에 해당하는 "MCP 도구 목록/기본 호출(infrastructure)"은 이미 구현되어 있으므로, 본 단계에서는 새로운 개별 도구(함수)를 추가하고 기존 인프라에 등록/노출하는 작업이 주가 됩니다. 단, 도구 이름이나 파라미터 명은 repo의 기존 규칙(예: `tools/list`, `tools/call`)에 맞춰 실제 구현과 문서에 일치시켜 기록합니다.

### 목표(세부)
- **list_full_tree** ✅ (이미 구현됨): docs 루트에서 재귀적으로 트리 정보를 수집해 사람이 읽을 수 있는 텍스트 출력과 구조화된 JSON을 반환. `src/routes/mcp.js`의 `list_full_tree` 도구로 이미 완성.
- **DocuLight_get_config**: 현재 런타임 설정을 안전하게 반환(민감정보 마스킹 또는 파라미터로 section 선택 기능)
- **DocuLight_search**: 키워드 기반 문서 검색(최대 결과 수, 하이라이팅 컨텍스트 포함)

### 계약(Inputs / Outputs / 에러)
- 공통: 모든 도구는 MCP 인프라의 `tools/call`로 호출됩니다. tools/call의 params는 보통 { name: string, arguments: object }

- **list_full_tree** ✅ (이미 구현됨 - src/routes/mcp.js 참고)
  - 입력: { path?: string, maxDepth?: number }
  - 출력: { root: { dirs: [], files: [] }, stats: { totalFiles, totalDirs }, startPath: string }
  - 기능: 완전한 재귀 트리 조회, 통계 포함

- **DocuLight_get_config** (구현 필요)
  - 입력: { section?: string }  // ui, security, ssl, all (기본: all)
  - 출력: { config: object } (민감값(masked): apiKey, passwords, ssl.key 등)
  - 오류: section 유효성 실패, 설정 로드 오류
  - 보안: 민감정보는 항상 마스킹(***로 표시)

- **DocuLight_search** (구현 필요)
  - 입력: { query: string, limit?: number = 10, path?: string = '/' }
  - 출력: { query: string, total: number, results: [ { path, matches: [ { line, content, context } ] } ] }
  - 오류: query 유효성 실패(길이<2 등), path 범위 검증 실패

### 상세 구현 계획 — 서버 측

#### 현재 상태
- `list_full_tree` 도구는 이미 `src/routes/mcp.js`에 완전히 구현되어 있으므로, 추가 작업 불필요
- 새로운 두 도구(`DocuLight_get_config`, `DocuLight_search`)만 추가하면 됨

#### 도구 등록 방식
- **권장**: `src/routes/mcp.js`의 TOOLS 배열과 executeTool() switch-case에 직접 추가
  - 구현이 간단하고 기존 패턴을 따름
  - 추후 도구 레지스트리 시스템으로 리팩토링 가능

#### 1) DocuLight_get_config 구현
- 함수: `getConfig(args)` in `src/routes/api-ctrl.js`
- 동작
  1. `req.app.locals.config`에서 현재 런타임 설정 획득
  2. 민감값 마스킹: apiKey, secrets, ssl.key, ssl.cert, passwords 등을 `***` 로 표시
  3. `section` 파라미터가 있을 경우 해당 섹션만 반환 (ui, security, ssl, all)
  4. 모든 민감값이 마스킹되었는지 확인 후 반환
- 구현 위치
  - 로직 함수: `src/routes/api-ctrl.js`에 추가
  - MCP 도구 등록: `src/routes/mcp.js`의 TOOLS 배열과 executeTool()에 추가
- 보안
  - 로그에 민감값 노출 금지 (로거에서 자동 마스킹 확인)
  - 민감값 목록: apiKey, password, key, secret, token, credentials

#### 2) DocuLight_search 구현
- 함수: `searchDocuments(args)` in `src/routes/api-ctrl.js`
- 구현 전략: **실시간 파일 스캔** (초기: 간단한 구현)
  - 대체 이전(향후): Hot Reload 워쳐와 연계해 인덱스 구축 가능
- 동작
  1. 입력 path 검증 및 정규화 (docsRoot 내에 있는지 확인)
  2. query 검증: 길이 ≥ 2, 특수문자 제한
  3. 재귀적으로 모든 파일 스캔 (excludes 패턴 적용)
  4. 각 파일 내에서 query를 포함하는 라인 찾기 (대소문자 무시)
  5. 매칭된 라인과 전후 컨텍스트(±2줄) 포함해 결과 구성
  6. limit에 따라 상위 결과만 반환 (기본 10, 최대 100)
  7. 실행 시간 로깅
- 제한/구성
  - 기본 limit: 10, 최대 limit: 100 (초과 시 100으로 제한)
  - 검색 시간 제한: 구현 초기는 5초 (성능 모니터링 후 조정)
  - 한 파일당 최대 매치: 50개 제한 (메모리 절약)
- 보안
  - docsRoot 밖 파일 접근 금지 (path 검증 사용)
  - 큰 파일 스캔 최적화 (1MB 초과 파일은 스킵)

#### 3) 공통 세부사항
- 입력 검증: 모든 문자열 입력은 길이/타입 검증, 특수문자 필터
- 에러 매핑: MCP JSON-RPC 표준 에러 코드 사용
  - -32602: Invalid params
  - -32603: Internal error
  - -32400: Server error (custom)
- 로깅: 각 도구 호출 시 duration, 결과 크기, 에러 기록
- 응답 포맷: 모든 도구는 MCP 표준 응답 포맷 사용
  ```javascript
  {
    content: [{ type: 'text', text: '...' }]
  }
  ```

### 상세 구현 계획 — 클라이언트(테스트/예제용)
 - `docs/api/mcp.md` 및 `public/mcp-doc.md` 업데이트: 신규 도구 설명, 예제 payload(예: tools/call 호출 예)
 - 간단한 테스트 스크립트 추가: `test/mcp-tools.test.js` (혹은 `test/mcp-tools/`) — unit/integration 테스트 포함

### 보안/운영 고려사항
 - 민감정보: `DocuLight_get_config` 반환 시 apiKey 등은 기본 마스킹, 별도 관리자 토글 필요
 - 권한: MCP 호출자 신뢰 모델을 정의(로컬 호스트 전용, 또는 인증 토큰 요구)
 - DoS: `DocuLight_get_full_tree`와 `DocuLight_search`는 비용이 크므로 rate-limit 또는 비용 기반 제한 도입
 - 파일 시스템 경계: 항상 docsRoot 안에서만 작동하도록 canonicalize 후 검사

### 예시: MCP 요청 샘플

#### 1) 도구 목록 조회
```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 1
}
```

#### 2) list_full_tree 호출 (이미 구현됨)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 2,
  "params": {
    "name": "list_full_tree",
    "arguments": { "path": "/", "maxDepth": 3 }
  }
}
```

#### 3) DocuLight_get_config 호출 (새로 추가)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 3,
  "params": {
    "name": "DocuLight_get_config",
    "arguments": { "section": "all" }
  }
}
```

응답 예:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\n  \"docsRoot\": \"/path/to/docs\",\n  \"apiKey\": \"***\",\n  \"port\": 3000,\n  \"ui\": {...},\n  \"security\": {...}\n}"
    }]
  }
}
```

#### 4) DocuLight_search 호출 (새로 추가)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 4,
  "params": {
    "name": "DocuLight_search",
    "arguments": {
      "query": "installation",
      "limit": 5,
      "path": "/"
    }
  }
}
```

응답 예:
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{
      "type": "text",
      "text": "# Search Results for 'installation'\n\nFound 5 matches:\n\n1. docs/setup.md:3 - Installation steps\n   Context: To install DocuLight, use npm...\n\n2. docs/api.md:12 - Installation required\n   Context: Installation is required before...\n\n..."
    }]
  }
}
```

### 구현 일정(권장 소요)
- 문서 검토 및 수정: 0.5h ✅ (완료: list_full_tree 매핑 반영)
- `DocuLight_get_config`: 1.0h
  - 민감값 마스킹 규칙 정의 및 구현
  - section 필터링 로직
  - MCP 도구 등록
- `DocuLight_search` (실시간 스캔): 1.5h
  - 입력 검증 및 경로 정규화
  - 파일 스캔 및 검색 로직
  - 컨텍스트 추출 및 결과 포맷팅
  - MCP 도구 등록
- 문서/테스트/예제 추가: 1.0h
  - `docs/api/mcp.md` 업데이트
  - curl 테스트 예제
  - 검증 테스트 케이스

총계(추정): 4.0 시간 (list_full_tree가 이미 구현되어 있어 1.5시간 절감)

### 마이그레이션·하위호환
- 기존 MCP 인프라(`tools/list`, `tools/call`)를 그대로 사용하므로 호환성 유지
- 신규 도구는 도구 목록에 추가되며 기존 클라이언트는 변하지 않음

---

## API 테스트 계획 및 전략

목표: 각 도구가 의도대로 동작하고, 에러/경계 조건, 보안 정책을 준수함을 자동/수동으로 검증

1) 테스트 종류
  - 단위 테스트: 핵심 유틸(파일 경계 검사, 마스킹 로직, 토큰화 등)
  - 통합 테스트: MCP 엔드포인트(`POST /mcp`)를 통해 실제 JSON-RPC 호출을 시뮬레이션
  - 부하/성능 테스트: 대형 트리/대량 검색 쿼리에서 응답 시간과 메모리 사용 모니터링
  - 보안 테스트: 민감정보 노출, 경로 탈출(../) 공격, 권한 우회

2) 자동화 테스팅 (권장)
  - 테스트 프레임워크: 기존 프로젝트의 테스트 스택을 따름(레포에 `test/` 폴더가 있으므로 동일 스타일 사용 — Node + mocha/jest 가능)
  - 추가 테스트 파일
    - `test/mcp-tools/full-tree.test.js` : 작은 파일셋과 큰 파일셋에서 응답 확인
    - `test/mcp-tools/config.test.js` : masking 규칙 확인, section 필터링
    - `test/mcp-tools/search.test.js` : 인덱스 빌드 후 쿼리 일치성 및 limit 검사
  - 통합 테스트는 `supertest` 또는 간단한 fetch/axios를 이용해 `POST /mcp`에 JSON-RPC 페이로드를 전송하고 응답 검사

3) 수동/탐색적 테스트 케이스(우선순위 높음)
  - 새 도구 정상 호출(기본 인자) → 200/valid result
  - 잘못된 파라미터(예: query="") → 적절한 오류(400/JSON-RPC error)
  - 존재하지 않는 도구 호출 → JSON-RPC method-not-found 유형 오류
  - 경로 탈출 시도: path="/../../.." → 거부
  - large tree: 제한시간 내에 부분 결과/타임아웃 발생 및 메시지
  - config 요청 시 민감필드 마스킹 확인

4) 성능/부하 전략
  - `DocuLight_get_full_tree`는 depth/size 제한을 기본 적용(예: depth=6, 파일 크기 상한 1MB)
  - `DocuLight_search`: 1) 로컬 인덱스 사용 2) 쿼리 시간 제한(500ms) 3) rate limit 적용

5) 실행 방법(예시)
  - 단위/통합 테스트 (프로젝트가 npm 스크립트를 사용한다고 가정)
    - npm script 추가 제안: `test:mcp-tools` → 실행시 `node ./test/mcp-tools/*.test.js` 또는 `npm run test -- test/mcp-tools`
  - 수동 curl 예제(참고용)
    - tools/list
      ```powershell
      curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
      ```
    - tools/call (search)
      ```powershell
      curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"tool":"DocuLight_search","args":{"query":"install","limit":5}}}'
      ```

6) 모니터링·로그링
  - 각 도구 호출 시 duration, 결과 크기, 에러코드 로깅
  - 운영환경에서는 MCP 로그를 별도 파이프(파일/ELK)로 전송 권장

7) 성공 기준
  - 단위/통합 테스트(해당 모듈) 통과
  - 주요 시나리오(트리 조회, 설정 조회, 검색) 정상 응답(정확도/형식 검증)
  - 보안 테스트(경로 탈출, 민감정보 노출) 실패(적절히 거부)

---

## 마무리 및 다음 단계

### 즉시 수행 항목
1. ✅ 문서 수정 완료 (list_full_tree 매핑 반영)
2. `DocuLight_get_config` 도구 구현 및 테스트
3. `DocuLight_search` 도구 구현 및 테스트
4. `docs/api/mcp.md` 업데이트 (새 도구 설명)
5. 통합 테스트 수행

### 구현 체크리스트
- [ ] `getConfig(args)` 함수 in src/routes/api-ctrl.js
  - [ ] config 로드 및 민감값 마스킹
  - [ ] section 필터링 로직
  - [ ] 에러 처리
- [ ] `searchDocuments(args)` 함수 in src/routes/api-ctrl.js
  - [ ] 경로 검증 및 정규화
  - [ ] query 유효성 검증
  - [ ] 파일 스캔 및 검색 로직
  - [ ] 컨텍스트 추출
  - [ ] limit 제한
- [ ] MCP 도구 등록 in src/routes/mcp.js
  - [ ] DocuLight_get_config 추가
  - [ ] DocuLight_search 추가
  - [ ] executeTool() case 추가
- [ ] curl 테스트 (두 도구 모두)
- [ ] MCP 클라이언트 테스트 (필요시)

### 향후 개선 사항
- **Search 인덱싱**: 현재 실시간 스캔을 사용하지만, 향후 Hot Reload 워쳐와 연계해 인덱스 기반 검색으로 전환 가능
- **Rate Limiting**: 필요시 MCP 도구에 rate limiting 추가
- **성능 최적화**: 검색 시간 제한값 모니터링 및 조정

---

**상태**: 문서 수정 완료, 코드 구현 준비 완료
