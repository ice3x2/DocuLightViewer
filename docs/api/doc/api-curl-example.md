# DocuLight API - cURL Examples

This document provides cURL command examples for testing the DocuLight REST API.

## Prerequisites

### Environment Variables

Before testing, set these environment variables for convenience:

```bash
# Windows PowerShell
$API_BASE = "http://localhost:3000/api"
$API_KEY = "your-api-key-here"

# Linux/Mac Bash
export API_BASE="http://localhost:3000/api"
export API_KEY="your-api-key-here"
```

Below examples use actual URLs and API keys directly.

---

## 1. Tree Structure Query (Public API)

### 1.1 Single Directory Tree Query

Query root directory contents:

```bash
curl "http://localhost:3000/api/tree"
```

Query specific directory:

```bash
curl "http://localhost:3000/api/tree?path=/guide"
```

Pretty print JSON results (requires jq):

```bash
curl "http://localhost:3000/api/tree?path=/guide" | jq
```

**Expected Response:**
```json
{
  "path": "/guide",
  "dirs": [
    { "name": "chapter1" },
    { "name": "chapter2" }
  ],
  "files": [
    { "name": "intro.md", "size": 1024 },
    { "name": "setup.md", "size": 2048 }
  ],
  "excludesApplied": true
}
```

---

### 1.2 Full Recursive Tree Query

Query entire document tree at once:

```bash
curl "http://localhost:3000/api/tree/full"
```

Save to file:

```bash
curl "http://localhost:3000/api/tree/full" -o tree-full.json
```

---

## 2. Raw File Query (Public API)

### Read Markdown File Content

Query README file:

```bash
curl "http://localhost:3000/api/raw?path=/README.md"
```

Query guide document:

```bash
curl "http://localhost:3000/api/raw?path=/guide/intro.md"
```

Save content locally:

```bash
curl "http://localhost:3000/api/raw?path=/guide/intro.md" -o intro.md"
```

---

## 3. File Upload (Protected API)

### 3.1 Single File Upload

Upload markdown file:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@document.md"
```

Upload to root directory:

```bash
curl -X POST "http://localhost:3000/api/upload" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@README.md"
```

**Expected Response:**
```json
{
  "success": true,
  "type": "file",
  "filename": "document.md",
  "size": 2048,
  "path": "/guide"
}
```

---

### 3.2 ZIP File Upload (Auto-extract)

Upload ZIP file (auto-extracts):

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@archive.zip"
```

**Expected Response:**
```json
{
  "success": true,
  "type": "zip",
  "filename": "archive.zip",
  "size": 10240,
  "path": "/guide",
  "extraction": {
    "extracted": 5,
    "skipped": 0,
    "errors": 0,
    "details": {
      "extracted": [
        { "name": "doc1.md", "size": 1024 },
        { "name": "doc2.md", "size": 2048 }
      ],
      "skipped": [],
      "errors": []
    }
  }
}
```

---

### 3.3 Multiple Files Upload

Upload all markdown files sequentially:

```bash
for file in *.md; do
  curl -X POST "http://localhost:3000/api/upload?path=/backup" \
    -H "X-API-Key: your-api-key-here" \
    -F "file=@$file"
done
```

---

## 4. File/Directory Deletion (Protected API)

### 4.1 File Deletion

Delete single file:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old-doc.md" \
  -H "X-API-Key: your-api-key-here"
```

**Expected Response:**
```json
{
  "success": true,
  "path": "/guide/old-doc.md",
  "message": "Entry deleted successfully"
}
```

---

### 4.2 Directory Deletion

Delete directory with files (recursive):

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old-chapter" \
  -H "X-API-Key: your-api-key-here"
```

Verify before deletion:

```bash
# 1. Check contents
curl "http://localhost:3000/api/tree?path=/temp"

# 2. Delete
curl -X DELETE "http://localhost:3000/api/entry?path=/temp" \
  -H "X-API-Key: your-api-key-here"

# 3. Verify deletion
curl "http://localhost:3000/api/tree?path=/"
```

---

## 5. File Download (Protected API)

### 5.1 Single File Download

Download markdown file:

```bash
curl "http://localhost:3000/api/download/file?path=/guide/intro.md" \
  -H "X-API-Key: your-api-key-here" \
  -o intro.md
```

Preserve original filename:

```bash
curl -OJ "http://localhost:3000/api/download/file?path=/guide/setup.md" \
  -H "X-API-Key: your-api-key-here"
```

Show download progress:

```bash
curl "http://localhost:3000/api/download/file?path=/large-file.md" \
  -H "X-API-Key: your-api-key-here" \
  -o large-file.md \
  --progress-bar
```

---

## 6. Directory Download (Protected API)

### 6.1 Download Directory as ZIP

Download single directory:

```bash
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -o guide.zip
```

Download entire root:

```bash
curl "http://localhost:3000/api/download/dir?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -o all-docs.zip
```

Download and extract:

```bash
# Download
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -o guide.zip

# Extract
unzip guide.zip -d guide/
```

---

## 7. Authentication Tests

### 7.1 No API Key (Error)

Request protected endpoint without API key:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/test" \
  -F "file=@test.md"
```

**Error Response:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "X-API-Key header is required"
  }
}
```

---

### 7.2 Invalid API Key (Error)

Request with wrong API key:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/test.md" \
  -H "X-API-Key: wrong-key"
