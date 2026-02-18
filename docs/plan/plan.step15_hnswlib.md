# Step 15-2: HNSWLib 기반 VectorStore 영속성 구현 계획

**작성일**: 2026-01-09
**상태**: 계획 완료 (구현 대기)
**버전**: 2.1.0

---

## 1. 개요

### 1.1 문제 정의

현재 인메모리 VectorStore는 서버 재시작 시 모든 벡터 데이터가 손실되어 매번 재임베딩이 필요합니다. 이는 다음 문제를 야기합니다:

- **시간 낭비**: 서버 시작 시 전체 문서 재인덱싱 필요 (1000문서 기준 5-10분)
- **API 비용**: 임베딩 API 호출 비용 중복 발생
- **가용성 저하**: 인덱싱 완료까지 챗봇 서비스 이용 불가

### 1.2 해결 방안

HNSWLib 기반 파일 영속성 저장소로 변경하여 벡터 인덱스를 디스크에 저장합니다.

### 1.3 의존성 패키지

```json
{
  "dependencies": {
    "@langchain/community": "^0.3.x",
    "hnswlib-node": "^3.0.0"
  }
}
```

**참고**: `hnswlib-node`는 네이티브 모듈로 Windows에서 Visual Studio Build Tools 필요

---

## 2. 요구사항

### 2.1 기능 요구사항

| ID | 요구사항 | 우선순위 | 수용 기준 |
|----|---------|---------|----------|
| FR-VS-001 | 데이터 디렉토리 | P0 | 기본 `data/vector`, config에서 변경 가능 |
| FR-VS-002 | 메타데이터 저장 | P0 | 모델 정보, 파일 크기, 수정일자 저장 |
| FR-VS-003 | 서버 시작 동기화 | P0 | 파일 변경 시 자동 재임베딩 |
| FR-VS-004 | 모델 변경 감지 | P0 | 모델 변경 시 전체 재인덱싱 |
| FR-VS-005 | 인덱스 영속성 | P0 | 서버 재시작 후 인덱스 유지 |
| FR-VS-006 | 원자적 저장 | P0 | 저장 중 크래시 시 데이터 무결성 보장 |
| FR-VS-007 | 삭제 문서 필터링 | P0 | 삭제된 문서는 검색 결과에서 제외 |

### 2.2 비기능 요구사항

| ID | 요구사항 | 목표값 | 측정 방법 |
|----|---------|-------|----------|
| NFR-VS-001 | 인덱스 로드 시간 | ≤ 2초 (1000문서) | 서버 시작 로그 |
| NFR-VS-002 | 동기화 시간 | ≤ 0.5초 (변경 없음) | 동기화 완료 로그 |
| NFR-VS-003 | 메모리 사용량 | ≤ 10MB (1000문서) | process.memoryUsage() |
| NFR-VS-004 | 디스크 사용량 | ≤ 20MB (1000문서) | 디렉토리 크기 |

---

## 3. 설계

### 3.1 데이터 디렉토리 구조

```
data/
  vector/
    index/                    # HNSWLib 인덱스 파일
      hnswlib.index          # HNSW 인덱스 바이너리
      docstore.json          # 문서 저장소 (LangChain 내부)
      args.json              # HNSWLib 설정
    metadata.json             # 메타데이터 (모델 정보, 문서 정보)
    metadata.json.bak         # 메타데이터 백업
```

### 3.2 메타데이터 구조 (`metadata.json`)

```json
{
  "version": 1,
  "schemaVersion": "1.0.0",
  "createdAt": "2026-01-09T10:00:00.000Z",
  "lastUpdatedAt": "2026-01-09T12:00:00.000Z",

  "embedding": {
    "type": "azure-openai",
    "model": "text-embedding-3-small",
    "deploymentName": "text-embedding-3-small",
    "endpoint": "https://xxx.openai.azure.com",
    "dimension": 1536
  },

  "documents": {
    "guide/intro.md": {
      "hash": "abc123def456...",
      "size": 12345,
      "mtime": 1704787200000,
      "chunkCount": 5,
      "version": 1,
      "indexedAt": "2026-01-09T10:00:00.000Z"
    },
    "api/reference.md": {
      "hash": "def456ghi789...",
      "size": 8901,
      "mtime": 1704790800000,
      "chunkCount": 3,
      "version": 1,
      "indexedAt": "2026-01-09T10:30:00.000Z"
    }
  },

  "stats": {
    "totalDocuments": 38,
    "totalChunks": 150,
    "deletedDocuments": 0,
    "deletedChunks": 0
  }
}
```

### 3.3 설정 구조 (`config.json5`)

```json5
chatbot: {
  // 기존 설정
  enabled: true,
  llm: { /* ... */ },
  embedding: { /* ... */ },

  // RAG 설정
  rag: {
    chunkSize: 1000,
    chunkOverlap: 200,
    retrievalCount: 20,

    // 벡터 스토어 영속성 설정
    persistence: {
      // 벡터 데이터 저장 디렉토리 (기본: "./data/vector")
      // 절대 경로 또는 프로젝트 루트 기준 상대 경로
      dataDir: "./data/vector",

      // 자동 compaction 활성화 (기본: true)
      // 삭제된 문서가 많아지면 자동으로 인덱스 재구축
      autoCompact: true,

      // Compaction 트리거: 삭제된 문서 비율 (기본: 0.3 = 30%)
      // 0.0 ~ 1.0 범위
      compactThreshold: 0.3,

      // 서버 시작 시 동기화 활성화 (기본: true)
      // false로 설정 시 동기화 건너뜀 (개발 모드용)
      syncOnStartup: true,

      // 배치 임베딩 크기 (기본: 50)
      // API 호출 최소화를 위한 배치 크기
      batchSize: 50
    }
  },

  context: { /* ... */ }
}
```

### 3.4 config-loader.js 검증 코드

