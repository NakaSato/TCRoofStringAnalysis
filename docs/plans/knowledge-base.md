# Plan: Knowledge Base (create and edit manuals)

Status: **Phase 1 built** (text articles, revisions, 409 check, Thai search, list / view / editor) · Created 2026-11-22 · Owner: Chanthawat

The uploaded PDF library (vendor manuals, datasheets, drawings; page-level search, viewer, fault-code links) is planned and built separately in `docs/plans/kb-documents.md`; these articles are its **Articles** tab.

An in-app library of O&M manuals: SOPs, troubleshooting guides, alarm-code manuals, inverter and equipment notes, and safety procedures. Engineers and admins can write, edit, search and read them, including on a phone at the site. Each article keeps its edit history, and articles link to the alarm codes, inverter models and plants they cover.

---

## 1. Why

- Know-how sits in people's heads, LINE chats and scattered PDFs. A new engineer at an alarm has nowhere to look up "what does this code mean on a MAX 80KTL3, and what do I do".
- The app stores only Growatt's own `alarm_message` (`growatt_alarms.py:83-97`). There is no code → meaning or code → action table anywhere.
- The AI Assistant answers only from tool results (`assistant/prompt.py:23`). With a KB tool it can cite the company's own procedures.

## 2. Scope

**In (v1)**
- **`/kb` page** in the **Operations** group:
  - A list with search, category filter and tags.
  - The article view.
  - An editor.
- **Roles:**
  - Everyone signed in can read.
  - **Engineers and admins** can create and edit (`require_write_access`).
  - **Admins** can publish, archive and delete. Engineers' new articles stay `draft` until an admin publishes them (decision §9.1).
- **Article fields:**
  - title
  - category: `sop` \| `troubleshooting` \| `alarm_code` \| `equipment` \| `safety` \| `other`
  - tags
  - Markdown body
  - links: alarm codes (`fault_type` + `alarm_code`), inverter models (`inverter_models.py` keys), plants
- **Edit history**: every save is a full snapshot revision, with a diff view and "restore this version".
- **Edit conflicts**: a `version` column. A save made against an older version answers 409 with the newer text, and the editor shows both.
- **Images** pasted or dropped into the editor are resized in the browser and uploaded (§5). PDF attachments up to 20 MB.
- **"Manuals" links in context:**
  - Active Alarm rows and the alarm detail: articles linked to that code.
  - The inverter page: articles for its model.
  - The plant Maintenance tab: articles linked to the plant.
- **Command palette**: a "Manuals" category (server search).

**Out (later)**
- Offline reading. frontend/CLAUDE.md:43 forbids runtime caching of `/api`. A later exception could cache only published articles and their images (§8, phase 4).
- Approval workflows beyond draft → published, comments on articles, translation side by side.
- Importing existing Word or PDF manuals as text. v1 attaches them as PDFs.

## 3. Editor (decision)

**Use a Markdown textarea with a live preview.** On a phone, use Edit / Preview tabs instead of side by side.

| Option | Verdict |
|---|---|
| **Textarea + `react-markdown` 10 + `remark-gfm` 4 + `rehype-sanitize` 6** (chosen) | About 48 KB gzip, loaded only on `/kb`. A native textarea means Thai input works as the browser handles it. GFM gives tables and task lists. Stored as Markdown, which is diffable and readable by the AI Assistant. MIT. |
| TipTap v3 | MIT, headless, a good fit for shadcn, ~115 KB+. ProseMirror has open IME composition bugs, and its Markdown round-trip is "early release". This is the fallback if users insist on WYSIWYG. |
| BlockNote | Its export and multi-column features need GPL or a paid licence. Too heavy. |
| Lexical, MDXEditor, Milkdown | Pre-1.0 or 450–570 KB. |

- **Toolbar**: buttons that insert Markdown: heading, bold, list, numbered steps, table, link, image, a "warning" callout (`> ⚠️`), and a link to an alarm code.
- **Author hint:** bold in Thai text needs `**`, because CommonMark doesn't allow `_` mid-word.
- **Rendering:**
  - react-markdown with no `rehype-raw`, so raw HTML is never rendered.
  - Its default URL filter, plus `rehype-sanitize` (GitHub schema) allowing `img` only from our asset URLs.
  - Links pass through `appHref()` from `components/assistant/Markdown.tsx`, so app paths stay in the app.
  - The assistant's own `Markdown.tsx` stays as it is; it has no images and is sized for chat.

