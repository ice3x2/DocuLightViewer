# Step 15.1: sLLM(1.2B) 최적화 Thinking Mode 구현 계획

## 1. 개요

### 1.1 목표
- sLLM(1.2B 파라미터) 환경에서 복잡한 질문도 단계별 사고 과정으로 처리
- 최종 답변 정확도 **90% 이상** 달성
- 시간 목표: Simple 5초, Complex 15초 (최대 20초)

### 1.2 모드 분리

#### Normal 모드 (기존)
- **대상**: 일반 LLM (GPT-4, Claude 등) 사용 시
- **워크플로우**: `graph.js`의 기존 플로우 (basic, self-correcting, thinking, simple)
- **State 필드**: `queryType`, `confidence`, `thinkingMode`, `thinkingAnalysis` 등 기존 필드 사용
- **특징**: 단일 LLM 호출로 복잡한 작업 처리 가능

#### sLLM Thinking 모드 (신규)
- **대상**: sLLM(1.2B-32B) 사용 시 복잡한 질문
- **워크플로우**: `sllm-graph.js`의 새로운 플로우
- **State 필드**: 기존 필드 재사용 + sLLM 전용 필드 추가
- **특징**: 각 LLM 호출을 단일 작업으로 분리하여 정확도 향상

#### 모드 선택 로직
```javascript
// config.json5의 chatbot.sllm.enabled로 결정
if (config.chatbot.sllm?.enabled) {
  // sLLM 모드: sllm-graph.js 사용
  return sllmGraph;
} else {
  // Normal 모드: 기존 graph.js 사용
  return normalGraph;
}
```

### 1.3 핵심 원칙
1. **극단적 단순화**: 각 LLM 호출은 정확히 1가지 작업만 수행
2. **다층 검증**: 여러 검증 단계를 거쳐 오류를 걸러냄
3. **분해 전략**: 복잡한 질문 → 단순한 하위 질문들로 분해

### 1.3 현재 문제점
| 현재 구현 | 문제 |
|----------|------|
| ANALYZE 노드 | 분석+분류+식별+설명 (4가지 동시) → 실패율 높음 |
| PLAN 노드 | 전략+단계+복잡도 (3가지 동시) → 추상적 사고 어려움 |
| EXECUTE 노드 | 이전결과+계획+컨텍스트+현재단계 → 토큰 과부하 |

---

## 2. 아키텍처 설계

### 2.1 새로운 워크플로우 구조

```
질문 입력
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: 질문 분석 (단순화)                                  │
├─────────────────────────────────────────────────────────────┤
│ [1] CLASSIFY_QUESTION                                        │
│     • 작업: simple vs complex 판정만                         │
│     • 출력: {type, confidence}                               │
│                                                              │
│ [2] EXTRACT_CONCEPTS                                         │
│     • 작업: 핵심 개념/키워드 추출만                           │
│     • 출력: {concepts, keywords, topics}                     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: 질문 분해 (복잡한 질문만)                           │
├─────────────────────────────────────────────────────────────┤
│ [3] DECOMPOSE_QUESTION                                       │
│     • 작업: 2-3개 하위 질문으로 분해                         │
│     • 출력: {subQuestions: [{order, question}]}              │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: 답변 생성                                           │
├─────────────────────────────────────────────────────────────┤
│ [4] ANSWER_SUBQUESTION (반복: 각 하위 질문)                  │
│     • 작업: 하위 질문 1개만 답변                             │
│     • 출력: {answer, sources}                                │
│                                                              │
│ [5] SYNTHESIZE_ANSWERS (복잡한 질문만)                       │
│     • 작업: 모든 하위 답변을 조합                            │
│     • 출력: {finalAnswer}                                    │
│                                                              │
│ [6] ANSWER_SIMPLE (간단한 질문)                              │
│     • 작업: 직접 답변 생성                                   │
│     • 출력: {answer}                                         │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: 다층 검증 (90% 정확도 달성)                         │
├─────────────────────────────────────────────────────────────┤
│ [7] ENSEMBLE_VERIFY                                          │
│     • 작업: 2개 프롬프트 변형으로 검증 (시간 최적화)         │
│     • 출력: {consensusScore, variants}                       │
│                                                              │
│ [8] FACT_VERIFY                                              │
│     • 작업: 답변을 사실 단위로 분해 후 검증                  │
│     • 출력: {facts: [{text, verified, evidence}]}            │
│                                                              │
│ [9] REFINE_ANSWER (신뢰도 < 80% 시)                          │
│     • 작업: 비평 → 개선                                      │
│     • 출력: {refinedAnswer}                                  │
└─────────────────────────────────────────────────────────────┘
    ↓
최종 답변 + 신뢰도 점수
```

