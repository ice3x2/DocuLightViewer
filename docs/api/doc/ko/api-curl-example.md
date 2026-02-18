# DocuLight API - cURL 사용 예제

이 문서는 DocuLight REST API를 cURL 명령어로 테스트하는 방법을 제공합니다.

## 사전 준비

### 환경 변수 설정

테스트를 시작하기 전에 다음 환경 변수를 설정하면 편리합니다:

```bash
# Windows PowerShell
$API_BASE = "http://localhost:3000/api"
$API_KEY = "your-api-key-here"

# Linux/Mac Bash
export API_BASE="http://localhost:3000/api"
export API_KEY="your-api-key-here"
```

아래 예제에서는 실제 URL과 API 키를 직접 사용합니다.

---

## 1. 트리 구조 조회 (공개 API)

### 1.1 단일 디렉토리 트리 조회

루트 디렉토리의 내용을 조회합니다:

```bash
curl "http://localhost:3000/api/tree"
```

특정 디렉토리를 조회합니다:

```bash
curl "http://localhost:3000/api/tree?path=/guide"
```

중첩된 경로 조회:

```bash
curl "http://localhost:3000/api/tree?path=/guide/chapter1"
```

JSON 결과를 보기 좋게 출력 (jq 사용):

```bash
curl "http://localhost:3000/api/tree?path=/guide" | jq
```

**예상 응답:**
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

### 1.2 전체 재귀 트리 조회

문서 전체의 트리 구조를 한 번에 조회합니다:

```bash
curl "http://localhost:3000/api/tree/full"
```

결과를 파일로 저장:

```bash
curl "http://localhost:3000/api/tree/full" -o tree-full.json
```

보기 좋게 출력:

```bash
curl "http://localhost:3000/api/tree/full" | jq
```

**예상 응답:**
```json
{
  "root": {
    "dirs": [
      {
        "name": "guide",
        "path": "/guide",
        "type": "directory",
        "dirs": [...],
        "files": [...]
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

---

## 2. 원본 파일 조회 (공개 API)

### 마크다운 파일 내용 읽기

README 파일 조회:

```bash
curl "http://localhost:3000/api/raw?path=/README.md"
```

가이드 문서 조회:

```bash
curl "http://localhost:3000/api/raw?path=/guide/intro.md"
```

파일 내용을 로컬에 저장:

```bash
curl "http://localhost:3000/api/raw?path=/guide/intro.md" -o intro.md
```

파일 크기 확인 (헤더만):

```bash
curl -I "http://localhost:3000/api/raw?path=/README.md"
```

**예상 응답:**
```
# Introduction

This is a markdown document...
```

---

## 3. 파일 업로드 (보호된 API)

### 3.1 단일 파일 업로드

마크다운 파일 업로드:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@document.md"
```

루트 디렉토리에 업로드:

```bash
curl -X POST "http://localhost:3000/api/upload" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@README.md"
```

하위 디렉토리에 업로드:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide/chapter1" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@lesson1.md"
```

업로드 결과를 보기 좋게 출력:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@document.md" | jq
```

**예상 응답:**
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

### 3.2 ZIP 파일 업로드 (자동 압축 해제)

ZIP 파일을 업로드하면 자동으로 압축이 해제됩니다:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@archive.zip"
```

상세한 압축 해제 결과 확인:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/docs" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@documentation.zip" | jq
```

**예상 응답:**
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
        { "name": "doc2.md", "size": 2048 },
        { "name": "subfolder/doc3.md", "size": 1536 }
      ],
      "skipped": [],
      "errors": []
    }
  }
}
```

---

### 3.3 이미지 파일 업로드

PNG 이미지 업로드:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/images" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@screenshot.png"
```

여러 파일 순차적으로 업로드:

```bash
for file in *.md; do
  curl -X POST "http://localhost:3000/api/upload?path=/backup" \
    -H "X-API-Key: your-api-key-here" \
    -F "file=@$file"
done
```

---

## 4. 파일/디렉토리 삭제 (보호된 API)

### 4.1 파일 삭제

단일 파일 삭제:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old-doc.md" \
  -H "X-API-Key: your-api-key-here"
```

삭제 결과 확인:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/temp/test.md" \
  -H "X-API-Key: your-api-key-here" | jq
```

**예상 응답:**
```json
{
  "success": true,
  "path": "/guide/old-doc.md",
  "message": "Entry deleted successfully"
}
```

---

### 4.2 디렉토리 삭제

빈 디렉토리 삭제:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/temp" \
  -H "X-API-Key: your-api-key-here"
```

파일이 있는 디렉토리 삭제 (재귀적):

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old-chapter" \
  -H "X-API-Key: your-api-key-here"
```

삭제 전 확인 (트리 조회 후 삭제):