## 4. Data model

| Table | Columns | Notes |
|---|---|---|
| `kb_articles` | `id`, `slug` (unique), `title`, `category`, `tags` (json list), `body_md` (Text), `search_text` (Text, lower-cased title + tags + body without Markdown), `status` (`draft` \| `published` \| `archived`), `version` (int), `created_by/at`, `updated_by/at`, `published_by/at` | `version` is used for the 409 check |
| `kb_revisions` | `id`, `article_id`, `rev_no`, `title`, `category`, `tags`, `body_md`, `author`, `note`, `created_at` | A full snapshot per save. The worst case, 500 articles × 30 revisions × 20 KB, is about 300 MB. |
| `kb_links` | `article_id`, `kind` (`alarm_code` \| `inverter_model` \| `plant`), `key` (`"<fault_type>:<alarm_code>"`, model key, or plant id) | Unique (article, kind, key); index on (kind, key) |
| `kb_assets` | `id` (uuid), `article_id?`, `object_name`, `content_type`, `bytes`, `width`, `height`, `original_name`, `created_by/at` | Files live in GCS (§5); SQL keeps only metadata |

- Alembic migration `d3e4f5a6b7c8` on `c2d3e4f5a6b7` (phase 1: `kb_articles`, `kb_revisions`; `kb_articles` also has `created_by_user_id` for the own-drafts rule).
- `plant_id` has no FK, as in claims.
- SQL only. Nothing goes to Firestore (rule 2).

## 5. Images and attachments (decision)

Use a **private GCS bucket `tcroof-kb-assets` in us-central1**.

- **Cost:**
  - The Always Free tier covers 5 GB-months, 5k Class A and 50k Class B operations, and 100 GB/month outbound, in us-central1 only.
  - Expected use is far below that, so the bucket adds ฿0.
  - When the cost guard trips, the bucket stops serving along with everything else.
- **Upload:**
  - `POST /kb/assets` answers a V4 signed PUT URL (5 min). The Cloud Run service account needs the Token Creator role on itself, so there is no key file.
  - The browser uploads straight to GCS, and `POST /kb/assets/{id}/done` confirms the size and type.
  - Images are resized in the browser to at most 1600 px WebP (quality 0.8). That needs no library, gives about 150–300 KB, and removes EXIF data, including the site photo's GPS.
  - PDFs are sent unchanged, at most 20 MB.
  - Allowed types: `image/webp|jpeg|png`, `application/pdf`. SVG and HTML are refused.
- **In the body:**
  - The Markdown stores `![caption](kb-asset:<uuid>)`.
  - When the API returns an article, it resolves those to signed GET URLs that last 1 h.
  - PDFs get `Content-Disposition: attachment`.
- **Rejected:**
  - Postgres bytea on the VM: every image would go through Cloud Run (1 GB/month free outbound) and wake it from zero, and it would use the disk sized for 90 days of readings.
  - Firebase Storage: it needs the Blaze plan, and the project is on Spark.
- **Settings:** `KB_ASSETS_BUCKET` (empty = image upload off; Markdown links still work) and `KB_MAX_UPLOAD_MB` (20).
  - Setup: `deploy/gcp.sh setup` creates the bucket (uniform access, no public access, a lifecycle rule that deletes unconfirmed uploads after 1 day).
  - Dev: a local folder backend behind the same interface (`services/kb_storage.py`: `GcsStore` / `LocalStore`).

## 6. Search (Thai)

