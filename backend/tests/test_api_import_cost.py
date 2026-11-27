"""`import app.main` must not load the heavy libraries only a few routes use (Cloud Run cold start).

They are imported inside the routes / services that need them (pandas and plotly for the legacy
analysis and the PWA meter report, numpy for the I-V models and OCR, the anthropic SDK for the
AI Assistant, openpyxl for workbook import / export, pypdfium2 and firebase_admin / google-cloud).
Run in a fresh interpreter: the test session itself has most of them loaded already.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

HEAVY = (
    "pandas",
    "numpy",
    "plotly",
    "anthropic",
    "openpyxl",
    "pypdfium2",
    "firebase_admin",
    "google.cloud",
    "google.auth",
    "scipy",
    "PIL",
)


def test_import_app_main_skips_heavy_libraries() -> None:
    code = (
        "import json, sys\n"
        "import app.main\n"
        f"heavy = {HEAVY!r}\n"
        "print(json.dumps(sorted(m for m in heavy if m in sys.modules)))\n"
    )
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(BACKEND), str(BACKEND.parent)])}
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND.parent, env=env, capture_output=True, text=True, timeout=120
    )
    assert out.returncode == 0, out.stderr[-2000:]
    loaded = json.loads(out.stdout.strip().splitlines()[-1])
    assert loaded == [], (
        f"import app.main loaded {loaded}: import them inside the route / service that uses them "
        "(python -X importtime -c 'import app.main' shows the chain)"
    )
