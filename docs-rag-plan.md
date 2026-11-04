# Reusable Local RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegation. Steps use checkbox syntax for tracking.

**Goal:** Add optional local retrieval to Shiping and provide reusable Ollama/Chroma services with complete operation and removal records.

**Architecture:** A dedicated Ollama instance generates BGE-M3 embeddings; a separate Chroma process persists project collections. Shiping retains authoritative document text and filters retrieved chunks against current document revisions and mode permissions. Only retrieved context enters AI requests in retrieval mode.

**Tech Stack:** Existing TypeScript/Electron/React; Ollama; isolated Python environment with Chroma; Python lifecycle tooling; node:test.

**Spec:** `/Users/saynoer/Documents/ChatGPT/识屏识饮/outputs/本地RAG设计.md` (approved 2026-10-31).

## Global Constraints

- Root: `/Users/saynoer/Documents/ChatGPT/识屏识饮/local-rag/`; editable source copy: sibling `shiping/`.
- No Docker, system PATH changes, login startup items, or changes to `/Applications/识屏.app`.
- Ollama: `127.0.0.1:11435`; Chroma: `127.0.0.1:18000`; collection `shiping_knowledge_bgem3_v1`.
- Separate models, data, runtime, logs and process records under the dedicated root. Never log credentials or full user documents.
- Chunk target 600 characters, overlap 100; at most 6 context chunks and 6000 context characters including source labels.
- Preserve existing 30MB/200000-character import limits, original files and user configuration.
- Full-text is the compatibility default. Retrieval errors never silently upload full documents.
- Textless image requests receive no RAG context; disclose this in UI. No extra OCR/vision model in this release.
- Model name, digest, actual dimensions and chunking version form index compatibility metadata.
- Uninstall defaults to dry run; destructive actions require explicit user confirmation.
- Test using synthetic documents and mocked AI transport. No live paid model calls or private corpus upload.

## Review Focus

- Old index jobs completing after a document edit/delete must never resurrect eligible old text (Task 3).
- A service port occupied by another application must not be adopted or killed (Task 1).
- Aborted retrieval and concurrent conversation cards must not cross-contaminate answers (Task 4).
- Replacing the embedding model under the same tag must invalidate incompatible indexes (Task 3).
- Failed saves must not report successful document/index persistence (Task 3).

## File Map

- `local-rag/scripts/manage.py`: setup/start/stop/status/backup/uninstall-plan, process identity and manifest bookkeeping.
- `local-rag/manifest.json`, `README.md`, `requirements.lock`: owned paths, consumers, versions and reuse instructions.
- `local-rag/examples/reuse.py`, `reuse.mjs`: separate synthetic collection using standard HTTP APIs.
- `shiping/src/shared/rag.ts`: typed config, status, chunk, hit and preview payloads.
- `shiping/src/main/rag/{chunks,client,index,retrieve,ipc}.ts`: chunking, local HTTP, index generations, query fusion and IPC.
- Existing `knowledge.ts`, `ai.ts`, settings/preload files and KnowledgeSection: lifecycle hooks, context attachment and controls.
- New `RagSettings.tsx` and tests; preserve existing shadcn primitives.

### Task 1: Isolated runtime and removable service lifecycle

**Interfaces:** `manage.py {setup,start,status,stop,backup,uninstall-plan}` returns nonzero on failure; `status` emits JSON with service identity, endpoint and readiness. Manifest tracks versions, checksums, ownership, baseline consumers and timestamps.