```javascript
/**
 * persistence 설정 검증 및 기본값 적용
 * @param {Object} config - 설정 객체
 * @returns {Object} 검증된 설정
 * @throws {Error} 유효하지 않은 설정
 */
function validatePersistenceConfig(config) {
  const errors = [];
  const rag = config.chatbot?.rag || {};

  // persistence 기본값 설정
  const persistence = {
    dataDir: './data/vector',
    autoCompact: true,
    compactThreshold: 0.3,
    syncOnStartup: true,
    batchSize: 50,
    ...rag.persistence
  };

  // dataDir 검증
  if (typeof persistence.dataDir !== 'string' || persistence.dataDir.trim() === '') {
    errors.push('chatbot.rag.persistence.dataDir must be a non-empty string');
  }

  // compactThreshold 검증
  if (typeof persistence.compactThreshold !== 'number' ||
      persistence.compactThreshold < 0 || persistence.compactThreshold > 1) {
    errors.push('chatbot.rag.persistence.compactThreshold must be a number between 0 and 1');
  }

  // batchSize 검증
  if (typeof persistence.batchSize !== 'number' ||
      persistence.batchSize < 1 || persistence.batchSize > 500) {
    errors.push('chatbot.rag.persistence.batchSize must be a number between 1 and 500');
  }

  // boolean 필드 검증
  if (typeof persistence.autoCompact !== 'boolean') {
    errors.push('chatbot.rag.persistence.autoCompact must be a boolean');
  }
  if (typeof persistence.syncOnStartup !== 'boolean') {
    errors.push('chatbot.rag.persistence.syncOnStartup must be a boolean');
  }

  if (errors.length > 0) {
    throw new Error(`Persistence configuration errors:\n${errors.join('\n')}`);
  }

  return persistence;
}
```

---

## 4. 동기화 전략

### 4.1 HNSWLib 제한사항

- **개별 문서 삭제 미지원**: `delete({ ids: [...] })` 사용 불가
- 전체 인덱스 삭제만 가능: `delete({ directory })`
- 이는 HNSW 알고리즘의 구조적 특성

### 4.2 해결 전략: Append-Only + 검색 시 필터링

1. **새 문서/변경 문서**: 버전 번호와 함께 추가
2. **검색 결과**: 최신 버전만 반환 (FilteredRetriever)
3. **Compaction**: 삭제 비율 임계치 초과 시 전체 재구축

### 4.3 서버 시작 동기화 흐름

```
서버 시작
    │
    ▼
persistence 설정 확인 ───────────────────┐
    │                                    │
    ├─ 설정 없음 → 기존 인메모리 모드 ────┘
    │
    ▼
metadata.json 로드 시도
    │
    ├─ 실패 (파일 없음) → 전체 재인덱싱 (신규 설치)
    │
    ▼
임베딩 모델 비교 (type, model, deploymentName, dimension)
    │
    ├─ 변경됨 → 인덱스 삭제 + 전체 재인덱싱
    │
    ▼
HNSWLib 인덱스 로드 시도
    │
    ├─ 실패 (손상/없음) → 전체 재인덱싱
    │
    ▼
docsRoot 스캔 → 현재 파일 목록
    │
    ▼
각 파일에 대해:
    ├─ 새 파일 → 인덱스에 추가 (버전 1)
    ├─ 변경됨 (hash/size/mtime 중 하나라도) → 새 버전 추가 (버전 +1)
    └─ 삭제됨 → metadata에서 제거 + deletedChunks 증가
    │
    ▼
Compaction 필요 여부 확인
    │
    ├─ deletedChunks / totalChunks > threshold → 전체 재구축
    │
    ▼
metadata.json 저장 (원자적)
    │
    ▼
인덱스 저장 (변경 있을 경우)
    │
    ▼
동기화 완료
```

---

## 5. 구현 파일

| 파일 | 변경 내용 | 우선순위 | 예상 작업량 |
|------|----------|----------|------------|
| `package.json` | `hnswlib-node` 의존성 추가 | P0 | 0.5h |
| `config.example.json5` | persistence 설정 문서화 | P0 | 0.5h |
| `src/utils/config-loader.js` | persistence 검증 및 기본값 | P0 | 1h |
| `src/services/chatbot/vector-storage.js` | **NEW**: HNSWLib 영속성 관리 클래스 | P0 | 4h |
| `src/services/chatbot/filtered-retriever.js` | **NEW**: 버전 필터링 Retriever | P0 | 2h |
| `src/services/chatbot/vector-store.js` | VectorStorage 통합, 기존 API 유지 | P0 | 2h |
| `src/services/chatbot/chatbot-service.js` | embeddingConfig 전달, 동기화 로직 | P1 | 1h |
| `test/chatbot/vector-storage.test.js` | **NEW**: 단위 테스트 | P1 | 2h |

---

## 5.1 Phase별 구현 계획

### Phase 1: 기반 설정 (예상 2시간)

**목표**: 의존성 설치 및 설정 검증 기반 구축

```markdown
1. [ ] package.json에 hnswlib-node, @langchain/community 추가
   - npm install hnswlib-node @langchain/community
   - Windows: Visual Studio Build Tools 설치 확인

2. [ ] config.example.json5에 persistence 설정 섹션 추가
   - chatbot.rag.persistence 블록 추가
   - 각 필드별 주석 문서화

3. [ ] config-loader.js에 validatePersistenceConfig() 추가
   - validateChatbotConfig() 내에서 호출
   - 기본값 병합 로직 구현
```

**완료 기준 (DoD)**:
- `npm install` 성공 (네이티브 빌드 포함)
- 잘못된 persistence 설정 시 명확한 에러 메시지 출력
- 기본값으로 서버 정상 시작

**의존성**: 없음 (독립적)

---

### Phase 2: VectorStorage 핵심 (예상 4시간)

**목표**: 디렉토리, 메타데이터, 인덱스 관리 기능 구현

```markdown
1. [ ] vector-storage.js 파일 생성
   - 클래스 기본 구조 및 생성자
   - AsyncLock 설정 및 락 키 정의

2. [ ] 디렉토리 관리 구현
   - _ensureDirectories(): 디렉토리 자동 생성
   - _deleteIndex(): 인덱스 디렉토리 삭제

3. [ ] 메타데이터 관리 구현
   - _initEmptyMetadata(): 빈 메타데이터 초기화
   - _loadMetadata(): 로드 및 백업 복원
   - _saveMetadata(): 원자적 저장 (temp + rename)

4. [ ] 인덱스 관리 구현
   - _loadIndex(): HNSWLib.load() 호출
   - _saveIndex(): vectorStore.save() 호출
   - _validateConsistency(): 일관성 검증

5. [ ] 초기화 로직 구현
   - initialize(): 전체 초기화 흐름
   - _isEmbeddingModelChanged(): 모델 변경 감지
```

**완료 기준 (DoD)**:
- `data/vector/` 디렉토리 자동 생성
- `metadata.json` 생성/로드/저장 정상 동작
- 서버 재시작 시 인덱스 정상 로드
- 메타데이터 손상 시 백업 복원 동작

