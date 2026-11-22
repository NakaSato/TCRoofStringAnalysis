# Plan: Knowledge Base library (manuals, PDF editing, engineering document authoring)

Status: **Phase 1 built** (library, upload, page-level search with OCR, viewer, deep links, plant Documents tab, fault-code links) · Spec written 2026-11-22 · Owner: Chanthawat

Related:
- `docs/plans/knowledge-base.md`: the Markdown articles (now the library's **Articles** tab).
- `pwa-inverter-plot-style-spec.md`: colours, status colours and charts used inside documents.
- `pwa-inverter-om-analysis-spec.md` §7.5: the fault-code map that links into manuals.
- `string-iv-realtime-spec.md`, `pv-string-realtime-engineering-analysis-spec.md`: field verification steps that become SOPs.

---

## 0. Phase 1 as built (2026-11-22)

### What it does
- **Library** `/kb`, tab **Documents** (default; the Markdown articles moved to tab **Articles**):
  - "Pinned for you" (the user's pins);
  - "For your plants" (engineers only: released documents linked to their plants or to their plants' inverter models);
  - every document as a list or a grid, with filters: type, status, equipment, plant, fault code, language, owner, tag.
- **Upload PDF** (admins and engineers):
  - the file is stored **unchanged**, one object per revision, with its SHA-256;
  - each page's text layer is read at upload (pypdfium2);
  - pages with fewer than 10 visible characters wait for OCR.
- **Numbering** `{TYPE}-{DISCIPLINE}-{SEQ:3}`, the next free number (e.g. MAN-INV-001); admins may type their own.
  - Types: MAN, DS, SOP, WI, MS, CHK, RPT, DWG, CERT, TN, DOC.
  - Disciplines: OM, ENG, INV, MOD, ELE, INS, SAF, GEN.
- **Statuses**: draft → released (admin) → superseded (banner "Replaced by …", still readable) or withdrawn (reason; hidden from engineers). Shown with an icon and a label, never colour alone.
- **Revisions**:
  - a new file = a new revision; older ones stay readable at `/kb/doc/:id/view?rev=n`, with a banner;
  - a released document needs a change note.
- **Search** `/kb/search?q=` (also the library header's search box):
  - fault-code links first ("growatt 203" → MAN-INV-001 p.37);
  - then documents: every word must be in the metadata (number, titles, tags, file name, source version) or on one page together with the words the metadata lacks;
  - up to three pages per document, each with a snippet, opening the viewer at that page with the words highlighted;
  - then the articles.
- **Viewer** `/kb/doc/:id/view?page=n` (pdf.js):
  - pages are rendered near the screen and freed after;
  - text layer (selection, find, screen readers);
  - thumbnail rail, outline from the PDF's bookmarks, the document's links, find in document;
  - zoom / fit width, keys ← → + − 0 and Ctrl/⌘ + F;
  - download; the page stays white in the dark theme.
- **Links**:
  - `fault_code` ("Error:203", Growatt `fault_type` + `alarm_code`), `equipment` (inverter model), `plant`;
  - each link has an optional page;
  - the picker offers the fault codes the alarm log has seen and the inverter models in the registry.
- **In context**:
  - Active Alarm rows and the plant's Growatt Fault Log show "📖 Manual p.37 · SOP-OM-007" for released documents linked to the code;
  - the inverter card's Model row shows the manuals for its model.
- **Plant Documents tab** `/plant/:id/documents`:
  - the plant's Google Drive links (as-built, site photos);
  - documents linked to the plant;
  - manuals per installed inverter model;
  - general procedures (SOP / WI / MS / checklist);
  - "Upload for this plant".
- **Scope**:
  - `general` documents are visible to everyone;
  - others only to users who may see one of their linked plants (admins see all);
  - drafts only to their uploader and admins;
  - anything else answers 404.
  - Engineers edit only their own drafts; admins edit everything.

### Decisions taken in phase 1
| Question | Decision |
|---|---|
| File storage | `services/kb_storage.py`. **Prod:** a private GCS bucket (`KB_ASSETS_BUCKET`); the browser reads through V4 signed URLs (Cloud Run signs with IAM, no key file), so files never pass through Cloud Run. **Dev:** the local folder `KB_FILES_DIR` (default `data/kb_files`), served by the API itself. Prod without a bucket refuses uploads (503), because Cloud Run's disk is not kept. Postgres bytea and Firebase Storage are rejected, for the reasons in knowledge-base.md §5. |
| Links the PDF viewer can open | `GET /kb/docs/{id}/file` answers a short-lived link (`KB_FILE_URL_TTL_S`, 1 h). Locally it is `/kb/files/{revision}?exp=&sig=` (HMAC with the JWT secret, with Range support so pdf.js loads page by page), and needs no Authorization header. |
| Text and OCR | pypdfium2 (Apache-2.0 / BSD) reads the text layer. **OCR runs only in the worker** (`kb_ocr` job, tesseract `tha+eng`, installed in the backend image), because the API never runs jobs (Cloud Run cuts the CPU). An upload with scanned pages queues `kb_ocr`, and a 30-minute schedule catches anything missed. Without tesseract or the languages, pages are marked "no text", and admins use **OCR again** once it is installed. |
| Search engine | `LIKE` over each page's lower-cased text, as for the articles: Postgres FTS does not split Thai. At ~150 documents × 100 pages this is fine. A `pg_trgm` index can come later. |
| In-context links | Released documents only (`/kb/docs/context`), cached in tab memory for 5 minutes and cleared on sign-out. |
| Review workflow | Phase 1 has draft → released by an admin only. In review / awaiting approval come with phase 4. |

### Not built yet (later phases below)
- **Phase 2:** the PDF editor (markup layer, stamps, comments, page operations, redaction, export with markups, edit locks).
- **Phase 3:** authored documents (wizard, templates, block editor, PDF publish).
- **Phase 4:** review / approval, compare, read-and-acknowledge.
- **Phase 5:** data blocks, report-from-finding, bilingual layouts.
- **Phase 6:** field mode, offline cache, step runs, QR labels.
- **Also deferred:**
  - real cover thumbnails in the grid (a grid card shows the type icon; the document page renders page 1);
  - a fault-code catalogue file (`growatt_fault_codes.json` does not exist; codes come from the alarm log);
  - a command-palette `⌘K` entry;
  - pdf.js cMaps / standard fonts (PDFs with non-embedded CJK fonts may render with fallback glyphs).

### Production setup still needed
1. Create the bucket: private, uniform access, us-central1 (free tier). Give the Cloud Run service account `roles/storage.objectAdmin` on it and `roles/iam.serviceAccountTokenCreator` on itself.
2. Add a CORS rule on the bucket for the Hosting origin: `GET` and `HEAD`, header `Range`, so pdf.js can read the signed URLs.
3. Pass `KB_ASSETS_BUCKET` to Cloud Run and to the worker on the VM. The worker OCRs from the same bucket, with the VM's service account.
4. Rebuild the backend image: it now installs `tesseract-ocr` + `tesseract-ocr-tha`, and pypdfium2.

`deploy/gcp.sh` does not do steps 1–3 yet. Production is stopped (2026-11-21).

---

## 1. Purpose

One place in TC Roof Solar for every document the O&M and engineering team works from. It covers three needs:

1. **Find:** inverter and module manuals, datasheets, SOPs, method statements, as-built drawings and reports. Search covers their content and links each document to the plants, equipment and fault codes it concerns.
2. **Edit PDFs:** mark up and correct a vendor PDF without leaving the app: annotate, stamp, redact, reorder pages, fill forms, add a cover page.
3. **Author:** write the team's own controlled documents in structured blocks, the way an engineering document tool works. Each document has:
   - a document number, revision and approval;
   - a title block on every page;
   - warnings in standard format;
   - tables and figures fed from live data.

   The result is published as a PDF.

**Not goals:**
- A general word processor.
- Editing the original text of a vendor PDF in place (§5.6 offers a defined alternative).
- Replacing a full EDMS for the client (กปภ.). Export and transmittals cover handover.

## 2. Users and jobs

| User | Main jobs | Device |
|---|---|---|
| O&M engineer (field) | Open the right manual page for a fault code; follow an SOP step by step; tick a checklist; add a field note or photo | Phone or tablet, sometimes offline |
| O&M lead | Write and revise SOPs and work instructions; approve them; see who has read the latest revision | Desktop |
| Engineering | Write method statements, commissioning and inspection reports with data tables, I-V and IR figures; mark up vendor manuals | Desktop |
| PM | Assemble handover packs and transmittals for กปภ.; check document status | Desktop |
| Admin | Manage document types, numbering, templates, approvers, retention | Desktop |

## 3. Information architecture

Route `/kb`; all page state in the URL (`useUrlState`).

```
/kb                               Library (home)                      ← built
/kb/search?q=…                    Search results                      ← built
/kb/doc/:docId                    Document page                       ← built
/kb/doc/:docId/view?page=12       PDF viewer at a page                ← built
/kb/doc/:docId/rev/:rev           A specific revision (read-only)     ← built (redirects to view?rev=)
/kb/doc/:docId/edit               PDF editor                          phase 2
/kb/doc/:docId/author             Authoring editor                    phase 3
/kb/new                           New document wizard                 phase 3 (today: the article editor)
/kb/packs/:packId                 Handover pack / transmittal         later
/kb/templates                     Templates and document types        phase 3
/kb/review                        Reviews and approvals queue         phase 4
```

There are two kinds of document in one library. An **imported PDF** is edited with a markup layer and page operations; the original is never altered (built: upload, revisions, viewing). An **authored document** is built in the app from blocks and published as a PDF (phase 3).

## 4. Library
### 4.1 Layout
- Filters, "Pinned for you", "All documents" as a list (desktop) or grid.
- Status chips: ✓ Released · ⚠ In review · ✎ Draft · ⊘ Superseded (struck through) · ✕ Withdrawn, always with an icon and a label.
- Phone: the filters fold away behind a button; one card per row.

### 4.2 Search
- Titles, numbers, tags and full text (text layer + OCR, Thai and English).
- Each result shows the matching page, a snippet and a link to "go to page".
- Fault-code queries match the fault-code links first.
- Postgres, no paid search service.

## 5. PDF viewer and editor (imported PDFs)
- 5.1 The original file is never changed: edits are a separate layer per revision, and export renders the original plus that layer. The checksum is kept.
- 5.2 Layout: page rail, the page, and a panel (outline, comments, links, info).
- 5.3–5.7 (phase 2):
  - edit toolbar: highlight, underline, strike, note (private / team / published), text box, callout, shape, ink, stamps, image, link (including **Link → Fault code** drawn on the manual's table), redact (mark, then apply; logged), form;
  - page operations (reorder, rotate, hide, insert, split, merge, extract);
  - "Save layer" makes edit revisions with a change note; a 15-min edit lock;
  - correction overlay or "convert to authored";
  - export menu: published markups, all markups as a review copy, original, a page range, controlled-copy watermark, QR.

## 6. Authoring editor (phase 3)
- Wizard: type → template → details → number.
- Block editor: headings, paragraph, safety message (ANSI Z535 / ISO 3864), note, procedure steps with hold points / measured values, checklist, table, figure, drawing reference, equation, specification table, **data block** (frozen on publish, "data as of", modelled values labelled), cross-reference, revision table, signature, page break, appendix.
- Templates and title block:
  - A4, 20 / 25 mm margins;
  - Sarabun / IBM Plex Sans Thai;
  - cover page, header and footer with page x of y and the status watermark;
  - required sections per type.
- Bilingual layouts: EN, TH, side by side, or TH under EN.

## 7. Review, approval and document control (phase 4)
- Lifecycle: Draft → In review → Awaiting approval → Released (Rev n) → Superseded on the next release; Released → Withdrawn (with a reason).
- Electronic sign-off records the user, the time and the revision checksum.
- A change summary is needed for Rev n+1; a compare view; optional read-and-acknowledge.
- Roles: Viewer, Contributor, Editor, Reviewer / Approver, Admin.
  - Phase 1 maps engineers to Contributor and admins to Editor + Admin.
- Plant scope as in the rest of the app; *general* documents are visible to everyone; outside the user's scope = "not found".

## 8. Links to the rest of the app
- 8.1 Fault codes → manual page and SOP; the alarm shows "📖 Manual p.37 · SOP-OM-007". (Built: through the document's links. The JSON catalogue file is not there.)
- 8.2 Equipment and plants; each plant page has a **Documents** tab. (Built.)
- 8.3 "Create inspection report" from an I-V result, an IR finding or an O&M event (phase 5).
- 8.4 Stable deep links `/kb/doc/:docId/view?page=n` (built); "Print QR label" (phase 6).

## 9. Field mode (phase 6)
- Step-by-step runs of released SOPs: safety messages first, photos, measured values against limits, hold points.
- A completed run becomes a record (a filled-form PDF) on the plant / issue.
- An offline cache of documents pinned to the user's plants; queued runs; a banner when the cached revision is not the current one.
  - This needs an explicit exception to the "no runtime caching of `/api`" rule in frontend/CLAUDE.md.

## 10. Visual design
- Status uses the reserved status colours, always with an icon and a label.
- Safety messages use standard colours: DANGER red / white, WARNING orange / black, CAUTION yellow / black, NOTICE blue / white.
- The viewer chrome is recessive, and the page stays white in dark mode.
- Annotation colours: 5 fixed swatches.
- Empty states have one primary action.

## 11. Accessibility and quality
- Keyboard shortcuts.
- The viewer exposes the PDF text layer (built).
- Tagged PDFs from authoring, with alt text required.
- WCAG AA.
- The first page within 1.5 s for a 100-page manual: pages render on demand and the file is read with range requests (built).

## 12. Data model

| Entity | Built as | Key fields |
|---|---|---|
| `kb_document` | `kb_documents` | id, number (unique), kind (`imported`), doc_type, discipline, title_en, title_th, language, tags, general, status, status_note, superseded_by_id, current_rev_id, search_text, owner, created_by_user_id, created / updated / released |
| `kb_revision` | `kb_doc_revisions` | doc_id, rev_no, label (source version), change_note, object_name, original_name, bytes, sha256, page_count, text_status, ocr_langs, uploaded_by, created_at |
| (page text) | `kb_doc_pages` | revision_id, page_no, text, search_text, source (`pdf` / `ocr` / `pending` / `none`) |
| `kb_link` | `kb_doc_links` | doc_id, target_type (`fault_code` / `equipment` / `plant`), target_id, page, label |
| (pins) | `kb_doc_pins` | user_id, doc_id |

- Migration: `e4f5a6b7c8d9` on `d3e4f5a6b7c8`.
- Later phases add `kb_layer`, `kb_blocks`, `kb_comment`, `kb_approval`, `kb_ack` and `kb_run`.

## 13. Phasing

| Phase | Scope | Done when |
|---|---|---|
| 1 ✅ | Library, upload, full-text search with OCR, viewer, deep links, plant **Documents** tab, fault-code links | A fault on the alarm list opens the right manual page |
| 2 | PDF editor: markup layer, stamps, comments, page operations, export, edit revisions | A vendor manual can be marked up and exported with its markups |
| 3 | Authoring: wizard, templates, block editor, preview, PDF publish, numbering, revisions | SOP-OM-004 publishes as a templated PDF with a title block and revision table |
| 4 | Review and approval, compare view, read-and-acknowledge | One SOP goes from draft to Rev 0 with two reviewers and an approver |
| 5 | Data blocks, report-from-finding, bilingual layouts | An IR inspection report is created from a finding, with frozen data |
| 6 | Field mode, offline cache, step runs, records, QR labels | An SOP run done offline syncs and attaches its record to the issue |

## 14. Open questions
1. Is an electronic sign-off enough for กปภ. handover documents, or do some types need a certified digital signature (Thai e-signature, ETDA)?
2. Should numbering follow a client or EPC standard on PWA projects (for example, a project prefix)?
3. Which documents must be bilingual?
4. What is the retention rule for superseded revisions and run records? (Phase 1 keeps every revision indefinitely.)
5. Which vendor manuals come first? Suggested: the Growatt models on PWA sites (MAX 125KTL3-X LV, 80 / 60KTL3 LV, MID 40KTL3-X), the module datasheets, and the pilot plants' as-builts.
6. Should field records also export into the daily Monitoring PWA Report sheet?
7. (New) Production storage: is one GCS bucket acceptable? It costs ฿0 within the free tier and stops with the cost guard.
