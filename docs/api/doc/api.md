# DocuLight REST API Documentation

## Overview

DocuLight provides a RESTful API for Markdown document management. The API consists of public and protected endpoints.

### Basic Information

- **Base URL**: `http(s)://your-domain/api`
- **Content-Type**: `application/json` (default)
- **Authentication**: API Key (X-API-Key header)

---

## Authentication

### Protected Endpoints

Some API endpoints require authentication via HTTP headers.

**Header**
```
X-API-Key: your-api-key-here
```

**Authentication Failure Response**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "X-API-Key header is required"
  }
}
```

Or

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

---

## API Endpoints

### 1. Tree Structure Query (Public)

#### 1.1 Single Directory Tree Query

Retrieve immediate children (files and directories) of a specific directory.

**Request**
```http
GET /api/tree?path={path}
```

**Query Parameters**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| path | string | No | `/` | Directory path to query |

**Response Example**
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

**Response Fields**
- `path`: Queried path
- `dirs`: Array of subdirectories
  - `name`: Directory name
- `files`: Array of files
  - `name`: File name
  - `size`: File size (bytes)
- `excludesApplied`: Whether exclude rules were applied

**Features**
- Hidden files (starting with `.`) are automatically excluded
- Filtered according to `excludes` settings in `config.json5`
- Both directories and files are sorted alphabetically

**Error Responses**
- `NOT_FOUND`: Path is not a directory
- `PATH_TRAVERSAL`: Invalid path

---

#### 1.2 Full Recursive Tree Query

Recursively query all subdirectories from the document root.

**Request**
```http
GET /api/tree/full
```

**Query Parameters**
None

**Response Example**
```json
{
  "root": {
    "dirs": [
      {
        "name": "guide",
        "path": "/guide",
        "type": "directory",
        "dirs": [
          {
            "name": "chapter1",
            "path": "/guide/chapter1",
            "type": "directory",
            "dirs": [],
            "files": [
              {
                "name": "lesson1.md",
                "path": "/guide/chapter1/lesson1.md",
                "type": "file",
                "size": 1536
              }
            ]
          }
        ],
        "files": [
          {
            "name": "intro.md",
            "path": "/guide/intro.md",
            "type": "file",
            "size": 1024
          }
        ]
      }
    ],
    "files": [
      {
        "name": "README.md",
        "path": "/README.md",
        "type": "file",
        "size": 512
      }
    ]
  },
  "docsRoot": "/path/to/docs",
  "excludesApplied": true,
  "stats": {
    "totalFiles": 123,
    "totalDirs": 45
  }
}
```

**Response Fields**
- `root`: Root tree structure
  - `dirs`: Array of subdirectories (recursive)
    - `name`: Directory name
    - `path`: Relative path
    - `type`: "directory"
    - `dirs`: Recursive subdirectories
    - `files`: Files in the directory
  - `files`: Array of files
    - `name`: File name
    - `path`: Relative path
    - `type`: "file"
    - `size`: File size (bytes)
- `docsRoot`: Absolute path to document root
- `excludesApplied`: Whether exclude rules were applied
- `stats`: Statistics
  - `totalFiles`: Total number of files
  - `totalDirs`: Total number of directories

**Features**
- Query the entire document tree at once
- Hidden files and exclude rules applied
- All paths use Unix-style format starting with `/`

---

### 2. Raw File Query (Public)

Retrieve the raw text content of a Markdown file.

**Request**
```http
GET /api/raw?path={path}
```

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | Yes | File path (e.g., `/guide/intro.md`) |

**Response**
```
Content-Type: text/plain

# Introduction

