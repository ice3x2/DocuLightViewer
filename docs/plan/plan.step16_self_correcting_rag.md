# Step 16: Self-Correcting RAG 워크플로우 개선

## 개요

**문제점**:
1. 이전 대화 내용을 기억하지 못함
2. 모든 질문에 RAG를 사용하여 불필요한 문서 검색 발생

**해결 방향**:
- 사전 분류(Pre-classification)에만 의존하지 않고
- **사후 평가(Post-generation Evaluation)** 노드를 추가하여 자가 수정

---

## 현재 워크플로우 문제점 분석

### 1. 대화 기억 문제

**현재 코드** (`chatbot-service.js:308`):
```javascript
const input = {
  messages: [new HumanMessage(message)],  // 새 메시지만 전달
  thinkingMode
};
```

- 세션에 `session.messages` 배열로 대화 기록 저장됨
- 하지만 워크플로우 호출 시 이전 메시지 미포함
- MemorySaver가 있지만 입력과의 상호작용 문제

### 2. RAG 과다 사용 문제

**현재 분류 로직** (`classify.js`, `graph.js`):

| 분류 | 라우팅 |
|------|--------|
| question | → retrieveDocs (RAG) |
| summary | → retrieveDocs (RAG) |
| unknown | → retrieveDocs (RAG) |
| chitchat | → generateAnswer (직접) |

**문제점**:
- 분류 시점에 어떤 문서가 있는지 모름
- "더 설명해줘" 같은 후속 질문도 RAG 사용
- 분류 실수 시 수정 불가

---

## 개선된 아키텍처: Self-Correcting RAG

### 워크플로우 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                        현재 워크플로우                            │
├─────────────────────────────────────────────────────────────────┤
│  classify → [question] → retrieve → grade → generate → END     │
│           → [chitchat] → generate → END                        │
└─────────────────────────────────────────────────────────────────┘

                              ▼

┌─────────────────────────────────────────────────────────────────┐
│                     개선된 워크플로우                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │ classify │───▶│   generate   │───▶│  evaluate    │          │
│  └──────────┘    │ (fast path)  │    │   Answer     │          │
│                  └──────────────┘    └──────┬───────┘          │
│                                             │                   │
│                    ┌────────────────────────┼────────────┐      │
│                    ▼                        ▼            ▼      │
│              [adequate]              [needs_docs]  [hallucination]
│                    │                        │            │      │
│                    ▼                        ▼            ▼      │
│                  END                  ┌──────────┐  ┌──────────┐│
│                                       │ retrieve │  │ retrieve ││
│                                       │   Docs   │  │   Docs   ││
│                                       └────┬─────┘  └────┬─────┘│
│                                            ▼             ▼      │
│                                       ┌──────────────────────┐  │
│                                       │    regenerate        │  │
│                                       │  (with documents)    │  │
│                                       └──────────┬───────────┘  │
│                                                  ▼              │
│                                            evaluateAnswer       │
│                                           (retry limit: 2)      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 핵심 개념

1. **Fast Path**: 먼저 RAG 없이 빠르게 답변 시도
2. **Evaluation**: 답변 품질 평가
3. **Self-Correction**: 평가 결과에 따라 RAG로 재시도
4. **Retry Limit**: 무한 루프 방지 (최대 2회)

---

## 평가 노드 설계

### 평가 스키마

```javascript
// workflow/nodes/evaluate.js

const evaluationSchema = z.object({
  // 질문-답변 일치도
  answerQuality: z.enum([
    "adequate",        // 답변이 질문을 충분히 다룸
    "needs_docs",      // 문서 검색 필요
    "hallucination",   // 근거 없는 답변 (문서로 검증 필요)
    "off_topic"        // 질문과 무관한 답변
  ]),

  // 평가 근거
  reason: z.string(),

  // 신뢰도
  confidence: z.number().min(0).max(1)
});
```

### 평가 기준

