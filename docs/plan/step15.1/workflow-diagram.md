# Step 15.1: sLLM 최적화 워크플로우 다이어그램

## 1. 전체 워크플로우

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              사용자 질문 입력                                  │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: 질문 분석                                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐         ┌─────────────────┐                           │
│   │ [1] CLASSIFY    │         │ [2] EXTRACT     │                           │
│   │    QUESTION     │ ──┬──── │    CONCEPTS     │  (병렬 실행 가능)          │
│   │                 │   │     │                 │                           │
│   │ simple/complex  │   │     │ concepts,       │                           │
│   │ confidence      │   │     │ keywords        │                           │
│   └─────────────────┘   │     └─────────────────┘                           │
│                         │                                                    │
└─────────────────────────┼────────────────────────────────────────────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ type check   │
                   └──────┬───────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
            ▼                           ▼
     ┌──────────┐                ┌──────────┐
     │  simple  │                │ complex  │
     └────┬─────┘                └────┬─────┘
          │                           │
          │                           ▼
          │     ┌──────────────────────────────────────────────────────────────┐
          │     │  PHASE 2: 질문 분해                                           │
          │     ├──────────────────────────────────────────────────────────────┤
          │     │                                                              │
          │     │   ┌─────────────────┐                                        │
          │     │   │ [3] DECOMPOSE   │                                        │
          │     │   │    QUESTION     │                                        │
          │     │   │                 │                                        │
          │     │   │ subQuestions[]  │                                        │
          │     │   └────────┬────────┘                                        │
          │     │            │                                                 │
          │     └────────────┼─────────────────────────────────────────────────┘
          │                  │
          │                  ▼
          │     ┌──────────────────────────────────────────────────────────────┐
          │     │  PHASE 3A: 하위 질문 답변 (순차 실행)                          │
          │     ├──────────────────────────────────────────────────────────────┤
          │     │                                                              │
          │     │   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐        │
          │     │   │ [4] ANSWER  │   │ [4] ANSWER  │   │ [4] ANSWER  │        │
          │     │   │   SUB_Q1    │──▶│   SUB_Q2    │──▶│   SUB_Q3    │        │
          │     │   │             │   │             │   │             │        │
          │     │   │ answer1     │   │ answer2     │   │ answer3     │        │
          │     │   └─────────────┘   └─────────────┘   └─────────────┘        │
          │     │                                              │               │
          │     └──────────────────────────────────────────────┼───────────────┘
          │                                                    │
          │                                                    ▼
          │     ┌──────────────────────────────────────────────────────────────┐
          │     │  PHASE 3B: 답변 조합                                          │
          │     ├──────────────────────────────────────────────────────────────┤
          │     │                                                              │
          │     │   ┌─────────────────┐                                        │
          │     │   │ [5] SYNTHESIZE  │                                        │
          │     │   │    ANSWERS      │                                        │
          │     │   │                 │                                        │
          │     │   │ synthesized     │                                        │
          │     │   │ answer          │                                        │
          │     │   └────────┬────────┘                                        │
          │     │            │                                                 │
          │     └────────────┼─────────────────────────────────────────────────┘
          │                  │
          ▼                  │
┌─────────────────┐          │
│ [6] ANSWER      │          │
│    SIMPLE       │          │
│                 │          │
│ direct answer   │          │
└────────┬────────┘          │
         │                   │
         └─────────┬─────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  PHASE 4: 다층 검증                                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────┐        │
│   │ [7] ENSEMBLE_VERIFY (3개 변형 병렬)                              │        │
│   │                                                                 │        │
│   │  ┌──────────┐   ┌──────────┐   ┌──────────┐                    │        │
│   │  │ Direct   │   │Conserv.  │   │Complete  │                    │        │
│   │  │ Check    │   │ Check    │   │ Check    │                    │        │
│   │  └────┬─────┘   └────┬─────┘   └────┬─────┘                    │        │
│   │       └──────────────┼──────────────┘                          │        │
│   │                      ▼                                         │        │
│   │              consensusScore                                    │        │
│   └──────────────────────┬──────────────────────────────────────────┘        │
│                          │                                                   │
│                          ▼                                                   │
│                   ┌──────────────┐                                           │
│                   │  score ≥ 80? │                                           │
│                   └──────┬───────┘                                           │
│                          │                                                   │
│            ┌─────────────┴─────────────┐                                     │
│            │ YES                       │ NO                                  │
│            ▼                           ▼                                     │
│     ┌──────────┐              ┌─────────────────┐                           │
│     │   END    │              │ [8] FACT_VERIFY │                           │
│     │ (빠른통과) │              │                 │                           │
│     └──────────┘              │ facts[],        │                           │
│                               │ overallScore    │                           │
│                               └────────┬────────┘                           │
│                                        │                                    │
│                                        ▼                                    │
│                                 ┌──────────────┐                            │
│                                 │  score ≥ 75? │                            │
│                                 └──────┬───────┘                            │
│                                        │                                    │
│                          ┌─────────────┴─────────────┐                      │
│                          │ YES                       │ NO                   │
│                          ▼                           ▼                      │
│                   ┌──────────┐              ┌─────────────────┐             │
│                   │   END    │              │ [9] REFINE      │             │
│                   │ (검증통과) │              │    ANSWER       │             │
│                   └──────────┘              │                 │             │
│                                             │ refinedAnswer   │             │
│                                             └────────┬────────┘             │
│                                                      │                      │
│                                                      ▼                      │
│                                               ┌──────────────┐              │
│                                               │ retry < 2?   │              │
│                                               └──────┬───────┘              │
│                                                      │                      │
│                                        ┌─────────────┴─────────────┐        │
│                                        │ YES                       │ NO     │
│                                        ▼                           ▼        │
│                                 ┌──────────────┐            ┌──────────┐    │
│                                 │ ENSEMBLE     │            │   END    │    │
│                                 │ VERIFY       │            │ (최종)    │    │
│                                 │ (재검증)      │            └──────────┘    │
│                                 └──────────────┘                            │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         최종 답변 + 신뢰도 점수                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Simple 질문 플로우

