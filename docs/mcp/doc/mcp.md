# DocuLight MCP API Documentation

## Overview

DocuLight supports Model Context Protocol (MCP) over HTTP, enabling AI agents to perform document management tasks. MCP is based on JSON-RPC 2.0 protocol and implemented natively without SDK dependencies.

### Basic Information

- **Protocol**: JSON-RPC 2.0
- **Endpoint**: `POST /mcp`
- **Content-Type**: `application/json`
- **MCP Version**: 2024-11-05
- **Authentication**: Not required (public endpoint)

---

## MCP Protocol Structure

### JSON-RPC 2.0 Request Format

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

### JSON-RPC 2.0 Response Format

**Success Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    // method-specific result
  }
}
```

**Error Response:**
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

## MCP Methods

### 1. initialize

Initialize MCP server and retrieve server information and capabilities.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize"
}
```

**Response:**
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

**Response Fields:**
- `protocolVersion`: MCP protocol version
- `capabilities`: Server supported features
  - `tools`: Tools feature support
- `serverInfo`: Server information
  - `name`: Server name
  - `version`: Server version

---

### 2. tools/list

Retrieve list of all available MCP tools.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

**Response:**
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
        "description": "Get DocuLight configuration (sensitive values masked)",
        "inputSchema": {
          "type": "object",
          "properties": {
            "section": {
              "type": "string",
              "description": "Config section to retrieve (all, ui, etc.)",
              "default": "all"
            }
          }
        }
      },
      {
        "name": "DocuLight_search",
        "description": "Search for documents by content or filename",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Search query"
            },
            "limit": {
              "type": "integer",
              "description": "Maximum results (default: 10)",
              "default": 10
            },
            "path": {
              "type": "string",
              "description": "Optional directory to search within"
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

Execute a specific MCP tool.

**Request:**
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

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Tool execution result"
      }
    ]
  }
}
```

---

## MCP Tools

### list_documents

List all documents in a directory.

**Arguments:**
- `path` (string, optional): Directory path (default: `/`)

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_documents",
    "arguments": {
      "path": "/guide"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Documents in /guide\n\n## Directories\n- chapter1\n- chapter2\n\n## Files\n- intro.md (1024 bytes)\n- setup.md (2048 bytes)\n\n**Total**: 2 directories, 2 files"
      }
    ]
  }
}
```

---

### list_full_tree

Recursively list all documents and directories.

**Arguments:**
- `path` (string, optional): Starting directory path (default: `/`)
- `maxDepth` (integer, optional): Maximum depth (0 = current directory only)

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_full_tree",
    "arguments": {
      "path": "/",
      "maxDepth": 2
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Full Document Tree\n\n/\n├── guide/\n│   ├── chapter1/\n│   │   └── lesson1.md (1536 bytes)\n│   ├── intro.md (1024 bytes)\n│   └── setup.md (2048 bytes)\n└── README.md (512 bytes)\n\n**Statistics**: 3 files, 2 directories"
      }
    ]
  }
}
```

---

### read_document

Read a markdown document.

**Arguments:**
- `path` (string, required): Document path (e.g., `guide/getting-started.md`)

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "read_document",
    "arguments": {
      "path": "/README.md"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Getting Started\n\nWelcome to DocuLight...\n\n## Installation\n\n..."
      }
    ]
  }
}
```

---

### create_document

Create or update a markdown document.

**Arguments:**
- `path` (string, required): Document path (e.g., `guide/new-doc.md`)
- `content` (string, required): Markdown content

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "create_document",
    "arguments": {
      "path": "/guide/new-doc.md",
      "content": "# New Document\n\nThis is a new document."
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "✅ Document created successfully\n\n**Path**: /guide/new-doc.md\n**Size**: 42 bytes\n**Status**: Created"
      }
    ]
  }
}
```

---

### delete_document

Delete a document or directory.

**Arguments:**
- `path` (string, required): Document or directory path to delete

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "delete_document",
    "arguments": {
      "path": "/guide/old-doc.md"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "✅ Successfully deleted: /guide/old-doc.md"
      }
    ]
  }
}
```

---

### DocuLight_get_config

Get DocuLight configuration (sensitive values masked).

