# DocuLight MCP API 문서

## 개요

DocuLight는 Model Context Protocol (MCP) over HTTP를 지원하여 AI 에이전트가 문서 관리 작업을 수행할 수 있도록 합니다. MCP는 JSON-RPC 2.0 프로토콜을 기반으로 하며, SDK 없이 직접 구현되었습니다.

### 기본 정보

- **프로토콜**: JSON-RPC 2.0
- **엔드포인트**: `POST /mcp`
- **Content-Type**: `application/json`
- **MCP 버전**: 2024-11-05
- **인증**: 불필요 (공개 엔드포인트)

---

## MCP 프로토콜 구조

### JSON-RPC 2.0 요청 형식

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method_name",
  "params": {
    // method-specific parameters
  }
}
```

### JSON-RPC 2.0 응답 형식

**성공 응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    // method-specific result
  }
}
```

**에러 응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": "Additional error information"
  }
}
```

---

## MCP 메서드

### 1. initialize

MCP 서버를 초기화하고 서버 정보 및 기능을 조회합니다.

**요청:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize"
}
```

**응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "DocuLight",
      "version": "1.0.0"
    }
  }
}
```

**응답 필드:**
- `protocolVersion`: MCP 프로토콜 버전
- `capabilities`: 서버가 지원하는 기능
  - `tools`: 도구(Tools) 기능 지원
- `serverInfo`: 서버 정보
  - `name`: 서버 이름
  - `version`: 서버 버전

---

### 2. tools/list

사용 가능한 모든 MCP 도구 목록을 조회합니다.

**요청:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

**응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "list_documents",
        "description": "List all documents in a directory",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Directory path (default: root)",
              "default": "/"
            }
          }
        }
      },
      {
        "name": "list_full_tree",
        "description": "Recursively list all documents and directories starting from a path",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Starting directory path (default: /)",
              "default": "/"
            },
            "maxDepth": {
              "type": "integer",
              "description": "Optional maximum depth (0 = only this directory). If omitted, full depth."
            }
          }
        }
      },
      {
        "name": "read_document",
        "description": "Read a markdown document",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Document path (e.g., guide/getting-started.md)"
            }
          },
          "required": ["path"]
        }
      },
      {
        "name": "create_document",
        "description": "Create or update a markdown document",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Document path (e.g., guide/new-doc.md)"
            },
            "content": {
              "type": "string",
              "description": "Markdown content"
            }
          },
          "required": ["path", "content"]
        }
      },
      {
        "name": "delete_document",
        "description": "Delete a document or directory",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Document or directory path to delete"
            }
          },
          "required": ["path"]
        }
      },
      {
        "name": "DocuLight_get_config",
        "description": "Get current runtime configuration with sensitive values masked",
        "inputSchema": {
          "type": "object",
          "properties": {
            "section": {
              "type": "string",
              "description": "Configuration section to retrieve (ui, security, ssl, all)",
              "default": "all",
              "enum": ["ui", "security", "ssl", "all"]
            }
          }
        }
      },
      {
        "name": "DocuLight_search",
        "description": "Search for documents containing specific text",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Search query (minimum 2 characters)"
            },
            "limit": {
              "type": "integer",
              "description": "Maximum number of results to return (1-100)",
              "default": 10
            },
            "path": {
              "type": "string",
              "description": "Search within directory (default: /)",
              "default": "/"
            }
          },
          "required": ["query"]
        }
      }
    ]
  }
}
```

---

### 3. tools/call

특정 도구를 실행합니다.

**요청 형식:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": {
      // tool-specific arguments
    }
  }
}
```

---

## MCP 도구 (Tools)

### 도구 1: list_documents

특정 디렉토리의 바로 하위 항목(1 depth)만 조회합니다.

**파라미터:**
| 이름 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| path | string | No | `/` | 조회할 디렉토리 경로 |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "list_documents",
    "arguments": {
      "path": "/guide"
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Documents at /guide\n\n📁 chapter1/\n📁 chapter2/\n📄 intro.md\n📄 setup.md\n"
      }
    ]
  }
}
```