### 2.2 조건 분기 로직

```
START
  ↓
CLASSIFY_QUESTION
  ↓
EXTRACT_CONCEPTS (병렬 가능)
  ↓
IF type == "simple":
  └→ ANSWER_SIMPLE
     └→ ENSEMBLE_VERIFY
        └→ confidence >= 85% ? → END (Early Exit)
           └→ FACT_VERIFY
              └→ confidence >= 75% ? → END
                 └→ REFINE_ANSWER → END

IF type == "complex":
  └→ DECOMPOSE_QUESTION
     └→ [LOOP: 각 subQuestion]
        ├→ ANSWER_SUBQUESTION_1
        ├→ ANSWER_SUBQUESTION_2
        └→ ANSWER_SUBQUESTION_3
        └→ SYNTHESIZE_ANSWERS
           └→ ENSEMBLE_VERIFY
              └→ (위와 동일한 검증 로직)
```

### 2.3 Early Exit 조건

```
┌─────────────────────────────────────────────────────────────┐
│                    Early Exit 플로우                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ENSEMBLE_VERIFY 결과                                        │
│         ↓                                                    │
│  ┌─────────────────┐                                         │
│  │ confidence >= 85%│─── YES ──→ 🏁 END (빠른 종료)          │
│  └─────────────────┘                                         │
│         │ NO                                                 │
│         ↓                                                    │
│  ┌─────────────────┐                                         │
│  │ confidence >= 70%│─── YES ──→ FACT_VERIFY                 │
│  └─────────────────┘                    │                    │
│         │ NO                            ↓                    │
│         ↓                    confidence >= 75% ?             │
│  FACT_VERIFY ────→ REFINE        │ YES    │ NO              │
│                                  ↓        ↓                  │
│                              🏁 END   REFINE_ANSWER          │
│                                              │               │
│                                              ↓               │
│                                          🏁 END              │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 병렬 처리 가능 노드

| 병렬 그룹 | 노드들 | 설명 |
|----------|-------|------|
| 분석 단계 | CLASSIFY + EXTRACT | 질문 분류와 개념 추출 동시 실행 |
| 하위 질문 답변 | ANSWER_SUB_1, _2, _3 | 각 하위 질문 독립적으로 답변 |
| 앙상블 검증 | Variant A + B | 두 검증 프롬프트 동시 실행 |

```javascript
// 병렬 처리 구현 예시
async function parallelPhase1(state) {
  const [classifyResult, extractResult] = await Promise.all([
    classifyQuestion(state),
    extractConcepts(state)
  ]);
  return { ...classifyResult, ...extractResult };
}

async function parallelSubQuestions(state, subQuestions) {
  const answers = await Promise.all(
    subQuestions.map(sq => answerSubQuestion(state, sq))
  );
  return answers;
}
```

---

## 3. 프롬프트 설계

### 3.1 [STEP 1] CLASSIFY_QUESTION

```
Your task: Identify if this question is SIMPLE or COMPLEX.

DEFINITION:
- SIMPLE: Single, clear question with one direct answer
  Examples: "What is X?", "How do I Y?"
- COMPLEX: Needs multiple pieces of information or comparisons
  Examples: "Compare X and Y", "Why does X happen and how to fix?"

QUESTION: {question}

Output JSON only:
{
  "type": "simple" or "complex",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence max"
}
```

### 3.2 [STEP 2] EXTRACT_CONCEPTS

```
Your task: Extract KEY CONCEPTS from the question.

QUESTION: {question}

EXTRACT:
1. Core concepts: Main ideas (2-5 items)
2. Keywords: Technical terms (2-5 items)

