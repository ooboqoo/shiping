# Shiping RAG v2 Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. User approved Spec v2 and instructed implementation; proceed inline without an additional planning approval loop.

**Goal:** Automatic local Markdown ingestion, real incremental/full indexing, unified backend, knowledge-base lifecycle and measurable hybrid retrieval.
**Architecture:** Extend the existing SQLite library with draft/active snapshots and persistent owned jobs. Backend is the only ingestion/index writer; Electron and web use the same local API. Immutable vector records and candidate manifests preserve old active revisions on failure.
**Tech Stack:** Existing Node/Electron/TypeScript, node:sqlite, local OCR, Ollama BGE-M3, Chroma; no reranker model installation.
**Spec:** ../specs/2026-11-01-rag-refactor-v2-design.md

## Global Constraints
- Local only; preserve originals, IDs, trash, modes and human edits. No destructive cleanup of real data.
- Canonical UTF-8/LF Markdown, versioned source mapping; 600/1200/100 character chunk defaults; 30MB/150 page existing limits.
- Vector top40 + sparse top40, RRF k=60/top20; final max8 fragments within6000 characters, complete structural units.
- Model failures never publish partial candidates; deletion/disable filters take effect immediately.
- Work in existing isolated developer fork branch web-admin; official app untouched. Deploy only after backup and restore verification.

## Review Focus
- Draft edits during index build, project deletion, expired lease worker late completion: reject stale publish.
- Identical fragments at different offsets, heading changes and duplicate originals: stable reuse without wrong citations.
- Sparse candidates/history vs mode filters: filter before limit, rank active corpus only.
- Disk/Chroma failure, restart and model change: recover without replacing active source or corrupting shared consumers.
- HTML/Markdown imports and purge ownership: no script/network execution or cross-project deletion.

## Task 1: Canonical Markdown and structure chunks
**Files:** Create src/main/library-v4/markdown.ts, tests/markdown-v4.test.cjs; reuse rag/structure.ts.
**Interfaces:** canonicalMarkdown(text:string):string; reportMarkdown(report:ProcessingResult,ext:string):ProcessingResult; markdownChunks(docId:string,text:string):Chunk[] (logical id, immutable vectorKey, embedding text, source spans).
- [x] RED: CRLF/control chars normalize while preserving code/URL/numbers; PDF page headings removed without inventing chapters; long code stays fenced, split table repeats headers; changed paragraph reuses unchanged vector keys.
- [x] Run node --test tests/markdown-v4.test.cjs, expect failures before implementation.
- [x] Implement deterministic canonicalization and safe structural splitting; reject indivisible over-limit URL/row with visible reason.
- [x] Verify targeted tests and desktop suite; commit task.

## Task 2: Catalog snapshots and knowledge-base lifecycle
**Files:** Create library-v4/catalog.ts and tests/catalog-v4.test.cjs; modify library/repository.ts additive schema support.
**Interfaces:** Catalog extends Library; projectInfo(id,includeTrash?), setProjectState(id,version,deleted), clearProject/restoreClear, activeDocuments(project,mode?), publish(project,generation,projectVersion), persistent tasks/claim/heartbeat/finish.
- [x] RED: edit draft leaves active text, delete/disable immediate, stale publish fails, restore excludes previously trashed docs, built-in clear reversible, competing owners only one claim, expired owner cannot finish/publish.
- [x] Implement additive schema with project versions, job leases, vector cache/ownership, normalized sparse postings and generation state. No downgrade on old Library open.
- [x] Run tests and Electron in-memory capability check; commit.

## Task 3: Incremental/full index engine
**Files:** Create library-v4/indexing.ts, tests/indexing-v4.test.cjs.
**Interfaces:** IndexEngine.build(project,kind:'incremental'|'full',signal?):Promise<IndexStats>; IO fingerprint/embed/request; Catalog owns publication.
- [x] RED: no-op invokes0 embeddings/upserts; local edit only changes new fragment inputs; metadata0 embeddings; full new collection/all embeddings; wrong ids/hash/dimension and concurrent changes do not activate.
- [x] Incremental immutable vector entries reuse same compatible collection/cache; full new collection. Build sparse postings with same candidate snapshot; publish both through one SQLite pointer. Persist collection ownership and tasks.
- [x] Model/config mismatch transitions to controlled full rebuild, reporting reason. Failed append remains unreferenced and never served.
- [x] Verify with deterministic IO and isolated real Chroma/Ollama; commit.