**의존성**: Phase 1 완료 필수

---

### Phase 3: 문서 관리 (예상 3시간)

**목표**: 문서 추가, 변경 감지, 배치 처리 구현

```markdown
1. [ ] 해시/변경 감지 구현
   - computeHash(): SHA256 해시 계산
   - isDocumentChanged(): 크기/mtime/해시 비교

2. [ ] 단일 문서 추가 구현
   - addDocument(): 청킹 + 임베딩 + 저장

3. [ ] 배치 처리 구현
   - addDocumentsBatch(): 다수 문서 일괄 처리
   - batchSize 기반 청크 분할

4. [ ] 소프트 삭제 구현
   - markDocumentDeleted(): 메타데이터만 제거

5. [ ] Compaction 구현
   - needsCompaction(): 임계치 확인
   - compact(): 전체 재구축
```

**완료 기준 (DoD)**:
- 파일 추가/변경/삭제 정상 감지
- 배치 처리로 다수 문서 일괄 인덱싱
- deletedChunks 비율 초과 시 compaction 트리거

**의존성**: Phase 2 완료 필수

---

### Phase 4: FilteredRetriever (예상 2시간)

**목표**: 삭제/오래된 문서 필터링 Retriever 구현

```markdown
1. [ ] filtered-retriever.js 파일 생성
   - 클래스 기본 구조 및 생성자

2. [ ] 오버샘플링 계산 구현
   - _updateOverSampleFactor(): 삭제 비율 기반 계수 계산

3. [ ] 문서 유효성 검사 구현
   - _isValidDocument(): source/version 검증

4. [ ] 검색 인터페이스 구현
   - invoke(): LangChain 표준 인터페이스
   - getRelevantDocuments(): 레거시 인터페이스
   - similaritySearchWithScore(): 점수 포함 검색
```

**완료 기준 (DoD)**:
- 삭제된 문서가 검색 결과에서 제외
- 이전 버전 청크가 필터링됨
- 삭제 비율에 따른 오버샘플링 동작

**의존성**: Phase 3 완료 필수

---

### Phase 5: 통합 (예상 2시간)

**목표**: 기존 VectorStoreManager 및 ChatbotService 통합

```markdown
1. [ ] vector-store.js 수정
   - VectorStorage 인스턴스 생성 조건 추가
   - persistence 설정 있으면 VectorStorage 사용
   - 없으면 기존 인메모리 폴백

2. [ ] chatbot-service.js 수정
   - embeddingConfig 추출 및 전달
   - VectorStoreManager 생성 시 persistence 옵션 전달

3. [ ] getRetriever() 통합
   - FilteredRetriever 반환 (persistence 모드)
   - 기존 asRetriever() (인메모리 모드)
```

**완료 기준 (DoD)**:
- 기존 API 완전 호환 유지
- persistence 설정 유무에 따른 모드 자동 전환
- ChatbotService에서 정상 동작

**의존성**: Phase 4 완료 필수

---

### Phase 6: 테스트 및 문서화 (예상 2시간)

**목표**: 단위 테스트 및 통합 테스트

```markdown
1. [ ] 단위 테스트 작성
   - TC-VS-001 ~ TC-VS-008 구현
   - FakeEmbeddings 활용

2. [ ] 통합 테스트 작성
   - 서버 시작/재시작 시나리오
   - 파일 추가/변경/삭제 시나리오

3. [ ] config.example.json5 최종 업데이트
   - 모든 옵션 문서화 확인

4. [ ] 로그 메시지 검토
   - 표준 포맷 준수 확인
```

**완료 기준 (DoD)**:
- 모든 테스트 케이스 통과
- 서버 재시작 후 인덱스 유지 확인
- 마이그레이션 가이드대로 동작 검증

**의존성**: Phase 5 완료 필수

---

### Phase 의존성 다이어그램

```
Phase 1 (기반 설정)
    │
    ▼
Phase 2 (VectorStorage 핵심)
    │
    ▼
Phase 3 (문서 관리)
    │
    ▼
Phase 4 (FilteredRetriever)
    │
    ▼
Phase 5 (통합)
    │
    ▼
Phase 6 (테스트)
```

**총 예상 시간**: 약 15시간

---

## 6. 핵심 클래스 상세 설계

### 6.1 VectorStorage 클래스