Output JSON only:
{
  "coreConcepts": ["concept1", "concept2"],
  "keywords": ["keyword1", "keyword2"]
}
```

### 3.3 [STEP 3] DECOMPOSE_QUESTION

```
Your task: Break this COMPLEX question into 2-3 simple sub-questions.

QUESTION: {question}
KEY CONCEPTS: {concepts}

RULE: Create sub-questions that:
1. Are simpler than the original
2. Together, fully answer the original question

Output JSON only:
{
  "subQuestions": [
    {"order": 1, "question": "sub-question 1"},
    {"order": 2, "question": "sub-question 2"},
    {"order": 3, "question": "sub-question 3"}
  ],
  "logic": "brief explanation"
}
```

### 3.4 [STEP 4] ANSWER_SUBQUESTION

```
Your task: Answer ONLY this ONE sub-question.

ORIGINAL QUESTION (context): {originalQuestion}
SUB-QUESTION TO ANSWER: {subQuestion}

DOCUMENTS:
{documents}

RULES:
1. Answer ONLY the sub-question
2. Use ONLY information from documents
3. If not found: say "Not found in documents"
4. Keep answer: 2-5 sentences
5. Cite: [Source: filename.md]

ANSWER:
```

### 3.5 [STEP 5] SYNTHESIZE_ANSWERS

```
Your task: Combine all sub-answers into ONE complete answer.

ORIGINAL QUESTION: {originalQuestion}

SUB-ANSWERS:
1. Q: {subQ1}
   A: {answer1}

2. Q: {subQ2}
   A: {answer2}

3. Q: {subQ3}
   A: {answer3}

RULES:
1. Create a single coherent answer
2. Synthesize, don't just concatenate
3. Remove redundancy
4. Include source citations
5. Length: 3-7 sentences

SYNTHESIZED ANSWER:
```

### 3.6 [STEP 6] ANSWER_SIMPLE

```
Your task: Provide a direct answer.

QUESTION: {question}

DOCUMENTS:
{documents}

RULES:
1. Direct answer (no preamble)
2. Support with document info
3. Structure:
   - Main answer (1-2 sentences)
   - Supporting details
   - [Source: filename.md]
4. Length: 3-8 sentences

ANSWER:
```

### 3.7 [STEP 7] ENSEMBLE_VERIFY (2개 변형 - 시간 최적화)

> 시간 절약을 위해 3개에서 2개 변형으로 축소. Direct와 Conservative를 통합.

**Variant A: Accuracy Check (Direct + Conservative 통합)**
```
QUESTION: {question}
ANSWER: {answer}
DOCUMENTS: {documents}

Check this answer:
1. Does it match the documents? [yes/no]
2. Does it answer the question? [yes/no]
3. Any unsupported claims? [list or empty]

Output JSON:
{
  "matchesDocuments": true/false,
  "answersQuestion": true/false,
  "unsupportedClaims": [...] or [],
  "score": 0-100
}
```

**Variant B: Completeness Check**
```
Does this answer fully address the question?

QUESTION: {question}
ANSWER: {answer}

Check:
1. Main question answered? [yes/partially/no]
2. Missing aspects? [list]

Output JSON:
{
  "mainAnswered": "yes" | "partially" | "no",
  "missingAspects": [...] or [],
  "score": 0-100
}
```

**앙상블 점수 계산:**
```javascript
function calculateEnsembleScore(variantA, variantB) {
  return (variantA.score * 0.6) + (variantB.score * 0.4);
}
```

### 3.8 [STEP 8] FACT_VERIFY

```
Your task: Break this answer into individual facts and verify each.

ANSWER: {answer}

DOCUMENTS:
{documents}

For each fact:
1. Extract the claim
2. Find evidence in documents
3. Mark as: verified / not_found / contradicted

Output JSON:
{
  "facts": [
    {"text": "fact1", "status": "verified", "evidence": "quote"},
    {"text": "fact2", "status": "not_found", "evidence": null}
  ],
  "overallScore": 0-100
}
```

### 3.9 [STEP 9] REFINE_ANSWER

```
Your task: Improve this answer based on verification feedback.

