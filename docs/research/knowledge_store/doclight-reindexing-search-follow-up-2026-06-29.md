---
title: Superseded DocLight Reindexing Research
name: Superseded DocLight Reindexing Research
description: 이 문서는 잘못된 DocLight 프로젝트 전제를 바탕으로 작성된 이전 연구를 대체 처리하기 위한 보관 문서입니다. DocuLightViewer 기준 연구는 knowledge.md를 사용합니다.
docType: report
category: superseded
project: DocuLightViewer
status: superseded
date: 2026-06-29
tags: superseded, doclight, indexing
sourcePath: docs/research/knowledge_store/doclight-reindexing-search-follow-up-2026-06-29.md
supersededBy: docs/research/knowledge_store/knowledge.md
visibility: internal
---

# Superseded: DocLight Reindexing Research

이 문서는 더 이상 DocuLightViewer의 설계 근거로 사용하지 않는다.

이전 내용은 서버형 DocLight 프로젝트의 RAG/HNSW/관리자 API 구조를 전제로 했고, 현재 DocuLightViewer의 Electron main process, MCP 6개 도구, BM25 JSON 인덱스, 설정 다이얼로그 구조와 맞지 않았다.

현재 기준 문서는 [knowledge.md](knowledge.md)다.

특히 이전 문서에 있던 MCP 재인덱싱/인덱스 상태/장기 인덱싱 도구 제안은 폐기한다. DocuLightViewer에서는 전체 재인덱싱, 장기 인덱싱, 취소, 재시도, 모델 변경 재빌드를 MCP 도구로 노출하지 않고 설정 다이얼로그와 Electron IPC에서만 처리한다.
