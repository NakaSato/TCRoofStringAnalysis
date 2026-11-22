"""File storage of the Knowledge Base library (docs/plans/kb-documents.md §5).

Two stores behind one interface:
- `GcsStore`: a private GCS bucket (`KB_ASSETS_BUCKET`, production). Reads go straight from the
  bucket to the browser through a V4 signed GET URL (`KB_FILE_URL_TTL_S`), so files never pass
  through Cloud Run.
- `LocalStore`: a folder (`KB_FILES_DIR`, default `data/kb_files`, dev). The API serves the file
  itself at `/kb/files/{revision_id}` with an HMAC signature in the query (same lifetime), so the
  PDF viewer and a plain download link need no Authorization header.

Files are written once and never changed (a new revision is a new object). Names are made by the
caller (`docs/<doc_id>/<rev_no>-<sha12>.pdf`), never from user input.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from datetime import timedelta
from pathlib import Path
from typing import Optional, Protocol
from urllib.parse import quote

from app.config import DATA_DIR, settings


class StorageUnavailable(RuntimeError):
    """No usable store (prod without a bucket): uploads answer 503."""


class Store(Protocol):
    kind: str

    def put(self, name: str, data: bytes, content_type: str) -> None: ...

    def get(self, name: str) -> bytes: ...

    def delete(self, name: str) -> None: ...

    def signed_url(self, name: str, *, filename: str, download: bool, ttl_s: int) -> Optional[str]:
        """A direct URL the browser can GET, or None when the API serves the file itself."""
        ...


def _safe_name(name: str) -> str:
    if not name or name.startswith("/") or ".." in name.split("/") or "\\" in name:
        raise ValueError(f"bad object name {name!r}")
    return name


class LocalStore:
    kind = "local"

    def __init__(self, root: Path):
        self.root = root

    def path(self, name: str) -> Path:
        return self.root / _safe_name(name)

    def put(self, name: str, data: bytes, content_type: str) -> None:
        p = self.path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def get(self, name: str) -> bytes:
        return self.path(name).read_bytes()

    def delete(self, name: str) -> None:
        try:
            self.path(name).unlink()
        except FileNotFoundError:
            pass

    def signed_url(self, name: str, *, filename: str, download: bool, ttl_s: int) -> Optional[str]:
        return None


class GcsStore:
    kind = "gcs"

    def __init__(self, bucket: str):
        from google.cloud import storage  # firebase-admin brings it

        self._bucket = storage.Client().bucket(bucket)

    def put(self, name: str, data: bytes, content_type: str) -> None:
        blob = self._bucket.blob(_safe_name(name))
        # objects are never overwritten: a second write of the same name fails instead
        blob.upload_from_string(data, content_type=content_type, if_generation_match=0)

    def get(self, name: str) -> bytes:
        return self._bucket.blob(_safe_name(name)).download_as_bytes()

    def delete(self, name: str) -> None:
        from google.api_core.exceptions import NotFound

        try:
            self._bucket.blob(_safe_name(name)).delete()
        except NotFound:
            pass

    def signed_url(self, name: str, *, filename: str, download: bool, ttl_s: int) -> Optional[str]:
        import google.auth
        from google.auth.transport import requests as g_requests

        # Cloud Run has no key file: sign through IAM with the service account's own token
        # (the account needs roles/iam.serviceAccountTokenCreator on itself)
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(g_requests.Request())
        disposition = "attachment" if download else "inline"
        return self._bucket.blob(_safe_name(name)).generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=ttl_s),
            method="GET",
            response_disposition=f"{disposition}; filename*=UTF-8''{quote(filename)}",
            response_type="application/pdf",
            service_account_email=getattr(creds, "service_account_email", None),
            access_token=getattr(creds, "token", None),
        )


_store: Optional[Store] = None


def local_root() -> Path:
    return Path(settings.kb_files_dir) if settings.kb_files_dir.strip() else DATA_DIR / "kb_files"


def get_store() -> Store:
    """The configured store (cached). Prod without a bucket: StorageUnavailable (Cloud Run's disk
    is lost on every restart, so a local file there would vanish)."""
    global _store
    if _store is None:
        bucket = settings.kb_assets_bucket.strip()
        if bucket:
            _store = GcsStore(bucket)
        elif settings.is_prod:
            raise StorageUnavailable("Document storage is not configured (KB_ASSETS_BUCKET).")
        else:
            _store = LocalStore(local_root())
    return _store


def reset_store(store: Optional[Store] = None) -> None:
    """Tests: use `store` (or re-read the settings on the next call)."""
    global _store
    _store = store


# --------------------------------------------------------------------------- API-served file links


def _sig(revision_id: int, exp: int, download: bool) -> str:
    msg = f"kb-file:{revision_id}:{exp}:{int(download)}".encode()
    return hmac.new(settings.jwt_secret_key.encode(), msg, hashlib.sha256).hexdigest()[:40]


def sign_api_path(revision_id: int, *, download: bool, ttl_s: int, now: Optional[float] = None) -> tuple[str, int]:
    """`/kb/files/<id>?exp=&sig=[&download=1]` and its expiry (unix s)."""
    exp = int((now if now is not None else time.time()) + ttl_s)
    q = f"exp={exp}&sig={_sig(revision_id, exp, download)}" + ("&download=1" if download else "")
    return f"/kb/files/{revision_id}?{q}", exp


def check_api_sig(revision_id: int, exp: int, sig: str, download: bool, now: Optional[float] = None) -> bool:
    if exp < int(now if now is not None else time.time()):
        return False
    return hmac.compare_digest(sig or "", _sig(revision_id, exp, download))