```javascript
/**
 * HNSWLib 기반 벡터 스토리지 관리 클래스
 * @class VectorStorage
 */
const { HNSWLib } = require('@langchain/community/vectorstores/hnswlib');
const AsyncLock = require('async-lock');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

/**
 * @typedef {Object} EmbeddingConfig
 * @property {string} type - 임베딩 타입 (azure-openai, openai, ollama)
 * @property {string} model - 모델명
 * @property {string} [deploymentName] - Azure 배포명
 * @property {string} [endpoint] - API 엔드포인트
 * @property {number} [dimension] - 임베딩 차원
 */

/**
 * @typedef {Object} DocumentMeta
 * @property {string} hash - SHA256 해시 (base64)
 * @property {number} size - 파일 크기 (bytes)
 * @property {number} mtime - 수정 시간 (Unix timestamp ms)
 * @property {number} chunkCount - 청크 수
 * @property {number} version - 문서 버전
 * @property {string} indexedAt - 인덱싱 시간 (ISO 8601)
 */

class VectorStorage {
  /**
   * @param {Object} config - RAG 설정 (chatbot.rag)
   * @param {Object} embeddings - LangChain Embeddings 인스턴스
   * @param {EmbeddingConfig} embeddingConfig - 임베딩 설정
   * @param {Object} logger - 로거 인스턴스
   */
  constructor(config, embeddings, embeddingConfig, logger) {
    this.config = config;
    this.embeddings = embeddings;
    this.embeddingConfig = embeddingConfig;
    this.logger = logger;

    // 경로 설정
    const persistence = config.persistence || {};
    this.dataDir = path.resolve(persistence.dataDir || './data/vector');
    this.indexDir = path.join(this.dataDir, 'index');
    this.metadataPath = path.join(this.dataDir, 'metadata.json');
    this.backupPath = path.join(this.dataDir, 'metadata.json.bak');

    // 설정값
    this.autoCompact = persistence.autoCompact !== false;
    this.compactThreshold = persistence.compactThreshold || 0.3;
    this.batchSize = persistence.batchSize || 50;

    // 상태
    this.vectorStore = null;
    this.metadata = null;
    this.isInitialized = false;

    // 동시성 제어
    this.lock = new AsyncLock({ timeout: 30000 });

    // 락 키 정의
    this.LOCK_KEYS = {
      READ: 'read',      // 인덱스 읽기
      WRITE: 'write',    // 문서 추가/수정
      PERSIST: 'persist', // 파일 저장
      REBUILD: 'rebuild'  // 전체 재구축 (배타적)
    };
  }

  /**
   * 초기화 - 디렉토리 생성, 메타데이터/인덱스 로드
   * @returns {Promise<void>}
   */
  async initialize() {
    return this.lock.acquire(this.LOCK_KEYS.REBUILD, async () => {
      this.logger?.info('[VectorStorage] Initializing...');

      // 1. 디렉토리 생성
      await this._ensureDirectories();

      // 2. 메타데이터 로드 시도
      const metadataLoaded = await this._loadMetadata();

      if (!metadataLoaded) {
        // 신규 설치: 빈 메타데이터 생성
        this.logger?.info('[VectorStorage] No metadata found, creating new');
        this._initEmptyMetadata();
        return;
      }

      // 3. 임베딩 모델 변경 확인
      if (this._isEmbeddingModelChanged()) {
        this.logger?.warn('[VectorStorage] Embedding model changed, rebuilding index');
        await this._deleteIndex();
        this._initEmptyMetadata();
        return;
      }

      // 4. 인덱스 로드 시도
      const indexLoaded = await this._loadIndex();

      if (!indexLoaded) {
        this.logger?.warn('[VectorStorage] Failed to load index, rebuilding');
        this._initEmptyMetadata();
        return;
      }

      // 5. 인덱스-메타데이터 일관성 검증
      if (!this._validateConsistency()) {
        this.logger?.warn('[VectorStorage] Inconsistency detected, rebuilding');
        await this._deleteIndex();
        this._initEmptyMetadata();
        return;
      }

      this.isInitialized = true;
      this.logger?.info(`[VectorStorage] Initialized with ${this.metadata.stats.totalChunks} chunks`);
    });
  }

  /**
   * 디렉토리 존재 확인 및 생성
   * @private
   */
  async _ensureDirectories() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.mkdir(this.indexDir, { recursive: true });
      this.logger?.debug(`[VectorStorage] Directories ensured: ${this.dataDir}`);
    } catch (error) {
      this.logger?.error('[VectorStorage] Failed to create directories:', error);
      throw new Error(`Cannot create data directory: ${error.message}`);
    }
  }

  /**
   * 빈 메타데이터 초기화
   * @private
   */
  _initEmptyMetadata() {
    this.metadata = {
      version: 1,
      schemaVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      embedding: {
        type: this.embeddingConfig.type,
        model: this.embeddingConfig.model,
        deploymentName: this.embeddingConfig.deploymentName,
        endpoint: this.embeddingConfig.endpoint,
        dimension: this.embeddingConfig.dimension || null
      },
      documents: {},
      stats: {
        totalDocuments: 0,
        totalChunks: 0,
        deletedDocuments: 0,
        deletedChunks: 0
      }
    };
    this.vectorStore = null;
  }

  /**
   * 메타데이터 로드
   * @private
   * @returns {Promise<boolean>} 로드 성공 여부
   */
  async _loadMetadata() {
    try {
      const content = await fs.readFile(this.metadataPath, 'utf-8');
      this.metadata = JSON.parse(content);
      this.logger?.debug('[VectorStorage] Metadata loaded');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      this.logger?.warn('[VectorStorage] Failed to parse metadata, trying backup');

      // 백업에서 복구 시도
      try {
        const backup = await fs.readFile(this.backupPath, 'utf-8');
        this.metadata = JSON.parse(backup);
        this.logger?.info('[VectorStorage] Restored from backup');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 메타데이터 원자적 저장
   * @private
   * @returns {Promise<void>}
   */
  async _saveMetadata() {
    return this.lock.acquire(this.LOCK_KEYS.PERSIST, async () => {
      this.metadata.lastUpdatedAt = new Date().toISOString();
      const content = JSON.stringify(this.metadata, null, 2);
      const tempPath = this.metadataPath + '.tmp';

      try {
        // 1. 현재 파일 백업
        try {
          await fs.copyFile(this.metadataPath, this.backupPath);
        } catch {
          // 첫 저장 시 원본 없음 - 무시
        }

        // 2. 임시 파일에 쓰기
        await fs.writeFile(tempPath, content, 'utf-8');

        // 3. 원자적 이동 (rename)
        await fs.rename(tempPath, this.metadataPath);

        this.logger?.debug('[VectorStorage] Metadata saved atomically');
      } catch (error) {
        // 임시 파일 정리
        try { await fs.unlink(tempPath); } catch {}
        throw error;
      }
    });
  }

  /**
   * HNSWLib 인덱스 로드
   * @private
   * @returns {Promise<boolean>} 로드 성공 여부
   */
  async _loadIndex() {
    try {
      const indexPath = path.join(this.indexDir, 'hnswlib.index');
      await fs.access(indexPath);

      this.vectorStore = await HNSWLib.load(this.indexDir, this.embeddings);
      this.logger?.debug('[VectorStorage] Index loaded successfully');
      return true;
    } catch (error) {
      this.logger?.debug(`[VectorStorage] Index load failed: ${error.message}`);
      return false;
    }
  }

  /**
   * HNSWLib 인덱스 저장
   * @private
   * @returns {Promise<void>}
   */
  async _saveIndex() {
    if (!this.vectorStore) return;

    return this.lock.acquire(this.LOCK_KEYS.PERSIST, async () => {
      try {
        await this.vectorStore.save(this.indexDir);
        this.logger?.debug('[VectorStorage] Index saved');
      } catch (error) {
        this.logger?.error('[VectorStorage] Failed to save index:', error);
        throw error;
      }
    });
  }

  /**
   * 인덱스 삭제
   * @private
   */
  async _deleteIndex() {
    try {
      await fs.rm(this.indexDir, { recursive: true, force: true });
      await fs.mkdir(this.indexDir, { recursive: true });
      this.vectorStore = null;
      this.logger?.info('[VectorStorage] Index deleted');
    } catch (error) {
      this.logger?.error('[VectorStorage] Failed to delete index:', error);
    }
  }

  /**
   * 임베딩 모델 변경 여부 확인
   * @private
   * @returns {boolean}
   */
  _isEmbeddingModelChanged() {
    const stored = this.metadata?.embedding;
    const current = this.embeddingConfig;

    if (!stored) return true;

    return stored.type !== current.type ||
           stored.model !== current.model ||
           stored.deploymentName !== current.deploymentName;
  }

  /**
   * 인덱스-메타데이터 일관성 검증
   * @private
   * @returns {boolean}
   */
  _validateConsistency() {
    if (!this.vectorStore || !this.metadata) return false;

    // 인덱스 크기와 메타데이터 통계 비교
    // HNSWLib는 size() 메서드 없음 - docstore로 확인
    const docstoreSize = this.vectorStore.docstore?._docs?.size || 0;
    const expectedSize = this.metadata.stats.totalChunks;

    // 10% 오차 허용 (compaction 대기 상태일 수 있음)
    if (Math.abs(docstoreSize - expectedSize) > expectedSize * 0.1) {
      this.logger?.warn(`[VectorStorage] Inconsistency: docstore=${docstoreSize}, expected=${expectedSize}`);
      return false;
    }

    return true;
  }

  /**
   * 콘텐츠 해시 계산
   * @param {string} content - 문서 내용
   * @returns {string} SHA256 해시 (base64)
   */
  computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('base64');
  }

  /**
   * 문서 변경 여부 확인
   * @param {string} docPath - 문서 경로 (상대)
   * @param {Object} stats - 파일 stats
   * @param {string} content - 파일 내용
   * @returns {boolean}
   */
  isDocumentChanged(docPath, stats, content) {
    const stored = this.metadata?.documents?.[docPath];
    if (!stored) return true; // 새 문서

    // 빠른 체크: 크기와 수정 시간
    if (stored.size !== stats.size) return true;
    if (stored.mtime !== stats.mtimeMs) return true;

    // 정밀 체크: 해시 비교
    const currentHash = this.computeHash(content);
    return stored.hash !== currentHash;
  }

  /**
   * 문서 추가/업데이트
   * @param {string} docPath - 문서 경로 (상대)
   * @param {string} content - 문서 내용
   * @param {Object} fileStats - 파일 stats
   * @param {Object} additionalMeta - 추가 메타데이터
   * @returns {Promise<number>} 생성된 청크 수
   */
  async addDocument(docPath, content, fileStats, additionalMeta = {}) {
    return this.lock.acquire(this.LOCK_KEYS.WRITE, async () => {
      const existing = this.metadata.documents[docPath];
      const version = existing ? existing.version + 1 : 1;

      this.logger?.info(`[VectorStorage] Adding document: ${docPath} (v${version})`);

      // 청킹
      const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: this.config.chunkSize || 1000,
        chunkOverlap: this.config.chunkOverlap || 200
      });

      const chunks = await splitter.createDocuments(
        [content],
        [{
          source: docPath,
          version,
          ...additionalMeta
        }]
      );

      // 벡터 스토어에 추가
      if (!this.vectorStore) {
        this.vectorStore = await HNSWLib.fromDocuments(chunks, this.embeddings);
      } else {
        await this.vectorStore.addDocuments(chunks);
      }

      // 기존 문서 청크 수 기록 (삭제된 것으로 처리)
      if (existing) {
        this.metadata.stats.deletedChunks += existing.chunkCount;
      }

      // 메타데이터 업데이트
      this.metadata.documents[docPath] = {
        hash: this.computeHash(content),
        size: fileStats.size,
        mtime: fileStats.mtimeMs,
        chunkCount: chunks.length,
        version,
        indexedAt: new Date().toISOString()
      };

      // 통계 업데이트
      if (!existing) {
        this.metadata.stats.totalDocuments++;
      }
      this.metadata.stats.totalChunks += chunks.length;

      // 저장
      await this._saveMetadata();
      await this._saveIndex();

      return chunks.length;
    });
  }

  /**
   * 배치 문서 추가 (API 호출 최소화)
   * @param {Array<{path: string, content: string, stats: Object}>} documents
   * @returns {Promise<number>} 총 생성된 청크 수
   */
  async addDocumentsBatch(documents) {
    return this.lock.acquire(this.LOCK_KEYS.WRITE, async () => {
      this.logger?.info(`[VectorStorage] Batch adding ${documents.length} documents`);

      let totalChunks = 0;

      // 배치 단위로 처리
      for (let i = 0; i < documents.length; i += this.batchSize) {
        const batch = documents.slice(i, i + this.batchSize);

        for (const doc of batch) {
          const existing = this.metadata.documents[doc.path];
          const version = existing ? existing.version + 1 : 1;

          // 청킹
          const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
          const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.config.chunkSize || 1000,
            chunkOverlap: this.config.chunkOverlap || 200
          });

          const chunks = await splitter.createDocuments(
            [doc.content],
            [{ source: doc.path, version }]
          );

          // 벡터 스토어에 추가
          if (!this.vectorStore) {
            this.vectorStore = await HNSWLib.fromDocuments(chunks, this.embeddings);
          } else {
            await this.vectorStore.addDocuments(chunks);
          }

          // 메타데이터 업데이트
          if (existing) {
            this.metadata.stats.deletedChunks += existing.chunkCount;
          } else {
            this.metadata.stats.totalDocuments++;
          }

          this.metadata.documents[doc.path] = {
            hash: this.computeHash(doc.content),
            size: doc.stats.size,
            mtime: doc.stats.mtimeMs,
            chunkCount: chunks.length,
            version,
            indexedAt: new Date().toISOString()
          };

          this.metadata.stats.totalChunks += chunks.length;
          totalChunks += chunks.length;
        }

        this.logger?.debug(`[VectorStorage] Processed batch ${i + 1}-${Math.min(i + this.batchSize, documents.length)}`);
      }

      // 한 번에 저장
      await this._saveMetadata();
      await this._saveIndex();

      return totalChunks;
    });
  }

  /**
   * 문서 소프트 삭제 (메타데이터만 제거)
   * @param {string} docPath - 문서 경로
   */
  markDocumentDeleted(docPath) {
    const doc = this.metadata.documents[docPath];
    if (!doc) return;

    this.metadata.stats.deletedDocuments++;
    this.metadata.stats.deletedChunks += doc.chunkCount;
    this.metadata.stats.totalDocuments--;

    delete this.metadata.documents[docPath];

    this.logger?.info(`[VectorStorage] Document marked deleted: ${docPath}`);
  }

  /**
   * Compaction 필요 여부 확인
   * @returns {boolean}
   */
  needsCompaction() {
    if (!this.autoCompact) return false;
    if (this.metadata.stats.totalChunks === 0) return false;

    const ratio = this.metadata.stats.deletedChunks /
                  (this.metadata.stats.totalChunks + this.metadata.stats.deletedChunks);

    return ratio > this.compactThreshold;
  }

  /**
   * Compaction 수행 (전체 재구축)
   * @param {Function} getContent - 문서 내용 가져오기 함수 (path) => Promise<{content, stats}>
   * @returns {Promise<void>}
   */
  async compact(getContent) {
    return this.lock.acquire(this.LOCK_KEYS.REBUILD, async () => {
      this.logger?.info('[VectorStorage] Starting compaction...');

      // 현재 유효한 문서 목록
      const validDocs = Object.keys(this.metadata.documents);

      // 인덱스 삭제
      await this._deleteIndex();

      // 통계 초기화
      this.metadata.stats.totalChunks = 0;
      this.metadata.stats.deletedChunks = 0;
      this.metadata.stats.deletedDocuments = 0;

      // 배치로 재인덱싱
      const documents = [];
      for (const docPath of validDocs) {
        try {
          const { content, stats } = await getContent(docPath);
          documents.push({ path: docPath, content, stats });
        } catch (error) {
          this.logger?.warn(`[VectorStorage] Skipping ${docPath}: ${error.message}`);
          delete this.metadata.documents[docPath];
          this.metadata.stats.totalDocuments--;
        }
      }

      if (documents.length > 0) {
        await this.addDocumentsBatch(documents);
      }

      this.logger?.info(`[VectorStorage] Compaction complete: ${documents.length} documents`);
    });
  }

  /**
   * FilteredRetriever 반환
   * @param {number} k - 반환할 문서 수
   * @returns {FilteredRetriever}
   */
  getRetriever(k = 4) {
    const FilteredRetriever = require('./filtered-retriever');
    return new FilteredRetriever(this.vectorStore, this.metadata, k, this.logger);
  }

  /**
   * 통계 반환
   * @returns {Object}
   */
  getStats() {
    return {
      totalDocuments: this.metadata?.stats?.totalDocuments || 0,
      totalChunks: this.metadata?.stats?.totalChunks || 0,
      deletedDocuments: this.metadata?.stats?.deletedDocuments || 0,
      deletedChunks: this.metadata?.stats?.deletedChunks || 0,
      needsCompaction: this.needsCompaction(),
      indexDir: this.indexDir,
      isInitialized: this.isInitialized
    };
  }
}

module.exports = { VectorStorage };
```