## Task 4: Hybrid retrieval and complete context
**Files:** Create library-v4/retrieval.ts, tests/retrieval-v4.test.cjs; modify rag/query.ts and chunks.ts integration.
**Interfaces:** retrieve(project,query,mode,signal):Promise<{hits,diagnostics}>; context(hits,budget=6000):string.
- [x] RED: Chinese entity/URL/code recall; valid BM25 corpus stats; active/mode filter before top40; RRF preserves route ranks; overlap dedupe, adjacent header support; no broken code/table; no-answer differs service failure; deletion during awaited search invalidates result.
- [x] Choose SQLite FTS5 if correct per-project/mode corpus statistics feasible, otherwise normalized SQLite postings + exact BM25 over active eligible corpus (spec permits local inverted alternative). No scan-and-substring candidate scoring as primary sparse retrieval.
- [x] Use current-focused query/conditional pronouns; cache fingerprint by model digest, safe invalidation; reranker disabled with replaceable interface.
- [x] Verify tests and held-out synthetic retrieval set; commit.

## Task 5: Automatic jobs and unified API
**Files:** Create library-v4/service.ts; modify local-rag/web/{server,store,vectors}.ts; tests/service-v4 and web/api-v4.
**Interfaces:** LibraryService methods project/document CRUD, upload, status, scheduleIndex(kind), search, exportMarkdown, projectTrash/restore/purgePreview/purge. Persist queue before replying202.
- [x] RED: upload->canonical MD->auto index without confirmation; quality problem blocked; draft retained on vector failure; manual edit goes directly to normalize/index; queue coalesces changes; restart/expired owner; same hash dedupe.
- [x] Adapt all activated projects including shiping directly to unified API (no web->Electron CRUD); keep legacy paths only in migration tooling/legacy unactivated mode.
- [x] Preserve Host/Origin/session/CSRF; add local process authentication endpoint for Electron with restricted discovery file; close server cancels owned work.
- [x] API full/incremental explicit, downloads MD/batch assets, lifecycle with ownership purge and delayed retry; backup restores canonical revisions.
- [x] Verify all API tests plus isolated real upload->answer-context; commit.

## Task 6: Desktop thin client
**Files:** Create library-v4/desktop-client.ts; modify knowledge.ts, rag/service.ts, admin bridge, IPC/renderer where async needed; tests/desktop-client-v4.
- [x] RED: desktop create/edit/upload enqueue backend once; get context uses active MD; service down clear error with no fallback writes; local mode/full mode retain behavior.
- [x] Remove production direct SQLite editing and duplicate indexing from activated v4 path. Retain legacy only for migration compatibility until controlled cutover.
- [x] Verify existing desktop and bridge regression + actual packaged runtime; commit.

## Task 7: Simplify management UI
**Files:** local-rag/web/public/{app.js,style.css}; renderer KnowledgeSection; web integration tests.
- [x] Implement four navigation areas: materials, retrieval, tasks/index, maintenance. Remove normal cleaning/apply buttons; details only for exceptions and optional audit.
- [x] Show processing/active vs draft state, auto refresh with dirty-editor protection, full/incremental commands and stats, project delete/restore/clear, explicit purge preview.
- [x] MD text editing + download; render only safe text/filtered content, no external asset loads. Retrieval diagnostics route ranks, context, sources, stage timing and degradation.
- [x] Verify API/UI contracts and actual browser flow, no changes to private course content; commit.

## Task 8: Controlled migration and recovery
**Files:** library-v4/migration.ts, library-maintenance.ts CLI, tests/migration-v4; manage.py/docs.
- [x] RED: preserve doc IDs/trash/tags/modes; existing body canonicalizes without OCR; missing original retained; index failure leaves legacy read snapshot; schema newer fails closed; restore roundtrip equals snapshot.
- [x] Add explicit maintenance prepare/verify/migrate with stopped writers and full backup manifest. Candidate build per project; no permanent delete old collections.
- [x] Cutover marker after verified readiness; stable dataRoot configuration, remove redundant v2/v3 production writers only after successful cutover.
- [x] Run full suites, types, builds, real Electron/OCR, backup restore and concurrent-process lease test.

## Task 9: Evaluation, review and deployment
**Files:** local-only work evaluation artifacts; README and operation ledgers; publication snapshot.
- [x] Compare old20 questions plus held-out cases; record evidence Recall/MRR/no-answer errors/latency with fixed corpus, distinguish answer scoring from retrieval. No new paid model requests unless existing authorized evaluation requires; local retrieval sufficient for automated gate, answer evidence manually review.
- [ ] Fresh final whole-branch read-only review (attempt failed due account quota; author self-review and full regression completed, disclosed in delivery record); fix important findings with RED/GREEN regressions; full suites green.
- [x] Stop owned writers, complete backup/restore; package app, migrate and start; verify original7 course documents remain accessible and synthetic automatic flow completes. Do not silently re-OCR courses.
- [x] Update install/backup/uninstall docs; synchronize GitHub via plugin and pcworkspace after checking user edits and excluding private data.

Final evidence and limitations: ../../implementation/rag-v4-delivery.md. Independent reviewer quota is the only uncompleted review item; no claim of independent approval.
