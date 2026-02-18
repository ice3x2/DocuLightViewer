# Step 15.1: sLLM 최적화 프롬프트 설계

## 0. 기존 코드와의 일관성

### 0.1 State 필드 매핑

기존 `state.js`의 필드를 재사용:

| 프롬프트 출력 | State 필드 | 비고 |
|-------------|-----------|------|
| `type: "simple"/"complex"` | `queryType` | 기존 필드 재사용 |
| `confidence: 0-1` | `confidence` | 기존 필드 재사용 |
| 개념 추출 결과 | `sllmExtractedConcepts` | 신규 필드 |
| 질문 분해 결과 | `sllmDecomposedQuestions` | 신규 필드 |
| 앙상블 검증 결과 | `sllmEnsembleResults` | 신규 필드 |
| 사실 검증 결과 | `sllmFactVerification` | 신규 필드 |

### 0.2 기존 노드 참고

프롬프트 구현 시 기존 노드 패턴 참고:
- `nodes/classify.js` → CLASSIFY_QUESTION
- `nodes/generate.js` → ANSWER_SIMPLE, ANSWER_SUBQUESTION
- `nodes/evaluate.js` → ENSEMBLE_VERIFY, FACT_VERIFY

---

## 1. 프롬프트 설계 원칙

### 1.1 sLLM 최적화 원칙

| 원칙 | 설명 | 예시 |
|------|------|------|
| **단일 작업** | 각 프롬프트는 1가지 작업만 | "분류만 하라" (분석+분류 X) |
| **긍정형 지시** | 부정형 제거 | "문서만 사용" ("가정하지 말라" X) |
| **구조화 출력** | JSON 형식 강제 | `{"type": "simple"}` |
| **짧은 예시** | 1-2개 예시만 | 과도한 few-shot 제거 |
| **명확한 제약** | 길이/형식 명시 | "2-5문장", "JSON만" |

### 1.2 토큰 예산

```
총 컨텍스트: 4K 토큰 (sLLM 기준)

할당:
- 시스템 프롬프트: 200-300 토큰
- 사용자 입력: 50-100 토큰
- 문서 컨텍스트: 2000-2500 토큰
- 생성 공간: 1000-1200 토큰
```

---

## 2. Phase 1: 질문 분석 프롬프트

### 2.1 CLASSIFY_QUESTION

**목적**: 질문이 simple인지 complex인지 판정

```
Your task: Identify if this question is SIMPLE or COMPLEX.

DEFINITION:
- SIMPLE: Single, clear question with one direct answer
  Example: "What is JWT?"
- COMPLEX: Needs multiple pieces of information or comparisons
  Example: "Compare JWT and OAuth2 security"

QUESTION: {question}

Output JSON only:
{
  "type": "simple" or "complex",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence"
}
```

**특징**:
- 토큰: ~150
- 온도: 0.1 (일관성)
- 폴백: 키워드 기반 분류

**폴백 로직**:
```javascript
function classifyByKeywords(question) {
  const complexPatterns = [
    /비교|차이|versus|vs\./i,
    /장단점|pros.*cons/i,
    /왜.*어떻게|why.*how/i,
    /여러|multiple|both/i
  ];

  const isComplex = complexPatterns.some(p => p.test(question));
  return { type: isComplex ? 'complex' : 'simple', confidence: 0.7 };
}
```

---

### 2.2 EXTRACT_CONCEPTS

**목적**: 핵심 개념과 키워드 추출

```
Your task: Extract KEY CONCEPTS from the question.

QUESTION: {question}

EXTRACT:
1. Core concepts: Main ideas in the question (2-5 items)
2. Keywords: Specific technical terms (2-5 items)

Output JSON only:
{
  "coreConcepts": ["concept1", "concept2"],
  "keywords": ["keyword1", "keyword2"]
}
```

**특징**:
- 토큰: ~100
- 온도: 0.3
- 폴백: 명사 추출 (NLP)

**폴백 로직**:
```javascript
function extractByPattern(question) {
  // 따옴표 내용, 대문자 단어, 기술 용어 추출
  const quoted = question.match(/"([^"]+)"|'([^']+)'/g) || [];
  const technical = question.match(/[A-Z][a-zA-Z0-9]+/g) || [];

  return {
    coreConcepts: [...new Set([...quoted, ...technical])].slice(0, 5),
    keywords: technical.slice(0, 5)
  };
}
```

---

## 3. Phase 2: 질문 분해 프롬프트

### 3.1 DECOMPOSE_QUESTION

**목적**: 복잡한 질문을 2-3개 하위 질문으로 분해

```
Your task: Break this COMPLEX question into 2-3 simple sub-questions.

QUESTION: {question}
KEY CONCEPTS: {concepts}

RULE: Create sub-questions that:
1. Are simpler than the original (each answerable independently)
2. Together, fully answer the original question
3. Maximum 3 sub-questions

EXAMPLE:
Original: "How does JWT improve API security?"
Sub-questions:
1. What is JWT?
2. How does JWT work in APIs?
3. What security benefits does JWT provide?

Output JSON only:
{
  "subQuestions": [
    {"order": 1, "question": "sub-question 1"},
    {"order": 2, "question": "sub-question 2"},
    {"order": 3, "question": "sub-question 3"}
  ],
  "logic": "brief explanation of how they combine"
}
```

