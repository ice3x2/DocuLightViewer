# Step 15: RAG 기반 문서 챗봇 시스템

## 1. 서론

### 1.1 목적

본 문서는 DocLight 시스템에 RAG(Retrieval-Augmented Generation) 기반 AI 챗봇을 추가하기 위한 소프트웨어 설계 명세서(SDS)입니다. 등록된 모든 Markdown 문서에 대해 자연어 질의응답을 수행하는 지능형 챗봇 시스템의 아키텍처, 구현 상세, 테스트 기준을 정의합니다.

### 1.2 범위

| 항목 | 포함 | 제외 |
|------|------|------|
| 문서 검색 | Markdown 파일 임베딩 및 벡터 검색 | PDF, 이미지 파일 처리 |
| LLM 통합 | OpenAI, Azure OpenAI, Ollama | Anthropic, Google 등 기타 |
| 벡터 저장소 | 인메모리 벡터 스토어 | 외부 벡터 DB (Pinecone, Weaviate 등) |
| 대화 관리 | 세션 기반 대화 히스토리 | 영구 대화 저장 |
| UI | 웹 기반 챗봇 인터페이스 | 모바일 앱, CLI |

### 1.3 용어 정의

| 용어 | 정의 |
|------|------|
| **RAG** | Retrieval-Augmented Generation. 검색 결과를 LLM 컨텍스트에 포함하여 답변 품질을 향상시키는 기법 |
| **LLM** | Large Language Model. GPT-4, Claude 등 대규모 언어 모델 |
| **임베딩 (Embedding)** | 텍스트를 고차원 벡터로 변환하는 과정. 의미적 유사도 계산에 사용 |
| **청킹 (Chunking)** | 긴 문서를 작은 단위로 분할하는 과정 |
| **벡터 스토어** | 임베딩 벡터를 저장하고 유사도 검색을 수행하는 저장소 |
| **토큰 (Token)** | LLM이 처리하는 텍스트의 최소 단위. 평균적으로 영어 4글자 또는 한글 1-2글자 |
| **컨텍스트 윈도우** | LLM이 한 번에 처리할 수 있는 최대 토큰 수 |
| **청크 (Chunk)** | 분할된 문서의 개별 조각 |
| **Retriever** | 쿼리를 받아 관련 문서를 검색하는 컴포넌트 |
| **Checkpointer** | LangGraph에서 상태를 저장하고 복원하는 컴포넌트 |
| **SSE** | Server-Sent Events. 서버에서 클라이언트로 단방향 실시간 데이터 전송 |
| **Agentic RAG** | 에이전트 기반 RAG. 질문을 분석하고 동적으로 검색 전략을 결정 |
| **Query Rewriting** | 검색 성능 향상을 위해 사용자 질문을 재구성하는 기법 |
| **Document Grading** | 검색된 문서의 관련성을 평가하는 과정 |

### 1.4 참조 문서

| 문서 | URL |
|------|-----|
| LangChain.js 공식 문서 | https://js.langchain.com/docs/ |
| LangGraph.js 공식 문서 | https://langchain-ai.github.io/langgraphjs/ |
| OpenAI API 문서 | https://platform.openai.com/docs/ |
| Server-Sent Events MDN | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events |

---

## 2. 요구사항 정의

### 2.1 기능 요구사항

| ID | 요구사항 | 우선순위 | 수용 기준 |
|----|----------|----------|----------|
| **FR-CB-001** | 다중 LLM 제공자 지원 | P0 | OpenAI, Azure OpenAI, Ollama 3종 모두 정상 동작 |
| **FR-CB-002** | 다중 임베딩 제공자 지원 | P0 | OpenAI, Azure OpenAI, Ollama 임베딩 모두 정상 동작 |
| **FR-CB-003** | Markdown 문서 자동 임베딩 | P0 | docsRoot 내 .md 파일 100% 벡터화 완료 |
| **FR-CB-004** | Frontmatter 메타데이터 추출 | P1 | name, description 필드 정상 파싱 |
| **FR-CB-005** | 실시간 문서 변경 감지 | P0 | 파일 추가/수정/삭제 5초 이내 반영 |
| **FR-CB-006** | 질문 분류 기능 | P0 | question/summary/chitchat/unknown 4종 분류 정확도 90% 이상 |
| **FR-CB-007** | 벡터 유사도 검색 | P0 | Top-K(20개) 관련 문서 검색 성공 |
| **FR-CB-008** | RAG 기반 답변 생성 | P0 | 검색된 문서 기반 답변 생성 |
| **FR-CB-009** | 대화 히스토리 관리 | P0 | 세션 내 이전 대화 컨텍스트 유지 |
| **FR-CB-010** | 컨텍스트 크기 관리 | P1 | 70% 초과 시 자동 요약, 10% 이하로 압축 |
| **FR-CB-011** | Thinking 모드 | P1 | 복잡한 질문에 대해 단계별 추론 수행 |
| **FR-CB-012** | 실시간 진행 상황 표시 | P0 | 워크플로우 단계별 상태 SSE 전송 |
| **FR-CB-013** | 토큰 단위 스트리밍 | P0 | 생성 중인 답변 실시간 표시 |
| **FR-CB-014** | Markdown 렌더링 | P0 | 코드 블록, 테이블, 리스트 등 정상 렌더링 |
| **FR-CB-015** | 챗봇 메인 페이지 설정 | P1 | ui.indexFile="CHATBOT" 설정 시 메인 페이지 변경 |
| **FR-CB-016** | Query Rewriting | P1 | 검색 실패 시 질문 재구성 후 재검색 |
| **FR-CB-017** | Document Grading | P1 | 검색된 문서 관련성 평가 및 필터링 |

