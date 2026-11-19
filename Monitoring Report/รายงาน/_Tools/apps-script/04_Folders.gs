// ============================================================ 1) month folder

/** The folder `name` in `parent`, or null when there is none (one in the trash does not count). */
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

/**
 * The folder that holds the month folders: CONFIG.MONTHS_FOLDER in the root folder (made when `make`),
 * the root folder itself when MONTHS_FOLDER is blank; null when it is not there and not `make`.
 */
function monthsParent_(make) {
  const root = DriveApp.getFolderById(rootId_());
  if (!CONFIG.MONTHS_FOLDER) return root;
  return childFolder_(root, CONFIG.MONTHS_FOLDER) || (make ? root.createFolder(CONFIG.MONTHS_FOLDER) : null);
}

/**
 * The month folder "yyyy-MM", or null when there is none: the one in the months folder, else one still
 * left directly in the root folder (from before MONTHS_FOLDER), so a month is never made twice.
 */
function findMonthFolder_(ym) {
  const parent = monthsParent_(false);
  return (parent && childFolder_(parent, ym)) || childFolder_(DriveApp.getFolderById(rootId_()), ym);
}

function monthFolder_(ym) {
  return findMonthFolder_(ym) || monthsParent_(true).createFolder(ym);
}

/**
 * Everything in a folder that is not in the trash: Map name → { id, edited (ms) }. One Drive API call
 * per 1,000 files, instead of one DriveApp round trip per file.
 */
function folderFiles_(folderId) {
  const out = new Map();
  const args = { q: `'${folderId}' in parents and trashed = false`, pageSize: 1000, fields: 'nextPageToken, files(id,name,modifiedTime)' };
  do {
    const page = retry_(() => Drive.Files.list(args));
    (page.files || []).forEach(f => out.set(f.name, { id: f.id, edited: new Date(f.modifiedTime).getTime() }));
    args.pageToken = page.nextPageToken;
  } while (args.pageToken);
  return out;
}

function fileName_(s, ym) { return `${s.code}_${s.name.replace(/[\\/:*?"<>|]/g, '-').trim()}_${ym}`; }

/**
 * A plant's file of the month in `files` (folderFiles_): by its exact name, else by plant code and month,
 * so a plant renamed in the Overview after its file was made keeps that file. undefined = no file yet.
 */
function plantFile_(files, s, ym) {
  const exact = files.get(fileName_(s, ym));
  if (exact) return exact;
  const head = `${s.code}_`, tail = `_${ym}`;
  for (const [name, f] of files) if (name.indexOf(head) === 0 && name.slice(-tail.length) === tail) return f;
  return undefined;
}