### 6.2 FilteredRetriever 클래스

```javascript
/**
 * 삭제된/오래된 버전 문서를 필터링하는 Retriever
 * @class FilteredRetriever
 */
class FilteredRetriever {
  /**
   * @param {Object} vectorStore - HNSWLib VectorStore 인스턴스
   * @param {Object} metadata - VectorStorage 메타데이터
   * @param {number} k - 반환할 최대 문서 수
   * @param {Object} logger - 로거 인스턴스
   */
  constructor(vectorStore, metadata, k = 4, logger = null) {
    this.vectorStore = vectorStore;
    this.metadata = metadata;
    this.k = k;
    this.logger = logger;

    // 삭제 비율에 따른 오버샘플링 계수 계산
    this._updateOverSampleFactor();
  }

  /**
   * 오버샘플링 계수 업데이트
   * @private
   */
  _updateOverSampleFactor() {
    const stats = this.metadata?.stats || {};
    const total = stats.totalChunks + stats.deletedChunks;

    if (total === 0) {
      this.overSampleFactor = 1;
      return;
    }

    // 삭제 비율만큼 추가 검색
    const deletedRatio = stats.deletedChunks / total;
    this.overSampleFactor = 1 + deletedRatio + 0.2; // 20% 버퍼

    // 최대 3배로 제한
    this.overSampleFactor = Math.min(this.overSampleFactor, 3);
  }

  /**
   * 문서가 유효한지 확인
   * @private
   * @param {Object} doc - 검색된 문서
   * @returns {boolean}
   */
  _isValidDocument(doc) {
    const source = doc.metadata?.source;
    const version = doc.metadata?.version;

    if (!source) return false;

    // 메타데이터에 없으면 삭제된 문서
    const storedDoc = this.metadata.documents?.[source];
    if (!storedDoc) return false;

    // 최신 버전만 유효
    if (version !== storedDoc.version) return false;

    return true;
  }

  /**
   * LangChain Retriever 인터페이스: invoke
   * @param {string} query - 검색 쿼리
   * @returns {Promise<Array>} 관련 문서 배열
   */
  async invoke(query) {
    return this.getRelevantDocuments(query);
  }

  /**
   * 관련 문서 검색 (레거시 인터페이스)
   * @param {string} query - 검색 쿼리
   * @returns {Promise<Array>} 관련 문서 배열
   */
  async getRelevantDocuments(query) {
    if (!this.vectorStore) {
      this.logger?.warn('[FilteredRetriever] VectorStore not initialized');
      return [];
    }

    // 오버샘플링으로 더 많이 검색
    const searchK = Math.ceil(this.k * this.overSampleFactor);

    this.logger?.debug(`[FilteredRetriever] Searching with k=${searchK} (target=${this.k})`);

    try {
      // 유사도 검색
      const results = await this.vectorStore.similaritySearch(query, searchK);

      // 유효한 문서만 필터링
      const validResults = results.filter(doc => this._isValidDocument(doc));

      this.logger?.debug(`[FilteredRetriever] Found ${results.length} docs, ${validResults.length} valid`);

      // 최대 k개 반환
      return validResults.slice(0, this.k);

    } catch (error) {
      this.logger?.error('[FilteredRetriever] Search failed:', error);
      return [];
    }
  }

  /**
   * 유사도 점수와 함께 검색
   * @param {string} query - 검색 쿼리
   * @returns {Promise<Array<{document: Object, score: number}>>}
   */
  async similaritySearchWithScore(query) {
    if (!this.vectorStore) return [];

    const searchK = Math.ceil(this.k * this.overSampleFactor);

    try {
      const results = await this.vectorStore.similaritySearchWithScore(query, searchK);

      return results
        .filter(([doc]) => this._isValidDocument(doc))
        .slice(0, this.k)
        .map(([document, score]) => ({ document, score }));

    } catch (error) {
      this.logger?.error('[FilteredRetriever] Search with score failed:', error);
      return [];
    }
  }
}

module.exports = FilteredRetriever;
```

