# ☀️ TC Roof Solar PV String Analysis & O&M Engineering Suite (Full-Stack)

An end-to-end **Full-Stack Solar PV String Performance, Asset Management, Root Cause Analysis (RCA), and SH&E Engineering Platform** built with **FastAPI**, **SQLAlchemy + Alembic**, **React + Vite + TypeScript + Tailwind CSS** and **Plotly** in compliance with **IEC 61724-1** and **ISO 45001 / NFPA 70E**.

---

## Architecture Overview

- **Domain Engine (`backend/solar_core/`)**: Pure Python/Pandas engineering engine for SCADA/API ingestion, IEC 61724 PR & temperature-corrected yield diagnostics, single-diode I-V/P-V modeling, Plotly figure generation (`fig.to_json()`).
- **REST API & Persistence (`backend/app/`)**: FastAPI backend with SQLAlchemy 2.0 ORM models, Alembic migrations, and JWT role-based access control (`admin`, `engineer`, `viewer`) across 10 relational tables (`users`, `plants`, `string_specs`, `datasets`, `telemetry`, `analysis_runs`, `pm_tasks`, `cm_work_orders`, `rca_records`, `ptw_permits`).
- **Frontend SPA (`frontend/`)**: React 19 + Vite + TypeScript + Tailwind CSS + `plotly.js-dist-min` rendering the engineering & O&M modules plus Plant & String Specifications and JWT role switching.

---

## Core Engineering & O&M Modules

1. **Upload or Fetch String Telemetry from API (`/`)**
   - **Inverter Cloud / REST APIs**: Huawei FusionSolar (`getDevHistoryKpi`), Sungrow iSolarCloud (`getDevicePointMinuteDataList`), and Generic REST APIs with offline sandbox fallback.
   - **SCADA CSV / Excel Upload**: Automatically normalizes both Long/Tidy and Wide SCADA formats (`PV1_U`, `PV1_I`, ..., `PV24_U`, `PV24_I`).
   - **Built-in PV String Simulator**: Multi-day telemetry with realistic solar irradiance curves and injected faults.

2. **Analyze Daily / Monthly Generation & Evaluate Performance Ratio (`/plant/:id/performance`)**
   - Daily & 6-Month Generation ($\text{kWh}$) and Performance Ratio ($\text{PR \%}$) vs. Contractual Target PR.
   - **IEC 61724 Energy Loss Waterfall**: Quantifies Theoretical STC Yield $\rightarrow$ Thermal Loss $\rightarrow$ Inverter/Cabling Loss $\rightarrow$ Open-Circuit / Bypassed Diode / Shading Fault Losses $\rightarrow$ Actual Metered Yield.
   - **Prioritized PR Improvement Opportunities**: Ranked by recoverable energy ($\text{kWh}$), estimated $\text{PR}$ gain ($\%$), and revenue recovery ($\text{THB}$).

3. **String-by-String Performance & I-V / P-V Curve Diagnostics (`/strings`)**
   - Specific Yield ($\text{kWh/kWp}$), Temperature-Corrected PR, Peer Median Deviation Heatmap, Interactive Telemetry Timeseries, and Single-Diode I-V / P-V Operating Envelope.

4. **Preventive Maintenance (PM), Corrective Maintenance (CM) & Equipment RCA (`/maintenance`)**
   - Interactive PM schedule across PV Arrays, Combiner Boxes, String Inverters, MV Step-Up Transformers (DGA/Oil), and LV/MV Switchgear (ACB/VCB).
   - Auto-generated CM Work Orders & step-by-step field troubleshooting checklists.
   - Structured **5-Why & Fishbone (Ishikawa)** RCA register with **CAPA (Corrective & Preventive Actions)** covering **Inverters**, **Transformers**, **Switchgear**, and **PV Strings**.

---

## Quick Start

### 1. Run Backend API (FastAPI + SQLite Auto-Seeded)
```bash
PYTHONPATH=backend uv run uvicorn app.main:app --reload --port 8000
```
- Swagger UI / OpenAPI Docs: `http://127.0.0.1:8000/docs`

### 2. Run Frontend Web App (React + Vite)
```bash
cd frontend
bun install
bun run dev
```
- Web App URL: `http://localhost:5173`

### 3. Run Automated Tests (Core + Full-Stack API)
```bash
uv run pytest -v
```

### 4. Run Database Migrations (Alembic)
```bash
uv run alembic -c backend/alembic.ini upgrade head
```

### 5. Run with Docker Compose (PostgreSQL + Backend + Frontend Nginx)
```bash
docker compose up --build
```