```
질문: "JWT란 무엇인가?"

[1] CLASSIFY → type: "simple", confidence: 0.95
[2] EXTRACT  → concepts: ["JWT", "인증"], keywords: ["JWT", "token"]
        │
        ▼
[6] ANSWER_SIMPLE
        │
        ├─ 문서 검색 (RAG)
        ├─ 답변 생성
        │
        ▼
[7] ENSEMBLE_VERIFY
        │
        ├─ Direct: score 85
        ├─ Conservative: score 90
        ├─ Completeness: score 82
        │
        └─ consensusScore: 86 (≥ 80)
              │
              ▼
            END (빠른 통과)

총 LLM 호출: 4회
예상 시간: 3-4초
```

---

## 3. Complex 질문 플로우

```
질문: "JWT와 OAuth2의 보안 측면 비교?"

[1] CLASSIFY → type: "complex", confidence: 0.92
[2] EXTRACT  → concepts: ["JWT", "OAuth2", "보안"], keywords: [...]
        │
        ▼
[3] DECOMPOSE
        │
        ├─ subQ1: "JWT란 무엇이고 어떻게 작동하나?"
        ├─ subQ2: "OAuth2란 무엇이고 어떻게 작동하나?"
        └─ subQ3: "각각의 보안 특성은?"
              │
              ▼
[4] ANSWER_SUBQUESTION × 3
        │
        ├─ answer1: "JWT는 토큰 기반 인증..."
        ├─ answer2: "OAuth2는 인증 위임 프레임워크..."
        └─ answer3: "JWT는 단순하지만 토큰 관리 필요..."
              │
              ▼
[5] SYNTHESIZE_ANSWERS
        │
        └─ "JWT와 OAuth2 비교: ..."
              │
              ▼
[7] ENSEMBLE_VERIFY
        │
        └─ consensusScore: 72 (< 80)
              │
              ▼
[8] FACT_VERIFY
        │
        ├─ fact1: "JWT는 토큰 기반" → verified
        ├─ fact2: "OAuth2는 위임 방식" → verified
        ├─ fact3: "JWT가 더 빠름" → inferred
        │
        └─ overallScore: 78 (≥ 75)
              │
              ▼
            END (검증 통과)

총 LLM 호출: 10회
예상 시간: 12-15초
```

---

## 4. 검증 실패 플로우

```
[7] ENSEMBLE_VERIFY
        │
        └─ consensusScore: 65 (< 80)
              │
              ▼
[8] FACT_VERIFY
        │
        ├─ fact1: "X는 Y이다" → verified
        ├─ fact2: "Z의 기본값은 100" → not_found  ⚠️
        ├─ fact3: "A는 B보다 빠름" → contradicted ❌
        │
        └─ overallScore: 55 (< 75)
              │
              ▼
[9] REFINE_ANSWER
        │
        ├─ 문제 사실 제거/수정
        │   - not_found: "문서에서 확인되지 않음" 추가
        │   - contradicted: 해당 주장 제거
        │
        └─ refinedAnswer: "개선된 답변..."
              │
              ▼
[7] ENSEMBLE_VERIFY (재검증, retry=1)
        │
        └─ consensusScore: 82 (≥ 80)
              │
              ▼
            END
```

---

## 5. 노드별 입출력

### 5.1 CLASSIFY_QUESTION

```
입력:
  - question: string

출력:
  - type: "simple" | "complex"
  - confidence: 0.0 - 1.0
  - reason: string
```

### 5.2 EXTRACT_CONCEPTS

```
입력:
  - question: string

출력:
  - coreConcepts: string[]
  - keywords: string[]
```