This is a markdown file...
```

**Features**
- Only supports Markdown files (`.md`)
- Returns raw text as-is
- Content-Type: `text/plain`

**Error Responses**
- `PATH_TRAVERSAL`: Missing path parameter
- `NOT_FOUND`: File does not exist or is a directory
- `UNSUPPORTED_TYPE`: Not a `.md` file

---

#### 2.1 Raw Download via Clean URL (New)

Adding `.md` extension to a document URL in the browser triggers a raw file download.

**Request**
```http
GET /doc/{path}.md
```

**Example**
```
Render URL: http://localhost:3000/doc/guide/intro
Download URL: http://localhost:3000/doc/guide/intro.md
```

**Behavior**
- URL with `.md` extension → Download raw file
- URL without `.md` extension → Render in Markdown viewer

**Response Headers**
```
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="intro.md"
Content-Type: text/markdown; charset=UTF-8
Content-Length: 2048
```

**cURL Examples**
```bash
# Download raw file
curl "http://localhost:3000/doc/guide/intro.md" -o intro.md

# Download multiple files
for doc in intro setup advanced; do
  curl "http://localhost:3000/doc/guide/$doc.md" -o "$doc.md"
done
```

**vs REST API (`/api/raw`)**

| Aspect | Clean URL (`/doc/*.md`) | REST API (`/api/raw`) |
|--------|------------------------|----------------------|
| **Purpose** | Browser download | API call |
| **Response Header** | Content-Disposition: attachment | Content-Type: text/plain |
| **Browser Behavior** | Download dialog | Display text |
| **Filename** | Auto-set | User saves manually |
| **Authentication** | Not required | Not required |

**Use Cases**
- **Clean URL**: End users downloading files from browser
- **REST API**: Programs reading file content for processing

---

### 3. File Upload (Protected)

Upload a file or ZIP archive.

**Request**
```http
POST /api/upload?path={path}
Content-Type: multipart/form-data
X-API-Key: your-api-key
```

**Headers**
| Header | Required | Description |
|--------|----------|-------------|
| X-API-Key | Yes | API authentication key |

**Query Parameters**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| path | string | No | `/` | Target directory path |

**Form Data**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | File to upload |

**Upload Limits**
- Maximum file size: `maxUploadMB` setting in `config.json5` (default: 10MB)

**Response Example - Regular File**
```json
{
  "success": true,
  "type": "file",
  "filename": "document.md",
  "size": 2048,
  "path": "/guide"
}
```

**Response Example - ZIP File**
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

**ZIP File Processing**
- Files with `.zip` extension are automatically extracted
- Path security checks performed (prevent path traversal)
- Items containing `..` or absolute paths are skipped
- Extraction outside target directory is blocked

**ZIP Extraction Security**
- Block path traversal attempts (containing `../`)
- Block absolute paths
- Prevent extraction outside target directory
- Auto-create directory entries

**Behavior**
- Overwrites existing files
- Auto-creates target directory if missing
- Directory-level locking prevents concurrent modifications

**Error Responses**
- `PAYLOAD_TOO_LARGE`: File size exceeded or no file provided
- `UNAUTHORIZED`: Authentication failure

---

### 4. File/Directory Deletion (Protected)

Delete a file or directory.

**Request**
```http
DELETE /api/entry?path={path}
X-API-Key: your-api-key
```

**Headers**
| Header | Required | Description |
|--------|----------|-------------|
| X-API-Key | Yes | API authentication key |

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | Yes | Path to file/directory to delete |

**Response Example**
```json
{
  "success": true,
  "path": "/guide/old-doc.md",
  "message": "Entry deleted successfully"
}
```

**Features**
- Can delete both files and directories
- Directories are deleted recursively (including subitems)
- Retries up to 2 times if file is busy (1-second interval)
- Path locking prevents concurrent deletion

**Error Responses**
- `PATH_TRAVERSAL`: Missing path parameter
- `NOT_FOUND`: Path does not exist
- `FILE_BUSY`: File is busy and cannot be deleted
- `UNAUTHORIZED`: Authentication failure

---

### 5. File Download (Protected)

Download a single file.

**Request**
```http
GET /api/download/file?path={path}
X-API-Key: your-api-key
```

**Headers**
| Header | Required | Description |
|--------|----------|-------------|
| X-API-Key | Yes | API authentication key |

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | Yes | Path to file to download |

**Response**
- Content-Type: `application/octet-stream`
- Content-Disposition: `attachment; filename="filename.ext"`
- Content-Length: File size
- Body: File binary stream

**Features**
- Memory-efficient file streaming
- Supports all file types

**Error Responses**
- `PATH_TRAVERSAL`: Missing path parameter
- `NOT_FOUND`: File does not exist or is a directory
- `UNAUTHORIZED`: Authentication failure

---

### 6. Directory Download (Protected)

Download a directory as a ZIP archive.

**Request**
```http
GET /api/download/dir?path={path}
X-API-Key: your-api-key
```

**Headers**
| Header | Required | Description |
|--------|----------|-------------|
| X-API-Key | Yes | API authentication key |

**Query Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | Yes | Path to directory to download |

**Response**
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="dirname.zip"`
- Body: ZIP file stream

**Features**
- Compresses entire directory to ZIP
- Applies `excludes` rules from `config.json5`
- Compression level: 9 (maximum compression)
- Streaming method supports large directories

**Error Responses**
- `PATH_TRAVERSAL`: Missing path parameter
- `NOT_FOUND`: Directory does not exist or is a file
- `UNAUTHORIZED`: Authentication failure

---

## Error Codes

All error responses follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message"
  }
}
```

### Error Code List

| Code | HTTP Status | Description |
|------|------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `PATH_TRAVERSAL` | 400 | Invalid path or missing required parameter |
| `NOT_FOUND` | 404 | Requested file/directory does not exist |
| `UNSUPPORTED_TYPE` | 400 | Unsupported file type |
| `PAYLOAD_TOO_LARGE` | 413 | Upload file size exceeded |
| `FILE_BUSY` | 500 | File is busy and operation cannot proceed |
| `INTERNAL_ERROR` | 500 | Internal server error |

---

## Security Features

### 1. Path Validation
- All paths validated with `path-validator` utility
- Prevents path traversal attacks (blocks `../`)
- Blocks access outside document root

### 2. Authentication
- Protected endpoints require API key
- API key transmitted via HTTP header (`X-API-Key`)
- Returns 401 response on key mismatch

### 3. File Upload Security
- File size limits (configurable)
- Blocks path traversal during ZIP extraction
- Only safe paths allowed for extraction

### 4. Concurrency Control
- File/directory-level locking via Lock Manager
- Prevents concurrent modifications/deletions
- Ensures data integrity

### 5. File Filtering
- Auto-excludes hidden files (starting with `.`)
- Supports custom exclude patterns (`excludes`)
- ignore library-based filtering

---

## Usage Examples

### cURL Examples

#### 1. Query Tree
```bash
curl "http://localhost:3000/api/tree?path=/guide"
```

#### 2. Query File Content
```bash
curl "http://localhost:3000/api/raw?path=/README.md"
```

#### 3. Upload File
```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -F "file=@document.md"
```

#### 4. Upload ZIP File (Auto-extract)
```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -F "file=@archive.zip"
```

#### 5. Delete File
```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old.md" \
  -H "X-API-Key: your-api-key"
```

#### 6. Download File
```bash
curl "http://localhost:3000/api/download/file?path=/guide/doc.md" \
  -H "X-API-Key: your-api-key" \
  -o doc.md
```

#### 7. Download Directory as ZIP
```bash
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -o guide.zip
```

### JavaScript/Fetch Examples

```javascript
// Query tree
const tree = await fetch('/api/tree?path=/guide').then(r => r.json());

// Upload file
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const uploadResult = await fetch('/api/upload?path=/guide', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your-api-key'
  },
  body: formData
}).then(r => r.json());

// Delete file
const deleteResult = await fetch('/api/entry?path=/guide/old.md', {
  method: 'DELETE',
  headers: {
    'X-API-Key': 'your-api-key'
  }
}).then(r => r.json());
```
