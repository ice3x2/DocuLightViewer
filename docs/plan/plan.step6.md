# Step 6: API & MCP Documentation Portal

## Overview

**Objective**: Create comprehensive API and MCP documentation with hidden documentation viewer endpoints

**Core Requirements**:
1. Create API documentation (api-doc.md) in English
2. Create MCP documentation (mcp-doc.md) with Copilot/Claude integration guides
3. Implement `/api/doc` and `/mcp/doc` routes for clean documentation viewing
4. Create documentation-only view template (no header/sidebar)

**Key Features**:
- Standalone documentation accessible via clean URLs
- Rendered dynamically with Markdown support
- Hidden from main file tree (not discoverable through sidebar)
- Professional technical writing in English

---

## 1. API Documentation

### 1.1 Document Structure

**File**: `public/api-doc.md`

**Content Overview**:
- Complete API reference for all endpoints
- Authentication mechanisms
- Request/response examples
- Error codes and handling
- Rate limiting and best practices

### 1.2 API Documentation Template

```markdown
# DocuLight API Documentation

Version: 1.0.0 | Last Updated: 2025-01-XX

## Table of Contents

1. [Introduction](#introduction)
2. [Authentication](#authentication)
3. [Endpoints](#endpoints)
4. [Error Handling](#error-handling)
5. [Rate Limiting](#rate-limiting)
6. [Examples](#examples)

---

## Introduction

DocuLight provides a RESTful API for managing Markdown documents. This API enables programmatic access to document operations including reading, uploading, deleting, and downloading files.

**Base URL**: `http://localhost:3000/api` (or your configured domain)

**Content Type**: `application/json` (except file uploads)

---

## Authentication

### API Key Authentication

Protected endpoints require authentication via the `X-API-Key` header.

```http
X-API-Key: your-api-key-here
```

**Configuration**: Set your API key in `config.json5`:
```json5
{
  apiKey: "your-secure-random-string"
}
```

**Security Best Practices**:
- Use a cryptographically secure random string (≥32 characters)
- Store API keys securely (environment variables recommended)
- Rotate keys periodically
- Never commit keys to version control

### Public vs Protected Endpoints