```bash
# 1. 삭제할 내용 확인
curl "http://localhost:3000/api/tree?path=/temp"

# 2. 삭제 실행
curl -X DELETE "http://localhost:3000/api/entry?path=/temp" \
  -H "X-API-Key: your-api-key-here"

# 3. 삭제 확인
curl "http://localhost:3000/api/tree?path=/"
```

---

### 4.3 삭제 에러 처리

존재하지 않는 파일 삭제 시도:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/nonexistent.md" \
  -H "X-API-Key: your-api-key-here"
```

**에러 응답:**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Path does not exist"
  }
}
```

---

## 5. 파일 다운로드 (보호된 API)

### 5.1 단일 파일 다운로드

마크다운 파일 다운로드:

```bash
curl "http://localhost:3000/api/download/file?path=/guide/intro.md" \
  -H "X-API-Key: your-api-key-here" \
  -o intro.md
```

원본 파일명 유지하며 다운로드:

```bash
curl -OJ "http://localhost:3000/api/download/file?path=/guide/setup.md" \
  -H "X-API-Key: your-api-key-here"
```

다운로드 진행률 표시:

```bash
curl "http://localhost:3000/api/download/file?path=/large-file.md" \
  -H "X-API-Key: your-api-key-here" \
  -o large-file.md \
  --progress-bar
```

이미지 파일 다운로드:

```bash
curl "http://localhost:3000/api/download/file?path=/images/logo.png" \
  -H "X-API-Key: your-api-key-here" \
  -o logo.png
```

---

### 5.2 다운로드 정보 확인

파일 크기 및 헤더 확인 (다운로드 없이):

```bash
curl -I "http://localhost:3000/api/download/file?path=/guide/intro.md" \
  -H "X-API-Key: your-api-key-here"
```

**예상 헤더:**
```
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="intro.md"
Content-Type: application/octet-stream
Content-Length: 2048
```

---

## 6. 디렉토리 다운로드 (보호된 API)

### 6.1 디렉토리를 ZIP으로 다운로드

단일 디렉토리 다운로드:

```bash
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -o guide.zip
```

루트 전체 다운로드:

```bash
curl "http://localhost:3000/api/download/dir?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -o all-docs.zip
```

하위 디렉토리 다운로드:

```bash
curl "http://localhost:3000/api/download/dir?path=/guide/chapter1" \
  -H "X-API-Key: your-api-key-here" \
  -o chapter1.zip
```

다운로드 후 압축 해제:

```bash
# 다운로드
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key-here" \
  -o guide.zip

# 압축 해제
unzip guide.zip -d guide/
```

---

### 6.2 대용량 디렉토리 다운로드

진행률 표시와 함께 다운로드:

```bash
curl "http://localhost:3000/api/download/dir?path=/large-docs" \
  -H "X-API-Key: your-api-key-here" \
  -o large-docs.zip \
  --progress-bar
```

타임아웃 늘리기 (대용량):

```bash
curl "http://localhost:3000/api/download/dir?path=/large-docs" \
  -H "X-API-Key: your-api-key-here" \
  -o large-docs.zip \
  --max-time 600
```

---

## 7. 인증 테스트

### 7.1 API 키 없이 요청 (에러)

보호된 엔드포인트에 API 키 없이 요청:

```bash
curl -X POST "http://localhost:3000/api/upload?path=/test" \
  -F "file=@test.md"
```

**에러 응답:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "X-API-Key header is required"
  }
}
```

---

### 7.2 잘못된 API 키 (에러)

잘못된 API 키로 요청:

```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/test.md" \
  -H "X-API-Key: wrong-key"
```

**에러 응답:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

---

### 7.3 올바른 API 키

올바른 API 키로 요청:

```bash
curl "http://localhost:3000/api/download/file?path=/README.md" \
  -H "X-API-Key: correct-api-key-here" \
  -o README.md
```

---

## 8. 에러 처리 예제

### 8.1 경로 오류

존재하지 않는 경로:

```bash
curl "http://localhost:3000/api/raw?path=/nonexistent.md"
```

**에러 응답:**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Path is not a file"
  }
}
```

---

### 8.2 지원하지 않는 파일 형식

`.md`가 아닌 파일의 raw 조회 시도:

```bash
curl "http://localhost:3000/api/raw?path=/image.png"
```

**에러 응답:**
```json
{
  "error": {
    "code": "UNSUPPORTED_TYPE",
    "message": "Only .md files are supported"
  }
}
```

---

### 8.3 파일 크기 초과

너무 큰 파일 업로드:

```bash
curl -X POST "http://localhost:3000/api/upload" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@huge-file.zip"
```

**에러 응답:**
```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "File too large"
  }
}
```

---

## 9. 복합 워크플로우 예제

### 9.1 전체 백업 및 복원

