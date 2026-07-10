# Mermaid Media Viewer Manual Test

이 문서는 `FR-RENDER-028` 전용 Mermaid / 이미지 뷰어를 수동으로 확인하기 위한 샘플입니다.

```mermaid
flowchart TD
  A["매우 긴 한국어 Mermaid 노드 라벨과 mixed language text that must stay inside the node box"] --> B["두 번째 긴 노드 라벨 with extra descriptive text"]
  B --> C{"조건 분기 diamond node with long mixed-language label"}
  C -->|예| D(("원형 노드 내부에도 긴 텍스트가 보이는지 확인"))
  C -->|아니오| E["다운로드 SVG에도 확장된 박스가 반영되어야 합니다"]
  D --> F["확대 창에서 마우스 휠 확대/축소, 드래그 이동, 우클릭 다운로드를 확인"]
  E --> F
```

확인 항목:

- 문서 안 Mermaid 블록 좌측 상단에 확장 버튼이 보이는지 확인합니다.
- 확장 버튼을 누르면 전용 미디어 뷰어 창이 열리는지 확인합니다.
- 긴 텍스트가 노드 박스 밖으로 나가지 않는지 확인합니다.
- 마우스 휠 확대/축소, 왼쪽 버튼 드래그 이동, 우클릭 다운로드를 확인합니다.