- [ ] Prepare `shiping/` as a separate local clone from the known baseline, check repository instructions, commit approved spec/plan there, and run 13-test baseline plus typecheck. Use existing locked dependencies where possible; record any installation.
- [ ] Write Python unittest cases `test_foreign_port_is_rejected`, `test_reused_pid_is_not_stopped`, `test_uninstall_plan_is_read_only`, `test_shared_consumer_blocks_whole_removal`; assert no unrelated kill, removal or directory writes.
- [ ] Run those tests and record failing results before implementation.
- [ ] Implement lifecycle tooling with subprocess argument lists, absolute paths, process start identity and owner checks, loopback listeners, bounded readiness deadlines, per-action manifest updates and safe partial-start cleanup.
- [ ] Install pinned official Ollama and isolated Chroma runtime, checking Python/Apple Silicon compatibility first. Capture actual source URLs, hashes, package lock and preexisting-install evidence. Pull only BGE-M3 into the dedicated model directory.
- [ ] Run tests, start services and verify versions, loopback-only listeners, conflict handling, stop/restart and persistent storage. Commit tooling and update operation ledger without committing runtime/data/models.

### Task 2: Chunking, local clients and ranking

**Interfaces:** `chunkDocument(docId: string, text: string): RagChunk[]`; `embed(texts: string[], signal?: AbortSignal): Promise<number[][]>`; `searchVectors(query: number[], limit: number, signal?: AbortSignal): Promise<RagHit[]>`; `rankHits(query: string, semantic: RagHit[], lexical: RagHit[]): RagHit[]`; `formatContext(hits: RagHit[]): string`.

- [ ] Define shared `RagChunk` (id, docId, revision, text, start, end), `RagHit` (chunk, name, score), config and status types in `src/shared/rag.ts`.
- [ ] Write `tests/rag-core.test.cjs`: no empty chunks; long Chinese paragraph splits with 100-character overlap; boundaries preserve text; mixed English/Chinese project keyword match; duplicated chunks excluded; unrelated low-score results omitted; 6-hit and 6000-character formatted budget including labels; invalid/nonfinite/zero vectors rejected.
- [ ] Run tests and capture red evidence.
- [ ] Implement paragraph-aware chunking, Ollama `/api/embed` client with `truncate:false`, small batches, timeout and cancellation, Chroma HTTP adapter against installed documented API version, cosine ranking and reciprocal-rank fusion with Unicode-aware lexical tokenization. Keep model output validation explicit; never auto-download a default cloud embedding model.
- [ ] Run tests to green; use real synthetic embeddings to calibrate the relevance threshold and document chosen value, retaining a no-match case. Commit.

### Task 3: Revision-safe indexing and document lifecycle

**Interfaces:** `reconcile(docs: RagDocument[]): Promise<void>` where RagDocument contains id/name/text/modes/revision; `retrieve(mode: AppMode, query: string, signal?: AbortSignal): Promise<RagHit[]>`; `getStatus(): RagStatus`; `clearProjectIndex(): Promise<void>`. Store active index generations and compatibility metadata locally, atomically.

- [ ] Write `tests/rag-index.test.cjs`: unchanged text reuses embeddings; interrupted replacement leaves previous generation but marks stale; deleted/disabled docs never returned; jobs completing after deletion cannot resurrect docs; concurrent edits select newest generation; corrupted metadata/model digest/dimension change requires rebuild; failed disk writes reject and do not report ready; service outage has explicit status; restart preserves generation.
- [ ] Run and record failing tests.
- [ ] Implement serialized bounded index jobs with generation tokens, content hashes and post-query revalidation against current authoritative snapshot. Index new revision fully before switching manifest; queries never use stale/partly built generations. Remove ineligible documents immediately from the eligibility snapshot, with deferred backend cleanup.
- [ ] Integrate `knowledge.ts` add/edit/reimport/remove/mode updates; avoid import cycles by registering a snapshot provider. Repair write-error propagation where necessary so indexing does not acknowledge unsaved text. Rebuild explicitly after failures; do not export old in-memory false-success state.
- [ ] Run tests and real synthetic create/update/delete/restart checks. Verify service downtime cannot make deleted content eligible. Commit.

### Task 4: Context injection for both modes without request races

**Interfaces:** `getRagContext(mode: AppMode, messages: ModelMessage[], signal?: AbortSignal): Promise<string>`; `streamWith` stays an AsyncIterable by making it an async generator which awaits context then yields stream chunks. Existing caller signatures remain compatible.