### 2.2 비기능 요구사항

| ID | 요구사항 | 측정 기준 | 목표값 |
|----|----------|----------|--------|
| **NFR-CB-001** | 응답 시간 (첫 토큰) | TTFB (Time To First Byte) | ≤ 2초 |
| **NFR-CB-002** | 문서 임베딩 처리량 | 문서/초 | ≥ 5개/초 (1KB 문서 기준) |
| **NFR-CB-003** | 벡터 검색 시간 | 쿼리 응답 시간 | ≤ 100ms (1000개 청크 기준) |
| **NFR-CB-004** | 동시 세션 지원 | 동시 사용자 수 | ≥ 10명 |
| **NFR-CB-005** | 메모리 사용량 | 서버 메모리 | ≤ 512MB (기본 문서 세트) |
| **NFR-CB-006** | API 키 보안 | 클라이언트 노출 | 0건 (서버 측에서만 사용) |
| **NFR-CB-007** | XSS 방지 | DOMPurify 적용률 | 100% |

---

## 3. 설정 구조

### 3.1 config.json5 스키마

```json5
{
  // 기존 설정 (docsRoot, apiKey, port 등)...

  chatbot: {
    // [FR-CB-001] LLM 설정 (필수)
    llm: {
      type: "openai",           // "openai" | "azure-openai" | "ollama" (필수)
      endpoint: "https://api.openai.com/v1",  // API 엔드포인트 (필수)
      apiKey: "sk-xxx",         // API 키 (필수, ollama는 빈 문자열 허용)
      model: "gpt-4o",          // 모델명 (필수)
      contextLength: 128000,    // 컨텍스트 윈도우 크기 (필수, 토큰 단위)
      temperature: 0.7,         // 온도 (선택, 기본값: 0.7, 범위: 0.0-2.0)
      maxTokens: 4096,          // 최대 출력 토큰 (선택, 기본값: 4096)
      // Azure OpenAI 전용 (azure-openai 타입 필수)
      apiVersion: "2024-02-01", // Azure API 버전
      deploymentName: "gpt-4o", // Azure 배포명
    },

    // [FR-CB-002] 임베딩 설정 (필수)
    embedding: {
      type: "openai",           // "openai" | "azure-openai" | "ollama" (필수)
      endpoint: "https://api.openai.com/v1",  // API 엔드포인트 (필수)
      apiKey: "sk-xxx",         // API 키 (필수)
      model: "text-embedding-3-small",  // 임베딩 모델명 (필수)
      // Azure OpenAI 전용
      apiVersion: "2024-02-01",
      deploymentName: "text-embedding-ada-002",
    },

    // RAG 설정 (선택)
    rag: {
      chunkSize: 1000,          // 청크 크기 (기본값: 1000자)
      chunkOverlap: 200,        // 청크 오버랩 (기본값: 200자)
      retrievalCount: 20,       // 검색할 청크 개수 (기본값: 20)
      // 20개 선택 근거: 평균 청크 500토큰 × 20 = 10,000토큰
      // GPT-4o 128K 컨텍스트의 약 8%로, 답변 생성에 충분한 컨텍스트 확보
    },

    // 컨텍스트 관리 (선택)
    context: {
      compressionThreshold: 0.7,  // 압축 시작 임계값 (기본값: 70%)
      compressionTarget: 0.1,     // 압축 목표 크기 (기본값: 10%)
      // 70%/10% 선택 근거:
      // - 70%: 신규 답변 생성에 30% 여유 공간 확보
      // - 10%: 핵심 맥락만 유지하여 장기 대화 지원
    },

    // 시스템 프롬프트 (선택)
    systemPrompt: "당신은 문서 기반 질의응답 도우미입니다. 검색된 문서를 기반으로 정확하고 간결하게 답변하세요.",
  },

  ui: {
    // 기존 설정 (title, icon 등)...
    indexFile: "CHATBOT",       // [FR-CB-015] "CHATBOT" 설정 시 메인 페이지에 챗봇 표시
  }
}
```

### 3.2 타입별 필수 인자

| 타입 | 필수 인자 | 선택 인자 |
|------|----------|----------|
| openai | type, endpoint, apiKey, model, contextLength | temperature, maxTokens |
| azure-openai | type, endpoint, apiKey, model, contextLength, apiVersion, deploymentName | temperature, maxTokens |
| ollama | type, endpoint, model, contextLength | temperature, maxTokens |

**참고**: Ollama는 로컬 실행이므로 apiKey가 필수가 아님 (빈 문자열 허용)

---

## 4. 아키텍처 설계

### 4.1 시스템 컨텍스트