**백업:**
```bash
# 1. 전체 트리 구조 저장
curl "http://localhost:3000/api/tree/full" -o tree-backup.json

# 2. 전체 문서 ZIP으로 다운로드
curl "http://localhost:3000/api/download/dir?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -o docs-backup-$(date +%Y%m%d).zip
```

**복원:**
```bash
# ZIP을 업로드하여 복원
curl -X POST "http://localhost:3000/api/upload?path=/" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@docs-backup-20251025.zip"
```

---

### 9.2 문서 마이그레이션

한 디렉토리에서 다른 디렉토리로 문서 이동:

```bash
# 1. 소스 다운로드
curl "http://localhost:3000/api/download/dir?path=/old-location" \
  -H "X-API-Key: your-api-key-here" \
  -o temp.zip

# 2. 대상에 업로드
curl -X POST "http://localhost:3000/api/upload?path=/new-location" \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@temp.zip"

# 3. 소스 삭제
curl -X DELETE "http://localhost:3000/api/entry?path=/old-location" \
  -H "X-API-Key: your-api-key-here"

# 4. 임시 파일 삭제
rm temp.zip
```

---

### 9.3 일괄 파일 업로드

현재 디렉토리의 모든 마크다운 파일 업로드:

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

### 9.4 트리 탐색 및 모든 파일 다운로드

재귀적으로 모든 파일 다운로드:

```bash
# 1. 전체 트리 가져오기
curl "http://localhost:3000/api/tree/full" -o tree.json

# 2. jq로 모든 파일 경로 추출
jq -r '.. | .path? // empty' tree.json | grep '.md$' > files.txt

# 3. 각 파일 다운로드
while IFS= read -r path; do
  filename=$(basename "$path")
  curl "http://localhost:3000/api/raw?path=$path" -o "downloaded/$filename"
done < files.txt
```

---

## 10. 유용한 cURL 옵션

### 기본 옵션

```bash
# 상세한 출력 (디버깅)
curl -v "http://localhost:3000/api/tree"

# 헤더만 확인
curl -I "http://localhost:3000/api/raw?path=/README.md"

# 자동 리디렉션 따라가기
curl -L "http://localhost:3000/api/tree"

# 타임아웃 설정 (초)
curl --max-time 30 "http://localhost:3000/api/tree/full"

# 재시도 설정
curl --retry 3 "http://localhost:3000/api/tree"

# 프록시 사용
curl --proxy http://proxy.example.com:8080 "http://localhost:3000/api/tree"
```

---

### 출력 형식

```bash
# JSON 보기 좋게 출력 (jq 필요)
curl "http://localhost:3000/api/tree" | jq

# 특정 필드만 추출
curl "http://localhost:3000/api/tree?path=/guide" | jq '.files[].name'

# HTTP 상태 코드만 출력
curl -w "%{http_code}" -o /dev/null -s "http://localhost:3000/api/tree"

# 응답 시간 측정
curl -w "\nTime: %{time_total}s\n" -o /dev/null -s "http://localhost:3000/api/tree"
```

---

### 파일 다운로드 옵션

```bash
# 원격 파일명 유지
curl -O "http://localhost:3000/api/download/file?path=/README.md" \
  -H "X-API-Key: your-api-key-here"

# Content-Disposition 헤더의 파일명 사용
curl -OJ "http://localhost:3000/api/download/file?path=/guide/intro.md" \
  -H "X-API-Key: your-api-key-here"

# 진행률 표시
curl --progress-bar -o file.zip \
  "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key-here"

# 이어받기 (resume)
curl -C - -o large-file.zip \
  "http://localhost:3000/api/download/dir?path=/large" \
  -H "X-API-Key: your-api-key-here"
```

---

## 11. Windows PowerShell 예제

PowerShell에서는 `Invoke-WebRequest` 또는 `curl` 별칭을 사용할 수 있습니다:

### 트리 조회
```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/tree?path=/guide" | Select-Object -Expand Content | ConvertFrom-Json
```

### 파일 업로드
```powershell
$headers = @{ "X-API-Key" = "your-api-key-here" }
$form = @{ file = Get-Item -Path "document.md" }
Invoke-WebRequest -Uri "http://localhost:3000/api/upload?path=/guide" -Method Post -Headers $headers -Form $form
```

### 파일 다운로드
```powershell
$headers = @{ "X-API-Key" = "your-api-key-here" }
Invoke-WebRequest -Uri "http://localhost:3000/api/download/file?path=/README.md" -Headers $headers -OutFile "README.md"
```

### 파일 삭제
```powershell
$headers = @{ "X-API-Key" = "your-api-key-here" }
Invoke-WebRequest -Uri "http://localhost:3000/api/entry?path=/test.md" -Method Delete -Headers $headers
```

---

## 12. 테스트 스크립트 예제

### Bash 스크립트

전체 API 테스트를 자동화하는 스크립트:

```bash
#!/bin/bash

API_BASE="http://localhost:3000/api"
API_KEY="your-api-key-here"

echo "=== DocuLight API Test ==="

# 1. 트리 조회
echo -e "\n1. Testing tree endpoint..."
curl -s "$API_BASE/tree" | jq '.path'

# 2. 전체 트리 조회
echo -e "\n2. Testing full tree endpoint..."
curl -s "$API_BASE/tree/full" | jq '.stats'

# 3. 파일 업로드
echo -e "\n3. Testing upload..."
echo "# Test Document" > test.md
curl -s -X POST "$API_BASE/upload?path=/test" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@test.md" | jq '.success'

# 4. 파일 조회
echo -e "\n4. Testing raw endpoint..."
curl -s "$API_BASE/raw?path=/test/test.md"

# 5. 파일 다운로드
echo -e "\n5. Testing download..."
curl -s "$API_BASE/download/file?path=/test/test.md" \
  -H "X-API-Key: $API_KEY" \
  -o downloaded.md

# 6. 파일 삭제
echo -e "\n6. Testing delete..."
curl -s -X DELETE "$API_BASE/entry?path=/test/test.md" \
  -H "X-API-Key: $API_KEY" | jq '.success'

# 7. 디렉토리 삭제
echo -e "\n7. Cleanup..."
curl -s -X DELETE "$API_BASE/entry?path=/test" \
  -H "X-API-Key: $API_KEY" | jq '.success'

# 정리
rm -f test.md downloaded.md

echo -e "\n=== Test Complete ==="
```

---

## 참고사항

1. **API 키 보안**: 실제 환경에서는 API 키를 코드에 하드코딩하지 말고 환경 변수나 설정 파일에서 읽어오세요.

2. **에러 처리**: 프로덕션 스크립트에서는 HTTP 상태 코드를 확인하고 적절히 처리하세요.

3. **파일 인코딩**: UTF-8 인코딩을 사용하여 한글 파일명도 올바르게 처리됩니다.

4. **경로 형식**: 모든 경로는 `/`로 시작하는 Unix 스타일을 사용합니다.

5. **대용량 파일**: 큰 파일을 다운로드할 때는 `--max-time` 옵션으로 타임아웃을 늘리세요.

---

---

## 13. MCP API 예제

DocuLight는 AI 에이전트를 위한 MCP (Model Context Protocol) API도 제공합니다.

### 13.1 도구 목록 조회

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }' | jq '.result.tools[].name'
```

**예상 응답:**
```
"list_documents"
"list_full_tree"
"read_document"
"create_document"
"delete_document"
"DocuLight_get_config"
"DocuLight_search"
```

---

### 13.2 설정 조회 (민감값 마스킹)

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_get_config",
      "arguments": {
        "section": "all"
      }
    }
  }' | jq '.result.content[0].text'
```

UI 설정만 조회:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_get_config",
      "arguments": {
        "section": "ui"
      }
    }
  }'
```

---

### 13.3 문서 검색

"installation" 키워드 검색:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_search",
      "arguments": {
        "query": "installation",
        "limit": 5
      }
    }
  }'
```

특정 디렉토리 내에서만 검색:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_search",
      "arguments": {
        "query": "api",
        "limit": 10,
        "path": "/guide"
      }
    }
  }' | jq '.result.content[0].text'
```

**예상 응답:**
```markdown
# Search Results for "api"

**Statistics**: 3 matches in 8 files scanned (42ms)

## 1. /guide/setup.md

**Line 15**: API configuration

```
## Configuration

API configuration is in config.json5
```

...
```

---

### 13.4 MCP 완전한 워크플로우

문서 검색 → 읽기 → 수정 → 저장:

```bash
#!/bin/bash

# 1. "configuration" 검색
echo "1. Searching for 'configuration'..."
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_search",
      "arguments": {"query": "configuration", "limit": 3}
    }
  }' | jq -r '.result.content[0].text'

# 2. 첫 번째 결과 파일 읽기
echo -e "\n2. Reading document..."
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "read_document",
      "arguments": {"path": "/guide/setup.md"}
    }
  }' | jq -r '.result.content[0].text'

# 3. 설정 확인
echo -e "\n3. Checking current config..."
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "DocuLight_get_config",
      "arguments": {"section": "ui"}
    }
  }' | jq -r '.result.content[0].text'

echo -e "\n=== MCP Workflow Complete ==="
```

---

## 추가 리소스

- [DocuLight API 문서](./api.md) - 전체 REST API 참조 문서
- [DocuLight MCP 문서](./mcp.md) - MCP (AI 에이전트용) API 참조 문서
- [cURL 공식 문서](https://curl.se/docs/manual.html)
- [jq 매뉴얼](https://stedolan.github.io/jq/manual/)
