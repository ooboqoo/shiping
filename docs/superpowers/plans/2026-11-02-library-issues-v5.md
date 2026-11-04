# 本地知识库 v5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task by task. User approved full design plus local reranker installation; continue implementation without another planning approval round.

**Goal:** Fix the seven recorded issues and ship grounded chat with local reranking and bounded query rewriting.
**Architecture:** Keep one Node backend and shared SQLite catalog; add bounded ingestion and a standalone local reranker. Desktop securely supplies its existing DeepSeek conversation profile; web persists conversations and streams evidence-grounded answers.
**Tech Stack:** Existing TypeScript/Node/Electron, SQLite/Chroma/Ollama, Tesseract; isolated Python PyTorch/Transformers for BGE reranker.
**Spec:** ../specs/2026-11-02-library-issues-v5-design.md

## Global Constraints
- Preserve current user records/human revisions/originals. Never reset live corpus to historical7 docs; latest baseline9 and growing.
- Local parsing/OCR, no GitHub upload. Only questions/necessary history/selected evidence reach the user-approved DeepSeek endpoint. Credentials never appear in logs/browser/Git.
- Upload30MB/PDF150pages/text2M chars; durable bounded jobs, cancellable and recoverable. Actual file5.5MB79pages must not stack-overflow.
- Retrieval vector40+sparse40→RRF20→local reranker→dedupe/neighbors→8 blocks/6000 chars. Preserve original-query recall; remove independent entity route. No silent reranker truncation.
- Existing isolated web-admin forks and packaging paths remain. Full verified backup before production schema6/desktop changes; keep rollback assets and local source copy.

## Review Focus
- Upload response lost/cancelled halfway: idempotent complete original or no record; user retries must not create duplicate jobs.
- OCR high-page-confidence/local noise: real raw lines retained; code, amounts, formulas/URLs protected; no fabricated cleaned facts.
- Evidence IDs vs actual8 blocks and async delete: citations and model see same current revisions, not rough20.
- Cloud timeout/restart/duplicate request: no stuck successful chat, no lost stop, no duplicate billing from unbounded retries; credentials redacted.
- Rerank/rewrites invalid or unavailable: deterministic original-query fallback, no wrong candidate ID mapping; no unsupported Mac CUDA assumptions.

## Task1 — bounded uploads
Files: shared/base64.ts, library-v4/inputs.ts; web/store.ts,v4-api.ts; upload-v5 tests.
Interfaces: decodeBase64Bounded(value,limit=30MiB):Buffer; readBinary(req,limit):Promise<Buffer>; upload(project,file,replace?,submissionId?) returns durable doc/job.
- [x] RED test6MB/30MB valid payload, invalid alphabet/padding/oversize, upload abort/no pending doc, submission retry returns same job, existing JSON compatibility.
- [x] Implement linear common validator and raw-body route before readJSON; preserve strict Host/session/Origin/CSRF. Add bounded content/file validation and receipt lifecycle.
- [x] Targeted tests GREEN, desktop+web regression, commit.

## Task2 — OCR/cleaning/progress
Files: shared/document-processing.ts; document-worker/import; document-processing/{quality,pdf-analysis}; library-v4/{catalog,service}; OCR/progress/quality tests.
Interfaces: OCRObservation {raw,text,confidence?,lines:[{text,confidence?,bbox?}]}; analyzeLocalDocument(...,onProgress?); Catalog.taskProgress(id,owner,progress).
- [x] RED tests local noise despite high aggregate confidence, protected code/numbers/URL, raw vs cleaned and source offsets, progress protocol/final JSON, inactivity timeout vs explicit cancellation.
- [x] Return actual line evidence, safe control/decorative cleanup with versioned audit; suspicious text gates. Use stderr whitelist progress, stdout final JSON; idle180s,total30min bound, serial workers. Persist stages/pages with lease.
- [x] Real OCR fixture and bounded real PDF observations, suite GREEN, commit.

## Task3 — deterministic retrieval/evidence
Files: library-v4/{retrieval,terms}, retrieval-v4 and retrieval-v5 tests.
Interfaces: Retriever.retrieve(project,raw,mode,signal?,options?:{queries?:string[]}):{hits,context,evidence,diagnostics}; evidence is final numbered source blocks.
- [x] RED symmetric RRF ties prefer sparse, stable route ties, no independent entity vote, final evidence equals budgeted blocks including neighbors, stale deletion filtered; original+rewrite in one route, no extra RRF votes.
- [x] Implement stable route sorting and tie break; final evidence assembler preserves existing string wrapper helper. Keep all compatibility entry points.
- [x] Fixed historical candidate replay plus new synthetic holdouts GREEN, commit.