ORIGINAL ANSWER: {answer}

ISSUES FOUND:
{issues}

UNVERIFIED FACTS:
{unverifiedFacts}

RULES:
1. Fix identified issues
2. Remove unverified claims OR add "according to available documents"
3. Keep verified facts unchanged
4. Maintain concise length

IMPROVED ANSWER:
```

---

## 4. 상태 관리 (State)

### 4.1 기존 State 필드 재사용

기존 `state.js`의 필드를 최대한 재사용하여 코드 일관성 유지:

```typescript
// 기존 필드 재사용 (state.js에서)
queryType: 'simple' | 'complex';           // 질문 분류 (기존 필드)
confidence: number;                         // 분류 신뢰도 (기존 필드)
thinkingMode: boolean;                      // Thinking 모드 (기존 필드)
thinkingAnalysis: object;                   // 분석 결과 (기존 필드)
retrievedDocs: Document[];                  // 검색 문서 (기존 필드)
retryCount: number;                         // 재시도 횟수 (기존 필드)
```

### 4.2 sLLM 전용 State 필드 (신규)

```typescript
interface SLLMState {
  // Phase 1: 추출 결과
  sllmExtractedConcepts: {
    coreConcepts: string[];
    keywords: string[];
  };

  // Phase 2: 분해 결과 (복잡한 질문만)
  sllmDecomposedQuestions: Array<{
    order: number;
    question: string;
    answer?: string;
    sources?: string[];
  }>;

  // Phase 3: 답변
  sllmDraftAnswer: string;
  sllmSynthesizedAnswer?: string;

  // Phase 4: 검증
  sllmEnsembleResults: {
    variants: Array<{name: string; result: object}>;
    consensusScore: number;
  };

  sllmFactVerification: {
    facts: Array<{
      text: string;
      status: 'verified' | 'not_found' | 'contradicted';
      evidence?: string;
    }>;
    overallScore: number;
  };