**출력 형식:**
- 디렉토리: `📁 디렉토리명/`
- 파일: `📄 파일명`
- 알파벳순 정렬
- 빈 디렉토리: `(Empty directory)`

**특징:**
- 숨김 파일(`.`로 시작) 자동 제외
- `config.json5`의 `excludes` 규칙 적용
- 하위 디렉토리 내부는 표시하지 않음 (1 depth만)

---

### 도구 2: list_full_tree

지정된 경로부터 모든 하위 디렉토리를 재귀적으로 조회합니다.

**파라미터:**
| 이름 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| path | string | No | `/` | 시작 디렉토리 경로 |
| maxDepth | integer | No | unlimited | 최대 깊이 (0 = 현재 디렉토리만) |

**요청 예시 1 - 전체 트리:**
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "list_full_tree",
    "arguments": {
      "path": "/"
    }
  }
}
```

**요청 예시 2 - 깊이 제한:**
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "list_full_tree",
    "arguments": {
      "path": "/guide",
      "maxDepth": 2
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Full Tree at /\n\nStats: Directories=15, Files=42\n\n📁 docs/\n  📁 api/\n    📄 api.md\n    📄 mcp.md\n  📁 guide/\n    📄 intro.md\n📁 public/\n  📄 index.html\n📄 README.md\n"
      }
    ]
  }
}
```

**출력 형식:**
- 헤더: 경로, 통계 정보 (디렉토리 수, 파일 수, maxDepth)
- 계층 구조: 들여쓰기 2칸으로 깊이 표현
- 디렉토리: `📁 디렉토리명/`
- 파일: `📄 파일명`
- 알파벳순 정렬

**특징:**
- 전체 문서 트리를 한 번에 조회 가능
- `maxDepth` 지정 시 지정된 깊이까지만 탐색
- 숨김 파일 및 제외 규칙 적용
- 출력 라인 수 제한 없음 (주의: 매우 큰 트리는 응답이 클 수 있음)

**성능 고려사항:**
- 대규모 문서 트리의 경우 응답 시간이 길 수 있음
- `maxDepth`를 적절히 설정하여 응답 크기 조절 권장
- 전체 트리가 필요하지 않은 경우 `list_documents` 사용 권장

---

### 도구 3: read_document

마크다운 파일의 원본 내용을 읽습니다.

**파라미터:**
| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| path | string | Yes | 읽을 파일 경로 (예: `/guide/intro.md`) |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "tools/call",
  "params": {
    "name": "read_document",
    "arguments": {
      "path": "/README.md"
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# /README.md\n\n# DocuLight\n\nA lightweight documentation server...\n"
      }
    ]
  }
}
```

**출력 형식:**
- 헤더: `# 파일경로`
- 본문: 파일의 원본 마크다운 내용

**제약사항:**
- 마크다운 파일(`.md`)만 지원
- 파일이 존재해야 함
- 디렉토리는 읽을 수 없음

**에러 케이스:**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 파일이 존재하지 않거나 디렉토리임
- `UNSUPPORTED_TYPE`: `.md` 파일이 아님

---

### 도구 4: create_document

마크다운 문서를 생성하거나 업데이트합니다.

