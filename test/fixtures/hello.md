# Hello World

This is a test document for DocLight E2E testing.

## Features

- Markdown rendering
- [Link to Guide](./guide.md)
- [External link](https://example.com)

## Code Block

```javascript
function hello() {
  console.log('Hello from DocLight!');
}
```

## Mermaid Diagram

```mermaid
graph LR
  A[Start] --> B[End]
```

## XSS Test

<script>alert('xss')</script>
<img onerror="alert(1)" src="x">

Normal text after XSS attempt.