```

**Error Response:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

---

## 8. Error Handling Examples

### 8.1 Path Not Found

Non-existent path:

```bash
curl "http://localhost:3000/api/raw?path=/nonexistent.md"
```

**Error Response:**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Path is not a file"
  }
}
```

---

### 8.2 Unsupported File Type

Try to query raw content of non-.md file:

```bash
curl "http://localhost:3000/api/raw?path=/image.png"
```

**Error Response:**
```json
{
  "error": {
    "code": "UNSUPPORTED_TYPE",
    "message": "Only .md files are supported"
  }
}
```

---

## 9. Complex Workflows

### 9.1 Full Backup and Restore

**Backup:**
```bash
# 1. Save tree structure
curl "http://localhost:3000/api/tree/full" -o tree-backup.json

# 2. Download all documents as ZIP
curl "http://localhost:3000/api/download/dir?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -o docs-backup-$(date +%Y%m%d).zip
```

**Restore:**
```bash
# Upload ZIP to restore
curl -X POST "http://localhost:3000/api/upload?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@docs-backup-20251025.zip"
```

---

### 9.2 Document Migration

Move documents from one directory to another:

```bash
# 1. Download source
curl "http://localhost:3000/api/download/dir?path=/old-location" \
  -H "X-API-Key: your-api-key-here" \
  -o temp.zip

# 2. Upload to destination
curl -X POST "http://localhost:3000/api/upload?path=/new-location" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@temp.zip"

# 3. Delete source
curl -X DELETE "http://localhost:3000/api/entry?path=/old-location" \
  -H "X-API-Key: your-api-key-here"

# 4. Clean up temp file
rm temp.zip
```

---

### 9.3 Batch File Upload

Upload all markdown files in current directory:

```bash
for file in *.md; do
  echo "Uploading $file..."
  curl -X POST "http://localhost:3000/api/upload?path=/imported" \
    -H "X-API-Key: your-api-key-here" \
    -F "file=@$file" \
    -s | jq '.success, .filename'
done
```

---

## 10. Useful cURL Options

### Basic Options

```bash
# Verbose output (debugging)
curl -v "http://localhost:3000/api/tree"

# Headers only
curl -I "http://localhost:3000/api/raw?path=/README.md"

# Timeout setting (seconds)
curl --max-time 30 "http://localhost:3000/api/tree/full"

# Retry settings
curl --retry 3 "http://localhost:3000/api/tree"
```

---

### Output Format

```bash
# Pretty print JSON (requires jq)
curl "http://localhost:3000/api/tree" | jq

# Extract specific fields
curl "http://localhost:3000/api/tree?path=/guide" | jq '.files[].name'

# Output HTTP status code only
curl -w "%{http_code}" -o /dev/null -s "http://localhost:3000/api/tree"

# Measure response time
curl -w "\nTime: %{time_total}s\n" -o /dev/null -s "http://localhost:3000/api/tree"
```

---

## 11. Windows PowerShell Examples

PowerShell uses `Invoke-WebRequest` or `curl` alias:

### Query Tree
```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/tree?path=/guide" | Select-Object -Expand Content | ConvertFrom-Json
```

### Upload File
```powershell
$headers = @{ "X-API-Key" = "your-api-key-here" }
$form = @{ file = Get-Item -Path "document.md" }
Invoke-WebRequest -Uri "http://localhost:3000/api/upload?path=/guide" -Method Post -Headers $headers -Form $form
```

### Download File
```powershell
$headers = @{ "X-API-Key" = "your-api-key-here" }
Invoke-WebRequest -Uri "http://localhost:3000/api/download/file?path=/README.md" -Headers $headers -OutFile "README.md"
```

---

## 12. Test Script Example

### Bash Script

Complete API test automation script:

```bash
#!/bin/bash

API_BASE="http://localhost:3000/api"
API_KEY="your-api-key-here"

echo "=== DocuLight API Test ==="

# 1. Tree query
echo -e "\n1. Testing tree endpoint..."
curl -s "$API_BASE/tree" | jq '.path'

# 2. Full tree query
echo -e "\n2. Testing full tree endpoint..."
curl -s "$API_BASE/tree/full" | jq '.stats'

# 3. File upload
echo -e "\n3. Testing upload..."
echo "# Test Document" > test.md
curl -s -X POST "$API_BASE/upload?path=/test" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@test.md" | jq '.success'

# 4. File query
echo -e "\n4. Testing raw endpoint..."
curl -s "$API_BASE/raw?path=/test/test.md"

# 5. File download
echo -e "\n5. Testing download..."
curl -s "$API_BASE/download/file?path=/test/test.md" \
  -H "X-API-Key: $API_KEY" \
  -o downloaded.md

# 6. File deletion
echo -e "\n6. Testing delete..."
curl -s -X DELETE "$API_BASE/entry?path=/test/test.md" \
  -H "X-API-Key: $API_KEY" | jq '.success'

# 7. Directory cleanup
echo -e "\n7. Cleanup..."
curl -s -X DELETE "$API_BASE/entry?path=/test" \
  -H "X-API-Key: $API_KEY" | jq '.success'

# Cleanup
rm -f test.md downloaded.md

echo -e "\n=== Test Complete ==="
```

---

## Additional Resources

- [DocuLight API Documentation](./api.md) - Complete REST API reference
- [DocuLight MCP Documentation](../mcp/doc/mcp.md) - MCP (AI Agent) API reference
- [cURL Official Documentation](https://curl.se/docs/manual.html)
- [jq Manual](https://stedolan.github.io/jq/manual/)