| Endpoint Type | Authentication Required | Examples |
|--------------|------------------------|----------|
| **Public** | ❌ No | GET /tree, GET /raw |
| **Protected** | ✅ Yes | POST /upload, DELETE /entry, GET /download/* |

---

## Endpoints

### 1. Get Directory Tree

**Endpoint**: `GET /api/tree`

**Authentication**: Public (No authentication required)

**Description**: Retrieve the directory structure of documents.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | No | `/` | Directory path to explore |

**Request Example**:
```bash
curl "http://localhost:3000/api/tree?path=/docs/guide"
```

**Response Example**:
```json
{
  "name": "guide",
  "type": "directory",
  "path": "/docs/guide",
  "children": [
    {
      "name": "getting-started.md",
      "type": "file",
      "path": "/docs/guide/getting-started.md"
    },
    {
      "name": "api",
      "type": "directory",
      "path": "/docs/guide/api",
      "children": [...]
    }
  ]
}
```

**Error Responses**:
- `400 Bad Request`: Invalid path parameter
- `403 Forbidden`: Path outside docsRoot
- `404 Not Found`: Directory not found

---

### 2. Get File Content

**Endpoint**: `GET /api/raw`

**Authentication**: Public (No authentication required)

**Description**: Retrieve the raw Markdown content of a file.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | File path to read |

**Request Example**:
```bash
curl "http://localhost:3000/api/raw?path=/README.md"
```

**Response Example**:
```json
{
  "content": "# Welcome to DocuLight\n\nThis is a Markdown viewer...",
  "path": "/README.md",
  "size": 1024,
  "modified": "2025-01-20T10:30:00.000Z"
}
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid path
- `403 Forbidden`: Path outside docsRoot
- `404 Not Found`: File not found
- `415 Unsupported Media Type`: Non-Markdown file

---

### 3. Upload File

**Endpoint**: `POST /api/upload`

**Authentication**: Protected (X-API-Key required)

**Description**: Upload a new file or overwrite an existing file.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Directory path where file will be saved |

**Request Headers**:
```http
Content-Type: multipart/form-data
X-API-Key: your-api-key-here
```

**Request Body**:
- Form field name: `file`
- File type: Any (Markdown recommended)
- Max size: Configurable via `maxUploadMB` (default: 10MB)

**Request Example**:
```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  -F "file=@document.md" \
  "http://localhost:3000/api/upload?path=/docs"
```

**Response Example**:
```json
{
  "success": true,
  "message": "File uploaded successfully",
  "path": "/docs/document.md",
  "size": 2048
}
```

**Error Responses**:
- `400 Bad Request`: Missing file or invalid path
- `401 Unauthorized`: Missing or invalid API key
- `403 Forbidden`: Path outside docsRoot
- `413 Payload Too Large`: File exceeds size limit

---

### 4. Delete Entry

**Endpoint**: `DELETE /api/entry`

**Authentication**: Protected (X-API-Key required)

**Description**: Delete a file or directory (recursive).

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Path to delete |

**Request Example**:
```bash
curl -X DELETE \
  -H "X-API-Key: your-api-key" \
  "http://localhost:3000/api/entry?path=/docs/old-file.md"
```

**Response Example**:
```json
{
  "success": true,
  "message": "Entry deleted successfully",
  "path": "/docs/old-file.md"
}
```

**Warning**: Deleting a directory removes all contents recursively.

**Error Responses**:
- `400 Bad Request`: Missing or invalid path
- `401 Unauthorized`: Missing or invalid API key
- `403 Forbidden`: Path outside docsRoot
- `404 Not Found`: Entry not found

---

### 5. Download File

**Endpoint**: `GET /api/download/file`

**Authentication**: Protected (X-API-Key required)

**Description**: Download a single file.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | File path to download |

**Request Example**:
```bash
curl -H "X-API-Key: your-api-key" \
  "http://localhost:3000/api/download/file?path=/README.md" \
  --output README.md
```

**Response**: File stream with appropriate headers

**Response Headers**:
```http
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="README.md"
Content-Length: 1024
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid path
- `401 Unauthorized`: Missing or invalid API key
- `403 Forbidden`: Path outside docsRoot
- `404 Not Found`: File not found

---

### 6. Download Directory

**Endpoint**: `GET /api/download/dir`

**Authentication**: Protected (X-API-Key required)

**Description**: Download a directory as a ZIP archive.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Directory path to download |

**Request Example**:
```bash
curl -H "X-API-Key: your-api-key" \
  "http://localhost:3000/api/download/dir?path=/docs" \
  --output docs.zip
```

**Response**: ZIP file stream

**Response Headers**:
```http
Content-Type: application/zip
Content-Disposition: attachment; filename="docs.zip"
```

**Error Responses**:
- `400 Bad Request`: Missing or invalid path
- `401 Unauthorized`: Missing or invalid API key
- `403 Forbidden`: Path outside docsRoot
- `404 Not Found`: Directory not found

---

### 7. Health Check

**Endpoint**: `GET /healthz`

**Authentication**: Public (No authentication required)

**Description**: Check server health and uptime.

**Request Example**:
```bash
curl "http://localhost:3000/healthz"
```

**Response Example**:
```json
{
  "status": "OK",
  "timestamp": "2025-01-20T10:30:00.000Z",
  "uptime": 3600.5
}
```

---

## Error Handling

### Standard Error Response Format

All errors follow a consistent JSON structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

### HTTP Status Codes

| Status Code | Meaning | Common Causes |
|------------|---------|---------------|
| `200 OK` | Success | Request processed successfully |
| `400 Bad Request` | Invalid request | Missing parameters, invalid format |
| `401 Unauthorized` | Authentication failed | Missing or invalid API key |
| `403 Forbidden` | Access denied | Path traversal attempt, IP blocked |
| `404 Not Found` | Resource not found | File/directory doesn't exist |
| `413 Payload Too Large` | File too large | Exceeds maxUploadMB limit |
| `415 Unsupported Media Type` | Invalid file type | Non-Markdown file requested |
| `500 Internal Server Error` | Server error | Unexpected server failure |

### Common Error Codes

| Error Code | Description | Solution |
|-----------|-------------|----------|
| `INVALID_PATH` | Path validation failed | Check path format and security |
| `FILE_NOT_FOUND` | File doesn't exist | Verify file path |
| `DIR_NOT_FOUND` | Directory doesn't exist | Verify directory path |
| `PATH_TRAVERSAL` | Security violation | Path must be within docsRoot |
| `AUTH_REQUIRED` | Missing authentication | Provide X-API-Key header |
| `INVALID_API_KEY` | Wrong API key | Check config.json5 apiKey |
| `FILE_TOO_LARGE` | Exceeds size limit | Reduce file size or adjust maxUploadMB |
| `IP_BLOCKED` | IP not whitelisted | Add IP to security.allows in config |

---

## Rate Limiting

Currently, DocuLight does not implement rate limiting. Consider implementing:

- Request throttling per IP address
- API key-based quotas
- Concurrent connection limits

**Recommended Configuration** (future enhancement):
```json5
{
  rateLimit: {
    windowMs: 60000,      // 1 minute
    maxRequests: 100,     // 100 requests per minute
    skipSuccessfulRequests: false
  }
}
```

---

## Examples

### Complete Workflow Example

**1. List documents**:
```bash
curl "http://localhost:3000/api/tree?path=/"
```

**2. Read a document**:
```bash
curl "http://localhost:3000/api/raw?path=/guide/api.md"
```

**3. Upload a new document**:
```bash
curl -X POST \
  -H "X-API-Key: my-secure-key" \
  -F "file=@new-doc.md" \
  "http://localhost:3000/api/upload?path=/guide"
```

**4. Download a document**:
```bash
curl -H "X-API-Key: my-secure-key" \
  "http://localhost:3000/api/download/file?path=/guide/new-doc.md" \
  --output new-doc.md
```

**5. Delete a document**:
```bash
curl -X DELETE \
  -H "X-API-Key: my-secure-key" \
  "http://localhost:3000/api/entry?path=/guide/new-doc.md"
```

### JavaScript/Node.js Example

```javascript
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = 'http://localhost:3000/api';
const API_KEY = 'your-api-key';

// Get tree
async function getTree(path = '/') {
  const response = await axios.get(`${BASE_URL}/tree`, {
    params: { path }
  });
  return response.data;
}

// Read file
async function readFile(path) {
  const response = await axios.get(`${BASE_URL}/raw`, {
    params: { path }
  });
  return response.data.content;
}

// Upload file
async function uploadFile(localPath, remotePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));

  const response = await axios.post(`${BASE_URL}/upload`, form, {
    params: { path: remotePath },
    headers: {
      ...form.getHeaders(),
      'X-API-Key': API_KEY
    }
  });
  return response.data;
}

// Delete file
async function deleteFile(path) {
  const response = await axios.delete(`${BASE_URL}/entry`, {
    params: { path },
    headers: { 'X-API-Key': API_KEY }
  });
  return response.data;
}

// Usage
(async () => {
  const tree = await getTree('/');
  console.log('Documents:', tree);

  const content = await readFile('/README.md');
  console.log('Content:', content);

  await uploadFile('./local.md', '/docs');
  console.log('Uploaded successfully');
})();
```

### Python Example

```python
import requests

BASE_URL = 'http://localhost:3000/api'
API_KEY = 'your-api-key'

# Get tree
def get_tree(path='/'):
    response = requests.get(f'{BASE_URL}/tree', params={'path': path})
    return response.json()

# Read file
def read_file(path):
    response = requests.get(f'{BASE_URL}/raw', params={'path': path})
    return response.json()['content']

# Upload file
def upload_file(local_path, remote_path):
    with open(local_path, 'rb') as f:
        files = {'file': f}
        headers = {'X-API-Key': API_KEY}
        response = requests.post(
            f'{BASE_URL}/upload',
            params={'path': remote_path},
            files=files,
            headers=headers
        )
    return response.json()

# Delete file
def delete_file(path):
    headers = {'X-API-Key': API_KEY}
    response = requests.delete(
        f'{BASE_URL}/entry',
        params={'path': path},
        headers=headers
    )
    return response.json()

# Usage
tree = get_tree('/')
print('Documents:', tree)

content = read_file('/README.md')
print('Content:', content)

upload_file('./local.md', '/docs')
print('Uploaded successfully')
```

---

## Security Considerations

### Path Traversal Prevention

All file paths are validated to prevent directory traversal attacks:

```javascript
// Blocked attempts
/api/raw?path=../../etc/passwd
/api/raw?path=/etc/passwd
/api/raw?path=/../sensitive.md
```

DocuLight validates that all paths resolve within the configured `docsRoot` directory.

### IP Whitelisting

Restrict access by IP address (optional):

```json5
{
  security: {
    allows: [
      "127.0.0.1",        // localhost
      "192.168.1.0/24",   // local network
      "10.0.1.*"          // wildcard pattern
    ]
  }
}
```

Blocked IPs receive `403 Forbidden` responses.

### SSL/TLS Configuration

Enable HTTPS for production deployments:

```json5
{
  ssl: {
    enabled: true,
    cert: "/path/to/cert.pem",
    key: "/path/to/key.pem",
    ca: "/path/to/ca.pem"  // optional
  }
}
```

---

## Best Practices

### API Key Management
- Generate keys using: `openssl rand -hex 32`
- Store in environment variables, not in code
- Use different keys for different environments
- Rotate keys regularly

### File Uploads
- Validate file extensions before upload
- Scan uploads for malware in production
- Set appropriate maxUploadMB limits
- Consider file type restrictions

### Error Handling
- Never expose internal paths in errors
- Log all authentication failures
- Implement proper error monitoring
- Provide helpful error messages to clients

### Performance
- Use streaming for large file downloads
- Implement caching for frequently accessed files
- Consider CDN for static documentation
- Monitor API response times

---

## Support & Resources

- **GitHub**: [DocuLight Repository](https://github.com/your-org/DocuLight)
- **MCP Integration**: See [MCP Documentation](/mcp/doc)
- **Configuration Guide**: See README.md
- **Issue Tracker**: GitHub Issues

---

**API Version**: 1.0.0
**Last Updated**: 2025-01-XX
**License**: MIT
```

---

## 2. MCP Documentation

### 2.1 Document Structure

**File**: `public/mcp-doc.md`

**Content Overview**:
- MCP (Model Context Protocol) introduction
- DocuLight MCP Server setup
- Integration guides for Claude Desktop, VS Code Copilot, and other MCP clients
- Tool descriptions and usage examples
- Troubleshooting guide

### 2.2 MCP Documentation Template

```markdown
# DocuLight MCP Server Documentation

Version: 1.0.0 | Last Updated: 2025-01-XX

## Table of Contents

1. [Introduction](#introduction)
2. [What is MCP?](#what-is-mcp)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Integration Guides](#integration-guides)
6. [Available Tools](#available-tools)
7. [Usage Examples](#usage-examples)
8. [Troubleshooting](#troubleshooting)

---

## Introduction

The DocuLight MCP Server enables AI assistants (like Claude, GitHub Copilot, and others) to interact with your DocuLight documentation system through the Model Context Protocol (MCP).

**Key Benefits**:
- AI assistants can read, create, update, and delete documents
- Natural language document management
- Seamless integration with existing tools
- No UI required for document operations

**Architecture**:
```
┌─────────────┐     MCP Protocol     ┌──────────────────┐
│  Claude /   │ ←──────────────────→ │ DocuLight MCP     │
│  Copilot    │   (stdio/JSON-RPC)   │ Server           │
└─────────────┘                       └────────┬─────────┘
                                              │
                                     HTTP API │
                                              │
                                       ┌──────▼──────┐
                                       │  DocuLight   │
                                       │  Server     │
                                       └─────────────┘
```

---

## What is MCP?

### Model Context Protocol Overview

MCP (Model Context Protocol) is an open protocol developed by Anthropic that enables AI assistants to securely interact with external systems and data sources.

**Key Concepts**:

| Concept | Description |
|---------|-------------|
| **Server** | Provides tools and resources to AI assistants |
| **Client** | AI assistant or application that uses MCP servers |
| **Tools** | Functions that servers expose to clients |
| **Transport** | Communication mechanism (stdio, HTTP, WebSocket) |

**How MCP Works**:
1. MCP server connects to AI client via transport layer
2. Client discovers available tools via `tools/list` request
3. Client invokes tools via `tools/call` request
4. Server executes operations and returns results
5. Client presents results to user

**MCP vs Traditional APIs**:

| Aspect | Traditional API | MCP |
|--------|----------------|-----|
| Discovery | Manual documentation | Automatic via protocol |
| Integration | Custom code required | Native AI integration |
| Authentication | Various methods | Transport-specific |
| Error Handling | HTTP status codes | Structured JSON responses |

---

## Installation

### Prerequisites

- Node.js ≥ 18.0.0
- DocuLight server running
- API key configured in DocuLight

### Installation Steps

**1. Install DocuLight MCP Server**:

```bash
cd DocuLight-mcp-server
npm install
```

**2. Configure Environment Variables**:

```bash
cp .env.example .env
```

Edit `.env`:
```bash
DocuLight_URL=http://localhost:3000
DocuLight_API_KEY=your-api-key-here
```

**3. Test Installation**:

```bash
npm start
```

You should see:
```
DocuLight MCP server running on stdio
```

---

## Configuration

### Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DocuLight_URL` | ✅ Yes | DocuLight server URL | `http://localhost:3000` |
| `DocuLight_API_KEY` | ✅ Yes | API key from config.json5 | `abc123...` |

### Configuration File

Alternatively, create `.env` from template:

```bash
# DocuLight Server Configuration
DocuLight_URL=http://localhost:3000
DocuLight_API_KEY=your-api-key-here

# Optional: Logging level
LOG_LEVEL=info
```

---

## Integration Guides

### 1. Claude Desktop Integration

Claude Desktop supports MCP servers natively.

**Configuration File Location**:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

**Configuration**:

```json
{
  "mcpServers": {
    "DocuLight": {
      "command": "node",
      "args": ["/absolute/path/to/DocuLight-mcp-server/src/index.js"],
      "env": {
        "DocuLight_URL": "http://localhost:3000",
        "DocuLight_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Important Notes**:
- Use **absolute paths** for the `args` field
- Replace `/absolute/path/to/` with your actual path
- On Windows, use double backslashes: `C:\\Users\\...\\index.js`

**Restart Claude Desktop** after configuration.

**Verification**:

Ask Claude:
```
"Can you list the documents in DocuLight?"
```

Claude should use the `DocuLight_list` tool and show your documents.

---

### 2. VS Code with GitHub Copilot

GitHub Copilot is adding MCP support. Configuration will be similar to Claude Desktop.

**Experimental Configuration** (subject to change):

**File**: `.vscode/settings.json`

```json
{
  "copilot.mcp.servers": {
    "DocuLight": {
      "command": "node",
      "args": ["/absolute/path/to/DocuLight-mcp-server/src/index.js"],
      "env": {
        "DocuLight_URL": "http://localhost:3000",
        "DocuLight_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Status**:
- GitHub Copilot MCP support is experimental (as of 2025-01)
- Check [GitHub Copilot documentation](https://docs.github.com/copilot) for updates
- Alternative: Use [Continue.dev extension](https://continue.dev) with MCP support

---

### 3. Continue.dev Extension

Continue.dev is an open-source VS Code extension with MCP support.

**Installation**:
1. Install Continue extension from VS Code marketplace
2. Open Continue settings (Command Palette → "Continue: Open Config")

**Configuration**:

**File**: `~/.continue/config.json`

```json
{
  "models": [...],
  "mcpServers": {
    "DocuLight": {
      "command": "node",
      "args": ["/absolute/path/to/DocuLight-mcp-server/src/index.js"],
      "env": {
        "DocuLight_URL": "http://localhost:3000",
        "DocuLight_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Usage**:
- Open Continue sidebar in VS Code
- Ask: "List documents in DocuLight"
- Continue will automatically use MCP tools

---

### 4. Custom MCP Client Integration

Build your own MCP client using the official SDK.

**Example using @modelcontextprotocol/sdk**:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Create transport
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/DocuLight-mcp-server/src/index.js'],
  env: {
    DocuLight_URL: 'http://localhost:3000',
    DocuLight_API_KEY: 'your-api-key'
  }
});

// Create client
const client = new Client({
  name: 'my-mcp-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

// Connect
await client.connect(transport);

// List tools
const tools = await client.listTools();
console.log('Available tools:', tools);

// Call tool
const result = await client.callTool({
  name: 'DocuLight_list',
  arguments: { path: '/' }
});
console.log('Documents:', result);

// Disconnect
await client.close();
```

---

## Available Tools

### 1. DocuLight_list

**Description**: List all documents in a directory

**Input Schema**:
```json
{
  "path": {
    "type": "string",
    "description": "Directory path (default: root)",
    "default": "/"
  }
}
```

**Output**: Formatted tree structure of documents

**Example**:
```
📁 docs
  📄 README.md
  📁 guide
    📄 getting-started.md
    📄 api-reference.md
```

---

### 2. DocuLight_read

**Description**: Read the content of a document

**Input Schema**:
```json
{
  "path": {
    "type": "string",
    "description": "Document path (e.g., guide/getting-started.md)",
    "required": true
  }
}
```

**Output**: Markdown content of the document

**Example Output**:
```markdown
# Getting Started

This guide will help you...
```

---

### 3. DocuLight_create

**Description**: Create a new document

**Input Schema**:
```json
{
  "path": {
    "type": "string",
    "description": "Document path (e.g., guide/new-doc.md)",
    "required": true
  },
  "content": {
    "type": "string",
    "description": "Markdown content",
    "required": true
  }
}
```

**Output**: Success confirmation with file path

**Example**:
```
Successfully created/updated: guide/new-doc.md
```

---

### 4. DocuLight_update

**Description**: Update an existing document (same as create - overwrites)

**Input Schema**: Same as `DocuLight_create`

**Behavior**:
- If file exists → overwrites content
- If file doesn't exist → creates new file

---

### 5. DocuLight_delete

**Description**: Delete a document

**Input Schema**:
```json
{
  "path": {
    "type": "string",
    "description": "Document path to delete",
    "required": true
  }
}
```

**Output**: Success confirmation

**Example**:
```
Successfully deleted: guide/old-doc.md
```

**Warning**: This operation is irreversible!

---

## Usage Examples

### Example 1: Listing Documents

**User**: "Show me all documents in the guide folder"

**Claude**: [Internally uses `DocuLight_list` tool]

```json
{
  "name": "DocuLight_list",
  "arguments": {
    "path": "/guide"
  }
}
```

**Response**:
```
📁 guide
  📄 getting-started.md
  📄 configuration.md
  📄 api-reference.md
  📁 advanced
    📄 performance.md
    📄 security.md
```

---

### Example 2: Reading a Document

**User**: "Read the getting-started.md file in the guide folder"

**Claude**: [Uses `DocuLight_read` tool]

```json
{
  "name": "DocuLight_read",
  "arguments": {
    "path": "/guide/getting-started.md"
  }
}
```

**Response**:
```markdown
# Getting Started with DocuLight

DocuLight is a lightweight Markdown viewer...

## Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Configure `config.json5`
...
```

---

### Example 3: Creating a New Document

**User**: "Create a new troubleshooting guide at guide/troubleshooting.md with common issues and solutions"

**Claude**: [Generates content and uses `DocuLight_create` tool]

```json
{
  "name": "DocuLight_create",
  "arguments": {
    "path": "/guide/troubleshooting.md",
    "content": "# Troubleshooting Guide\n\n## Common Issues\n\n### Server Won't Start\n\n**Symptom**: Error when running `npm start`\n\n**Solution**:\n1. Check Node.js version (≥18 required)\n2. Verify config.json5 exists\n3. Check port availability\n\n### API Key Invalid\n\n**Symptom**: 401 Unauthorized responses\n\n**Solution**:\n1. Verify X-API-Key header\n2. Check config.json5 apiKey matches\n3. Ensure no whitespace in key\n..."
  }
}
```

**Response**:
```
Successfully created: guide/troubleshooting.md

I've created a comprehensive troubleshooting guide with common issues and solutions...
```

---

### Example 4: Updating a Document

**User**: "Update the API reference to add the new download endpoint"

**Claude**: [Reads existing file, generates updated content, uses `DocuLight_update` tool]

```json
{
  "name": "DocuLight_update",
  "arguments": {
    "path": "/guide/api-reference.md",
    "content": "[Updated content with new download endpoint section]"
  }
}
```

---

### Example 5: Deleting a Document

**User**: "Delete the old migration guide, it's no longer needed"

**Claude**: [Uses `DocuLight_delete` tool]

```json
{
  "name": "DocuLight_delete",
  "arguments": {
    "path": "/guide/migration-v1.md"
  }
}
```

**Response**:
```
Successfully deleted: guide/migration-v1.md
```

---

## Troubleshooting

### MCP Server Not Connecting

**Symptom**: Claude/Copilot doesn't show DocuLight tools

**Solutions**:
1. **Check absolute paths**:
   ```bash
   # Get absolute path
   pwd
   # Use in config: /full/path/to/DocuLight-mcp-server/src/index.js
   ```

2. **Verify environment variables**:
   ```bash
   # Test manually
   DocuLight_URL=http://localhost:3000 \
   DocuLight_API_KEY=your-key \
   node src/index.js
   ```

3. **Check DocuLight server is running**:
   ```bash
   curl http://localhost:3000/healthz
   ```

4. **Restart AI client** after config changes

5. **Check client logs**:
   - **Claude Desktop**: Menu → View → Toggle Developer Tools
   - Look for MCP server startup messages

---

### Authentication Failures

**Symptom**: "API error: 401 - Unauthorized"

**Solutions**:
1. **Verify API key matches config.json5**:
   ```bash
   # DocuLight config
   cat config.json5 | grep apiKey

   # MCP .env
   cat .env | grep DocuLight_API_KEY
   ```

2. **Check for whitespace**:
   ```bash
   # Trim whitespace
   DocuLight_API_KEY=$(echo "your-key" | tr -d '[:space:]')
   ```

3. **Regenerate API key**:
   ```bash
   openssl rand -hex 32
   # Update both config.json5 and .env
   ```

---

### Path Not Found Errors

**Symptom**: "Failed to read document: File not found"

**Solutions**:
1. **Check path format**:
   - ✅ Correct: `/guide/api.md`
   - ❌ Wrong: `guide/api.md` (missing leading slash)
   - ❌ Wrong: `/guide/api` (missing extension)

2. **List directory first**:
   ```
   User: "List files in /guide"
   Claude: [Uses DocuLight_list to verify path]
   ```

3. **Check docsRoot configuration**:
   ```bash
   # Verify file exists on server
   ls -la /path/to/docsRoot/guide/api.md
   ```

---

### Connection Timeout

**Symptom**: MCP requests time out or hang

**Solutions**:
1. **Check network connectivity**:
   ```bash
   curl -v http://localhost:3000/api/tree
   ```

2. **Verify firewall rules** if DocuLight is remote

3. **Check DocuLight_URL format**:
   - ✅ Correct: `http://localhost:3000`
   - ❌ Wrong: `http://localhost:3000/` (trailing slash)
   - ❌ Wrong: `localhost:3000` (missing protocol)

4. **Increase timeout** (if modifying client):
   ```javascript
   // In client.js
   timeout: 30000  // 30 seconds
   ```

---

### Large File Uploads Fail

**Symptom**: "Upload failed: Payload Too Large"

**Solutions**:
1. **Check maxUploadMB in config.json5**:
   ```json5
   {
     maxUploadMB: 10  // Increase if needed
   }
   ```

2. **Restart DocuLight server** after config change

3. **Split large documents** into smaller files

---

### Tool Execution Errors

**Symptom**: "Error: Failed to execute tool"

**Solutions**:
1. **Check MCP server logs**:
   ```bash
   # Run with debug logging
   LOG_LEVEL=debug npm start
   ```

2. **Verify required arguments**:
   - `DocuLight_read`: requires `path`
   - `DocuLight_create`: requires `path` and `content`

3. **Test with curl** first:
   ```bash
   curl -H "X-API-Key: key" \
     "http://localhost:3000/api/raw?path=/test.md"
   ```

---

## Advanced Topics

### Custom Transport Layer

Use HTTP transport instead of stdio:

```javascript
// Future enhancement - HTTP transport
const transport = new HttpTransport({
  url: 'http://localhost:3001/mcp',
  headers: {
    'Authorization': 'Bearer token'
  }
});
```

### Multiple DocuLight Instances

Connect to multiple DocuLight servers:

```json
{
  "mcpServers": {
    "DocuLight-prod": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "DocuLight_URL": "https://docs.company.com",
        "DocuLight_API_KEY": "prod-key"
      }
    },
    "DocuLight-dev": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "DocuLight_URL": "http://localhost:3000",
        "DocuLight_API_KEY": "dev-key"
      }
    }
  }
}
```

### Security Best Practices

1. **API Key Security**:
   - Never commit API keys to version control
   - Use environment variables or secret managers
   - Rotate keys regularly

2. **Network Security**:
   - Use HTTPS for production DocuLight servers
   - Implement IP whitelisting
   - Consider VPN for remote access

3. **Access Control**:
   - Use separate API keys per environment
   - Limit MCP server permissions
   - Monitor API usage logs

---

## Resources

### Official Documentation

- **MCP Protocol Spec**: [https://modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Anthropic MCP SDK**: [GitHub](https://github.com/anthropics/mcp-sdk)
- **Claude Desktop**: [https://claude.ai/download](https://claude.ai/download)

### Community Resources

- **MCP Servers List**: [GitHub - awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- **Continue.dev Docs**: [https://continue.dev/docs](https://continue.dev/docs)
- **DocuLight GitHub**: [Your repository]

### Support

- **GitHub Issues**: [DocuLight Issues](https://github.com/your-org/DocuLight/issues)
- **API Documentation**: [/api/doc](/api/doc)
- **Discord Community**: [Your Discord server]

---

## Changelog

### Version 1.0.0 (2025-01-XX)

**Initial Release**:
- ✅ Claude Desktop integration
- ✅ 5 core tools (list, read, create, update, delete)
- ✅ Stdio transport
- ✅ Header-based authentication

**Upcoming Features**:
- 🔜 HTTP transport support
- 🔜 WebSocket transport
- 🔜 Document search tool
- 🔜 Batch operations
- 🔜 Webhook notifications

---

**MCP Server Version**: 1.0.0
**Last Updated**: 2025-01-XX
**License**: MIT
```

---

## 3. Documentation Portal Implementation

### 3.1 New Route Handler

**File**: `src/routes/api-ctrl.js` (New file)

```javascript
const path = require('path');
const fs = require('fs');

/**
 * Serve documentation files
 */