### 5.3 DECOMPOSE_QUESTION

```
입력:
  - question: string
  - concepts: {coreConcepts, keywords}

출력:
  - subQuestions: Array<{order, question}>
  - logic: string
```

### 5.4 ANSWER_SUBQUESTION

```
입력:
  - originalQuestion: string
  - subQuestion: string
  - documents: Document[]

출력:
  - answer: string
  - sources: string[]
```

### 5.5 SYNTHESIZE_ANSWERS

```
입력:
  - originalQuestion: string
  - subAnswers: Array<{question, answer}>

출력:
  - synthesizedAnswer: string
```

### 5.6 ANSWER_SIMPLE

```
입력:
  - question: string
  - documents: Document[]

출력:
  - answer: string
  - sources: string[]
```

### 5.7 ENSEMBLE_VERIFY

```
입력:
  - question: string
  - answer: string
  - documents: Document[]

출력:
  - variants: Array<{name, result, score}>
  - consensusScore: 0-100
```

### 5.8 FACT_VERIFY

```
입력:
  - answer: string
  - documents: Document[]

출력:
  - facts: Array<{text, status, evidence}>
  - summary: {verified, inferred, not_found, contradicted}
  - overallScore: 0-100
```

### 5.9 REFINE_ANSWER

```
입력:
  - answer: string
  - issues: string[]
  - unverifiedFacts: string[]
  - contradictedFacts: string[]

출력:
  - refinedAnswer: string
```

---

## 6. 상태 전이 다이어그램

```
                          ┌─────────────┐
                          │   START     │
                          └──────┬──────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │  CLASSIFY   │
                          └──────┬──────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
             ┌─────────────┐           ┌─────────────┐
             │   SIMPLE    │           │   COMPLEX   │
             │   PATH      │           │   PATH      │
             └──────┬──────┘           └──────┬──────┘
                    │                         │
                    │                         ▼
                    │                  ┌─────────────┐
                    │                  │  DECOMPOSE  │
                    │                  └──────┬──────┘
                    │                         │
                    │                         ▼
                    │                  ┌─────────────┐
                    │                  │ ANSWER_SUBS │◄──┐
                    │                  └──────┬──────┘   │
                    │                         │          │ more subs
                    │                         ├──────────┘
                    │                         │
                    │                         ▼
                    │                  ┌─────────────┐
                    │                  │ SYNTHESIZE  │
                    │                  └──────┬──────┘
                    │                         │
                    ▼                         │
             ┌─────────────┐                  │
             │ANSWER_SIMPLE│                  │
             └──────┬──────┘                  │
                    │                         │
                    └────────────┬────────────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │  ENSEMBLE   │
                          │   VERIFY    │
                          └──────┬──────┘
                                 │
                    ┌────────────┴────────────┐
                    │ score >= 80             │ score < 80
                    ▼                         ▼
             ┌─────────────┐           ┌─────────────┐
             │    END      │           │ FACT_VERIFY │
             │ (빠른 통과)  │           └──────┬──────┘
             └─────────────┘                  │
                                 ┌────────────┴────────────┐
                                 │ score >= 75             │ score < 75
                                 ▼                         ▼
                          ┌─────────────┐           ┌─────────────┐
                          │    END      │           │   REFINE    │
                          │ (검증 통과)  │           └──────┬──────┘
                          └─────────────┘                  │
                                                          │
                                              ┌───────────┴───────────┐
                                              │ retry < 2             │ retry >= 2
                                              ▼                       ▼
                                       ┌─────────────┐         ┌─────────────┐
                                       │  ENSEMBLE   │         │    END      │
                                       │   VERIFY    │         │ (최종)       │
                                       │  (재검증)   │         └─────────────┘
                                       └─────────────┘
```

---

## 7. 병렬 처리 기회

### 7.1 Phase 1 병렬화

```javascript
// CLASSIFY와 EXTRACT를 동시 실행
const [classifyResult, extractResult] = await Promise.all([
  classifyQuestion(state),
  extractConcepts(state)
]);
```

### 7.2 Phase 4 병렬화

```javascript
// 3개 앙상블 변형을 동시 실행
const [directResult, conservativeResult, completenessResult] = await Promise.all([
  verifyDirect(state),
  verifyConservative(state),
  verifyCompleteness(state)
]);
```

---

## 8. 타임아웃 및 에러 처리

```
각 노드별 타임아웃:
- CLASSIFY: 5초
- EXTRACT: 5초
- DECOMPOSE: 10초
- ANSWER_*: 15초
- SYNTHESIZE: 10초
- VERIFY_*: 10초
- REFINE: 15초

전체 타임아웃: 60초

에러 시:
- 재시도: 1회
- 폴백: 키워드/휴리스틱 기반
- 최종 실패: 부분 답변 반환
```

---

**작성일**: 2026-01-15
**버전**: 1.0.0
