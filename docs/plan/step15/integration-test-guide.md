# 통합 테스트 가이드

## 1. 통합 테스트 목적

### 1.1 원래 의도
DocLight 시스템에 RAG 기반 AI 챗봇을 추가하여 사용자가 등록된 Markdown 문서에 대해 자연어로 질의응답할 수 있게 함.

### 1.2 검증 목표
- 전체 RAG 파이프라인이 End-to-End로 동작
- 다중 LLM 제공자 간 전환 가능
- 실시간 스트리밍 응답 제공
- 세션 기반 대화 컨텍스트 유지

---

## 2. End-to-End 시나리오

### 시나리오 1: 기본 RAG 질의응답

```gherkin
Given DocLight 서버가 실행 중이고
  And docsRoot에 Markdown 문서가 있고
  And chatbot 설정이 유효함
When 사용자가 /chatbot 페이지에 접속하고
  And "API 인증 방법은?" 질문을 입력하고
  And Send 버튼을 클릭함
Then 워크플로우 인디케이터에 "Analyzing your question..." 표시되고
  And "Searching relevant documents..." 표시되고
  And "Generating response..." 표시되고
  And 토큰 단위로 응답이 스트리밍되고
  And 응답이 검색된 문서 내용을 기반으로 함
```

**검증 포인트**:
- [ ] SSE 이벤트 순서 정상
- [ ] 토큰 스트리밍 동작
- [ ] Markdown 렌더링 정상
- [ ] TTFB ≤ 2초

### 시나리오 2: 연속 대화 (세션 유지)

```gherkin
Given 첫 번째 질문 "API 엔드포인트 목록은?"에 답변을 받음
When 후속 질문 "그 중에서 인증이 필요한 것은?"을 입력함
Then 이전 대화 맥락을 참조하여 답변함
  And threadId가 동일하게 유지됨
```

**검증 포인트**:
- [ ] MemorySaver 상태 유지
- [ ] 컨텍스트 참조 응답

### 시나리오 3: Thinking 모드

```gherkin
Given Thinking Mode 토글이 활성화됨
When 복잡한 질문을 입력함
Then "Analyzing question complexity..." 표시되고
  And "Planning response strategy..." 표시되고
  And "Executing reasoning steps..." 표시되고
  And 단계별 추론 결과가 포함된 응답 제공
```

**검증 포인트**:
- [ ] Thinking 노드 실행
- [ ] 단계별 SSE 이벤트

### 시나리오 4: 문서 변경 반영

```gherkin
Given 챗봇이 초기화됨
When docsRoot에 새 Markdown 파일을 추가함
  And 5초 대기
  And 새 문서 내용에 대해 질문함
Then 새 문서 내용이 검색 결과에 포함됨
```

**검증 포인트**:
- [ ] DocWatcher 이벤트 발생
- [ ] VectorStore 업데이트
- [ ] 5초 이내 반영

### 시나리오 5: 다국어 응답

```gherkin
Given 시스템 프롬프트가 영어로 작성됨
When 한글로 질문함 ("API 사용법 알려줘")
Then 한글로 응답함

When 영어로 질문함 ("How to use the API?")
Then 영어로 응답함
```

**검증 포인트**:
- [ ] 언어 감지 동작
- [ ] 응답 언어 일치

---

## 3. 컴포넌트 통합 검증

| 컴포넌트 A | 컴포넌트 B | 통합 포인트 | 검증 방법 |
|-----------|-----------|------------|----------|
| DocWatcher | VectorStoreManager | 파일 변경 시 재임베딩 | 파일 수정 후 검색 확인 |
| LLMFactory | WorkflowNodes | LLM 인스턴스 주입 | 노드 실행 확인 |
| StateGraph | MemorySaver | 상태 저장/복원 | 연속 대화 테스트 |
| ChatbotController | SSE | 스트림 응답 | 이벤트 수신 확인 |
| ChatbotUI | MarkdownRenderer | 응답 렌더링 | 코드 블록 표시 확인 |