  // 최종
  sllmFinalAnswer: string;
  sllmFinalConfidence: number;
  sllmRefinementCount: number;
}
```

### 4.3 State 필드 매핑

| 목적 | 기존 필드 | sLLM 신규 필드 |
|------|----------|---------------|
| 질문 분류 | `queryType` | (재사용) |
| 분류 신뢰도 | `confidence` | (재사용) |
| 개념 추출 | - | `sllmExtractedConcepts` |
| 질문 분해 | - | `sllmDecomposedQuestions` |
| 답변 초안 | - | `sllmDraftAnswer` |
| 앙상블 검증 | - | `sllmEnsembleResults` |
| 사실 검증 | - | `sllmFactVerification` |
| 최종 답변 | - | `sllmFinalAnswer` |

---

## 5. 구현 계획

### Phase 1: 기본 구조 (Week 1)

#### 5.1.1 새로운 노드 파일 생성

```
src/services/chatbot/workflow/nodes/sllm/
├── classify-question.js      # [STEP 1]
├── extract-concepts.js       # [STEP 2]
├── decompose-question.js     # [STEP 3]
├── answer-subquestion.js     # [STEP 4]
├── synthesize-answers.js     # [STEP 5]
├── answer-simple.js          # [STEP 6]
├── index.js                  # 모듈 export
```

#### 5.1.2 작업 항목
- [x] classify-question.js 구현 `2026-01-15`
- [x] extract-concepts.js 구현 `2026-01-15`
- [x] decompose-question.js 구현 `2026-01-15`
- [x] answer-subquestion.js 구현 `2026-01-15`
- [x] synthesize-answers.js 구현 `2026-01-15`
- [x] answer-simple.js 구현 `2026-01-15`
- [x] State 타입 확장 `2026-01-15`
- [x] 기본 그래프 생성 `2026-01-15`

### Phase 2: 검증 시스템 (Week 2)

#### 5.2.1 검증 노드 파일 생성

```
src/services/chatbot/workflow/nodes/sllm/verify/
├── ensemble-verify.js        # [STEP 7]
├── fact-verify.js            # [STEP 8]
├── refine-answer.js          # [STEP 9]
├── index.js
```

#### 5.2.2 작업 항목
- [x] ensemble-verify.js 구현 (2개 프롬프트 변형) `2026-01-15`
- [x] fact-verify.js 구현 (사실 분해 + 검증) `2026-01-15`
- [x] refine-answer.js 구현 (비평 + 개선) `2026-01-15`
- [x] 신뢰도 계산 로직 `2026-01-15`
- [x] 조건부 라우팅 구현 `2026-01-15`

### Phase 3: 통합 및 최적화 (Week 3)

#### 5.3.1 그래프 통합

```
src/services/chatbot/workflow/
├── sllm-graph.js             # sLLM 최적화 그래프
├── graph.js                  # 기존 (수정)
```

#### 5.3.2 작업 항목
- [x] sllm-graph.js 생성 (새로운 워크플로우) `2026-01-15`
- [ ] config에 sllm 모드 옵션 추가
- [ ] 기존 그래프와 통합
- [ ] 폴백 로직 구현
- [ ] 에러 핸들링 강화

### Phase 4: 테스트 및 튜닝 (Week 4)

#### 5.4.1 작업 항목
- [ ] 단위 테스트 작성
- [ ] 통합 테스트 작성
- [ ] 다양한 질문 유형 테스트
- [ ] 프롬프트 미세 조정
- [ ] 온도/파라미터 튜닝
- [ ] 정확도 벤치마크

---

## 6. 기존 노드 재사용

### 6.0 재사용 가능한 기존 노드

기존 구현된 노드를 최대한 재사용하여 개발 효율성 향상:

| 기존 노드 | 파일 위치 | sLLM에서 용도 |
|----------|----------|--------------|
| `classify` | `nodes/classify.js` | 질문 분류 베이스로 활용 |
| `retrieve` | `nodes/retrieve.js` | 문서 검색 (그대로 재사용) |
| `grade` | `nodes/grade.js` | 문서 관련성 평가 참고 |
| `generate` | `nodes/generate.js` | 답변 생성 패턴 참고 |
| `evaluate` | `nodes/evaluate.js` | 검증 로직 패턴 참고 |
| `rewrite` | `nodes/rewrite.js` | 쿼리 재작성 로직 참고 |

### 6.0.1 직접 재사용 노드

```javascript
// sllm-graph.js에서 기존 노드 직접 사용
const { retrieve } = require('./nodes/retrieve');
const { grade } = require('./nodes/grade');

// retrieve: 문서 검색은 동일 로직
// grade: 문서 관련성 평가도 동일
```

### 6.0.2 패턴 참고 노드

기존 노드의 구조와 에러 처리 패턴을 참고하여 신규 노드 구현:

```javascript
// 예: classify-question.js는 기존 classify.js 패턴 참고
// - 프롬프트 구조
// - JSON 파싱 로직
// - 폴백 처리
// - 에러 핸들링
```

### 6.1 파일 구조 - 신규 파일

```
src/services/chatbot/workflow/
├── nodes/
│   ├── sllm/                          # 새로 생성
│   │   ├── classify-question.js
│   │   ├── extract-concepts.js
│   │   ├── decompose-question.js
│   │   ├── answer-subquestion.js
│   │   ├── synthesize-answers.js
│   │   ├── answer-simple.js
│   │   ├── verify/
│   │   │   ├── ensemble-verify.js
│   │   │   ├── fact-verify.js
│   │   │   └── refine-answer.js
│   │   └── index.js
│   └── ... (기존 노드)
├── sllm-graph.js                      # 새로 생성
├── sllm-prompts.js                    # 새로 생성
└── ... (기존 파일)
```

### 6.2 파일 구조 - 수정 파일

```
src/services/chatbot/workflow/
├── state.js                           # State 타입 확장
├── graph.js                           # sLLM 모드 분기 추가