**Arguments:**
- `section` (string, optional): Config section to retrieve (`all`, `ui`, etc.) (default: `all`)

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_get_config",
    "arguments": {
      "section": "ui"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# DocuLight Configuration (Section: ui)\n\n```json\n{\n  \"title\": \"DocuLight\",\n  \"icon\": \"/images/icon.png\",\n  \"maxWidth\": \"1024px\"\n}\n```\n\n**Note**: Sensitive values (apiKey, SSL certificates) are masked for security."
      }
    ]
  }
}
```

---

### DocuLight_search

Search for documents by content or filename.

**Arguments:**
- `query` (string, required): Search query
- `limit` (integer, optional): Maximum results (default: 10)
- `path` (string, optional): Optional directory to search within

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_search",
    "arguments": {
      "query": "installation",
      "limit": 5,
      "path": "/guide"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Search Results for \"installation\"\n\n**Statistics**: 3 matches in 8 files scanned (42ms)\n\n## 1. /guide/setup.md\n\n**Line 15**: Installation instructions\n\n```markdown\n## Installation\n\nFollow these steps for installation...\n```\n\n## 2. /guide/intro.md\n\n**Line 8**: Quick installation\n\n```markdown\nQuick installation guide...\n```"
      }
    ]
  }
}
```

---

## Error Codes

JSON-RPC 2.0 standard error codes:

| Code | Message | Description |
|------|---------|-------------|
| -32700 | Parse error | Invalid JSON |
| -32600 | Invalid Request | Missing required fields |
| -32601 | Method not found | Unknown method |
| -32602 | Invalid params | Invalid parameters |
| -32603 | Internal error | Server internal error |
| -32000 | Server error | DocuLight-specific errors |

**DocuLight-specific Error Codes (-32000):**
- `PATH_TRAVERSAL`: Invalid path or security violation
- `NOT_FOUND`: File or directory not found
- `UNSUPPORTED_TYPE`: Invalid file type
- `FILE_BUSY`: File is busy

**Example Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "NOT_FOUND",
    "data": "File does not exist: /nonexistent.md"
  }
}
```

---

## Usage Examples

### Complete Workflow Example

Search → Read → Modify → Save:

```bash
#!/bin/bash

# 1. Search for "configuration"
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_search",
      "arguments": {"query": "configuration", "limit": 3}
    }
  }'

# 2. Read first result file
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "read_document",
      "arguments": {"path": "/guide/setup.md"}
    }
  }'

# 3. Create updated document
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "create_document",
      "arguments": {
        "path": "/guide/setup-updated.md",
        "content": "# Updated Setup\n\nNew content..."
      }
    }
  }'
```

---

## Integration with AI Agents

### Claude Code Integration

Add to Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "docuLight": {
      "command": "curl",
      "args": [
        "-X", "POST",
        "http://localhost:3000/mcp",
        "-H", "Content-Type: application/json",
        "-d", "@-"
      ]
    }
  }
}
```

### Direct HTTP Requests

All AI agents can use DocuLight MCP through standard HTTP requests:

```python
import requests

def call_mcp_tool(tool_name, arguments):
    response = requests.post(
        "http://localhost:3000/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
    )
    return response.json()

# Example: List documents
result = call_mcp_tool("list_documents", {"path": "/guide"})
print(result["result"]["content"][0]["text"])
```

---

## Security Considerations

### Authentication

MCP tools are divided into public (read-only) and protected (write) operations:

**Public Tools** (No authentication required):
- `list_documents` - List directory contents
- `list_full_tree` - Recursive tree listing
- `read_document` - Read document content
- `DocuLight_search` - Search documents
- `DocuLight_get_config` - Get configuration

**Protected Tools** (X-API-Key header required):
- `create_document` - Create or update documents
- `delete_document` - Delete documents or directories

**Authentication Header:**
```
X-API-Key: your-api-key-here
```

**Example with Authentication:**
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

**Error Response (Missing API Key):**
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

### Path Validation
- All paths validated against document root
- Path traversal attacks blocked (`../` rejected)
- Only markdown files (`.md`) supported for read/write

### Sensitive Data Masking
- `DocuLight_get_config` masks sensitive values
- API keys, SSL certificates automatically redacted
- Safe for AI agent access

---

## Additional Resources

- [MCP Protocol Specification](https://spec.modelcontextprotocol.io/)
- [DocuLight REST API Documentation](../api/doc/api.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
