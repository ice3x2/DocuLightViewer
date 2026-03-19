# Step 23: Integration Test Guide

## E2E 시나리오

### E2E-01: docType 전체 파이프라인 (CRITICAL)

```
1. MCP HTTP로 open_markdown 호출: { content: "# Test", docType: "plan", project: "TestProj" }
2. 뷰어 창 열림 확인
3. frontmatter에 docType: plan 확인
4. metabox에 "📋 계획" 표시 확인
5. mcpAutoSave 활성화 시 저장 경로에 docType 반영 확인
6. search_documents({ query: "Test", docType: "plan" }) → 결과 반환 확인
```

### E2E-02: docType 기본값 파이프라인 (HIGH)

```
1. MCP HTTP로 open_markdown 호출: { content: "# Note", project: "TestProj" } (docType 미지정)
2. frontmatter에 docType: note 확인
3. metabox에 "📝 노트" 표시 확인
4. 저장 경로의 {type} 토큰이 "note"로 치환 확인
```

### E2E-03: update_markdown으로 docType 변경 (HIGH)

```
1. open_markdown with docType: "note"
2. update_markdown with docType: "report" on same window
3. frontmatter에 docType: report로 업데이트 확인
4. metabox 표시 갱신 확인
```

### E2E-04: search_documents docType 필터 (MEDIUM)

```
1. open_markdown 3회: docType=note, plan, issue
2. search_documents({ query: "*", docType: "plan" })
3. plan 타입 문서만 반환 확인
4. search_documents({ query: "*" }) → 전체 반환 확인
```

### E2E-05: Named Window upsert + docType (MEDIUM)

```
1. open_markdown with windowName: "test", docType: "issue"
2. open_markdown with windowName: "test", docType: "completion" (upsert)
3. 동일 창에서 docType이 completion으로 변경 확인
```

## 수동 검증 항목

| # | 항목 | 방법 |
|---|------|------|
| 1 | 10개 docType 아이콘 표시 | 각 타입으로 문서 열기 |
| 2 | 4개 로케일 라벨 | `npm run dev -- locale ja` 등으로 전환 |
| 3 | 다크/라이트 테마 | 설정에서 테마 전환 후 metabox 확인 |
| 4 | 서브디렉토리 저장 | mcpSaveSubDir = "{type}/{yyyy-mm-dd}" 설정 후 저장 확인 |