---

## 7. 에러 처리 전략

### 7.1 에러 타입 정의

```javascript
/**
 * VectorStorage 에러 타입
 */
class VectorStorageError extends Error {
  constructor(message, code, recoverable = false) {
    super(message);
    this.name = 'VectorStorageError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

// 에러 코드
const ErrorCodes = {
  DIRECTORY_CREATE_FAILED: 'VS_DIR_001',  // 디렉토리 생성 실패
  METADATA_PARSE_FAILED: 'VS_META_001',   // 메타데이터 파싱 실패
  METADATA_SAVE_FAILED: 'VS_META_002',    // 메타데이터 저장 실패
  INDEX_LOAD_FAILED: 'VS_IDX_001',        // 인덱스 로드 실패
  INDEX_SAVE_FAILED: 'VS_IDX_002',        // 인덱스 저장 실패
  INDEX_CORRUPTED: 'VS_IDX_003',          // 인덱스 손상
  EMBEDDING_API_FAILED: 'VS_EMB_001',     // 임베딩 API 실패
  EMBEDDING_MODEL_CHANGED: 'VS_EMB_002',  // 모델 변경됨
  LOCK_TIMEOUT: 'VS_LOCK_001',            // 락 타임아웃
};
```

### 7.2 복구 전략

| 에러 상황 | 복구 가능 | 자동 복구 방법 |
|----------|----------|---------------|
| 디렉토리 생성 실패 | X | 권한 오류 로깅, 인메모리 폴백 |
| 메타데이터 파싱 실패 | O | 백업 파일에서 복원 시도 |
| 인덱스 로드 실패 | O | 전체 재인덱싱 |
| 인덱스 손상 | O | 메타데이터 기반 전체 재구축 |
| 임베딩 API 실패 | O | 3회 재시도 후 해당 문서 스킵 |
| 락 타임아웃 | O | 30초 후 재시도 |