## Task4 — real local reranker
Files: library-v4/reranker.ts; local-rag/{scripts/setup-reranker.py,reranker/server.py,tests/test_reranker.py,scripts/manage.py}; runtime/model assets ignored.
Protocol: POST local18200/rerank {query,documents}→{model,device,results:[{index,relevance_score}]}; max20 bounded inputs, model revision fixed. TS adapter validates full result permutation/finite scores and signal/timeout.
- [x] RED adapter invalid/duplicate/missing indices, timeout fallback diagnostics, long input no silent truncation; Python endpoint shape/limits/offline startup.
- [x] Isolate Python env; download pinned official safetensors/tokenizer to local models; lock dependencies/checksums. MPS first, low batch; add owned lifecycle/readiness/backup/uninstall ledger. No arbitrary global cache.
- [x] Real scoring Chinese sample, compare fixed corpus with/without reranker, measure warm/cold/P95/RSS; enable only after gate, commit source+locks (no weights).

## Task5 — provider config and bounded query planning
Files: library-v4/{ai-client,query-planner}; main/library-v4/model-sync.ts; query/AI tests; local HTTP config routes.
Interfaces: AIClient.status/configure(profile,source,version), rewrite(query,history,signal), answer(messages,evidence,signal):AsyncIterable<string>; planQuery returns original,queries,max3 terms,diagnostics.
- [x] RED secret redaction, explicit web override vs desktop sync, malformed/changed identifiers/timeout rewrite fallback, simple query no paid rewrite, unrelated history excluded.
- [x] Reuse compatible SDK/headers, provider on disk600; bounded deadlines/tokens, no implicit cross-provider fallback. On-demand JSON rewrite with original retained; advanced web config/status.
- [x] Fake local provider protocol/stream/error tests GREEN; real synthetic DeepSeek smoke after secure sync, commit.

## Task6 — chat catalog and streaming API
Files: library-v4/{catalog,chat}; library/repository; web/chat-api.ts/server; chat-v5 and api-chat tests.
Interfaces: sessions(project), create/get session; beginTurn(project,session,requestId,question), finish/interrupt; stream SSE meta/token/done/error using exact evidence[].
- [x] RED schema5→6 preserves docs, old higher version fails; per-session single active turn/idempotency, project isolation/trash/purge, restart incomplete→interrupted, stop aborts all stages, fresh sources and consistent citations.
- [x] Additive migration unified version; bounded successful history; persistent status and partial output; no model-generated fake references. On disconnect cancel; app/service close aborts in-flight work.
- [x] API auth/CSRF, fake provider + actual SQLite tests, commit.

## Task7 — web interaction
Files: web/public/{index,app-v4,style}, add chat/markdown pure scripts if needed; browser and meaningful pure UI tests.
- [x] Uniform link-button styles; web brand/title local knowledge, built-in display default library only. Preserve custom project names/internalIDs.
- [x] Sequential per-file upload queue with byte progress/cancel/retry/reuse and continue-after-error; tasks display actual stage/page progress.
- [x] Chat sessions/messages/bottom composer, Enter/ShiftEnter, stream/stop/retry; safe Markdown and exact sources/diagnostics, retrieval-only option; model/rewrite/rerank status & settings, no key disclosure.
- [x] Actual browser verifies normal-window chat and sources; dirty editor/duplicate-send protection tested. Narrow viewport control and native file chooser remain explicitly unverified because tools were unavailable; responsive CSS is included. Commit verified source.

## Task8 — desktop reuse and installation usability
Files: main/library-v4/model-sync.ts, knowledge/index integration; desktop client timeout; README/manage startup scripts.
- [x] RED profile sync after settings ready, respects explicit web config, only permitted fields, no secret on error; disabled/missing service doesn't break desktop.
- [x] Authenticated sync active DeepSeek conversation profile, no browser secret; startup retry bounded. Document independent web after sync and proxy support/error limits.
- [x] Packaged Electron/native OCR + client RPC verify, install/start/stop/uninstall/rollback docs, commit.

## Task9 — integration/review/deployment
- [x] Full suites/types/build, native OCR, raw actual79page file in isolated test project, cancel/quality report; keep course originals/manual edits.
- [x] Isolated fixed7-doc eval and heldout/noanswer/colloquial/multiturn; separate actual generated answer grading from keyword checks. Compare RRF/tie/rewrite/rerank, preserve failures and resources honestly.
- [x] One independent final branch review per executing-plans; fixes RED/GREEN then full regression. No extra implementer agents.
- [x] Stop only owned writers after checking unsaved UI; full backup/restore hash verification; schema6/service+app cutover. Test real synthetic DeepSeek chat, live UI and source integrity; restart all owned services.
- [x] Local commits and source copy to pcworkspace after user-edit comparison; operations/removal ledger complete; no GitHub writes.

## 交付记录

功能已在本机部署，独立审查及真实模型、完整PDF、备份恢复、源数据保留均完成。代理范围按实机需求补充为HTTP(S)，不支持SOCKS且不绕行。具体证据与已知验收边界见 `../../implementation/rag-v5-delivery.md` 和本机操作台账。GitHub同步按用户要求保持关闭。
