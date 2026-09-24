# S25 regression harness evidence

- Issue: [#48](https://github.com/ice3x2/DocuLightViewer/issues/48); start commit `aae49ca39feba3868170c2c0eaea516c64e97d11`.
- Requirements: `FR-DOC-019` (in_progress/stable), `REL-DOC-009` (planned/evolving), `DR-DOC-014` (in_progress/evolving), `IR-APP-013` (planned/evolving).
- Run sourceHash: `b1e9dfd7f8d6df3653197494c799046f6d7bdc73addf859c593a22f24675b029`. Windows x64, Node `v24.16.0`, Node ABI `137`. The prepared Node runtime is `%TEMP%/doculight-r3-node-20260924d`; its dependency lockfile matched the worktree. Only the package script changed since its original snapshot, so its source snapshot and manifest were refreshed without replacing native modules.
- Fixture seed: `s25-2026-09-25-v1`; final GREEN temporary fixture `%TEMP%/doculight-r3-fpAMjD`, removed by harness cleanup. Separate `source/`, `store/`, `private/`, `ledger.sqlite`, and `keyword.sqlite` were used. No personal document or userData was read.

## Failure detection

The isolated prepared Node snapshot was temporarily changed in `src/main/source-ledger-store.js`: `const desiredRevision = (existing?.desired_revision || 0) + 1;` became `... + 0;`. Its full source snapshot hash was `5b5adb0942c38ffe3ea3e9cb7ce5fa624413e4941a76b72f0e905b8c5893c525`; the mutated product file SHA-256 was `755c6f4087efcb83e9ba20ee3f241b52f8305541ad5211843a6124bf64271fe9`. `node test/r3/run-node.cjs --case s25` exited **1** after `S25_PRE_ACK_REACHED` and `S25_PRE_COMMIT_FAILURE_REACHED`:

```text
ASSERTION_FAIL case=s25 assertions=3 S25_PRE_COMMIT_REPLAY: retry assigns one stable document ID and revision
```

The product file was then restored exactly from the worktree; its SHA-256 was `3c00d78945e612648b8289035b841f74a0ae294e87191063706348d1b64b8fc9`, and the restored full snapshot hash matched the worktree at `b1e9dfd7f8d6df3653197494c799046f6d7bdc73addf859c593a22f24675b029`. The same command exited **0**, emitted `PASS case=s25 assertions=16`, and reached all ten case markers including `S25_ALL_ASSERTIONS_REACHED`. No product file in the worktree was changed for the mutation.

`node test/r3/run-node.cjs --case unknown` and `node test/r3/run-node.cjs` each exited **2** with `SETUP_ERROR` and usage. No runner dispatcher or unknown-case behavior was changed.

## Redacted runtime facts

| Published fixture | Byte count | SHA-256 | Durable state |
| --- | ---: | --- | --- |
| First `latest.md` | 21 | `9ca278d7327b05f4b6c2c184b359dc8763645f55628e37f46872694df4995b98` | old job `cancelled` |
| Latest `latest.md` | 20 | `476c9a22914441990b27fe6888d40d009bf62cb49abcf985b1b662457913f389` | desired revision 2; failed attempt `failed`; retry `queued`, then `completed` |
| Completed `imported.md` | 40 | `62131a3324069d21f7edd1397632cdac0a1b004651f11a573f607563281d1932` | cancelled attempt; final file and retry retained |
| Content-only `generated.md` | 15 | `81e79779d697fcf818cb564b445e2b87dee26e542b1a6336fc977e52c58c9e57` | zero original aliases |
| Source-backed copy | 9 | `42c5d06e3b2974deb9a4f68ff1d66910005da76a19c014f60a7b77182f5d2dd0` | two lexical aliases, same final GREEN canonical hash `d45696658c0331ce0fbf53acdc5b2f8e9bc69d09e585d97a671e8431431171c3` |

The actual document IDs in the final GREEN run were `doc_d3f04bc930257ef4602805f9` (latest), `doc_21fb7b06072e19bf3e4b0de8` (linked import), `doc_990cbdb6ec9287b20036c1c8` (content-only), and `doc_d8222ba9fda6a0c92bff9b3e` (source-backed). A fresh SQLite connection found the source-backed ID unchanged with two lexical aliases and one canonical target hash `d45696658c0331ce0fbf53acdc5b2f8e9bc69d09e585d97a671e8431431171c3`. Search returned one latest-term hit and zero old-term hits after retry. A live worker returned status `indexing` and accepted targeted cancellation in 3 ms while work units were active.

Before durable ACK, `publishSave` returned saved bytes with `enqueue_failed` and no `jobId`. A running owner then hit a real SQLite `index_jobs` insert trigger fault; it returned saved/`enqueue_failed` without a job, while the final file and private intent remained and the job table was empty. After dropping the trigger, owner replay produced one stable document ID, revision 1, and job ID. The completed import was created by `createLinkedImporter.importMarkdownGraph`; its job had `requested_by=local.linked_import`. Failed and cancelled indexing left the published saved and import files intact; latest retry completed at revision 2.

## Focused regression results

- `node test/test-indexed-origin-open-contract.js`: exit 0, all assertions passed.
- `node test/r3/run-node.cjs --case s07`: exit 0, 15 assertions.
- `--case s08`: exit 0, 53 assertions.
- `--case s10`: exit 0, 47 assertions.
- `--case s12`: exit 0, 28 assertions.
- `--case s16`: exit 0, 24 assertions.
- `--case s09`: exit 0, 37 assertions after the ACK-fault correction.
- `--case s17`: exit 0, 32 assertions after the linked-import correction.

No aggregate suite was run. The deliberate product mutation was fully restored in the prepared snapshot; no product behavior was changed in the worktree.