```
┌─────────────────────────────────────────────────────────────────────┐
│                          DocLight Server                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Document Processing Layer                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │   │
│  │  │ DocWatcher   │─▶│ DocLoader    │─▶│ TextSplitter     │   │   │
│  │  │ (chokidar)   │  │ (Markdown)   │  │ (Recursive)      │   │   │
│  │  └──────────────┘  └──────────────┘  └────────┬─────────┘   │   │
│  │                                               │              │   │
│  │                                               ▼              │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │ EmbeddingFactory ─▶ MemoryVectorStore               │   │   │
│  │  │ (OpenAI/Azure/Ollama)                               │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              │ Retriever (Top-20)                   │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │               LangGraph Workflow Engine                      │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │                    Standard Mode                      │   │   │
│  │  │  ┌─────────┐   ┌─────────┐   ┌─────────┐            │   │   │
│  │  │  │Classify │──▶│Grade    │──▶│Generate │            │   │   │
│  │  │  │ Query   │   │ Docs    │   │ Answer  │            │   │   │
│  │  │  └────┬────┘   └────┬────┘   └─────────┘            │   │   │
│  │  │       │             │                                │   │   │
│  │  │       ▼             ▼ (relevance < 0.7)             │   │   │
│  │  │  ┌─────────┐   ┌─────────┐                          │   │   │
│  │  │  │Retrieve │   │Rewrite  │──▶ [Re-retrieve]         │   │   │
│  │  │  │  Docs   │   │ Query   │                          │   │   │
│  │  │  └─────────┘   └─────────┘                          │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  │                                                              │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │                   Thinking Mode                       │   │   │
│  │  │  ┌─────────┐   ┌─────────┐   ┌─────────┐            │   │   │
│  │  │  │Analyze  │──▶│ Plan    │──▶│Execute  │            │   │   │
│  │  │  │Question │   │Strategy │   │ Steps   │            │   │   │
│  │  │  └─────────┘   └─────────┘   └─────────┘            │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  │                                                              │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │              Memory Management                        │   │   │
│  │  │  MemorySaver (Checkpointer) ─▶ Thread-based State    │   │   │
│  │  │  SummarizeHistory ─▶ Context Compression             │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              │ SSE Stream                           │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Chatbot UI (EJS)                          │   │
│  │  - 워크플로우 진행 상황 실시간 표시                           │   │
│  │  - Markdown 렌더링 (marked + DOMPurify)                      │   │
│  │  - 대화 히스토리 관리                                        │   │
│  │  - Thinking 모드 토글                                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 핵심 라이브러리

| 패키지 | 버전 | 용도 | 요구사항 매핑 |
|--------|------|------|--------------|
| `@langchain/core` | ^0.3.x | LangChain 코어 기능 | FR-CB-001~017 |
| `@langchain/langgraph` | ^0.2.x | 워크플로우 그래프, Checkpointer | FR-CB-009, FR-CB-011 |
| `@langchain/openai` | ^0.3.x | OpenAI/Azure OpenAI 통합 | FR-CB-001, FR-CB-002 |
| `@langchain/ollama` | ^0.1.x | Ollama 로컬 LLM 통합 | FR-CB-001, FR-CB-002 |
| `@langchain/textsplitters` | ^0.1.x | 텍스트 분할 | FR-CB-003 |
| `@langchain/classic` | ^0.0.x | MemoryVectorStore | FR-CB-007 |
| `chokidar` | ^3.6.x | 파일 시스템 감시 | FR-CB-005 |
| `zod` | ^3.x | 스키마 검증 | FR-CB-006 |

---

## 5. 상세 설계

### 5.1 문서 처리 파이프라인 [FR-CB-003, FR-CB-004, FR-CB-005]

#### 5.1.1 DocWatcher 클래스

```javascript
// src/services/chatbot/doc-watcher.js
import chokidar from 'chokidar';
import { EventEmitter } from 'events';

class DocWatcher extends EventEmitter {
  constructor(docsRoot, options = {}) {
    super();
    this.docsRoot = docsRoot;
    this.debounceMs = options.debounceMs || 1000;
    this.pendingChanges = new Map();

    this.watcher = chokidar.watch(`${docsRoot}/**/*.md`, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (path) => this.debouncedEmit('add', path))
      .on('change', (path) => this.debouncedEmit('change', path))
      .on('unlink', (path) => this.emit('remove', path));
  }

  debouncedEmit(event, path) {
    if (this.pendingChanges.has(path)) {
      clearTimeout(this.pendingChanges.get(path));
    }
    this.pendingChanges.set(path, setTimeout(() => {
      this.pendingChanges.delete(path);
      this.emit(event, path);
    }, this.debounceMs));
  }

  async close() {
    await this.watcher.close();
  }
}
```

#### 5.1.2 Frontmatter 파싱

```javascript
// src/services/chatbot/doc-loader.js
import fs from 'fs/promises';
import path from 'path';

async function loadMarkdownWithFrontmatter(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  let metadata = {
    filePath: filePath,
    source: path.basename(filePath),
  };

  let pageContent = content;

  if (match) {
    const frontmatter = match[1];
    pageContent = content.slice(match[0].length);

    // YAML 파싱 (간단 구현)
    frontmatter.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length) {
        metadata[key.trim()] = valueParts.join(':').trim();
      }
    });
  }

  return { pageContent, metadata };
}
```

#### 5.1.3 벡터 스토어 관리

```javascript
// src/services/chatbot/vector-store.js
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";

