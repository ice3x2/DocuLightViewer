# S31 통합 CI 게이트 증거

관련 이슈: #54. 요구사항: `OPS-ARCH-009`, `OPS-ARCH-010`, `OPS-ARCH-012`, `OPS-ARCH-013`, `IR-APP-013`.

- 작성 커밋: `11f6ae7644ca30d752a77efa978a44c9583f1c71`; 작성 worktree sourceHash: `a09c3d1a330b3caf1e062e4606951641d9a6de4a86f5cc1d5651aabf4a3bfdac`. [작성 증거](./2026-09-29-s31-release-gate-evidence.json)의 `finalSourceHash`와 파일 바이트 SHA-256은 이 작성 worktree에만 해당한다.
- 통합 커밋: `9c14963d11afb7ea3d83562008ead9d33bafbcba`; 통합 checkout sourceHash: `c0150280172060a8ce47a37042503073cac9c4db9757ccb77c5df228fb7e2345`. 작성 브랜치와 통합 브랜치의 Git blob은 동일하다. 예를 들어 `.github/workflows/release.yml`은 `54e17dce5032c54dca207276b333bd25eb3a0722`, `scripts/release-evidence.js`는 `81c44bfdb2329740f4df2c4b664c0bafa84a3c5f`다. Windows checkout의 CRLF 때문에 작업 파일 바이트 해시를 작성 증거와 동일하다고 주장하지 않는다.
- 통합 커밋에서 `node test/<파일명>.js`로 `test-release-workflow-contract.js`, `test-release-evidence-contract.js`, `test-wave2-package-contract.js`, `test-sqlite-native-packaging-contract.js`, `test-dev-profile-runtime-isolation-contract.js`, `test-startup-ledger-responsiveness-contract.js`, `test-package-smoke-launch-options.js`를 각각 실행해 exit 0과 `all assertions passed` 표식을 확인했다. 독립 검토는 같은 Git blob의 패키지-실행 파일 해시, macOS ZIP 내부 실행 파일, ABI/native/응답성 원시 표본, 세 필수 작업 결과와 게시 전 순서를 확인했다.
- 이 커밋에서 GitHub Actions 릴리스 workflow를 실행하지 않았다. Windows portable, macOS arm64 `.app`, Linux x64 AppImage의 실제 CI 산출물과 서명·게시 결과는 별도 릴리스 게이트에 남는다.