---

## 4. 통합 테스트 코드

### 4.1 E2E 테스트 (Playwright)

```javascript
// test/chatbot/e2e.spec.js

import { test, expect } from '@playwright/test';

test.describe('Chatbot E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chatbot');
  });

  test('should display welcome message', async ({ page }) => {
    await expect(page.locator('.welcome-message')).toBeVisible();
    await expect(page.locator('#doc-count')).not.toHaveText('-');
  });

  test('should send message and receive streaming response', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendButton = page.locator('#send-button');

    await input.fill('What is DocLight?');
    await sendButton.click();

    // 사용자 메시지 표시 확인
    await expect(page.locator('.message-user')).toBeVisible();

    // 워크플로우 인디케이터 표시 확인
    await expect(page.locator('#workflow-indicator')).toBeVisible();

    // 봇 응답 대기
    await expect(page.locator('.message-bot .message-content')).not.toBeEmpty({ timeout: 30000 });

    // 워크플로우 인디케이터 숨김 확인
    await expect(page.locator('#workflow-indicator')).not.toBeVisible();
  });

  test('should toggle thinking mode', async ({ page }) => {
    const toggle = page.locator('#thinking-mode');
    await toggle.check();
    await expect(toggle).toBeChecked();
  });

  test('should render markdown code blocks', async ({ page }) => {
    const input = page.locator('#message-input');
    await input.fill('Show me a code example');
    await page.locator('#send-button').click();

    // 코드 블록 렌더링 확인
    await expect(page.locator('.message-bot pre code')).toBeVisible({ timeout: 30000 });
  });
});
```

### 4.2 API 통합 테스트

```javascript
// test/chatbot/api.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Chatbot API Integration', () => {
  let threadId;

  it('should stream chat response', async () => {
    const response = await fetch('http://localhost:3000/api/chatbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let hasStepEvent = false;
    let hasTokenEvent = false;
    let hasDoneEvent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      if (text.includes('event: step')) hasStepEvent = true;
      if (text.includes('event: token')) hasTokenEvent = true;
      if (text.includes('event: done')) {
        hasDoneEvent = true;
        // threadId 추출
        const match = text.match(/"threadId":"([^"]+)"/);
        if (match) threadId = match[1];
      }
    }

    expect(hasStepEvent).toBe(true);
    expect(hasTokenEvent).toBe(true);
    expect(hasDoneEvent).toBe(true);
    expect(threadId).toBeDefined();
  });

  it('should maintain session with threadId', async () => {
    const response = await fetch('http://localhost:3000/api/chatbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Follow up question',
        threadId,
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should return status', async () => {
    const response = await fetch('http://localhost:3000/api/chatbot/status');
    const status = await response.json();

    expect(status.vectorStore).toBeDefined();
    expect(status.llm).toBeDefined();
    expect(status.embedding).toBeDefined();
  });
});
```

---

## 5. 성능/부하 테스트

### 5.1 성능 목표

| 항목 | 목표 | 측정 방법 |
|------|------|----------|
| TTFB | ≤ 2초 | 첫 토큰 수신 시간 |
| 벡터 검색 | ≤ 100ms | retrieval 노드 실행 시간 |
| 문서 임베딩 | ≥ 5 docs/sec | 초기화 시간 / 문서 수 |

### 5.2 부하 테스트 시나리오

```javascript
// k6 스크립트 예시
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '1m',
};

export default function () {
  const res = http.post('http://localhost:3000/api/chatbot/chat', JSON.stringify({
    message: 'Test question',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'TTFB < 2s': (r) => r.timings.waiting < 2000,
  });

  sleep(1);
}
```

---

## 6. 원래 목적 달성 검증