| 평가 결과 | 설명 | 다음 단계 |
|----------|------|----------|
| `adequate` | 답변이 질문을 충분히 다룸 | END |
| `needs_docs` | 문서 검색이 필요한 질문 | retrieveDocs → regenerate |
| `hallucination` | 근거 없는 주장 포함 | retrieveDocs → regenerate |
| `off_topic` | 질문과 무관한 답변 | classifyQuery (재분류) |

### 평가 프롬프트

```javascript
// workflow/prompts.js

const EVALUATE_ANSWER_PROMPT = `You are an answer quality evaluator for a document Q&A system.

CONVERSATION HISTORY:
{history}

USER'S QUESTION:
{question}

GENERATED ANSWER:
{answer}

DOCUMENTS USED (if any):
{documents}

EVALUATE the answer quality:

1. "adequate" - Answer fully addresses the question
   - For chitchat/greetings: appropriate response
   - For follow-ups: correctly references previous context
   - For document questions: answer is supported by documents
   - For general knowledge: reasonable and accurate response

2. "needs_docs" - Answer is insufficient, document search needed
   - Question asks about specific technical details not in context
   - Answer is vague or says "I don't know" for document-related question
   - Question references specific features/APIs/configurations
   - User asks about "how to" do something specific

3. "hallucination" - Answer contains unsupported claims
   - Claims specific facts without document support
   - Invents features, APIs, or details not in documents
   - Provides code examples that may be incorrect
   - States specific version numbers or configurations without source

4. "off_topic" - Answer doesn't address the question
   - Completely misunderstands the question
   - Answers a different question
   - Ignores key parts of the question

IMPORTANT CONSIDERATIONS:
- Was RAG used for this answer? (documents provided: {has_documents})
- If no documents were used, could documents have improved the answer?
- Is the answer based on conversation context alone appropriate?
- Are there specific technical claims that need document verification?

Respond with JSON: {answerQuality, reason, confidence}`;
```

---

## 라우팅 로직

### 평가 기반 라우팅

```javascript
// workflow/graph.js

function routeByEvaluation(state) {
  const { answerQuality, usedRAG, retryCount } = state;

  // 최대 재시도 횟수 제한 (무한 루프 방지)
  if (retryCount >= 2) {
    return END;
  }

  switch (answerQuality) {
    case "adequate":
      // 답변 충분 → 종료
      return END;

    case "needs_docs":
      if (!usedRAG) {
        // RAG 없이 답변했는데 문서 필요 → RAG로 재시도
        return "retrieveDocs";
      }
      // RAG 했는데도 부족 → 쿼리 재작성 후 재시도
      return "rewriteQuery";

    case "hallucination":
      // 근거 없는 답변 → 반드시 문서 검색
      return "retrieveDocs";

    case "off_topic":
      // 질문 이해 실패 → 재분류 후 재시도
      return "classifyQuery";

    default:
      return END;
  }
}
```

### 상태 확장

```javascript
// workflow/state.js 추가 필드

// 평가 결과
answerQuality: Annotation({
  reducer: (_, action) => action,
  default: () => null,
}),

// RAG 사용 여부
usedRAG: Annotation({
  reducer: (_, action) => action,
  default: () => false,
}),

// 재시도 횟수
retryCount: Annotation({
  reducer: (_, action) => action,
  default: () => 0,
}),

// 평가 이유
evaluationReason: Annotation({
  reducer: (_, action) => action,
  default: () => "",
}),
```

---

## 대화 기억 개선

### 옵션 A: 이전 메시지 포함 (권장)

```javascript
// chatbot-service.js 수정

async chat(sessionId, message, options = {}) {
  const session = this.sessions.get(sessionId);

  // 이전 메시지를 LangChain 메시지로 변환 (최근 N개)
  const maxHistory = 10;  // 설정 가능
  const previousMessages = session.messages
    .slice(-maxHistory)
    .map(msg =>
      msg.role === 'user'
        ? new HumanMessage(msg.content)
        : new AIMessage(msg.content)
    );

  const input = {
    messages: [...previousMessages, new HumanMessage(message)],
    thinkingMode
  };

  // ... rest of the code
}
```

### 옵션 B: 대화 요약 활용

