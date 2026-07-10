# Mermaid And Image Viewer Sample

이 문서는 DocuLight의 Mermaid 뷰어와 이미지 뷰어를 빠르게 확인하기 위한 샘플입니다.

## Mermaid

```mermaid
flowchart TD
  A["긴 한국어 Mermaid 노드 라벨입니다. 이 문장은 노드 박스 안에서 줄바꿈과 크기 조정이 잘 되는지 확인하기 위한 텍스트입니다."] --> B["Mixed language node label with Korean 설명 and English words"]
  B --> C{"조건 분기: 전용 확대창에서 텍스트와 도형이 깨지지 않는가?"}
  C -- "예" --> D["확대 / 축소 / 창에 맞추기 / 드래그 이동 확인"]
  C -- "아니오" --> E["레이아웃 또는 텍스트 박스 크기 문제 확인"]
  D --> F(("다운로드 메뉴 확인"))
  E --> F
```

## Local Image

![DocuLight sample media image](./assets/sample-media-image.svg)

## Code Block

```javascript
const message = 'copy button hover sample';
console.log(message);
```
