# S19 legacy indexing job migration evidence

Requirement IDs: `REL-DOC-009`, `FR-DOC-019`, `DR-DOC-014`, `SEC-DOC-003`.
Start SHA: `a4c78f84b9c8de6c96e7e9a02e9f971f65e8d6b3`. Working checkout: isolated `DocuLightViewer-r3`.

## Public fixture provenance

The public starting artifact is `src/main/source-ledger-store.js` at
[`12d312cea07d530c7aa28ffb849575ea3d94b459`](https://github.com/ice3x2/DocuLightViewer/blob/12d312cea07d530c7aa28ffb849575ea3d94b459/src/main/source-ledger-store.js).
Its exact source bytes are 89,999 bytes; SHA-256 is
`2d2e2f1a637a59c8eecff7e5d896d9b95ffec4e2fccdf48ef9b367423667a3e6`.
That version uses SQLite `source_ledger_meta.schema_version=1` and `index_jobs`, with
`queued`, `indexing`, `completed`, `cancelled`, and `failed` states. It has no
separate file journal. `test/r3/fixtures/generate-public-ledger.cjs` loads
that immutable public source file and its public `redaction.js` dependency,
then calls the original `SourceLedgerStore.initialize()` to generate
`test/r3/fixtures/public-ledger-12d312c.sqlite`. Its SHA-256 is
`e6739aa66353f85a601e56cf62af9b42c629b11b2bc36b6c08950eef74ed3bf0`.
The S19 case copies this exact SQLite file, verifies its checksum and public
`index_jobs` CHECK/foreign keys plus nullable alias-origin columns, then
inserts recovery rows. `documents.desired_revision` is absent in the public
fixture and added by the current schema migration. The S19 case file SHA-256
is `630ff109168d42763dc0f0c4733a7a340c6be17a31be91e342e3d67c11f9f1ba`.

The fixture begins with six old job rows: one queued, one stale indexing, one
completed, one cancel requested, one changed-content, and one missing-source.
A seventh row has a null source ID. The alternate fixtures use a mismatched
source root, a fresh indexing heartbeat, and unknown schema version `999`.
The hash-only alias initially has no lexical or canonical origin path.

## RED and GREEN

RED before implementation: `node test/r3/run-node.cjs --case s19` exited 1 with
`ASSERTION_FAIL ... public baseline jobs have an owner migration entrypoint`.
Fixture setup completed; this was a semantic assertion failure.

GREEN after implementation: the same command passes 47 assertions on the
prepared Node snapshot `C:/Users/beom/AppData/Local/Temp/doculight-r3-node-20260924d`.
The verified queued and stale indexing rows become two new durable pending
jobs and desired revision 1. The old completed row remains completed and has
desired revision 0. The alias row, document ID, category, tags, and saved files
remain. The cancel-requested, changed-content, missing-source, and corrupt
rows retain desired revision 0 and durable blocked diagnostics. Root mismatch
and fresh heartbeat stay blocked with their original job statuses. An unknown
schema prevents owner `START` readiness and `acceptPublishedSave` acceptance.
Restarting the actual owner yields the same two new jobs and retained blocked
diagnostic count. A prior clean-r3 schema upgrade without an S19 marker is
detected from the unmigrated rows, including a corrupt-only row with no
document link. Competing same-document jobs select the latest verified public
job; equal-time same-content jobs remain blocked. A disabled source remains
blocked. A fresh blocked legacy indexing row survives the modern interrupted
job scan. When any fresh legacy indexing claim makes the document's order
uncertain, the owner blocks the whole document before creating a new pending
job; the older queued row, fresh indexing row, and saved file remain.
After that blocked decision, a later valid published save to the same document
receives a new desired job. Pending-page selection, claim, and revision
completion ignore only the legacy `indexing` row with a durable blocked
marker; that old row and its diagnostic remain unchanged. Modern live claims
still prevent a second concurrent claim.

The transition is a single SQLite transaction per owner startup scan. It
inserts a decision marker and new desired/job rows together, then marks only
successfully migrated old queued/indexing rows as cancelled history. The owner
does not announce `START` ready or accept writes until the migration call has
returned. It does not invent origin paths from a canonical hash or trigger a
full rebuild. A SQLite trigger that aborts decision-marker insertion proves
the pending job and old-row status roll back together; owner `START` and write
ACK remain closed. Removing the trigger and restarting commits one pending job
per eligible document. Unknown migration marker and schema versions fail
closed with original rows intact.

## Related checks

- `node test/test-search-engine-lifecycle.js`: PASS.
- `node test/test-startup-index-recovery-memory-contract.js`: PASS, four known
  2 MiB documents and one fallback, zero retained queue content bytes.
- `s09`: PASS 37 assertions; `s10`: PASS 47; `s11`: PASS 24; `s17`: PASS 32;
  `s18`: PASS 19.
- The clean `a4c78f8` baseline independently reproduced S10's invalid
  fixture source identity. S10 first failed a new exact identity assertion,
  then its fixture used the stable knowledge-store source ID and
  `opened_markdown` for the initial alias-backed publications. The original
  S10 assertions remain and pass; the product identity contract was unchanged.

No saga/grant module exists in this checkout; S19 removes none. No source
ledger, user Markdown, or alias row is deleted by the migration.