class VectorStoreManager {
  constructor(embeddings, config) {
    this.embeddings = embeddings;
    this.config = config;
    this.vectorStore = null;
    this.documentHashes = new Map(); // 변경 감지용 해시 저장

    this.splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
      chunkSize: config.rag?.chunkSize || 1000,
      chunkOverlap: config.rag?.chunkOverlap || 200,
    });
  }

  async initialize() {
    this.vectorStore = new MemoryVectorStore(this.embeddings);
  }

  async addDocument(filePath, content, metadata) {
    const hash = this.computeHash(content);
    if (this.documentHashes.get(filePath) === hash) {
      return; // 변경 없음, 스킵
    }

    // 기존 문서 제거
    await this.removeDocument(filePath);

    // 청킹 및 임베딩
    const docs = await this.splitter.createDocuments(
      [content],
      [{ ...metadata, filePath }]
    );

    await this.vectorStore.addDocuments(docs);
    this.documentHashes.set(filePath, hash);
  }

  async removeDocument(filePath) {
    // MemoryVectorStore는 직접 삭제 미지원
    // 전체 재구축 또는 필터링 방식 사용
    this.documentHashes.delete(filePath);
  }

  getRetriever(k = 20) {
    return this.vectorStore.asRetriever(k);
  }

  computeHash(content) {
    // 간단한 해시 (실제로는 crypto.createHash 사용)
    return Buffer.from(content).toString('base64').slice(0, 32);
  }
}
```

### 5.2 LangGraph 워크플로우 [FR-CB-006 ~ FR-CB-013]

#### 5.2.1 상태 정의

```javascript
// src/services/chatbot/workflow/state.js
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const ChatbotAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,

  // 대화 요약 (컨텍스트 압축용) [FR-CB-010]
  summary: Annotation({
    reducer: (_, action) => action,
    default: () => "",
  }),

  // 질문 분류 결과 [FR-CB-006]
  queryType: Annotation({
    reducer: (_, action) => action,
    default: () => "unknown",
  }),

  // 검색된 문서 청크 [FR-CB-007]
  retrievedDocs: Annotation({
    reducer: (_, action) => action,
    default: () => [],
  }),

  // 문서 관련성 점수 [FR-CB-017]
  relevanceScore: Annotation({
    reducer: (_, action) => action,
    default: () => 0,
  }),

  // 현재 워크플로우 단계 [FR-CB-012]
  currentStep: Annotation({
    reducer: (_, action) => action,
    default: () => "",
  }),

  // Thinking 모드 활성화 여부 [FR-CB-011]
  thinkingMode: Annotation({
    reducer: (_, action) => action,
    default: () => false,
  }),

  // Query Rewriting 횟수 [FR-CB-016]
  rewriteCount: Annotation({
    reducer: (_, action) => action,
    default: () => 0,
  }),
});
```

#### 5.2.2 질문 분류 노드 [FR-CB-006]

```javascript
// src/services/chatbot/workflow/nodes/classify.js
import { z } from "zod";