- The browser splits the query into words with `Intl.Segmenter('th', {granularity: 'word'})`.
- The backend needs every word to appear (`lower(search_text) LIKE %w%`, the same as `system_logs.py:96`, so it runs on SQLite and Postgres).
- Ranking: title hit > tag hit > body hit, then newest first.
- At ≤ 500 articles this takes milliseconds.
- Postgres FTS is not used (it doesn't split Thai words). PGroonga and pythainlp are not worth it at this size.
- A `pg_trgm` index can come later. Check `show_trgm('อินเวอร์เตอร์')` on our `postgres:16-alpine` first.

## 7. API (`/kb`, router `api/routes/kb.py`, service `services/kb.py`)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/kb/articles?q=&category=&tag=&status=&link_kind=&link_key=` | read | Engineers see `published` plus their own drafts; admins see all |
| GET | `/kb/articles/{slug}` | read | Body with asset URLs resolved, plus links |
| POST | `/kb/articles` | write | Creates a `draft`, revision 1 |
| PATCH | `/kb/articles/{id}` | write | Body has `base_version`; 409 `{current}` when stale; adds a revision |
| POST | `/kb/articles/{id}/publish` / `archive` | admin | |
| DELETE | `/kb/articles/{id}` | admin | Soft delete = archive; hard delete only for drafts |
| GET | `/kb/articles/{id}/revisions`, `/revisions/{rev}` | read | Diffs are computed in the browser (`diff`, ~10 KB) |
| POST | `/kb/articles/{id}/restore/{rev}` | write | Saved as a new revision |
| POST | `/kb/assets`, `/kb/assets/{id}/done` | write | Signed upload (§5) |
| GET | `/kb/for?kind=alarm_code&key=…` | read | For the in-context links (alarm row, inverter, plant) |

Edits are also written to the `app.audit` log.

**AI Assistant**: two read-only tools in `services/assistant/tools.py`:
- `search_manuals(q, category?)` returns titles and snippets.
- `read_manual(slug)` returns the published body, trimmed to `RESULT_MAX_CHARS`.

The prompt gets one line: "When a manual covers the question, cite it by title."

## 8. UI (`pages/KnowledgeBasePage.tsx` + `pages/kb/*`)

- **List (`/kb`)**:
  - Search box ("/" focuses it), category chips, tag filter, and status filter for admins.
  - Rows show title, category, tags, linked codes or models, "updated 3 d ago by …", and a draft badge.
  - Uses `TablePager`.
- **Article (`/kb/:slug`)**:
  - The rendered body.
  - Side panel: links, history, attachments.
  - Buttons: Edit, Publish (admin), Copy link.
  - `HIDDEN_NAV` entry for the header title.
- **Editor (`/kb/:slug/edit`, `/kb/new`)**:
  - Title, category, tags, link pickers (alarm code, inverter model from the datasheet catalog, plants via the `PlantMultiPicker` pattern), the textarea with toolbar, preview, and a "change note" field.
  - Paste or drop images.
  - The unsent draft is kept in `localStorage` (try/catch) so a dropped connection on site loses nothing.
  - A 409 conflict opens a dialog: "Someone saved a newer version", with a diff and "Keep mine / Take theirs / Merge by hand".
- **In context**:
  - Active Alarm row: a `BookOpen` icon when articles exist for its code.
  - Inverter page: a "Manuals" card.
  - Plant Maintenance tab: "Manuals for this plant".
- **i18n**: UI strings in `th/kb.ts`. Article text is stored as written (Thai or English) and never goes through `t()`.

## 9. Phases

1. **Articles, text only**:
   - Tables, migration, CRUD, revisions, 409 check, search.
   - List, view and editor (no images yet).
   - Tests: roles, draft visibility, 409, revision restore, Thai search ("อินเวอร์เตอร์ ไม่ทำงาน" finds an article that has both words apart).
2. **Images and PDFs**: storage interface, GCS bucket in `gcp.sh setup`, signed URLs, browser resize, sanitised rendering.
3. **Links in context and the Assistant**: `kb_links` pickers, alarm / inverter / plant entry points, assistant tools, command palette.
4. **Offline reading (optional)**: a service-worker cache only for `GET /kb/articles/*` that are published, plus their images, cached at most 7 days. It needs an explicit exception added to frontend/CLAUDE.md:43.

Seed content for the first week: about 10 articles written from the team's most frequent alarm codes. Use `/growatt/alarms` counts to pick which ones.

## 10. Decisions needed

1. **Publishing:** must an admin publish engineers' articles, or do they go live at once? (Plan: draft → admin publishes.)
2. **GCS bucket:** is one new bucket in the project acceptable? It adds ฿0 within the free tier, but it is one more resource the cost guard stops.
3. **Offline:** is reading manuals offline at the site needed in v1? It changes the PWA rule.
4. **Seed content:** are there existing manuals or SOP documents (Word or PDF on Drive) to attach in phase 2?