**파라미터:**
| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| path | string | Yes | 생성/업데이트할 문서 경로 (예: `/guide/new-doc.md`) |
| content | string | Yes | 마크다운 내용 |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "tools/call",
  "params": {
    "name": "create_document",
    "arguments": {
      "path": "/guide/getting-started.md",
      "content": "# Getting Started\n\nWelcome to DocuLight!\n\n## Installation\n\n..."
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Successfully created/updated: /guide/getting-started.md"
      }
    ]
  }
}
```

**동작 방식:**
- 경로에서 디렉토리 부분과 파일명을 자동 분리
- 대상 디렉토리가 없으면 자동 생성
- 기존 파일이 있으면 덮어쓰기
- UTF-8 인코딩으로 저장
- 디렉토리 단위 잠금으로 동시 수정 방지

**경로 처리:**
- 입력: `/guide/chapter1/lesson1.md`
- 디렉토리: `/guide/chapter1`
- 파일명: `lesson1.md`

**특징:**
- 중첩 디렉토리 자동 생성
- 동시성 제어로 데이터 무결성 보장
- 파일 시스템 보안 검증 (path traversal 방지)

---

### 도구 5: delete_document

문서 또는 디렉토리를 삭제합니다.

**파라미터:**
| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| path | string | Yes | 삭제할 문서/디렉토리 경로 |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 40,
  "method": "tools/call",
  "params": {
    "name": "delete_document",
    "arguments": {
      "path": "/guide/old-doc.md"
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 40,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Successfully deleted: /guide/old-doc.md"
      }
    ]
  }
}
```

**동작 방식:**
- 파일과 디렉토리 모두 삭제 가능
- 디렉토리는 재귀적으로 삭제 (모든 하위 항목 포함)
- 파일이 사용 중일 경우 최대 2회 재시도 (1초 간격)
- 경로 잠금으로 동시 삭제 방지

**재시도 로직:**
- Windows에서 파일이 사용 중(`EBUSY`)일 경우 자동 재시도
- 재시도 간격: 1초
- 최대 재시도: 2회
- 모든 재시도 실패 시 `FILE_BUSY` 에러

**에러 케이스:**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 경로가 존재하지 않음
- `FILE_BUSY`: 파일이 사용 중이어서 삭제 불가

---

### 도구 6: DocuLight_get_config

현재 런타임 설정을 조회합니다. 민감한 정보(apiKey, passwords 등)는 자동으로 마스킹됩니다.

**파라미터:**
| 이름 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| section | string | No | `all` | 조회할 설정 섹션 (`ui`, `security`, `ssl`, `all`) |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 50,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_get_config",
    "arguments": {
      "section": "all"
    }
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 50,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Configuration (section: all)\n\n```json\n{\n  \"docsRoot\": \"/path/to/docs\",\n  \"apiKey\": \"***\",\n  \"port\": 3000,\n  \"ui\": {\n    \"title\": \"DocuLight\",\n    \"icon\": \"/images/icon.png\"\n  },\n  \"ssl\": {\n    \"enabled\": false,\n    \"key\": \"***\"\n  }\n}\n```"
      }
    ]
  }
}
```

**출력 형식:**
- 헤더: `# Configuration (section: {section})`
- 본문: JSON 형식의 설정 정보
- 민감값 마스킹: `apiKey`, `password`, `key`, `secret`, `token` 등이 `***`로 표시

**섹션 필터링:**
- `all`: 전체 설정 반환 (기본값)
- `ui`: UI 관련 설정만 반환
- `security`: 보안 관련 설정만 반환
- `ssl`: SSL 관련 설정만 반환

**보안 기능:**
- 민감한 필드 자동 감지 및 마스킹
- 로그에 민감값 노출 방지
- 재귀적으로 중첩된 객체도 마스킹

**특징:**
- 런타임 설정 조회 (재시작 없이 최신 상태)
- 안전한 설정 확인 및 디버깅
- AI 에이전트가 서버 설정 파악 가능

**에러 케이스:**
- `INVALID_SECTION`: 유효하지 않은 section 값

---

### 도구 7: DocuLight_search

문서 내용에서 키워드를 검색합니다. 실시간 파일 스캔 방식으로 작동합니다.

**파라미터:**
| 이름 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| query | string | Yes | - | 검색 쿼리 (최소 2글자) |
| limit | integer | No | `10` | 최대 결과 수 (1-100) |
| path | string | No | `/` | 검색 대상 디렉토리 |