| 요구사항 ID | 설명 | 검증 방법 | 결과 |
|------------|------|----------|------|
| FR-CB-001 | 다중 LLM 제공자 지원 | 설정 변경 후 동작 확인 | ⬜ |
| FR-CB-002 | 다중 임베딩 제공자 지원 | 설정 변경 후 동작 확인 | ⬜ |
| FR-CB-003 | Markdown 문서 자동 임베딩 | 초기화 후 검색 확인 | ⬜ |
| FR-CB-004 | Frontmatter 추출 | 메타데이터 검색 확인 | ⬜ |
| FR-CB-005 | 실시간 문서 변경 감지 | 파일 수정 후 반영 확인 | ⬜ |
| FR-CB-006 | 질문 분류 | 분류 정확도 테스트 | ⬜ |
| FR-CB-007 | 벡터 유사도 검색 | Top-20 반환 확인 | ⬜ |
| FR-CB-008 | RAG 기반 답변 생성 | 문서 기반 응답 확인 | ⬜ |
| FR-CB-009 | 대화 히스토리 관리 | 연속 대화 테스트 | ⬜ |
| FR-CB-010 | 컨텍스트 크기 관리 | 장기 대화 테스트 | ⬜ |
| FR-CB-011 | Thinking 모드 | 토글 동작 확인 | ⬜ |
| FR-CB-012 | 실시간 진행 상황 표시 | SSE 이벤트 확인 | ⬜ |
| FR-CB-013 | 토큰 단위 스트리밍 | 스트리밍 동작 확인 | ⬜ |
| FR-CB-014 | Markdown 렌더링 | 코드 블록 표시 확인 | ⬜ |
| FR-CB-015 | 챗봇 메인 페이지 설정 | 리다이렉트 확인 | ⬜ |
| FR-CB-016 | Query Rewriting | 재검색 동작 확인 | ⬜ |
| FR-CB-017 | Document Grading | 관련성 평가 확인 | ⬜ |

---

## 7. 테스트 실행 명령

```bash
# E2E 테스트 (Playwright)
npm run test:chatbot:e2e

# API 통합 테스트
npm run test:chatbot:api

# 성능 테스트 (k6)
k6 run test/chatbot/load.js

# 전체 통합 테스트
npm run test:chatbot:integration
```

---

## 8. DocLight 기존 기능과의 통합 검증

### 8.1 기존 API와의 공존 테스트

```javascript
// test/integration/coexistence.test.js

describe('Chatbot and Existing DocLight API Coexistence', () => {
  it('should not affect existing /api/tree endpoint', async () => {
    const response = await fetch('http://localhost:3000/api/tree?path=/');
    expect(response.status).toBe(200);
    const tree = await response.json();
    expect(Array.isArray(tree)).toBe(true);
  });

  it('should not affect existing /api/raw endpoint', async () => {
    const response = await fetch('http://localhost:3000/api/raw?path=/README.md');
    expect(response.status).toBe(200);
  });

  it('should not affect protected endpoints with API key', async () => {
    const response = await fetch('http://localhost:3000/api/download/file?path=/README.md', {
      headers: { 'X-API-Key': process.env.DOCLIGHT_API_KEY }
    });
    expect(response.status).toBe(200);
  });

  it('should share config.docsRoot with existing features', async () => {
    // Tree API와 Chatbot이 같은 docsRoot 사용
    const treeResponse = await fetch('http://localhost:3000/api/tree?path=/');
    const statusResponse = await fetch('http://localhost:3000/api/chatbot/status');

    const status = await statusResponse.json();
    expect(status.vectorStore.totalDocs).toBeGreaterThan(0);
  });
});
```

### 8.2 설정 검증 통합

```javascript
// test/integration/config-validation.test.js

describe('Chatbot Configuration Integration', () => {
  it('should load chatbot config alongside existing config', () => {
    const { loadConfig } = require('../../src/utils/config-loader');
    const config = loadConfig();

    // 기존 설정 유지 확인
    expect(config.docsRoot).toBeDefined();
    expect(config.apiKeys).toBeDefined();
    expect(config.port).toBeDefined();

    // 챗봇 설정 공존 확인
    if (config.chatbot) {
      expect(config.chatbot.llm).toBeDefined();
      expect(config.chatbot.embedding).toBeDefined();
    }
  });

  it('should work without chatbot config (backwards compatible)', () => {
    // chatbot 섹션 없이도 기존 기능 동작 확인
    const { loadConfig } = require('../../src/utils/config-loader');

    // chatbot 없는 config 시뮬레이션
    const config = loadConfig();
    delete config.chatbot;

    expect(config.docsRoot).toBeDefined();
    expect(() => {
      // 기존 tree API 호출 시뮬레이션
    }).not.toThrow();
  });
});
```

