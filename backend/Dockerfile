# Two images from one file (build context: the repo root):
#   --target api     Cloud Run API (uvicorn). No tesseract: a smaller image starts faster.
#   --target worker  growatt-worker on the VM (python -m app.worker), with tesseract for `kb_ocr`.
# Both share the Python dependency layers. `uv` is mounted only while installing, so it is not in
# either image. backend/tests and sample_data/ are not copied (see .dockerignore): nothing reads
# them at runtime.

FROM python:3.13-slim AS deps

WORKDIR /app
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

COPY backend/pyproject.toml ./pyproject.toml
# --compile-bytecode: .pyc files are written now, not on each cold start (the image is read-only
# at runtime on Cloud Run, so Python would otherwise compile every import again).
RUN --mount=from=ghcr.io/astral-sh/uv:latest,source=/uv,target=/bin/uv \
    uv pip install --system --no-cache --compile-bytecode -r pyproject.toml


# Knowledge Base OCR of scanned PDF pages (the worker's `kb_ocr` job), Thai + English.
# Before the code copy, so a code change does not reinstall it.
FROM deps AS worker-os
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*


FROM worker-os AS worker
COPY backend/ ./
RUN python -m compileall -q app solar_core
CMD ["python", "-m", "app.worker"]


# Last stage = the default target of a plain `docker build`.
FROM deps AS api
COPY backend/ ./
RUN python -m compileall -q app solar_core
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