**요청 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 60,
  "method": "tools/call",
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

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 60,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Search Results for \"installation\"\n\n**Statistics**: 3 matches in 8 files scanned (42ms)\n\n## 1. /guide/setup.md\n\n**Line 5**: ## Installation\n\n```\n# Getting Started\n\n## Installation\n\nTo install DocuLight, run:\n```\n\n## 2. /README.md\n\n**Line 12**: Installation is simple\n\n```\nDocuLight is a lightweight server.\n\nInstallation is simple:\n\nnpm install\n```\n\n## 3. /docs/advanced.md\n\n**Line 23**: Post-installation steps\n\n```\nConfiguration file setup.\n\nPost-installation steps:\n\n1. Copy config\n```\n"
      }
    ]
  }
}
```

**출력 형식:**
- 헤더: `# Search Results for "{query}"`
- 통계: 매치 수, 스캔한 파일 수, 실행 시간
- 결과: 각 매치별로 파일 경로, 라인 번호, 내용, 컨텍스트(±2줄)

**검색 특징:**
- **대소문자 무시**: `Installation`, `installation` 모두 매칭
- **컨텍스트 제공**: 매칭 라인의 전후 2줄 포함
- **성능 최적화**:
  - 1MB 이상 파일은 자동 스킵
  - 검색 시간 제한: 5초
  - 파일당 최대 50개 매치 제한

**제한사항:**
- 쿼리 최소 길이: 2글자
- 최대 결과 수: 100 (초과 시 자동 제한)
- 숨김 파일 및 exclude 패턴 적용

**성능 고려사항:**
- 실시간 스캔 방식으로 대규모 문서 집합에서는 느릴 수 있음
- `path` 파라미터로 검색 범위 제한 권장
- 향후 인덱싱 기반으로 업그레이드 예정

**에러 케이스:**
- `INVALID_QUERY`: query 파라미터 누락 또는 타입 오류
- `QUERY_TOO_SHORT`: 쿼리 길이 < 2글자
- `PATH_TRAVERSAL`: 잘못된 path 파라미터
- `PATH_NOT_FOUND`: 검색 경로가 존재하지 않음
- `SEARCH_TIMEOUT`: 검색 시간 초과 (5초)

---

## JSON-RPC 에러 코드

MCP 프로토콜에서 사용하는 표준 JSON-RPC 2.0 에러 코드:

| 코드 | 이름 | 설명 |
|------|------|------|
| -32600 | Invalid Request | JSON-RPC 버전이 "2.0"이 아니거나 필수 필드 누락 |
| -32601 | Method not found | 요청한 메서드가 존재하지 않음 |
| -32602 | Invalid params | 파라미터가 누락되었거나 형식이 잘못됨 |
| -32603 | Internal error | 서버 내부 오류 발생 |

### 에러 응답 예시

**잘못된 JSON-RPC 버전:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": "jsonrpc must be \"2.0\""
  }
}
```

**메서드 누락:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": "method is required"
  }
}
```

**존재하지 않는 메서드:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": "Method unknown_method not supported"
  }
}
```

**도구 이름 누락:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": "tool name is required"
  }
}
```

**내부 오류 (예: 파일 시스템 에러):**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": "ENOENT: no such file or directory"
  }
}
```

---

## 사용 예시

### Python 예시

```python
import requests
import json

MCP_URL = "http://localhost:3000/mcp"

def mcp_call(method, params=None):
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {}
    }
    response = requests.post(MCP_URL, json=payload)
    return response.json()

# 1. 초기화
init_result = mcp_call("initialize")
print(f"Server: {init_result['result']['serverInfo']['name']}")

# 2. 도구 목록 조회
tools_result = mcp_call("tools/list")
print(f"Available tools: {len(tools_result['result']['tools'])}")

# 3. 문서 목록 조회
list_result = mcp_call("tools/call", {
    "name": "list_documents",
    "arguments": {"path": "/"}
})
print(list_result['result']['content'][0]['text'])

# 4. 문서 읽기
read_result = mcp_call("tools/call", {
    "name": "read_document",
    "arguments": {"path": "/README.md"}
})
print(read_result['result']['content'][0]['text'])

# 5. 문서 생성
create_result = mcp_call("tools/call", {
    "name": "create_document",
    "arguments": {
        "path": "/test/hello.md",
        "content": "# Hello World\n\nThis is a test document."
    }
})
print(create_result['result']['content'][0]['text'])