### 8.3 로깅 통합

```javascript
// 기존 DocLight 로거와 통합
describe('Logger Integration', () => {
  it('should use existing Winston logger instance', () => {
    // ChatbotService가 req.app.locals.logger 사용 확인
    const express = require('express');
    const app = express();
    const logger = require('../../src/utils/logger')('./logs', 'info');

    app.locals.logger = logger;

    // ChatbotService 초기화 시 logger 전달 확인
    const { ChatbotService } = require('../../src/services/chatbot');
    const service = new ChatbotService({ chatbot: mockConfig }, logger);

    expect(service.logger).toBe(logger);
  });
});
```

### 8.4 에러 핸들러 통합

```javascript
// 기존 error-handler.js와 통합
describe('Error Handler Integration', () => {
  it('should use existing error handler middleware', async () => {
    // 잘못된 요청으로 에러 발생
    const response = await fetch('http://localhost:3000/api/chatbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // message 누락
    });

    expect(response.status).toBe(400);
    const error = await response.json();

    // 기존 DocLight 에러 형식과 일치 확인
    expect(error.error).toBeDefined();
    expect(error.error.code).toBeDefined();
    expect(error.error.message).toBeDefined();
  });
});
```

### 8.5 라우트 순서 통합

```
기존 DocLight 라우트 순서:
1. Static files (public/)
2. /api/tree, /api/raw, /api/html, /api/search (공개)
3. /api/upload, /api/entry, /api/download (인증 필요)
4. /doc/* (문서 뷰어)
5. / (메인 페이지)

새로운 Chatbot 라우트 추가 위치:
1. Static files (public/)
2. /api/tree, /api/raw, /api/html, /api/search (공개)
3. /api/chatbot/* (공개, 인증 선택적)  <-- 새로운 위치
4. /api/upload, /api/entry, /api/download (인증 필요)
5. /chatbot (챗봇 UI)  <-- 새로운 위치
6. /doc/* (문서 뷰어)
7. / (메인 페이지 또는 챗봇 리다이렉트)
```

---

## 9. 기존 기능 회귀 테스트

| 기능 | 테스트 | 통과 기준 |
|------|--------|----------|
| 파일 트리 조회 | GET /api/tree | 200 응답, 트리 구조 반환 |
| Markdown 조회 | GET /api/raw | 200 응답, 파일 내용 반환 |
| HTML 렌더링 | GET /api/html | 200 응답, HTML 반환 |
| 문서 검색 | GET /api/search | 200 응답, 검색 결과 반환 |
| 파일 업로드 | POST /api/upload | 201 응답 (인증 필요) |
| 파일 삭제 | DELETE /api/entry | 200 응답 (인증 필요) |
| 파일 다운로드 | GET /api/download/file | 200 응답 (인증 필요) |
| 문서 뷰어 | GET /doc/* | 200 응답, HTML 렌더링 |
| 메인 페이지 | GET / | 200 응답 |

---

## 10. 체크리스트

- [ ] 모든 E2E 시나리오 통과
- [ ] 모든 API 통합 테스트 통과
- [ ] 성능 목표 달성 (TTFB ≤ 2초)
- [ ] 17개 요구사항 모두 검증
- [ ] 다국어 응답 동작 확인
- [ ] 기존 DocLight API 정상 동작 확인
- [ ] 설정 하위 호환성 확인
- [ ] 에러 형식 일관성 확인
- [ ] 로깅 통합 확인
