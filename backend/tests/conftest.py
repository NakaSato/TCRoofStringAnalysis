"""Shared test guards: tests never reach the real Firebase project, whatever `.env` says."""

import pytest


@pytest.fixture(autouse=True)
def _no_real_firebase(tmp_path, monkeypatch):
    """`.env` may set PUBLISH_SINK=firestore and the Firebase credentials, and routes that mirror a save
    (layout edit, site register import) publish through `make_sink` right away. Every sink becomes a JSON
    folder under the test's tmp dir, and the real FCM sender refuses to send. A test that needs its own
    sink or sender still patches `make_sink` / `firebase_sender` or passes `sender=`."""
    from app.services import daily_summary as ds
    from app.services import push

    out = tmp_path / "publish_sink"
    monkeypatch.setattr(ds, "make_sink", lambda kind, out_dir=None: ds.JsonFileSink(out_dir or out))

    def no_fcm():
        raise RuntimeError("tests never send real FCM pushes: pass sender= or patch push.firebase_sender")

    monkeypatch.setattr(push, "firebase_sender", no_fcm)