# 6. 전체 트리 조회 (최대 깊이 2)
tree_result = mcp_call("tools/call", {
    "name": "list_full_tree",
    "arguments": {
        "path": "/",
        "maxDepth": 2
    }
})
print(tree_result['result']['content'][0]['text'])

# 7. 문서 삭제
delete_result = mcp_call("tools/call", {
    "name": "delete_document",
    "arguments": {"path": "/test/hello.md"}
})
print(delete_result['result']['content'][0]['text'])

# 8. 설정 조회
config_result = mcp_call("tools/call", {
    "name": "DocuLight_get_config",
    "arguments": {"section": "all"}
})
print(config_result['result']['content'][0]['text'])

# 9. 문서 검색
search_result = mcp_call("tools/call", {
    "name": "DocuLight_search",
    "arguments": {
        "query": "installation",
        "limit": 5
    }
})
print(search_result['result']['content'][0]['text'])
```

---

### JavaScript/Node.js 예시

```javascript
const axios = require('axios');

const MCP_URL = 'http://localhost:3000/mcp';

async function mcpCall(method, params = {}) {
  const response = await axios.post(MCP_URL, {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params
  });
  return response.data;
}

async function main() {
  // 1. 초기화
  const initResult = await mcpCall('initialize');
  console.log('Server:', initResult.result.serverInfo.name);

  // 2. 도구 목록
  const toolsResult = await mcpCall('tools/list');
  console.log('Tools:', toolsResult.result.tools.map(t => t.name));

  // 3. 문서 목록
  const listResult = await mcpCall('tools/call', {
    name: 'list_documents',
    arguments: { path: '/' }
  });
  console.log(listResult.result.content[0].text);

  // 4. 문서 읽기
  const readResult = await mcpCall('tools/call', {
    name: 'read_document',
    arguments: { path: '/README.md' }
  });
  console.log(readResult.result.content[0].text);

  // 5. 문서 생성
  const createResult = await mcpCall('tools/call', {
    name: 'create_document',
    arguments: {
      path: '/guide/new-guide.md',
      content: '# New Guide\n\nContent here...'
    }
  });
  console.log(createResult.result.content[0].text);

  // 6. 전체 트리
  const treeResult = await mcpCall('tools/call', {
    name: 'list_full_tree',
    arguments: { path: '/guide' }
  });
  console.log(treeResult.result.content[0].text);

  // 7. 삭제
  const deleteResult = await mcpCall('tools/call', {
    name: 'delete_document',
    arguments: { path: '/guide/new-guide.md' }
  });
  console.log(deleteResult.result.content[0].text);

  // 8. 설정 조회
  const configResult = await mcpCall('tools/call', {
    name: 'DocuLight_get_config',
    arguments: { section: 'ui' }
  });
  console.log(configResult.result.content[0].text);

  // 9. 검색
  const searchResult = await mcpCall('tools/call', {
    name: 'DocuLight_search',
    arguments: {
      query: 'configuration',
      limit: 10
    }
  });
  console.log(searchResult.result.content[0].text);
}

main().catch(console.error);
```

---

### cURL 예시

**초기화:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize"
  }'
```

**도구 목록:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

**문서 목록 조회:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_documents",
      "arguments": {
        "path": "/guide"
      }
    }
  }'
```

**전체 트리 조회:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "list_full_tree",
      "arguments": {
        "path": "/",
        "maxDepth": 3
      }
    }
  }'
```

**문서 읽기:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "read_document",
      "arguments": {
        "path": "/README.md"
      }
    }
  }'
```

**문서 생성:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "create_document",
      "arguments": {
        "path": "/test.md",
        "content": "# Test\n\nHello World"
      }
    }
  }'
```

**문서 삭제:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "delete_document",
      "arguments": {
        "path": "/test.md"
      }
    }
  }'
```

**설정 조회:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 8,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_get_config",
      "arguments": {
        "section": "all"
      }
    }
  }'
```