function getDocumentation(req, res, next) {
  const docType = req.params.docType; // 'api' or 'mcp'
  const docFile = `${docType}-doc.md`;
  const docPath = path.join(__dirname, '../../public', docFile);

  // Check if documentation exists
  if (!fs.existsSync(docPath)) {
    return res.status(404).json({
      error: {
        code: 'DOC_NOT_FOUND',
        message: `Documentation not found: ${docType}`
      }
    });
  }

  try {
    const content = fs.readFileSync(docPath, 'utf-8');

    res.json({
      content,
      type: docType,
      path: `/${docType}/doc`
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getDocumentation };
```

### 3.2 Update API Router

**File**: `src/routes/api.js` (Modify)

```javascript
const express = require('express');
const authMiddleware = require('../middleware/auth');
const { getTree } = require('../controllers/tree-controller');
const { getRaw } = require('../controllers/raw-controller');
const { configureUpload, uploadFile } = require('../controllers/upload-controller');
const { deleteEntry } = require('../controllers/delete-controller');
const { downloadFile, downloadDirectory } = require('../controllers/download-controller');
const { getDocumentation } = require('../controllers/doc-controller'); // NEW

function createApiRouter(config) {
  const router = express.Router();
  const upload = configureUpload(config);

  // Public routes (no authentication required)
  router.get('/tree', getTree);
  router.get('/raw', getRaw);

  // Protected routes (authentication required)
  const auth = authMiddleware(config);

  router.post('/upload', auth, upload.single('file'), uploadFile);
  router.delete('/entry', auth, deleteEntry);
  router.get('/download/file', auth, downloadFile);
  router.get('/download/dir', auth, downloadDirectory);

  return router;
}

module.exports = createApiRouter;
```

### 3.3 Create Documentation Controller

**File**: `src/controllers/doc-controller.js` (New file)

```javascript
const path = require('path');
const fs = require('fs');

/**
 * Serve API or MCP documentation
 */
function getDocumentation(req, res, next) {
  const docType = req.params.docType; // 'api' or 'mcp'

  // Validate doc type
  if (!['api', 'mcp'].includes(docType)) {
    return res.status(404).json({
      error: {
        code: 'INVALID_DOC_TYPE',
        message: 'Documentation type must be "api" or "mcp"'
      }
    });
  }

  const docFile = `${docType}-doc.md`;
  const docPath = path.join(__dirname, '../../public', docFile);

  // Check if documentation exists
  if (!fs.existsSync(docPath)) {
    return res.status(404).json({
      error: {
        code: 'DOC_NOT_FOUND',
        message: `Documentation file not found: ${docFile}`
      }
    });
  }

  try {
    const content = fs.readFileSync(docPath, 'utf-8');
    const stats = fs.statSync(docPath);

    res.json({
      content,
      type: docType,
      path: `/${docType}/doc`,
      size: stats.size,
      modified: stats.mtime
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getDocumentation };
```

### 3.4 Update App.js

**File**: `src/app.js` (Modify)

```javascript
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { loadConfig } = require('./utils/config-loader');
const { createLogger } = require('./utils/logger');
const { loadSSLOptions } = require('./utils/ssl-validator');
const { createIpWhitelist } = require('./middleware/ip-whitelist');
const requestLogger = require('./middleware/request-logger');
const errorHandler = require('./middleware/error-handler');
const createApiRouter = require('./routes/api');
const createMcpRouter = require('./routes/mcp');
const { getDocumentation } = require('./controllers/doc-controller'); // NEW

// Load configuration
let config;
try {
  config = loadConfig();
  console.log('Configuration loaded successfully');
} catch (error) {
  console.error('Failed to load configuration:', error.message);
  process.exit(1);
}

// Create logger
const logger = createLogger(config);

// Create Express app
const app = express();

// Store config and logger in app.locals for access in routes
app.locals.config = config;
app.locals.logger = logger;

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// IP whitelist middleware (applied first)
app.use(createIpWhitelist(config));

app.use(requestLogger(logger));

// Routes
app.use('/api', createApiRouter(config));
app.use(createMcpRouter());

// Main page
app.get('/', (req, res) => {
  res.render('index', {
    title: 'DocuLight - Markdown Viewer',
    uiTitle: config.ui.title,
    uiIcon: config.ui.icon
  });
});

// Document viewer route (for clean URLs)
app.get('/doc/*', (req, res) => {
  res.render('index', {
    title: 'DocuLight - Markdown Viewer',
    uiTitle: config.ui.title,
    uiIcon: config.ui.icon
  });
});

// NEW: Documentation portal routes (hidden, no header/sidebar)
app.get('/api/doc', (req, res) => {
  req.params.docType = 'api';
  getDocumentation(req, res, (error) => {
    if (error) {
      return res.status(500).json({ error: error.message });
    }
  });
});

app.get('/mcp/doc', (req, res) => {
  req.params.docType = 'mcp';
  getDocumentation(req, res, (error) => {
    if (error) {
      return res.status(500).json({ error: error.message });
    }
  });
});

// NEW: Documentation viewer routes (rendered as clean page)
app.get('/:docType(api|mcp)/doc', (req, res) => {
  res.render('doc-viewer', {
    title: `${req.params.docType.toUpperCase()} Documentation - DocuLight`,
    docType: req.params.docType
  });
});

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  });
});

// Error handler (must be last)
app.use(errorHandler(logger));

// Start server
const PORT = config.port || 3000;

let server;

if (config.ssl && config.ssl.enabled) {
  // HTTPS server
  const sslOptions = loadSSLOptions(config.ssl);
  server = https.createServer(sslOptions, app);

  server.listen(PORT, () => {
    logger.info('DocuLight HTTPS server started', {
      port: PORT,
      docsRoot: config.docsRoot,
      ssl: true
    });

    console.log(`\n✅ DocuLight Server Started (HTTPS)`);
    console.log(`   📂 Docs: ${config.docsRoot}`);
    console.log(`   🔒 SSL: Enabled`);
    console.log(`   🌐 URL: https://localhost:${PORT}\n`);
  });
} else {
  // HTTP server
  server = http.createServer(app);

  server.listen(PORT, () => {
    logger.info('DocuLight HTTP server started', {
      port: PORT,
      docsRoot: config.docsRoot,
      ssl: false
    });

    console.log(`\n✅ DocuLight Server Started (HTTP)`);
    console.log(`   📂 Docs: ${config.docsRoot}`);
    console.log(`   ⚠️  SSL: Disabled`);
    console.log(`   🌐 URL: http://localhost:${PORT}\n`);
  });
}

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
```

### 3.5 Documentation Viewer Template

**File**: `src/views/doc-viewer.ejs` (New file)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><%= title %></title>
  <link rel="icon" type="image/png" href="/images/icon.svg">

  <!-- Highlight.js for syntax highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

  <!-- Marked.js for Markdown rendering -->
  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>

  <!-- DOMPurify for XSS protection -->
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>

  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #24292e;
      background-color: #ffffff;
      padding: 0;
      margin: 0;
    }

    .doc-container {
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
      background: #fff;
      min-height: 100vh;
    }

    .doc-header {
      padding-bottom: 20px;
      margin-bottom: 30px;
      border-bottom: 1px solid #e1e4e8;
    }

    .doc-header h1 {
      font-size: 32px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .doc-meta {
      color: #586069;
      font-size: 14px;
    }

    .loading {
      text-align: center;
      padding: 100px 20px;
      color: #586069;
    }

    .loading-spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #0366d6;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .error {
      background-color: #f85149;
      color: white;
      padding: 16px;
      border-radius: 6px;
      margin: 20px 0;
    }

    /* GitHub-style markdown rendering */
    .markdown-body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      word-wrap: break-word;
    }

    .markdown-body h1,
    .markdown-body h2 {
      padding-bottom: 0.3em;
      border-bottom: 1px solid #eaecef;
    }

    .markdown-body h1 {
      font-size: 2em;
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
    }

    .markdown-body h2 {
      font-size: 1.5em;
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
    }

    .markdown-body h3 {
      font-size: 1.25em;
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
    }

    .markdown-body p {
      margin-top: 0;
      margin-bottom: 16px;
    }

    .markdown-body a {
      color: #0366d6;
      text-decoration: none;
    }

    .markdown-body a:hover {
      text-decoration: underline;
    }

    .markdown-body code {
      padding: 0.2em 0.4em;
      margin: 0;
      font-size: 85%;
      background-color: rgba(27, 31, 35, 0.05);
      border-radius: 3px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    }

    .markdown-body pre {
      padding: 16px;
      overflow: auto;
      font-size: 85%;
      line-height: 1.45;
      background-color: #f6f8fa;
      border-radius: 6px;
      margin-bottom: 16px;
    }

    .markdown-body pre code {
      display: inline;
      padding: 0;
      margin: 0;
      overflow: visible;
      line-height: inherit;
      word-wrap: normal;
      background-color: transparent;
      border: 0;
    }

    .markdown-body table {
      border-spacing: 0;
      border-collapse: collapse;
      width: 100%;
      margin-top: 0;
      margin-bottom: 16px;
    }

    .markdown-body table th {
      font-weight: 600;
      padding: 6px 13px;
      border: 1px solid #d0d7de;
      background-color: #f6f8fa;
    }

    .markdown-body table td {
      padding: 6px 13px;
      border: 1px solid #d0d7de;
    }

    .markdown-body table tr {
      background-color: #fff;
      border-top: 1px solid #d0d7de;
    }

    .markdown-body table tr:nth-child(2n) {
      background-color: #f6f8fa;
    }

    .markdown-body blockquote {
      padding: 0 1em;
      color: #57606a;
      border-left: 0.25em solid #d0d7de;
      margin-top: 0;
      margin-bottom: 16px;
    }

    .markdown-body ul,
    .markdown-body ol {
      padding-left: 2em;
      margin-top: 0;
      margin-bottom: 16px;
    }

    .markdown-body li {
      margin-top: 0.25em;
    }

    .markdown-body hr {
      height: 0.25em;
      padding: 0;
      margin: 24px 0;
      background-color: #e1e4e8;
      border: 0;
    }

    @media (max-width: 767px) {
      .doc-container {
        padding: 20px;
      }

      .doc-header h1 {
        font-size: 24px;
      }

      .markdown-body {
        font-size: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="doc-container">
    <div class="doc-header">
      <h1 id="doc-title">Loading...</h1>
      <div class="doc-meta" id="doc-meta"></div>
    </div>

    <div id="loading" class="loading">
      <div class="loading-spinner"></div>
      <p>Loading documentation...</p>
    </div>

    <div id="error" class="error" style="display: none;"></div>

    <div id="content" class="markdown-body" style="display: none;"></div>
  </div>

  <script>
    const DOC_TYPE = '<%= docType %>';

    // Configure marked options
    marked.setOptions({
      gfm: true,
      breaks: false,
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch (err) {}
        }
        return hljs.highlightAuto(code).value;
      }
    });

    // Fetch and render documentation
    async function loadDocumentation() {
      const loadingEl = document.getElementById('loading');
      const errorEl = document.getElementById('error');
      const contentEl = document.getElementById('content');
      const titleEl = document.getElementById('doc-title');
      const metaEl = document.getElementById('doc-meta');

      try {
        const response = await fetch(`/${DOC_TYPE}/doc`);

        if (!response.ok) {
          throw new Error(`Failed to load documentation: ${response.status}`);
        }

        const data = await response.json();

        // Update title
        const docTitle = DOC_TYPE === 'api' ? 'API Documentation' : 'MCP Server Documentation';
        titleEl.textContent = docTitle;
        document.title = `${docTitle} - DocuLight`;

        // Update meta
        const modified = new Date(data.modified).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        metaEl.textContent = `Last updated: ${modified} • ${(data.size / 1024).toFixed(1)} KB`;

        // Render markdown
        const rawHtml = marked.parse(data.content);
        const cleanHtml = DOMPurify.sanitize(rawHtml);
        contentEl.innerHTML = cleanHtml;

        // Show content
        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';

        // Highlight code blocks
        document.querySelectorAll('pre code').forEach((block) => {
          hljs.highlightElement(block);
        });

      } catch (error) {
        console.error('Error loading documentation:', error);

        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${error.message}`;
      }
    }

    // Load documentation on page load
    document.addEventListener('DOMContentLoaded', loadDocumentation);
  </script>