```javascript
// 긴 대화의 경우 요약 사용
const input = {
  messages: [new HumanMessage(message)],
  summary: session.summary,  // 이전 대화 요약
  thinkingMode
};
```

---

## 구현 계획

### Phase 1: 평가 노드 추가
1. `workflow/nodes/evaluate.js` 생성
2. 평가 스키마 및 프롬프트 정의
3. 평가 노드 함수 구현

### Phase 2: 워크플로우 수정
1. `workflow/state.js` 상태 필드 추가
2. `workflow/graph.js` 노드 및 엣지 추가
3. 라우팅 로직 구현

### Phase 3: 대화 기억 개선
1. `chatbot-service.js` 메시지 히스토리 전달
2. 생성 프롬프트에 대화 컨텍스트 포함

### Phase 4: 테스트
1. 단위 테스트: 평가 노드
2. 통합 테스트: 자가 수정 시나리오
3. E2E 테스트: Playwright로 UI 테스트

---

## 예상 시나리오

### 시나리오 1: 후속 질문 (RAG 불필요)

```
User: "FxStore가 뭐야?"
→ classify: question
→ generate (fast): "FxStore는 Java 기반 영속 컬렉션 라이브러리..."
→ evaluate: adequate (이전 답변 기반으로 충분)
→ END
```

### 시나리오 2: 기술 질문 (RAG 필요)

```
User: "FxStore API 사용법 알려줘"
→ classify: question
→ generate (fast): "FxStore API는... (모호한 답변)"
→ evaluate: needs_docs (구체적 API 정보 필요)
→ retrieveDocs
→ regenerate: "FxStore API 사용법은 다음과 같습니다... [Source: api.md]"
→ evaluate: adequate
→ END
```

### 시나리오 3: Hallucination 감지

```
User: "FxStore 최신 버전이 뭐야?"
→ classify: question
→ generate (fast): "FxStore 최신 버전은 2.0.0입니다" (근거 없음)
→ evaluate: hallucination (버전 정보는 문서 확인 필요)
→ retrieveDocs
→ regenerate: "문서에 따르면 FxStore 버전은 0.3.0입니다 [Source: installation.md]"
→ evaluate: adequate
→ END
```

---

## 장단점 비교

| 항목 | 현재 방식 | Self-Correcting RAG |
|------|----------|---------------------|
| 분류 실수 대응 | 불가 | 평가 후 수정 가능 |
| RAG 사용 빈도 | 높음 (대부분) | 필요시에만 |
| 응답 속도 (간단 질문) | 느림 | 빠름 (fast path) |
| 응답 품질 | 일정 | 자가 검증으로 향상 |
| LLM 호출 횟수 | 고정 | 가변 (1~3회) |
| 구현 복잡도 | 낮음 | 중간 |

---

## 설정 옵션

```json5
// config.json5
chatbot: {
  rag: {
    // 기존 설정...
  },

  // Self-Correcting RAG 설정
  selfCorrection: {
    enabled: true,              // 기능 활성화
    maxRetries: 2,              // 최대 재시도 횟수
    evaluationThreshold: 0.7,   // 평가 신뢰도 임계값
    fastPathEnabled: true,      // Fast path (RAG 없이 먼저 시도)
    historyLimit: 10            // 대화 히스토리 최대 개수
  }
}
```

---

## 참고 자료

- [Self-RAG Paper](https://arxiv.org/abs/2310.11511)
- [CRAG: Corrective Retrieval Augmented Generation](https://arxiv.org/abs/2401.15884)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)

---

## 변경 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `workflow/nodes/evaluate.js` | 신규: 평가 노드 |
| `workflow/prompts.js` | 평가 프롬프트 추가 |
| `workflow/state.js` | 상태 필드 추가 |
| `workflow/graph.js` | 노드/엣지 추가, 라우팅 수정 |
| `chatbot-service.js` | 대화 히스토리 전달 |
| `config.example.json5` | selfCorrection 설정 문서화 |

---

**작성일**: 2026-01-09
**버전**: 1.0.0 (Draft)
