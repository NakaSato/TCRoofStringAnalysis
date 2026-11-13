"""Dataset ingestion endpoints (CSV/XLSX Upload, Huawei/Sungrow/Generic REST API Fetch, Simulator)."""

from __future__ import annotations

from datetime import datetime, timedelta
import io
from typing import List
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import AnalysisRun, Dataset, Plant, User
from app.db.session import get_db
from app.schemas.api_schemas import (
    DatasetDetailOut,
    DatasetOut,
    FetchAPIDatasetRequest,
    SimulateDatasetRequest,
)
from app.services.solar_service import (
    df_to_records,
    execute_and_store_analysis,
    load_dataset_dataframe,
    store_dataset_from_dataframe,
)
from solar_core.ingestion import (
    EndpointUnreachable,
    SolarAPIClient,
    generate_simulated_string_data,
    load_from_uploaded_file,
)

router = APIRouter(tags=["1. Ingestion & Datasets"])


@router.get("/plants/{plant_id}/datasets", response_model=List[DatasetOut])
def list_plant_datasets(plant_id: int, db: Session = Depends(get_db)) -> List[DatasetOut]:
    datasets = db.scalars(
        select(Dataset)
        .where(Dataset.plant_id == plant_id)
        .order_by(Dataset.id.desc())
    ).all()
    return [DatasetOut.model_validate(d) for d in datasets]


@router.get("/datasets/{dataset_id}", response_model=DatasetDetailOut)
def get_dataset_detail(dataset_id: int, db: Session = Depends(get_db)) -> DatasetDetailOut:
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    df = load_dataset_dataframe(db, dataset_id)
    latest_run = db.scalar(
        select(AnalysisRun)
        .where(AnalysisRun.dataset_id == dataset_id)
        .order_by(AnalysisRun.id.desc())
        .limit(1)
    )
    out = DatasetDetailOut.model_validate(dataset)
    out.preview_rows = df_to_records(df.head(100))
    out.latest_analysis_run_id = latest_run.id if latest_run else None
    return out


@router.get("/datasets/{dataset_id}/sample-csv")
def download_sample_csv(dataset_id: int, db: Session = Depends(get_db)) -> Response:
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    df = load_dataset_dataframe(db, dataset_id)
    csv_bytes = df.head(160).to_csv(index=False).encode("utf-8")
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sample_solar_string_telemetry.csv"'},
    )


@router.post(
    "/plants/{plant_id}/datasets/upload",
    response_model=DatasetDetailOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_dataset(
    plant_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> DatasetDetailOut:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")

    raw_bytes = await file.read()
    filename = file.filename or "uploaded_telemetry.csv"
    try:
        df = load_from_uploaded_file(io.BytesIO(raw_bytes), filename)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse uploaded file '{filename}': {exc}") from exc

    dataset = store_dataset_from_dataframe(
        db=db,
        plant=plant,
        df=df,
        name=f"Uploaded File: {filename}",
        source_type="upload",
        source_label=f"Uploaded File: {filename}",
    )
    run, _ = execute_and_store_analysis(db=db, plant=plant, dataset=dataset)
    out = DatasetDetailOut.model_validate(dataset)
    out.preview_rows = df_to_records(df.head(100))
    out.latest_analysis_run_id = run.id
    return out


def _sandbox_fallback(client: SolarAPIClient, prov: str, dev_id: str):
    """Simulated stand-in for an unreachable provider (Huawei goes through its real parser)."""
    if "huawei" in prov:
        return client.parse_huawei_response(client.build_mock_huawei_payload(dev_id=dev_id), inverter_id=dev_id)
    df, _ = generate_simulated_string_data(days=5, num_strings=8)
    return df


@router.post(
    "/plants/{plant_id}/datasets/fetch",
    response_model=DatasetDetailOut,
    status_code=status.HTTP_201_CREATED,
)
def fetch_dataset_from_api(
    plant_id: int,
    payload: FetchAPIDatasetRequest,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> DatasetDetailOut:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")

    client = SolarAPIClient()
    prov = payload.provider.lower()
    if "huawei" in prov:
        label, src_type = f"Huawei FusionSolar API ({payload.dev_id})", "huawei_api"
    elif "sungrow" in prov:
        label, src_type = f"Sungrow iSolarCloud API ({payload.ps_key})", "sungrow_api"
    else:
        label, src_type = f"Generic REST API ({payload.base_url})", "generic_rest"
    try:
        if "huawei" in prov:
            end_ms = int(datetime.now().timestamp() * 1000)
            start_ms = int((datetime.now() - timedelta(days=5)).timestamp() * 1000)
            df = client.fetch_huawei_fusionsolar(
                base_url=payload.base_url,
                xsrf_token=payload.xsrf_token,
                dev_id=payload.dev_id,
                start_time_ms=start_ms,
                end_time_ms=end_ms,
            )
        elif "sungrow" in prov:
            df = client.fetch_sungrow_isolarcloud(
                base_url=payload.base_url,
                appkey=payload.appkey,
                token=payload.token,
                ps_key=payload.ps_key,
                start_time_str=payload.start_time_str,
                end_time_str=payload.end_time_str,
            )
        else:
            df = client.fetch_generic_rest(
                endpoint_url=payload.base_url,
                method=payload.http_method,
                headers=payload.headers,
                records_key=payload.records_key,
            )
    except EndpointUnreachable as exc:
        if not payload.simulate_if_unreachable:
            raise HTTPException(status_code=400, detail=f"API fetch failed: {exc}") from exc
        # Sandbox fallback: simulated data, stored and labelled as simulated, never under the
        # provider's name. Only an unreachable endpoint falls back; a response that arrived but
        # cannot be parsed is a configuration error and stays a 400 below.
        df = _sandbox_fallback(client, prov, payload.dev_id)
        label = f"Sandbox simulator ({label} unreachable)"
        src_type = "simulated"
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"API fetch failed: {exc}") from exc

    dataset = store_dataset_from_dataframe(
        db=db,
        plant=plant,
        df=df,
        name=label,
        source_type=src_type,
        source_label=label,
    )
    run, _ = execute_and_store_analysis(db=db, plant=plant, dataset=dataset)
    out = DatasetDetailOut.model_validate(dataset)
    out.preview_rows = df_to_records(df.head(100))
    out.latest_analysis_run_id = run.id
    return out


@router.post(
    "/plants/{plant_id}/datasets/simulate",
    response_model=DatasetDetailOut,
    status_code=status.HTTP_201_CREATED,
)
def simulate_dataset(
    plant_id: int,
    payload: SimulateDatasetRequest,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> DatasetDetailOut:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")

    mods = int(payload.modules_per_string or plant.modules_per_string)
    wp = float(payload.module_wp or plant.module_wp)
    sim_df, _ = generate_simulated_string_data(
        days=payload.days,
        interval_minutes=payload.interval_minutes,
        num_strings=payload.num_strings,
        modules_per_string=mods,
        module_wp=wp,
        seed=payload.seed,
    )
    label = f"Simulated PV Dataset ({payload.num_strings} Strings, {payload.days} Days @ {payload.interval_minutes}m)"
    dataset = store_dataset_from_dataframe(
        db=db,
        plant=plant,
        df=sim_df,
        name=label,
        source_type="simulated",
        source_label=label,
    )
    run, _ = execute_and_store_analysis(db=db, plant=plant, dataset=dataset)
    out = DatasetDetailOut.model_validate(dataset)
    out.preview_rows = df_to_records(sim_df.head(100))
    out.latest_analysis_run_id = run.id
    return out
