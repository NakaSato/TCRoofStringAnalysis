# Plan: As-built drawing and site photo links in the plant header

Status: **Built** (phase 2: table, API, header buttons, Settings → Plant documents, matcher CLI) 2026-11-22; first match applied locally 2026-11-22 (as-built 150 auto / 83 none, site photos 230 auto / 2 review / 1 none; 131 PDFs from the site folders' own `As-Built Drawing` subfolders, 19 from P1 / P2 / P3; `AS BUILT / รายการคำนวณ PHASE 3-4` is not used) · Created 2026-11-22 · Owner: Chanthawat

Every plant page header (`SelectedPlantBanner`) gets two buttons:

- **As-built (PDF)** opens the plant's newest as-built drawing on Google Drive.
- **Photos** opens the plant's site photo folder.

The links are matched once from the company Drive, kept in SQL per plant, and admins can correct them.

---

## 1. What is on the Drive (surveyed 2026-11-22)

All the folders sit under the same parent folder (`11qOzK5KrqkrrR-YBGUt2ZspFO8vaw0Ch`):

| Folder | Content | Naming |
|---|---|---|
| `รูปภาพติดตั้งหน้างาน (link to monitoring)` (`1HZYsFfI9OPybx1G53Z_q2pZXgAdQBrGf`) | ~239 site folders, each with `Picture` and `As-Built Drawing` subfolders. 131 of the 233 `As-Built Drawing` subfolders hold the site's PDF (listed 2026-11-22); the other 102 are empty. The matcher takes the subfolder's PDF first and the P1 / P2 / P3 folders only when it is empty. | `175 สถานีผลิตน้ำ กม.5 กปภ.สาขาสุราษฎร์ธานี`, `43.สถานีผลิตน้ำควนพลา`, `17. อุโมงค์` |
| `As-Build Drawing Phase 1 Rev.00` (`1-8czLtWYlHL5ecOx-Pvfey68e_ijn0aG`) | Phase 1 PDFs | `17.โรงกรองน้ำอุโมงค์ การประปาส่วนภูมิภาคสาขาเชียงใหม่ As-Build.pdf` |
| `AS-BUILT P2` (`1oOHLwFlZ43nbRa99JNkwHs8RcFBcNXk_`) | Phase 2, one subfolder per region (ภาคกลาง / อีสาน / ตะวันออก / เหนือ / ใต้) | not yet listed |
| `AS-BUILT P3` (`1UhrBHvaN1rjH8pYBMFt8BsLtEXHtMQMU`) | Phase 3, REV.1 | `227 โรงกรองน้ำหาดเหนือ กปภ.สาขาพยุหะคีรี 109.44 kWp AS Built REV.1.pdf` |
| `AS BUILT / รายการคำนวณ PHASE 3-4` → `AS BUILT PHASE 3-4` (`18-L4jJ6zs5TTXI5Rc02Lq3TB18WQSvee`) | Phase 3–4, newer revisions, mixed with calculation sheets, test reports and route plans. **Not used as a source** (decision 2026-11-22). | `156. AS BUILT โรงสูบน้ำแรงต่ำ…อ่างทอง … 30.07.69 REV.3.pdf` |

What the survey shows:

- **The numbers can't be trusted as keys.**
  - Site folders use a running number from 1 to 233.
  - PDF names often carry a different number: บ้านท่านางหอม is 186 on the PDF but folder 183; หลังสวน is 113 vs 168; the same อ่างทอง site is `3` in P3 and `156` in Phase 3-4.
  - `_Tools/registry.csv` numbers phases 3 and 4 separately (P3-001 ชัยบาดาล is folder 148).
  - **Match by name.**
- **A site can have several revisions** (REV.1 in P3, REV.3 in Phase 3-4). Use the highest `REV.n`; if the revisions tie, take the newest `modifiedTime`.
- **Some files are broken.** `202 สำนักงานประปาพังโคน…pdf` in P3 is 0 bytes. The matcher skips files of 0 bytes.
- **Access.** The files belong to company Drive accounts. A user who has no Drive access sees Google's "Request access" page. The app only stores and shows the link; it does not proxy or copy the PDF.

## 2. Scope

**In (v1)**
- SQL table `plant_documents` and the import script (§4).
- Header buttons, with no button shown when a plant has no link.
- An admin editor for the links in Plant Settings → Plant.
- A "Documents" row in the Overview Location card.

**Out (later)**
- Embedding the PDF in the app (Drive `/preview` iframe). This depends on the viewer's Drive sign-in, so v1 opens a new tab.
- An automatic weekly refresh from Drive (§7, phase 3).
- Other document kinds: single-line diagram, PVsyst report, handover documents in `เอกสารส่งมอบงานประปา ระยะ 3`. The `kind` column leaves room for them.

## 3. Data model

New table `plant_documents`, so the data stays out of `GrowattPlant`. `GrowattPlant` is the Growatt mirror, and the registry sync deletes the rows of blocked plants.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `plant_id` | int, index | Growatt plant id. No FK, the same as claims and site events. |
| `kind` | str(32) | `asbuilt` \| `site_photos` (more later) |
| `drive_id` | str(128), null | Drive file or folder id. The URL is built from it. |
| `url` | str(1000) | `https://drive.google.com/file/d/<id>/view` or `…/drive/folders/<id>`; any https URL for a manual entry |
| `title` | str(300), null | The file or folder name on Drive |
| `revision` | str(16), null | `REV.3` as parsed from the name |
| `source` | str(16) | `matched` (script) \| `manual` (admin). The script never overwrites `manual`. |
| `match_score` | float, null | Confidence of the name match, for review |
| `updated_by`, `updated_at` | | Audit, as `OmPlantSettings` has |

- Unique key: (`plant_id`, `kind`).
- Alembic migration on head `b1c2d3e4f5a6`, plus `create_all`.
- Static registry data: SQL only. Nothing goes to Firestore (rule 2).

## 4. Matching (one-off script, then admin review)

Script `backend/scripts/drive_asbuilt_match.py`:

1. **List the folders recursively** through the Drive API v3.
   - Use the same OAuth user flow as `_Tools/gsheets_sync.py` (`credentials.json` + `token.json`, read-only Drive scope). That avoids sharing the folders with a service account. `credentials.json` / `token.json` are not in `_Tools` now, so they must be created once.
   - Folders: the four as-built folders (P2 by region) and the photo folder's direct children.
2. **Normalise each name:**
   - Strip the leading number and punctuation.
   - Strip `As-built` / `AS BUILT` / `As-Build`, `REV.n`, `xx kWp`, the date (`30.07.69`) and `.pdf`.
   - Replace `การประปาส่วนภูมิภาคสาขา` → `กปภ.สาขา`.
   - Collapse spaces and Thai/Latin variants (`เเ` → `แ`).
   - Split into (site name, branch).
3. **Candidate names per plant:**
   - `GrowattPlant.name`
   - `PwaMeterSite.name` / `growatt_name`
   - `_Tools/registry.csv` name through `plant_map.json` (plant_id → code)
4. **Score.**
   - Use the token-set ratio of the site name, plus a bonus when the branch matches and when the phase matches the source folder (P1 / P2 / P3 / 3-4).
   - Auto-accept at ≥ 0.9 when the runner-up is ≥ 0.1 below; everything else is marked for review.
5. **Write `asbuilt_matches.csv`** with columns plant_id, plant name, kind, drive file, revision, score, status (`auto` / `review` / `none`). An admin checks the `review` rows.
6. **`--apply`** upserts the CSV into `plant_documents` with `source=matched` and leaves rows with `source=manual` alone.
   - Locally, write to the DB directly.
   - For production, post the CSV to the admin endpoint (§5).

Acceptance target: at least 95 % of the 233 plants get an as-built link, and no plant gets another plant's PDF. Spot-check 20 plants by hand.

## 5. API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/growatt/plants/{id}/documents` | `require_plant_read` | `[{kind, url, title, revision, source, updated_at}]` |
| PUT | `/growatt/plants/{id}/documents/{kind}` | `require_admin` | Body `{url, title?}`. Only `https://drive.google.com/…` or other https URLs pass `safeHref`. Sets `source=manual`. Audit-logged. |
| DELETE | `/growatt/plants/{id}/documents/{kind}` | `require_admin` | |
| POST | `/growatt/documents/import` | `require_admin` | The CSV from §4, as a dry run by default (`?apply=1` to write); returns counts |

The overview's `plant` dict (`growatt_overview.py:621-638`) adds `documents: {asbuilt?: {url, revision}, site_photos?: {url}}`, so the banner needs no extra request.

## 6. UI

- **`SelectedPlantBanner`**: icon buttons next to the status badge (`:123-128`), using the Google Maps button pattern from `OverviewPage.tsx:499-505` (`Button asChild variant="ghost" size="icon-sm"`, `<a target="_blank" rel="noreferrer">`).
  - `FileText` "As-built (REV.3)" and `Images` "Site photos".
  - Each has a tooltip ("Opens Google Drive. You need access to the company Drive.").
  - No link means no button. There is no "—" placeholder in the header.
- **Overview Location card**: a "Documents" line with the same links.
- **Plant Settings → Plant tab**: an admin table with one row per plant. Columns: as-built link, revision, source (matched / manual), score, and an edit button that opens a dialog with a URL field.
  - Filters: "missing" and "needs review".
  - Engineers see the table read-only.
- **i18n**: strings in `th/plant.ts`, e.g. "As-built (PDF)" → "แบบ As-built (PDF)", "Site photos" → "รูปหน้างาน".

## 7. Phases

1. **Matching**: script and CSV review. Only the script, no app change, so the match quality is known before any UI is built.
2. **App**: table, migration, API, header buttons, admin editor. Tests for the API (scoping, admin-only PUT, `manual` protected from import) and for name normalisation (the five PDF names in §1 as fixtures).
3. **Refresh (optional)**: a monthly `fleet`-job step that re-lists the as-built folders and proposes newer revisions. It needs a service account with Drive read access to the folders. Proposals go to the review list and never overwrite on their own.

## 8. Decisions needed

1. Should Photos link the site's `Picture` subfolder or the site folder itself? (Plan: `Picture`.)
2. Should engineers be allowed to fix a link (`require_plant_write`), or only admins? (Plan: admin only.)
3. Should the empty `As-Built Drawing` subfolders in each site folder be filled from the phase folders on Drive? That is a Drive housekeeping job outside the app, but it would make the photo folder the one place to look.