const classificationSchema = z.object({
  type: z.enum(["question", "summary", "chitchat", "unknown"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export async function classifyQuery(state, { llm }) {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  const prompt = `다음 사용자 입력을 분류하세요:

1. question: 문서에 대한 구체적인 질문 (예: "API 인증 방법은?")
2. summary: 요약 요청 (예: "요약해줘", "정리해줘")
3. chitchat: 일상 대화, 인사, 잡담 (예: "안녕", "고마워")
4. unknown: 분류 불가

사용자 입력: ${lastMessage.content}

JSON 형식으로 응답하세요.`;

  const model = llm.withStructuredOutput(classificationSchema);
  const result = await model.invoke(prompt);

  return {
    queryType: result.type,
    currentStep: "classifyQuery",
  };
}
```

#### 5.2.3 Document Grading 노드 [FR-CB-017]

```javascript
// src/services/chatbot/workflow/nodes/grade.js
import { z } from "zod";

const gradingSchema = z.object({
  relevant: z.boolean(),
  score: z.number().min(0).max(1),
});

export async function gradeDocuments(state, { llm }) {
  const { messages, retrievedDocs } = state;
  const question = messages[0].content;

  const prompt = `검색된 문서가 사용자 질문과 관련이 있는지 평가하세요.

질문: ${question}

문서:
${retrievedDocs.map(d => d.pageContent).join('\n\n---\n\n')}

관련성을 0-1 사이 점수로 평가하세요.
0.7 이상이면 관련 있음(relevant: true)으로 판단합니다.`;

  const model = llm.withStructuredOutput(gradingSchema);
  const result = await model.invoke(prompt);

  return {
    relevanceScore: result.score,
    currentStep: "gradeDocuments",
  };
}
```

#### 5.2.4 Query Rewriting 노드 [FR-CB-016]

```javascript
// src/services/chatbot/workflow/nodes/rewrite.js
export async function rewriteQuery(state, { llm }) {
  const { messages, rewriteCount } = state;

  if (rewriteCount >= 2) {
    // 최대 2회 재작성 후 원본 유지
    return { currentStep: "rewriteQuery" };
  }

  const originalQuestion = messages[0].content;

  const prompt = `다음 질문의 의미를 파악하고, 검색 성능을 높이기 위해 재구성하세요.
핵심 의도와 키워드를 명확히 표현하세요.

원본 질문: ${originalQuestion}

재구성된 질문:`;

  const response = await llm.invoke(prompt);

  return {
    messages: [{ role: "user", content: response.content }],
    rewriteCount: rewriteCount + 1,
    currentStep: "rewriteQuery",
  };
}
```

#### 5.2.5 워크플로우 그래프 구성

```javascript
// src/services/chatbot/workflow/graph.js
import { StateGraph, START, END } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { ChatbotAnnotation } from "./state.js";
import { classifyQuery } from "./nodes/classify.js";
import { retrieveDocs } from "./nodes/retrieve.js";
import { gradeDocuments } from "./nodes/grade.js";
import { rewriteQuery } from "./nodes/rewrite.js";
import { generateAnswer } from "./nodes/generate.js";
import { summarizeHistory } from "./nodes/summarize.js";

export function createChatbotGraph(config, llm, retriever) {
  const checkpointer = new MemorySaver(); // [FR-CB-009] 세션 상태 저장

  const workflow = new StateGraph(ChatbotAnnotation)
    // 노드 추가
    .addNode("classifyQuery", (state) => classifyQuery(state, { llm }))
    .addNode("retrieveDocs", (state) => retrieveDocs(state, { retriever }))
    .addNode("gradeDocuments", (state) => gradeDocuments(state, { llm }))
    .addNode("rewriteQuery", (state) => rewriteQuery(state, { llm }))
    .addNode("generateAnswer", (state) => generateAnswer(state, { llm, config }))
    .addNode("summarizeHistory", (state) => summarizeHistory(state, { llm, config }))

    // 엣지 추가
    .addEdge(START, "classifyQuery")
    .addConditionalEdges("classifyQuery", routeByQueryType)
    .addEdge("retrieveDocs", "gradeDocuments")
    .addConditionalEdges("gradeDocuments", routeByRelevance)
    .addEdge("rewriteQuery", "retrieveDocs")
    .addConditionalEdges("generateAnswer", checkContextSize)
    .addEdge("summarizeHistory", END);

  return workflow.compile({ checkpointer });
}

// 라우팅 함수들
function routeByQueryType(state) {
  switch (state.queryType) {
    case "question": return "retrieveDocs";
    case "summary": return "generateAnswer"; // 전체 요약은 검색 없이
    case "chitchat": return "generateAnswer"; // 직접 응답
    default: return "generateAnswer";
  }
}

function routeByRelevance(state) {
  if (state.relevanceScore >= 0.7) {
    return "generateAnswer";
  }
  if (state.rewriteCount < 2) {
    return "rewriteQuery"; // 관련성 낮으면 재검색
  }
  return "generateAnswer"; // 재시도 초과 시 현재 결과로 진행
}

function checkContextSize(state, config) {
  const contextLength = config.chatbot?.llm?.contextLength || 128000;
  const threshold = config.chatbot?.context?.compressionThreshold || 0.7;
  const currentTokens = estimateTokens(state);

  if (currentTokens > contextLength * threshold) {
    return "summarizeHistory";
  }
  return END;
}
```

### 5.3 LLM/Embedding 팩토리 [FR-CB-001, FR-CB-002]

```javascript
// src/services/chatbot/llm-factory.js
import { ChatOpenAI, AzureChatOpenAI, OpenAIEmbeddings, AzureOpenAIEmbeddings } from "@langchain/openai";
import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";

export function createLLM(config) {
  const { type, endpoint, apiKey, model, temperature, maxTokens, apiVersion, deploymentName } = config;

  switch (type) {
    case "openai":
      return new ChatOpenAI({
        model,
        apiKey,
        configuration: { baseURL: endpoint },
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 4096,
      });

    case "azure-openai":
      return new AzureChatOpenAI({
        model,
        azureOpenAIApiKey: apiKey,
        azureOpenAIApiEndpoint: endpoint,
        azureOpenAIApiVersion: apiVersion,
        azureOpenAIApiDeploymentName: deploymentName,
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 4096,
      });

    case "ollama":
      return new ChatOllama({
        model,
        baseUrl: endpoint,
        temperature: temperature ?? 0.7,
      });

    default:
      throw new Error(`Unsupported LLM type: ${type}`);
  }
}

export function createEmbeddings(config) {
  const { type, endpoint, apiKey, model, apiVersion, deploymentName } = config;

  switch (type) {
    case "openai":
      return new OpenAIEmbeddings({
        model,
        apiKey,
        configuration: { baseURL: endpoint },
      });

    case "azure-openai":
      return new AzureOpenAIEmbeddings({
        azureOpenAIApiKey: apiKey,
        azureOpenAIApiEndpoint: endpoint,
        azureOpenAIApiVersion: apiVersion,
        azureOpenAIApiEmbeddingsDeploymentName: deploymentName,
      });

    case "ollama":
      return new OllamaEmbeddings({
        model,
        baseUrl: endpoint,
      });

    default:
      throw new Error(`Unsupported embedding type: ${type}`);
  }
}
```

### 5.4 컨텍스트 관리 [FR-CB-010]

```javascript
// src/services/chatbot/workflow/nodes/summarize.js
export async function summarizeHistory(state, { llm, config }) {
  const { messages, summary } = state;
  const contextLength = config.chatbot?.llm?.contextLength || 128000;
  const targetRatio = config.chatbot?.context?.compressionTarget || 0.1;
  const targetTokens = Math.floor(contextLength * targetRatio);

  let summaryPrompt;
  if (summary) {
    summaryPrompt = `기존 요약:
${summary}

새로운 대화 내용을 포함하여 요약을 업데이트하세요.
${targetTokens}토큰 이내로 핵심 내용만 유지하세요.`;
  } else {
    summaryPrompt = `다음 대화를 ${targetTokens}토큰 이내로 요약하세요:`;
  }

  const conversationText = messages.map(m =>
    `${m.role}: ${m.content}`
  ).join('\n');

  const response = await llm.invoke(`${summaryPrompt}\n\n${conversationText}`);

  // 요약 후 오래된 메시지 제거 (최근 2개만 유지)
  const recentMessages = messages.slice(-2);

  return {
    summary: response.content,
    messages: recentMessages,
    currentStep: "summarizeHistory",
  };
}

// 토큰 추정 함수
export function estimateTokens(state) {
  const allContent = [
    state.summary || "",
    ...state.messages.map(m => m.content),
  ].join("\n");

  // UTF-8 바이트 기반 추정 (평균 3바이트 ≈ 1토큰)
  // 한글: 3바이트/글자, 평균 1글자 ≈ 1토큰
  // 영어: 평균 4글자 ≈ 1토큰
  const encoder = new TextEncoder();
  const bytes = encoder.encode(allContent);
  return Math.ceil(bytes.length / 3);
}
```

---

## 6. API 설계

### 6.1 엔드포인트 정의

| Method | Endpoint | 설명 | 요구사항 |
|--------|----------|------|----------|
| POST | `/api/chatbot/chat` | 메시지 전송 (SSE 스트림 응답) | FR-CB-008, FR-CB-012, FR-CB-013 |
| GET | `/api/chatbot/history/:threadId` | 대화 히스토리 조회 | FR-CB-009 |
| DELETE | `/api/chatbot/history/:threadId` | 대화 히스토리 삭제 | FR-CB-009 |
| GET | `/api/chatbot/status` | 벡터 스토어 상태 조회 | 디버깅용 |

### 6.2 SSE 스트림 이벤트 형식

```javascript
// 워크플로우 단계 업데이트
event: step
data: {"step": "classifyQuery", "message": "질문을 분류하고 있습니다..."}

event: step
data: {"step": "retrieveDocs", "message": "관련 문서를 검색하고 있습니다..."}

event: step
data: {"step": "gradeDocuments", "message": "문서 관련성을 평가하고 있습니다..."}

// 검색 결과
event: retrieval
data: {"count": 20, "topScore": 0.92, "sources": ["api-guide.md", "auth.md"]}

// 토큰 스트리밍
event: token
data: {"content": "안녕"}

event: token
data: {"content": "하세요"}

// Thinking 모드 중간 결과
event: thinking
data: {"phase": "analyze", "content": "이 질문은 API 인증에 관한 것입니다..."}

// 완료
event: done
data: {"totalTokens": 150, "duration": 2500, "threadId": "abc123"}

// 에러
event: error
data: {"message": "Rate limit exceeded", "code": "RATE_LIMIT", "retryAfter": 60}
```

### 6.3 요청/응답 스키마

```typescript
// POST /api/chatbot/chat
interface ChatRequest {
  message: string;           // 사용자 메시지
  threadId?: string;         // 세션 ID (없으면 새 세션 생성)
  thinkingMode?: boolean;    // Thinking 모드 활성화
}

// GET /api/chatbot/history/:threadId
interface HistoryResponse {
  threadId: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
  summary?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

// GET /api/chatbot/status
interface StatusResponse {
  vectorStore: {
    totalDocuments: number;
    totalChunks: number;
    lastUpdated: string;
  };
  llm: {
    type: string;
    model: string;
    status: "connected" | "error";
  };
  embedding: {
    type: string;
    model: string;
    status: "connected" | "error";
  };
}
```

---

## 7. UI 설계

### 7.1 챗봇 페이지 레이아웃 [FR-CB-014]

```
┌─────────────────────────────────────────────────────────────────┐
│  DocLight Chatbot                    [Thinking Mode] [○ OFF]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 🤖 안녕하세요! 문서에 대해 질문해 주세요.                  │ │
│  │    등록된 문서: 42개                                       │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ 👤 API 인증 방법에 대해 알려주세요.                        │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ ⏳ 질문을 분석하고 있습니다...                             │ │
│  │ ✅ 관련 문서 20개를 검색했습니다.                          │ │
│  │    📄 api-guide.md (92%), auth.md (87%)                   │ │
│  │ ✅ 문서 관련성: 높음 (0.89)                                │ │
│  │ ⏳ 답변을 생성하고 있습니다...                             │ │
│  │                                                           │ │
│  │ 🤖 API 인증은 다음과 같이 진행됩니다:                      │ │
│  │                                                           │ │
│  │ ## 1. API 키 발급                                         │ │
│  │ config.json5에서 apiKey를 설정합니다.                     │ │
│  │                                                           │ │
│  │ ```javascript                                             │ │
│  │ const apiKey = "your-api-key";                            │ │
│  │ ```                                                       │ │
│  │                                                           │ │
│  │ 📚 참조: api-guide.md, auth.md                            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐ [Send] │
│  │ 메시지를 입력하세요...                             │        │
│  └───────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 UI 컴포넌트

| 컴포넌트 | 설명 | 요구사항 |
|----------|------|----------|
| `ChatHeader` | 제목, Thinking 모드 토글 | FR-CB-011 |
| `MessageList` | 대화 히스토리 스크롤 영역 | FR-CB-009 |
| `MessageBubble` | 개별 메시지 (User/Bot 구분) | FR-CB-014 |
| `WorkflowIndicator` | 워크플로우 단계 진행 상황 | FR-CB-012 |
| `RetrievalInfo` | 검색된 문서 정보 표시 | FR-CB-007 |
| `MarkdownRenderer` | Markdown 렌더링 영역 | FR-CB-014 |
| `InputArea` | 메시지 입력 및 전송 | FR-CB-008 |

---

## 8. 파일 구조

```
src/
├── services/
│   └── chatbot/
│       ├── index.js                    # 챗봇 서비스 진입점
│       ├── doc-watcher.js              # 문서 감시 [FR-CB-005]
│       ├── doc-loader.js               # 문서 로드 [FR-CB-003, FR-CB-004]
│       ├── vector-store.js             # 벡터 스토어 관리 [FR-CB-007]
│       ├── llm-factory.js              # LLM 인스턴스 생성 [FR-CB-001]
│       ├── embedding-factory.js        # Embedding 인스턴스 생성 [FR-CB-002]
│       └── workflow/
│           ├── state.js                # 상태 정의
│           ├── graph.js                # 워크플로우 그래프
│           └── nodes/
│               ├── classify.js         # 질문 분류 [FR-CB-006]
│               ├── retrieve.js         # 문서 검색 [FR-CB-007]
│               ├── grade.js            # 문서 평가 [FR-CB-017]
│               ├── rewrite.js          # 질문 재작성 [FR-CB-016]
│               ├── generate.js         # 답변 생성 [FR-CB-008]
│               ├── summarize.js        # 히스토리 요약 [FR-CB-010]
│               └── thinking/           # Thinking 모드 [FR-CB-011]
│                   ├── analyze.js
│                   ├── plan.js
│                   └── execute.js
├── controllers/
│   └── chatbot-controller.js           # API 컨트롤러 [FR-CB-012, FR-CB-013]
├── routes/
│   └── chatbot.js                      # 라우트 정의
└── views/
    └── chatbot.ejs                     # 챗봇 UI 템플릿 [FR-CB-014, FR-CB-015]

public/
├── js/
│   └── chatbot.js                      # 클라이언트 로직
└── css/
    └── chatbot.css                     # 챗봇 스타일
```

---

## 9. 구현 Phase 및 추적 매트릭스

### 9.1 Phase별 계획

| Phase | 이름 | 요구사항 | 우선순위 |
|-------|------|----------|----------|
| Phase 1 | 설정 및 기반 구조 | FR-CB-001, FR-CB-002 | P0 |
| Phase 2 | 문서 처리 파이프라인 | FR-CB-003, FR-CB-004, FR-CB-005 | P0 |
| Phase 3 | 기본 RAG 워크플로우 | FR-CB-006, FR-CB-007, FR-CB-008 | P0 |
| Phase 4 | 대화 관리 | FR-CB-009, FR-CB-010 | P1 |
| Phase 5 | Advanced RAG | FR-CB-016, FR-CB-017 | P1 |
| Phase 6 | Thinking 모드 | FR-CB-011 | P1 |
| Phase 7 | API 및 스트리밍 | FR-CB-012, FR-CB-013 | P0 |
| Phase 8 | 챗봇 UI | FR-CB-014, FR-CB-015 | P0 |

### 9.2 요구사항 추적 매트릭스

| 요구사항 ID | Phase | 구현 파일 | 테스트 케이스 |
|-------------|-------|----------|--------------|
| FR-CB-001 | 1 | llm-factory.js | TC-CB-001 |
| FR-CB-002 | 1 | embedding-factory.js | TC-CB-002 |
| FR-CB-003 | 2 | doc-loader.js, vector-store.js | TC-CB-003 |
| FR-CB-004 | 2 | doc-loader.js | TC-CB-004 |
| FR-CB-005 | 2 | doc-watcher.js | TC-CB-005 |
| FR-CB-006 | 3 | nodes/classify.js | TC-CB-006 |
| FR-CB-007 | 3 | nodes/retrieve.js | TC-CB-007 |
| FR-CB-008 | 3 | nodes/generate.js | TC-CB-008 |
| FR-CB-009 | 4 | graph.js (MemorySaver) | TC-CB-009 |
| FR-CB-010 | 4 | nodes/summarize.js | TC-CB-010 |
| FR-CB-011 | 6 | nodes/thinking/*.js | TC-CB-011 |
| FR-CB-012 | 7 | chatbot-controller.js | TC-CB-012 |
| FR-CB-013 | 7 | chatbot-controller.js | TC-CB-013 |
| FR-CB-014 | 8 | chatbot.ejs, chatbot.js | TC-CB-014 |
| FR-CB-015 | 8 | app.js, chatbot.ejs | TC-CB-015 |
| FR-CB-016 | 5 | nodes/rewrite.js | TC-CB-016 |
| FR-CB-017 | 5 | nodes/grade.js | TC-CB-017 |

---

## 10. 테스트 계획

### 10.1 단위 테스트

| ID | 테스트 케이스 | 입력 | 예상 결과 |
|----|--------------|------|----------|
| TC-CB-001 | OpenAI LLM 생성 | type="openai" 설정 | ChatOpenAI 인스턴스 반환 |
| TC-CB-002 | Azure 임베딩 생성 | type="azure-openai" 설정 | AzureOpenAIEmbeddings 반환 |
| TC-CB-003 | Markdown 청킹 | 1000자 문서 | 청크 배열 생성 |
| TC-CB-004 | Frontmatter 파싱 | YAML 헤더 포함 문서 | metadata 객체에 필드 포함 |
| TC-CB-005 | 파일 변경 감지 | .md 파일 수정 | change 이벤트 발생 |
| TC-CB-006 | 질문 분류 | "API 사용법 알려줘" | queryType="question" |
| TC-CB-007 | 벡터 검색 | 질문 텍스트 | 20개 문서 반환 |
| TC-CB-010 | 컨텍스트 압축 | 100K 토큰 대화 | 10K 토큰 이하로 압축 |
| TC-CB-016 | 질문 재작성 | 모호한 질문 | 개선된 질문 텍스트 |
| TC-CB-017 | 문서 관련성 평가 | 검색 결과 | relevanceScore 0-1 |

### 10.2 통합 테스트

| ID | 시나리오 | 검증 항목 |
|----|----------|----------|
| IT-CB-001 | 전체 RAG 파이프라인 | 질문 → 검색 → 답변 생성 완료 |
| IT-CB-002 | 세션 연속 대화 | 이전 대화 컨텍스트 유지 |
| IT-CB-003 | SSE 스트리밍 | 토큰 단위 실시간 전송 |
| IT-CB-004 | 문서 변경 후 검색 | 새 문서 내용 검색 가능 |

### 10.3 E2E 테스트 (Playwright)

| ID | 시나리오 | 검증 항목 |
|----|----------|----------|
| E2E-CB-001 | 챗봇 페이지 로드 | UI 정상 렌더링 |
| E2E-CB-002 | 메시지 전송 및 응답 | 사용자 입력 → 봇 응답 표시 |
| E2E-CB-003 | Thinking 모드 토글 | 모드 전환 및 UI 변경 |
| E2E-CB-004 | 워크플로우 진행 표시 | 단계별 인디케이터 업데이트 |

---

## 11. 제약사항 및 가정

### 11.1 제약사항

| ID | 제약사항 | 영향 |
|----|----------|------|
| CON-CB-001 | 인메모리 벡터 스토어 사용 | 서버 재시작 시 임베딩 재생성 필요 |
| CON-CB-002 | 단일 서버 배포 | 수평 확장 시 벡터 스토어 동기화 불가 |
| CON-CB-003 | LangChain.js 의존 | 라이브러리 버전 호환성 관리 필요 |
| CON-CB-004 | API 호출 비용 | 외부 LLM/임베딩 API 사용 시 비용 발생 |

### 11.2 가정

| ID | 가정 | 근거 |
|----|------|------|
| ASM-CB-001 | 문서 수 ≤ 1000개 | 인메모리 처리 가능 범위 |
| ASM-CB-002 | 동시 사용자 ≤ 10명 | 단일 서버 처리 용량 |
| ASM-CB-003 | LLM API 가용성 99% 이상 | 주요 제공자 SLA 기준 |
| ASM-CB-004 | Markdown 문서만 대상 | 기존 DocLight 사용 패턴 |

---

## 12. 리스크 및 완화 전략

| ID | 리스크 | 발생 가능성 | 영향도 | 완화 전략 |
|----|--------|------------|--------|----------|
| RSK-CB-001 | 서버 재시작 시 임베딩 손실 | 높음 | 중간 | 캐시 파일 저장 옵션 추가 (향후) |
| RSK-CB-002 | LLM API 장애 | 낮음 | 높음 | Fallback 응답 메시지 제공 |
| RSK-CB-003 | 토큰 비용 초과 | 중간 | 중간 | 사용량 모니터링 및 알림 |
| RSK-CB-004 | 대용량 문서 처리 지연 | 중간 | 낮음 | 배치 처리 및 진행률 표시 |
| RSK-CB-005 | LangChain.js 버전 호환성 | 중간 | 중간 | package-lock.json 버전 고정 |
| RSK-CB-006 | 검색 정확도 저하 | 중간 | 중간 | Query Rewriting, Document Grading 적용 |

---

## 13. 의존성 설치

```bash
# 핵심 LangChain 패키지
npm install @langchain/core @langchain/langgraph @langchain/langgraph-checkpoint

# LLM/Embedding 제공자
npm install @langchain/openai @langchain/ollama

# 텍스트 처리
npm install @langchain/textsplitters @langchain/classic

# 유틸리티
npm install zod
```

---

## 14. 보안 고려사항

| 항목 | 위험 | 대책 | 요구사항 |
|------|------|------|----------|
| API 키 노출 | 클라이언트 코드에서 키 노출 | 서버 측에서만 사용, 환경 변수 권장 | NFR-CB-006 |
| XSS 공격 | 악성 스크립트 삽입 | DOMPurify로 Markdown 렌더링 결과 sanitize | NFR-CB-007 |
| Prompt Injection | 악의적 프롬프트 삽입 | 시스템 프롬프트 분리, 입력 검증 | - |
| Rate Limiting | API 남용 | 세션별 요청 제한 (10회/분) | - |
| 민감 정보 노출 | 문서 내 비밀 정보 | 검색 결과 필터링 옵션 제공 | - |

---

## 15. 성능 최적화

| 항목 | 전략 | 기대 효과 |
|------|------|----------|
| 임베딩 캐시 | 해시 기반 변경 감지, 미변경 문서 스킵 | 재시작 시 처리 시간 50% 단축 |
| 배치 임베딩 | 여러 청크 동시 임베딩 요청 | 처리량 3배 향상 |
| 스트리밍 | 토큰 단위 SSE 전송 | 체감 응답 시간 단축 |
| 연결 풀링 | LLM API 연결 재사용 | 연결 오버헤드 감소 |

---

## 16. 참고 자료

### 공식 문서
- [LangChain.js](https://js.langchain.com/docs/)
- [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)
- [OpenAI API](https://platform.openai.com/docs/)
- [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/)
- [Ollama](https://ollama.ai/docs)

### RAG 관련
- [Agentic RAG - LangChain](https://docs.langchain.com/oss/javascript/langgraph/agentic-rag)
- [Query Rewriting](https://docs.langchain.com/oss/javascript/langchain/retrieval)
- [Document Grading](https://docs.langchain.com/oss/javascript/langgraph/agentic-rag)

### 클라이언트
- [Server-Sent Events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Marked.js](https://marked.js.org/)
- [DOMPurify](https://github.com/cure53/DOMPurify)