src/utils/
├── config-loader.js                   # sllm 옵션 추가
```

---

## 7. 설정 옵션

### 7.1 config.json5 추가 옵션

```json5
{
  chatbot: {
    // 기존 옵션...

    // sLLM 최적화 옵션
    sllm: {
      enabled: true,                    // sLLM 모드 활성화
      maxSubQuestions: 3,               // 최대 하위 질문 수
      ensembleVariants: 2,              // 앙상블 변형 수 (시간 최적화)
      factVerifyThreshold: 0.7,         // 사실 검증 임계값
      refinementMaxRetries: 1,          // 최대 개선 반복 (시간 최적화)
      timeoutMs: {
        simple: 15000,                  // Simple 질문 타임아웃
        complex: 20000                  // Complex 질문 타임아웃
      },
      confidenceThreshold: {
        high: 0.85,                     // FACT_VERIFY 스킵 기준
        medium: 0.70,                   // 추가 검증 기준
        low: 0.50                       // 재생성 기준
      }
    }
  }
}
```

---

## 8. 성능 목표

### 8.1 정확도 목표

| Phase | 예상 정확도 | 누적 |
|-------|-----------|------|
| 기본 sLLM | 60-65% | 60-65% |
| + 단순화 워크플로우 | +10% | 70-75% |
| + Ensemble Verify | +8% | 78-83% |
| + Fact Verify | +5% | 83-88% |
| + Refinement | +4% | 87-92% |

### 8.2 처리 시간 목표 (최대 20초)

| 질문 유형 | 예상 시간 | LLM 호출 | 타임아웃 |
|----------|----------|----------|----------|
| Simple (검증 통과) | 3-5초 | 3-4회 | 10초 |
| Simple (검증 필요) | 6-10초 | 5-6회 | 15초 |
| Complex (기본) | 10-15초 | 7-10회 | 20초 |
| Complex (재시도) | 15-20초 | 10-12회 | 25초 (예외) |

**시간 최적화 전략:**
1. Ensemble 2개 변형 사용 (3개에서 축소)
2. 병렬 처리 가능한 노드 식별 및 적용
3. 캐싱: 동일 질문에 대한 분류/개념 추출 결과 재사용
4. Early Exit: confidence >= 85%면 FACT_VERIFY 스킵

---

## 9. 테스트 계획

### 9.1 테스트 케이스

```
test/chatbot/sllm/
├── test-classify.js          # 분류 테스트
├── test-decompose.js         # 분해 테스트
├── test-verify.js            # 검증 테스트
├── test-e2e-simple.js        # 간단한 질문 E2E
├── test-e2e-complex.js       # 복잡한 질문 E2E
└── test-accuracy.js          # 정확도 벤치마크
```

### 9.2 테스트 질문 세트

```
Simple Questions (30개):
- "X는 무엇인가?"
- "Y를 어떻게 설정하나?"
- "Z의 기본값은?"

Complex Questions (30개):
- "X와 Y의 차이점은?"
- "A를 사용할 때 B와 C 중 어떤 것이 좋은가?"
- "D 문제가 발생하면 어떻게 해결하나?"

Edge Cases (10개):
- 모호한 질문
- 문서에 없는 정보
- 다국어 질문
```

---

## 10. 마일스톤

| 주차 | 목표 | 산출물 |
|------|------|--------|
| Week 1 | 기본 구조 | 6개 노드 구현 |
| Week 2 | 검증 시스템 | 3개 검증 노드 + 라우팅 |
| Week 3 | 통합 | sllm-graph.js + config |
| Week 4 | 테스트 | 테스트 + 90% 정확도 달성 |

---

## 11. 위험 요소 및 대응

| 위험 | 영향 | 대응 |
|------|------|------|
| JSON 파싱 실패 | 노드 실패 | 텍스트 폴백 파서 구현 |
| 신뢰도 과신 | 잘못된 답변 통과 | 신뢰도 10-15% 할인 적용 |
| 처리 시간 초과 | 사용자 경험 저하 | 타임아웃 + 중간 결과 반환 |
| 토큰 한계 초과 | 컨텍스트 손실 | 동적 청킹 + 요약 |

---

## 12. 참고 자료

- 연구 분석: 이전 대화에서 수행한 sLLM 최적화 연구
- 기존 구현: `src/services/chatbot/workflow/nodes/thinking/`
- 프롬프트 참고: `src/services/chatbot/workflow/prompts.js`

---

**작성일**: 2026-01-15
**버전**: 1.0.0
**상태**: 계획 수립 완료