**문서 검색:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 9,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_search",
      "arguments": {
        "query": "api",
        "limit": 5,
        "path": "/"
      }
    }
  }'
```

---

## 보안 및 제약사항

### 보안 기능

1. **경로 검증**
   - 모든 경로는 `path-validator` 유틸리티로 검증
   - Path traversal 공격 방지 (`../` 차단)
   - 문서 루트 외부 접근 차단

2. **파일 타입 제한**
   - `read_document`: 마크다운 파일(`.md`)만 허용
   - 다른 파일 형식은 읽을 수 없음

3. **동시성 제어**
   - Lock Manager를 통한 디렉토리/파일 단위 잠금
   - 동시 수정/삭제 방지
   - 데이터 무결성 보장

4. **파일 필터링**
   - 숨김 파일 자동 제외 (`.`로 시작)
   - 사용자 정의 제외 패턴 지원 (`config.json5`의 `excludes`)

### 인증 (Authentication)

MCP 도구는 공개(읽기 전용)와 보호(쓰기) 작업으로 구분됩니다:

**공개 도구** (인증 불필요):
- `list_documents` - 디렉토리 내용 조회
- `list_full_tree` - 재귀적 트리 조회
- `read_document` - 문서 내용 읽기
- `DocuLight_search` - 문서 검색
- `DocuLight_get_config` - 설정 조회

**보호된 도구** (X-API-Key 헤더 필수):
- `create_document` - 문서 생성/수정
- `delete_document` - 문서/디렉토리 삭제

**인증 헤더:**
```
X-API-Key: your-api-key-here
```

**인증 포함 예시:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "create_document",
      "arguments": {
        "path": "new-doc.md",
        "content": "# New Document"
      }
    }
  }'
```

**에러 응답 (API 키 누락):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": "UNAUTHORIZED: X-API-Key header is required for this operation"
  }
}
```

### 제약사항

1. **마크다운 전용**
   - `read_document`는 `.md` 파일만 지원
   - 이미지, PDF 등 바이너리 파일 미지원

2. **응답 크기**
   - `list_full_tree`는 출력 라인 수 제한 없음
   - 매우 큰 트리는 응답이 클 수 있음
   - `maxDepth` 파라미터로 조절 권장

4. **동기 실행**
   - 각 도구 호출은 순차적으로 처리
   - 장시간 실행 작업은 다른 요청을 지연시킬 수 있음

---

## 워크플로우 예시

### 워크플로우 1: 문서 탐색 및 읽기

```
1. initialize → 서버 정보 확인
2. tools/list → 사용 가능한 도구 확인
3. list_documents (path: "/") → 루트 디렉토리 내용 확인
4. list_documents (path: "/guide") → 가이드 디렉토리 확인
5. read_document (path: "/guide/intro.md") → 문서 읽기
```

### 워크플로우 2: 문서 작성 및 구조 확인

```
1. list_full_tree (path: "/", maxDepth: 2) → 전체 구조 파악
2. create_document (path: "/guide/new-chapter.md", content: "...") → 새 문서 생성
3. list_documents (path: "/guide") → 생성 확인
4. read_document (path: "/guide/new-chapter.md") → 내용 확인
```

### 워크플로우 3: 문서 정리

```
1. list_full_tree (path: "/old-docs") → 삭제 대상 확인
2. delete_document (path: "/old-docs/obsolete.md") → 개별 파일 삭제
3. delete_document (path: "/old-docs") → 디렉토리 전체 삭제
4. list_documents (path: "/") → 삭제 확인
```

### 워크플로우 4: 문서 복사/이동 (간접)

MCP는 직접적인 복사/이동 기능이 없으므로 읽기+쓰기+삭제 조합:

```
1. read_document (path: "/source/doc.md") → 원본 읽기
2. create_document (path: "/target/doc.md", content: "...") → 대상에 쓰기
3. delete_document (path: "/source/doc.md") → 원본 삭제 (이동의 경우)
```