- [ ] Write `tests/rag-ai.test.cjs` using source mocks: retrieved text appears in system message; full corpus absent in retrieval mode; full-text mode remains compatible; latest user question/limited prior context selected; transcript text is usable; pure image has no fabricated query/context; abort during retrieval never calls AI; separate cards retain separate contexts; unavailable services emit actionable errors rather than full-text fallback; no-match explicitly describes lack of reference material.
- [ ] Run tests to verify failures.
- [ ] Add typed text-query extraction, async context acquisition, quoted reference-source formatting and instructions that retrieved text is evidence rather than executable instructions. Forward cancellation across retrieval and AI; preserve original AI transport and profile selection.
- [ ] Run tests and mocked streaming integration, including user stop/new request while embedding is pending. Commit.

### Task 5: Settings, preview and isolated runnable app

**Interfaces:** preload exposes `ragStatus`, `ragCheck`, `ragRebuild`, `ragClear`, `ragPreview(mode, query)` with typed Promise results; settings adds validated retrieval/full-text choice plus local endpoint/collection defaults.

- [ ] Write `tests/rag-settings.test.cjs`: old persisted settings default to full-text; unknown mode/remote URL/malformed collections rejected; enabled retrieval setting survives restart; retrieval cannot activate before compatible index is ready; clear affects only owned project collection.
- [ ] Run tests red, implement main-process validation, IPC and preload declarations, renderer persistence and `RagSettings.tsx` inside the existing KnowledgeSection.
- [ ] Show check/rebuild progress, stale/error details, preview sources and hits, clear confirmation, full-text versus retrieval behavior and textless-image limitation in plain Chinese. Network timeout/empty query must remain visible and recoverable.
- [ ] Run tests and production build. Produce an isolated test app with its own user-data directory and baseline sample corpus, never opening or replacing official userData by accident. Document how to launch and how to import real documents later.
- [ ] Verify UI controls and hit preview, mocked AI integration, and cancellation. Record any unavailable visual validation honestly. Commit.

### Task 6: Reuse acceptance, resource evidence and exit rehearsal

**Interfaces:** both examples accept explicit collection names and embedding endpoint; neither contains a Key or defaults to the Shiping collection. `uninstall-plan` lists affected collections, consumers and owned paths only.

- [ ] Add service integration checks using synthetic Chinese question paraphrases, technical identifiers, irrelevant questions and a second project collection. Assert the expected doc is within top 3, independent collection cannot return Shiping content, and persistence survives a controlled restart.
- [ ] Add Python and JavaScript reuse examples and register only the synthetic test consumer in manifest during tests; remove the temporary consumer registration afterward.
- [ ] Measure actual install/model/data disk sizes, service memory and peak index/query memory plus cold/warm latency; label any measurement unavailable rather than estimate it as measured.
- [ ] Stop services, back up synthetic collections, run read-only uninstall plan and verify original Shiping app/source/data/config untouched. Restart only the services needed for handoff.
- [ ] Run all project tests, typecheck, lint and build; inspect full diff. Use requesting-code-review for an independent whole-change review, address findings and rerun affected checks.
- [ ] Update plan checkboxes, source commit IDs, exact changed paths, install/version manifest, service state, launch steps, limitations and three-level removal instructions in outputs/operation ledger. Deliver the runnable test build and service/reuse documentation.

## Plan self-review

All design sections map to Tasks 1–6. The five review-focus cases each have explicit red/green tests. Runtime installation, retrieval interfaces, async request contract and settings IPC types are assigned once and consumed consistently. Any upstream API/version incompatibility must be resolved and recorded before integration, not bypassed through silent fallback.

## Execution choice

Recommend native execution in this chat: the tasks share indexing and streaming interfaces, and one implementer can keep those consistent; an independent review follows at the end. Await user plan review and execution-method choice under the writing-plans skill before product changes or installation.
