# Local Document Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** Local OCR and XLSX/PPTX import in both desktop and admin.
**Architecture:** Shared parsers; bounded child process for expensive parsing; local OCR assets prepared explicitly, never runtime CDN fetches. Native canvas renders PDF/image inputs; Office XML decoded with bounded ZIP handling.
**Tech Stack:** TypeScript, Node child process, Tesseract.js, @napi-rs/canvas, JSZip, fast-xml-parser.
**Spec:** ../specs/2026-11-01-local-document-import-design.md

## Global Constraints
30 MB files; retain existing text limits and collections; offline document processing; no macro execution. Support PNG/JPEG/WebP, PDF, XLSX, PPTX; legacy binary Office rejected. No overwriting private documents.

## Review Focus
ZIP inflation, huge images/PDF pages, OCR timeouts and worker cleanup, formula cache missing, PPT relationships and external images.

## Task 1: Shared bounded Office parsers
- [x] Tests: synthetic ZIPs for sheet/row coordinates, formula cached vs absent, slide ordering and notes, corrupt ZIP/oversized entries/external relationships.
- [x] See tests fail; implement knowledge-office.ts helpers for XLSX and PPTX using ZIP/XML; count entries and bytes before extraction. Return labeled text; no formulas or links executed.
- [x] Verify new tests and existing parser tests.

## Task 2: Offline OCR and PDF fallback
- [x] Tests: supported extensions, picture OCR, mixed PDF page fallback, no network, missing assets, pixel/page/timeout bounds and child exit cleanup.
- [x] Add local asset preparation script with versioned official download source and SHA256 manifest; tesseract worker resolves packaged local code/assets.
- [x] Use bounded child parsing to avoid main event-loop work; packaged helper path and resources configured for Electron and admin. Deadline kills child and owned OCR worker process; temporary inputs cleaned in finally.
- [x] Real fixtures: Chinese/English PNG, scanned/mixed PDF, PPTX embedded image; confirm unique tokens extracted offline.

## Task 3: Integration and delivery
- [x] Update shared formats, file pickers/validation, progress copy, timeout for bridge parsing; regression tests desktop/web.
- [x] Update README setup/limits/uninstall, build assets and package; test/typecheck/build.
- [x] Review all changes, retain existing data, record operations; synchronize publication and pcworkspace copies after checking changes.

## Execution evidence

79 desktop tests (including 3 real OCR cases), 14 web tests, node/web typechecks and production build passed. Packaged Electron OCR executed successfully. Compiled HTTP upload/OCR/chunk/retrieval exercised in a temporary store with isolated synthetic vectors. Independent review found UTF-8 chunk decoding issue, reproduced RED and fixed GREEN. Existing desktop index remains ready: 7 documents, 1837 chunks.
