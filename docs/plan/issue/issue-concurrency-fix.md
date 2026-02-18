# 챗봇 동시성 문제 해결 계획

## 문제 요약

챗봇 서비스에서 동일 세션으로 동시에 여러 요청이 들어올 경우 다음 문제가 발생할 수 있음:

1. **세션 메시지 Race Condition**: 메시지 순서 뒤바뀜
2. **MemorySaver 상태 충돌**: LangGraph 상태 덮어쓰기
3. **VectorStore 비원자적 업데이트**: 문서 인덱싱 중 검색 시 불완전한 결과

---

## 해결 방안: AsyncLock 적용

### 1. 의존성 추가

```bash
npm install async-lock
```

### 2. ChatbotService 수정

**파일**: `src/services/chatbot/chatbot-service.js`

#### 2.1 AsyncLock 임포트 및 초기화

```javascript
const AsyncLock = require('async-lock');

class ChatbotService {
  constructor(config, logger) {
    // ... 기존 코드 ...

    // 동시성 제어를 위한 락
    this.sessionLock = new AsyncLock();
  }
}
```

#### 2.2 chat() 메서드에 락 적용

```javascript
async chat(sessionId, message, options = {}) {
  if (!this.isInitialized) {
    throw new Error("ChatbotService not initialized");
  }

  // 세션 확인 또는 생성 (락 외부에서 수행)
  if (!this.sessions.has(sessionId)) {
    sessionId = this.createSession();
  }

  // 동일 세션에 대한 요청은 순차 처리
  return this.sessionLock.acquire(sessionId, async () => {
    const session = this.sessions.get(sessionId);

    // ... 기존 chat 로직 ...

    // 세션 업데이트 (락 내부에서 안전하게 수행)
    if (finalState && finalState.messages) {
      session.messages.push(
        { role: "user", content: message, timestamp: new Date() },
        {
          role: "assistant",
          content: finalState.messages[finalState.messages.length - 1]?.content || "",
          timestamp: new Date()
        }
      );
      session.lastUpdatedAt = new Date();
    }

    return result;
  });
}
```

### 3. VectorStoreManager 수정 (선택적)

**파일**: `src/services/chatbot/vector-store.js`

문서 추가/삭제 시 락 적용:

```javascript
const AsyncLock = require('async-lock');

class VectorStoreManager {
  constructor(embeddings, config = {}, options = {}) {
    // ... 기존 코드 ...
    this.lock = new AsyncLock();
  }

  async addDocument(filePath, content, metadata = {}) {
    return this.lock.acquire('vectorstore', async () => {
      // 기존 addDocument 로직
    });
  }

  async removeDocument(filePath) {
    return this.lock.acquire('vectorstore', async () => {
      // 기존 removeDocument 로직
    });
  }
}
```

---

## AsyncLock 동작 원리

### 핵심 메커니즘

```
┌─ Request A (sessionId='xyz')
│  ├─ sessionLock.acquire('xyz', async () => {...})
│  ├─ 락 획득 성공 → 처리 시작
│  └─ 처리 완료 → 락 해제
│
└─ Request B (sessionId='xyz')  ← 동시 요청
   ├─ sessionLock.acquire('xyz', async () => {...})
   ├─ 락 대기 (A가 보유 중)
   └─ A 완료 후 → 락 획득 → 처리
```

### AsyncLock 특징

1. **키 기반 락**: 각 sessionId별로 독립적인 락
2. **FIFO 큐**: 요청 순서대로 처리
3. **Promise 기반**: async/await 완전 지원
4. **타임아웃 지원**: 무한 대기 방지 가능

### 타임아웃 옵션 (권장)

```javascript
this.sessionLock = new AsyncLock({ timeout: 60000 }); // 60초 타임아웃

// 또는 호출 시 지정
this.sessionLock.acquire(sessionId, async () => {...}, { timeout: 30000 });
```

---

## 예상 동작

### Before (현재 - 문제 있음)

```
T0: A 시작 (session='s1')
T1: B 시작 (session='s1')
T2: A가 messages 읽음
T3: B가 messages 읽음 (같은 상태)
T4: A가 messages.push()
T5: B가 messages.push() → 순서 뒤바뀜 가능!
```

### After (락 적용 후)

```
T0: A 시작 (session='s1') → 락 획득
T1: B 시작 (session='s1') → 락 대기
T2: A 처리 중...
T3: A 완료 → 락 해제
T4: B 락 획득 → B 처리 시작
T5: B 완료 → 락 해제
```

---

## 고려사항

### 1. 성능 영향

- 같은 세션에 대한 요청만 직렬화됨
- 다른 세션은 병렬 처리 가능
- 일반적인 사용 패턴(한 사용자가 순차적으로 대화)에서는 영향 없음

### 2. 타임아웃 처리

```javascript
try {
  await this.sessionLock.acquire(sessionId, async () => {...}, { timeout: 30000 });
} catch (error) {
  if (error.message === 'async-lock timed out') {
    throw new Error('Request timed out. Please try again.');
  }
  throw error;
}
```

### 3. 락 범위 최소화

- 락은 필요한 부분만 감싸야 함
- LLM 호출 등 오래 걸리는 작업도 포함되므로 타임아웃 필수

---

## 구현 단계

### Phase 1: ChatbotService 락 추가 (필수)

1. `async-lock` 패키지 설치
2. `ChatbotService` 생성자에 `sessionLock` 추가
3. `chat()` 메서드에 `sessionLock.acquire()` 적용
4. 타임아웃 설정 (60초 권장)

### Phase 2: VectorStoreManager 락 추가 (선택)

1. 인메모리 모드에서만 필요 (영속성 모드는 자체 동시성 제어 있음)
2. `addDocument`, `removeDocument`에 락 적용
3. 검색은 락 불필요 (읽기 전용)

---

## 테스트 시나리오

### 1. 동시 요청 테스트

```javascript
// 같은 세션으로 동시에 3개 요청
const sessionId = chatbotService.createSession();
const promises = [
  chatbotService.chat(sessionId, "First message"),
  chatbotService.chat(sessionId, "Second message"),
  chatbotService.chat(sessionId, "Third message")
];
await Promise.all(promises);

// 검증: 메시지가 순서대로 저장되었는지 확인
const history = await chatbotService.getHistory(sessionId);
// messages: [user1, assistant1, user2, assistant2, user3, assistant3]
```

### 2. 타임아웃 테스트

```javascript
// 오래 걸리는 요청 중 타임아웃 확인
```

---

## 결론

AsyncLock을 사용한 세션별 락 메커니즘은:

- **간단함**: 코드 변경 최소화
- **효과적**: 동일 세션 요청 직렬화로 Race Condition 해결
- **성능 영향 적음**: 다른 세션은 영향 없음
- **검증됨**: async-lock은 널리 사용되는 라이브러리

Redis 등 외부 저장소 없이도 단일 서버 환경에서 동시성 문제를 효과적으로 해결할 수 있음.