### 7.3 재시도 로직

```javascript
/**
 * 재시도 헬퍼 함수
 * @param {Function} fn - 실행할 함수
 * @param {number} maxRetries - 최대 재시도 횟수
 * @param {number} delay - 재시도 간격 (ms)
 */
async function withRetry(fn, maxRetries = 3, delay = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }

  throw lastError;
}
```

---

## 8. 로깅 가이드

### 8.1 로그 레벨 표준

| 레벨 | 사용 상황 | 예시 |
|------|----------|------|
| **ERROR** | 복구 불가능한 오류 | 인덱스 손상, API 인증 실패 |
| **WARN** | 복구 가능한 문제 | 파일 스킵, 재시도 발생 |
| **INFO** | 주요 작업 시작/완료 | 초기화 완료, 동기화 시작 |
| **DEBUG** | 상세 진행 상황 | 해시 비교 결과, 청크 수 |

### 8.2 로그 메시지 포맷

```javascript
// 표준 로그 포맷
[VectorStorage] <action>: <detail>

// 예시
[VectorStorage] Initializing...
[VectorStorage] Loaded 150 chunks from index
[VectorStorage] Document added: guide/intro.md (v2, 5 chunks)
[VectorStorage] Sync complete: 38 docs, 3 new, 1 updated, 0 deleted
[VectorStorage] Compaction triggered: 35% deleted chunks
```

---

## 9. 테스트 계획

### 9.1 단위 테스트

| ID | 테스트 케이스 | 검증 방법 |
|----|-------------|----------|
| TC-VS-001 | persistence 설정 검증 | 잘못된 설정으로 에러 발생 확인 |
| TC-VS-002 | 빈 상태 초기화 | metadata.json 생성 확인 |
| TC-VS-003 | 인덱스 로드/저장 | 서버 재시작 후 데이터 유지 |
| TC-VS-004 | 해시 변경 감지 | 내용 변경 시 재인덱싱 |
| TC-VS-005 | 모델 변경 감지 | 모델 변경 시 전체 재인덱싱 |
| TC-VS-006 | 원자적 저장 | 저장 중 크래시 시 백업 복원 |
| TC-VS-007 | FilteredRetriever | 삭제된 문서 필터링 |
| TC-VS-008 | Compaction 트리거 | 임계치 초과 시 재구축 |

### 9.2 테스트 픽스처

```javascript
/**
 * 테스트용 가짜 Embeddings
 */
class FakeEmbeddings {
  constructor(dimension = 1536) {
    this.dimension = dimension;
  }

  async embedDocuments(texts) {
    return texts.map(() =>
      Array(this.dimension).fill(0).map(() => Math.random())
    );
  }

  async embedQuery(text) {
    return Array(this.dimension).fill(0).map(() => Math.random());
  }
}

/**
 * 테스트 설정
 */
const testConfig = {
  chunkSize: 100,
  chunkOverlap: 20,
  persistence: {
    dataDir: './test-data/vector',
    autoCompact: true,
    compactThreshold: 0.3,
    syncOnStartup: true,
    batchSize: 10
  }
};
```

---

## 10. 마이그레이션 가이드

### 10.1 기존 사용자 마이그레이션 체크리스트

```markdown
## 사전 준비
1. [ ] 현재 서버 중지
2. [ ] npm install hnswlib-node 실행
3. [ ] Windows: Visual Studio Build Tools 설치 확인
4. [ ] config.json5 백업

## 설정 업데이트
5. [ ] config.json5에 persistence 섹션 추가:
   ```json5
   rag: {
     chunkSize: 1000,
     chunkOverlap: 200,
     retrievalCount: 20,
     persistence: {
       dataDir: "./data/vector",
       autoCompact: true,
       compactThreshold: 0.3,
       syncOnStartup: true
     }
   }
   ```
6. [ ] dataDir 경로 확인 (쓰기 권한)

## 첫 실행
7. [ ] npm start 실행
8. [ ] 로그에서 "[VectorStorage] Initializing..." 확인
9. [ ] 전체 인덱싱 진행 (문서 수에 따라 시간 소요)
10. [ ] "Sync complete" 로그 확인
11. [ ] data/vector/metadata.json 생성 확인

## 검증
12. [ ] 챗봇으로 테스트 질문
13. [ ] 서버 재시작
14. [ ] 로그에서 "Loaded X chunks from index" 확인 (재인덱싱 없음)
```

### 10.2 롤백 절차

```markdown
## 영속성 비활성화 (인메모리 모드)
1. [ ] 서버 중지
2. [ ] config.json5에서 persistence 섹션 삭제 또는:
   ```json5
   persistence: {
     syncOnStartup: false  // 비활성화
   }
   ```
3. [ ] data/vector 디렉토리 삭제 (선택적)
4. [ ] 서버 시작 → 기존 인메모리 모드로 동작
```