</body>
</html>
```

---

## 4. Implementation Steps

### Phase 1: Documentation Creation (3-4 hours)

1. ✅ Create `public/api-doc.md` with complete API reference
2. ✅ Research MCP integration for Copilot and Claude
3. ✅ Create `public/mcp-doc.md` with integration guides
4. ✅ Review and edit for accuracy and clarity

### Phase 2: Route Implementation (2-3 hours)

1. ✅ Create `src/controllers/doc-controller.js`
2. ✅ Add documentation routes to `src/app.js`
3. ✅ Create `src/views/doc-viewer.ejs` template
4. ✅ Test `/api/doc` and `/mcp/doc` endpoints

### Phase 3: Testing & Validation (1-2 hours)

1. ✅ Test documentation loading
2. ✅ Verify Markdown rendering
3. ✅ Check syntax highlighting
4. ✅ Test responsive design on mobile
5. ✅ Validate links and code examples

### Phase 4: Documentation Review (1 hour)

1. ✅ Proofread technical content
2. ✅ Verify code examples work
3. ✅ Check formatting and styling
4. ✅ Update version numbers and dates

**Total Estimated Time**: 7-10 hours

---

## 5. Success Criteria

- [ ] API documentation is comprehensive and accurate
- [ ] MCP documentation includes working integration guides
- [ ] `/api/doc` renders documentation without header/sidebar
- [ ] `/mcp/doc` renders documentation without header/sidebar
- [ ] Documentation is responsive on mobile devices
- [ ] Code examples are syntax-highlighted
- [ ] Links within documentation work correctly
- [ ] Documentation files are not visible in main file tree
- [ ] Markdown rendering matches GitHub style
- [ ] All code examples are tested and functional

---

## 6. File Changes Summary

### New Files (4)

1. `public/api-doc.md` - Complete API reference documentation
2. `public/mcp-doc.md` - MCP integration documentation
3. `src/controllers/doc-controller.js` - Documentation controller
4. `src/views/doc-viewer.ejs` - Documentation-only view template

### Modified Files (1)

1. `src/app.js` - Add documentation routes

---

## 7. Next Steps

After Step 6 completion:
- Add search functionality to documentation
- Implement documentation versioning
- Add interactive API examples
- Create PDF export for documentation
- Implement documentation feedback system