**특징**:
- 토큰: ~250
- 온도: 0.5
- 폴백: 템플릿 기반 분해

**폴백 로직**:
```javascript
function decomposeByTemplate(question, concepts) {
  // 비교 질문
  if (/비교|차이|vs/i.test(question)) {
    const [a, b] = concepts.slice(0, 2);
    return {
      subQuestions: [
        { order: 1, question: `${a}는 무엇인가?` },
        { order: 2, question: `${b}는 무엇인가?` },
        { order: 3, question: `${a}와 ${b}의 주요 차이점은?` }
      ]
    };
  }

  // 방법 질문
  if (/어떻게|how/i.test(question)) {
    const topic = concepts[0];
    return {
      subQuestions: [
        { order: 1, question: `${topic}는 무엇인가?` },
        { order: 2, question: `${topic}의 사용 방법은?` },
        { order: 3, question: `${topic} 사용 시 주의사항은?` }
      ]
    };
  }

  // 기본
  return {
    subQuestions: [
      { order: 1, question: question }
    ]
  };
}
```

---

## 4. Phase 3: 답변 생성 프롬프트

### 4.1 ANSWER_SUBQUESTION

**목적**: 하위 질문 1개에 대해 답변

```
Your task: Answer ONLY this ONE sub-question.

ORIGINAL QUESTION (for context):
{originalQuestion}

SUB-QUESTION TO ANSWER:
{subQuestion}

RELEVANT DOCUMENTS:
{documents}

RULES:
1. Answer ONLY the sub-question, not the full original question
2. Use ONLY information from the documents above
3. If documents don't contain the answer: say "Not found in documents"
4. Keep answer concise: 2-5 sentences
5. Cite source: [Source: filename.md]

ANSWER:
```

**특징**:
- 토큰: ~200 + 문서
- 온도: 0.3
- 출력 길이: 최대 150 토큰

---

### 4.2 SYNTHESIZE_ANSWERS

**목적**: 모든 하위 답변을 하나로 조합

```
Your task: Combine all sub-answers into ONE complete answer.

ORIGINAL QUESTION: {originalQuestion}

SUB-QUESTION ANSWERS:
1. Q: {subQ1}
   A: {answer1}

2. Q: {subQ2}
   A: {answer2}

3. Q: {subQ3}
   A: {answer3}

RULES:
1. Create a single coherent answer that addresses the original question
2. Synthesize the information (don't just concatenate)
3. Remove redundancy between answers
4. Organize logically
5. Include source citations: [Source: filename.md]
6. Length: 3-7 sentences

SYNTHESIS PATTERN:
"Considering [insight from A1], [insight from A2], and [insight from A3],
the answer to '[original question]' is: ..."

SYNTHESIZED ANSWER:
```

**특징**:
- 토큰: ~300 + 하위 답변들
- 온도: 0.5
- 출력 길이: 최대 200 토큰

---

### 4.3 ANSWER_SIMPLE

**목적**: 간단한 질문에 직접 답변

```
Your task: Provide a direct answer to this question.

QUESTION: {question}

DOCUMENTS:
{documents}

RULES:
1. Give a direct answer (no preamble like "Sure, I can help...")
2. Support with information from documents
3. Use clear structure:
   - Main answer (1-2 sentences)
   - Supporting details (if needed)
   - Source references: [Source: filename.md]
4. Total length: 3-8 sentences

ANSWER:
```

**특징**:
- 토큰: ~150 + 문서
- 온도: 0.3
- 출력 길이: 최대 200 토큰

---

## 5. Phase 4: 검증 프롬프트 (2개 변형 - 시간 최적화)

> **변경사항**: 3개에서 2개 변형으로 축소하여 시간 최적화 (20초 목표 달성)

### 5.1 ENSEMBLE_VERIFY - Variant A (Accuracy Check)

**목적**: 답변이 문서와 일치하고 지원되지 않는 주장이 없는지 확인 (Direct + Conservative 통합)

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

**특징**:
- 토큰: ~200 + 문서
- 온도: 0.1 (객관성)
- 기존 Direct와 Conservative 역할 통합

---

### 5.2 ENSEMBLE_VERIFY - Variant B (Completeness Check)

**목적**: 답변이 질문을 완전히 다루는지 확인

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

**특징**:
- 토큰: ~150
- 온도: 0.1 (객관성)
- 문서 불필요 (답변과 질문만 비교)

---

### 5.3 앙상블 점수 계산

```javascript
function calculateEnsembleScore(variantA, variantB) {
  // Accuracy (60%) + Completeness (40%)
  return (variantA.score * 0.6) + (variantB.score * 0.4);
}
```

---

### 5.4 FACT_VERIFY

**목적**: 답변을 사실 단위로 분해하고 각각 검증