### 10.3 버전 호환성

| DocLight 버전 | persistence 지원 | 비고 |
|--------------|-----------------|------|
| < 2.0.0 | X | 인메모리 전용 |
| >= 2.0.0 | O | persistence 옵션 |

---

## 11. 성능 및 확장성

### 11.1 성능 예측

| 항목 | 100 문서 | 1,000 문서 | 10,000 문서 |
|------|---------|-----------|------------|
| 메모리 | ~1MB | ~6MB | ~60MB |
| 디스크 | ~2MB | ~15MB | ~150MB |
| 인덱스 로드 | <0.5초 | ~1-2초 | ~10-20초 |
| 동기화 (변경 없음) | <0.1초 | ~0.5초 | ~2초 |
| 전체 재인덱싱 | ~1분 | ~10분 | ~100분 |

**참고**: 재인덱싱 시간은 임베딩 API 속도에 크게 의존

### 11.2 문서 규모별 권장 설정

| 문서 수 | 권장 설정 | 비고 |
|---------|----------|------|
| ~100 | 기본 설정 | 별도 최적화 불필요 |
| ~1,000 | `batchSize: 50` | 기본값으로 적합 |
| ~5,000 | `batchSize: 100`, `compactThreshold: 0.2` | 빈번한 compaction 방지 |
| ~10,000 | `batchSize: 100`, 백그라운드 동기화 고려 | 아래 대용량 처리 전략 참조 |
| 10,000+ | 전용 벡터 DB 권장 | Pinecone, Weaviate, Milvus |

### 11.3 대용량 문서 처리 전략

#### 11.3.1 스트리밍 동기화 (향후 구현)

대용량 파일 목록 처리 시 메모리 효율화를 위한 스트리밍 패턴:

```javascript
/**
 * 스트리밍 동기화 - 대용량 문서용 (향후 구현)
 * @param {AsyncIterable<string>} fileStream - 파일 경로 스트림
 * @param {number} chunkSize - 한 번에 처리할 파일 수
 */
async *streamingSync(fileStream, chunkSize = 100) {
  let batch = [];

  for await (const filePath of fileStream) {
    batch.push(filePath);

    if (batch.length >= chunkSize) {
      yield await this._processBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield await this._processBatch(batch);
  }
}
```

#### 11.3.2 백그라운드 동기화 옵션 (향후 구현)

서버 시작 블로킹 방지를 위한 백그라운드 동기화:

```javascript
// config.json5 확장 옵션 (향후)
persistence: {
  dataDir: "./data/vector",
  syncOnStartup: "background",  // "blocking" | "background" | false
  syncProgressEndpoint: true     // GET /api/chatbot/sync-status
}
```

**동작 방식**:
- `"blocking"`: 기존 방식, 동기화 완료까지 대기
- `"background"`: 서버 즉시 시작, 백그라운드에서 동기화 진행
- `false`: 동기화 건너뜀 (개발 모드)

#### 11.3.3 점진적 인덱스 로드 (향후 구현)

자주 사용되는 문서 우선 로드:

```javascript
// 우선순위 기반 로드 전략
const loadPriority = {
  recent: 0.5,      // 최근 수정된 문서 50%
  frequent: 0.3,    // 자주 검색된 문서 30%
  remaining: 0.2    // 나머지 20%
};
```

#### 11.3.4 10,000+ 문서 마이그레이션 가이드

HNSWLib 파일 기반 저장소의 한계를 초과하는 경우:

```markdown
## 전용 벡터 DB 마이그레이션 체크리스트

### 권장 대안
1. **Pinecone**: 관리형 서비스, 무료 티어 제공
2. **Weaviate**: 오픈소스, 셀프호스팅 가능
3. **Milvus**: 대규모 벡터 검색 특화
4. **Chroma**: Python 친화적, LangChain 통합 우수

### 마이그레이션 단계
1. 새 벡터 DB 환경 구성
2. metadata.json에서 문서 목록 추출
3. 배치 단위로 임베딩 마이그레이션
4. config.json5 벡터 DB 설정 변경
5. data/vector 디렉토리 백업 후 삭제
```

### 11.4 메모리 관리 지침

| 상황 | 권장 조치 |
|------|----------|
| 서버 시작 시 OOM | `batchSize` 감소 (예: 25) |
| 동기화 중 메모리 급증 | 동기화 파일 수 제한 |
| 검색 시 지연 | `compactThreshold` 감소 (예: 0.2) |
| 인덱스 로드 지연 | SSD 디스크 사용 권장 |

---

## 12. 주의사항

### 12.1 Windows hnswlib-node 빌드

- **문제**: hnswlib-node는 네이티브 모듈로 빌드 필요
- **해결**: Visual Studio Build Tools 설치 필요
- **대안**: 빌드 실패 시 인메모리 모드 폴백

### 12.2 동시 쓰기 충돌

- **문제**: DocWatcher와 동기화 동시 실행
- **해결**: AsyncLock 사용하여 직렬화
- **락 범위**: READ, WRITE, PERSIST, REBUILD 키 분리

### 12.3 대용량 인덱스 로드

- **문제**: 수천 개 문서 인덱스 로드 지연
- **해결**: 비동기 초기화, 진행 상황 로깅
- **권장**: 10,000+ 문서는 별도 벡터 DB 검토

### 12.4 임베딩 API 실패

- **문제**: API 오류 시 인덱스 일관성 깨짐
- **해결**: 3회 재시도, 실패 문서 스킵 및 기록

---

## 13. 관련 문서

- `docs/plan/plan.step15.md` - Step 15 전체 계획
- `src/services/chatbot/vector-store.js` - 현재 VectorStoreManager
- `src/services/chatbot/chatbot-service.js` - ChatbotService

---

## 변경 이력

| 버전 | 날짜 | 변경 내용 |
|------|------|----------|
| 1.0.0 | 2026-01-09 | 초기 계획 작성 |
| 2.0.0 | 2026-01-09 | 전문가 평가 반영: 상세 구현 코드, 에러 처리, 테스트 계획, 마이그레이션 가이드 추가 |
| 2.1.0 | 2026-01-09 | 2차 평가 반영: Phase별 구현 계획(DoD 포함), 확장성 전략(대용량 문서, 스트리밍 동기화, 마이그레이션 가이드) 추가 |
