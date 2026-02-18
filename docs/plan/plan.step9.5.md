# Step 9.5: 이미지 렌더링 검증 구현 계획

작성일: 2025-10-28

## 🎯 목표

마크다운 이미지 구문의 다양한 경로 패턴이 정상적으로 렌더링되는지 검증합니다.

---

## 📐 구현 범위

### 테스트할 이미지 경로 패턴

1. **절대 경로**: `/images/test.png`
2. **상대 경로**: `../images/test.png` (현재는 지원 안 될 수 있음)
3. **외부 URL**: `https://via.placeholder.com/150`
4. **제목 속성**: `![Alt](path "Title")`
5. **존재하지 않는 이미지**: 404 처리 확인

---

## 🔨 구현 단계

### Step 1: 테스트 이미지 준비

**이미지 파일**:
- `test-source/images/test-absolute.png` - 절대 경로 테스트용
- `test-source/images/test-relative.png` - 상대 경로 테스트용

**이미지 소스**:
- 간단한 placeholder 이미지 사용
- 또는 기존 `/public/images/icon.png` 활용

---

### Step 2: 테스트 문서 작성

**파일**: `test-source/test-images.md`

```markdown
# 이미지 렌더링 테스트

이 문서는 다양한 이미지 경로 패턴의 렌더링을 테스트합니다.

## 1. 절대 경로

DocLight 내부 이미지:

![DocLight Icon](/images/icon.png)

테스트 이미지:

![Test Image Absolute](/images/test-absolute.png)

## 2. 외부 URL

외부 placeholder 이미지:

![Placeholder 150x150](https://via.placeholder.com/150)

![Placeholder 300x200](https://via.placeholder.com/300x200/3498db/ffffff?text=DocLight)

## 3. 제목 속성 포함

![Icon with title](/images/icon.png "DocLight Application Icon")

## 4. 존재하지 않는 이미지

이 이미지는 존재하지 않아야 합니다 (alt 텍스트 표시):

![Missing Image](nonexistent.png)

## 5. 다양한 크기

작은 이미지:
![Small](https://via.placeholder.com/50)

중간 이미지:
![Medium](https://via.placeholder.com/200)

큰 이미지:
![Large](https://via.placeholder.com/400)

## 테스트 체크리스트

- [ ] 절대 경로 이미지 표시
- [ ] 외부 URL 이미지 표시
- [ ] 제목 속성 hover 시 표시
- [ ] 존재하지 않는 이미지는 alt 텍스트 표시
- [ ] 다양한 크기 이미지 정상 렌더링
- [ ] 이미지 lazy loading 동작
```

---

### Step 3: 이미지 경로 처리 확인

**현재 상태 확인**:
- `marked.js`가 기본적으로 이미지를 처리
- `DOMPurify`가 `<img>` 태그를 허용하는지 확인

**필요한 개선**:
- 상대 경로 처리 (필요시)
- lazy loading 속성 추가
- alt 텍스트 필수화

---

### Step 4: 테스트 이미지 업로드

**방법 1**: API를 통한 업로드
```bash
curl -X POST "http://localhost:3000/api/upload?path=/images" \
  -H "X-API-Key: your-api-key" \
  -F "file=@test-image.png"
```

**방법 2**: 직접 파일 복사
```bash
cp test-image.png test-source/images/test-absolute.png
```

---

### Step 5: Playwright MCP 테스트

**테스트 케이스**:

1. **이미지 존재 확인**
   - 페이지 내 `<img>` 태그 개수 확인
   - 각 이미지의 visibility 확인

2. **src 속성 확인**
   - 절대 경로: `/images/icon.png`
   - 외부 URL: `https://via.placeholder.com/150`

3. **alt 속성 확인**
   - 모든 이미지에 alt 텍스트 존재

4. **로딩 확인**
   - 이미지 로드 완료 확인
   - 404 이미지는 broken image 아이콘

---

## ✅ 완료 조건

- [ ] 테스트 이미지 파일 준비
- [ ] `test-source/test-images.md` 작성
- [ ] 이미지 경로 처리 확인
- [ ] MCP 브라우저 테스트
- [ ] 모든 이미지 패턴 검증
- [ ] 문서화

---

## 🧪 테스트 매트릭스

| 이미지 타입 | 경로 | 예상 결과 |
|------------|------|----------|
| DocLight Icon | `/images/icon.png` | ✅ 표시 |
| 외부 Placeholder | `https://via.placeholder.com/150` | ✅ 표시 |
| 제목 속성 | `![](path "title")` | ✅ hover 시 제목 표시 |
| 존재하지 않음 | `nonexistent.png` | ⚠️ alt 텍스트 표시 |
| 다양한 크기 | 50px ~ 400px | ✅ 모두 표시 |

---

## 📊 예상 소요 시간

- 이미지 준비: 10분
- 테스트 문서 작성: 10분
- 이미지 처리 확인: 15분
- MCP 테스트: 15분
- 총계: 50분

---

## 🎯 구현 완료 요약

### 변경 파일

**1. public/js/app.js**
- `renderer.image()` 추가: lazy loading 속성 자동 추가
- DOMPurify 설정: 이미지 속성 허용 (loading, title, alt, src)

**2. test-source/test-images.md** (새 파일)
- 다양한 이미지 경로 패턴 테스트
- 절대 경로, 외부 URL, 제목 속성, 다양한 크기

**3. test-source/images/test-absolute.png** (새 파일)
- 테스트용 이미지 파일

---

## ✅ 테스트 결과 (모두 통과)

| 테스트 | 결과 | 비고 |
|--------|------|------|
| 절대 경로 (`/images/icon.png`) | ✅ PASS | 정상 표시 |
| 절대 경로 (`/images/test-absolute.png`) | ✅ PASS | 정상 표시 |
| 외부 URL (placeholder) | ✅ PASS | 경로 정상 (네트워크는 환경 의존) |
| title 속성 | ✅ PASS | hover 시 tooltip 표시 |
| alt 텍스트 | ✅ PASS | 모든 이미지에 설정됨 |
| loading="lazy" | ✅ PASS | 모든 이미지에 자동 추가됨 |
| 다양한 크기 | ✅ PASS | 50px ~ 600px 모두 렌더링 |
| 인라인 이미지 | ✅ PASS | 텍스트 중간에 표시 |
| 연속 이미지 | ✅ PASS | 4개 이미지 나란히 표시 |
| 존재하지 않는 이미지 | ✅ PASS | broken image + alt 텍스트 |

**총 이미지 감지**: 21개 (sidebar 아이콘 포함)

---

## 🔍 발견 사항

### 정상 동작
- ✅ marked.js의 기본 이미지 파싱이 잘 동작함
- ✅ 절대 경로 이미지 정상 제공
- ✅ 외부 URL 이미지 경로 정상 처리
- ✅ lazy loading 자동 적용으로 성능 최적화
- ✅ alt/title 속성 모두 정상 동작

### 개선 사항
- ✅ renderer.image() 추가로 lazy loading 통합
- ✅ DOMPurify 설정에 이미지 속성 추가

### 향후 개선 가능
- 상대 경로 지원 (현재는 절대 경로만)
- 이미지 최적화 (리사이징, 압축)
- 라이트박스/갤러리 뷰

---

**작성자**: Claude Code
**상태**: ✅ 구현 및 테스트 완료
**완료일**: 2025-10-28