```
Your task: Break this answer into individual facts and verify each.

ANSWER: {answer}

DOCUMENTS:
{documents}

STEPS:
1. Extract each factual claim from the answer
2. For each fact, search for evidence in documents
3. Mark each fact as:
   - "verified": Found exact or very similar statement in documents
   - "inferred": Can be reasonably concluded from documents
   - "not_found": No evidence in documents
   - "contradicted": Documents say something different

Output JSON:
{
  "facts": [
    {
      "id": 1,
      "text": "factual claim",
      "status": "verified|inferred|not_found|contradicted",
      "evidence": "quote from document" or null,
      "documentSource": "filename.md" or null
    }
  ],
  "summary": {
    "verified": N,
    "inferred": N,
    "not_found": N,
    "contradicted": N
  },
  "overallScore": 0-100
}
```

**특징**:
- 토큰: ~400 + 문서
- 온도: 0.1 (객관성)
- 중요도: 높음 (Hallucination 감지)

---

### 5.5 REFINE_ANSWER

**목적**: 검증 피드백을 반영하여 답변 개선

```
Your task: Improve this answer based on verification feedback.

ORIGINAL ANSWER:
{answer}

ISSUES FOUND:
{issues}

UNVERIFIED FACTS:
{unverifiedFacts}

CONTRADICTED FACTS:
{contradictedFacts}

RULES:
1. Fix all identified issues
2. Remove contradicted claims completely
3. For unverified facts: either remove OR add "according to available documents, this is not confirmed"
4. Keep verified facts unchanged
5. Maintain concise length (don't add filler)

IMPROVED ANSWER:
```

**특징**:
- 토큰: ~300 + 원본 답변
- 온도: 0.3
- 출력: 개선된 답변

---

## 6. 신뢰도 계산

### 6.1 Ensemble 신뢰도 (2개 변형)

```javascript
function calculateEnsembleConfidence(variantA, variantB) {
  // 가중 평균: Accuracy 60%, Completeness 40%
  const weightedScore = (variantA.score * 0.6) + (variantB.score * 0.4);

  // 두 변형 모두 통과해야 함
  const bothPass = variantA.score >= 70 && variantB.score >= 70;
  const anyFail = variantA.score < 50 || variantB.score < 50;

  if (bothPass) return weightedScore;
  if (anyFail) return Math.min(weightedScore, 50);

  return weightedScore * 0.9; // 부분 불일치 시 10% 감점
}
```

### 6.2 Fact 신뢰도

```javascript
function calculateFactConfidence(factResult) {
  const { verified, inferred, not_found, contradicted } = factResult.summary;
  const total = verified + inferred + not_found + contradicted;

  if (total === 0) return 0;

  // 가중치 점수
  const score = (
    (verified * 100) +
    (inferred * 70) +
    (not_found * 0) +
    (contradicted * -50)
  ) / total;

  return Math.max(0, Math.min(100, score));
}
```

### 6.3 최종 신뢰도

```javascript
function calculateFinalConfidence(ensembleConf, factConf, refinementCount) {
  // 가중 평균
  let confidence = (ensembleConf * 0.4) + (factConf * 0.6);

  // 개선 횟수에 따른 보정
  if (refinementCount > 0) {
    confidence = Math.min(confidence * 1.1, 95); // 개선됨 = 보너스
  }

  return Math.round(confidence);
}
```

---

## 7. 에러 처리

### 7.1 JSON 파싱 실패

```javascript
function parseWithFallback(response, fallbackFn) {
  try {
    // JSON 추출 시도
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('JSON parse failed, using fallback');
  }

  // 폴백 함수 실행
  return fallbackFn(response);
}
```

### 7.2 빈 응답 처리

```javascript
function handleEmptyResponse(nodeName, state) {
  const defaults = {
    'classify': { type: 'simple', confidence: 0.5 },
    'extract': { coreConcepts: [], keywords: [] },
    'decompose': { subQuestions: [{ order: 1, question: state.question }] },
    'verify': { score: 50, issues: ['Response was empty'] }
  };

  return defaults[nodeName] || {};
}
```

---

## 8. 온도 설정 가이드

| 노드 | 온도 | 이유 |
|------|------|------|
| CLASSIFY | 0.1 | 일관된 분류 필요 |
| EXTRACT | 0.3 | 약간의 유연성 |
| DECOMPOSE | 0.5 | 창의적 분해 허용 |
| ANSWER_* | 0.3 | 사실 기반 답변 |
| SYNTHESIZE | 0.5 | 자연스러운 조합 |
| VERIFY_* | 0.1 | 객관적 평가 |
| REFINE | 0.3 | 정확한 수정 |

---

## 9. 프롬프트 테스트 체크리스트

각 프롬프트에 대해:

- [ ] JSON 출력이 올바르게 파싱되는가?
- [ ] 폴백 로직이 작동하는가?
- [ ] 토큰 사용량이 예산 내인가?
- [ ] 온도 설정이 적절한가?
- [ ] 다국어(한글) 입력에 대응하는가?
- [ ] 빈 문서/컨텍스트 처리가 되는가?

---

**작성일**: 2026-01-15
**버전**: 1.0.0
