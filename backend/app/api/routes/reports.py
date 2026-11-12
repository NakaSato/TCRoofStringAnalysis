"""Engineering & O&M Report export endpoints (`pdf`, `xlsx`, `html`, `csv`)."""

from __future__ import annotations

from datetime import datetime
import io
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.db.models import AnalysisRun
from app.db.session import get_db
from app.services.solar_service import (
    get_om_dataframes_for_plant,
    reconstruct_analysis_results,
)
from solar_core.reporting import (
    generate_excel_report,
    generate_html_report,
    generate_pdf_report,
)

router = APIRouter(tags=["7. Engineering & O&M Reports"])


@router.get("/analysis/{run_id}/reports/{report_format}")
def export_report(
    run_id: int,
    report_format: str,
    db: Session = Depends(get_db),
):
    """Stream a management report in PDF, 11-Sheet Excel (.xlsx), printable HTML, or CSV."""
    run = db.get(AnalysisRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Analysis run {run_id} not found")

    results, config = reconstruct_analysis_results(db, run)
    pm_df, cm_df, rca_df, ptw_df = get_om_dataframes_for_plant(db, run.plant_id)
    slug = datetime.now().strftime("%Y%m%d_%H%M")
    fmt = report_format.lower().strip()

    if fmt == "pdf":
        pdf_bytes = generate_pdf_report(
            results,
            config,
            pm_df=pm_df if not pm_df.empty else None,
            cm_df=cm_df if not cm_df.empty else None,
            rca_df=rca_df if not rca_df.empty else None,
        )
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="Solar_OM_Engineering_Report_{slug}.pdf"'
            },
        )

    if fmt in ("xlsx", "excel"):
        excel_bytes = generate_excel_report(
            results,
            config,
            pm_df=pm_df if not pm_df.empty else None,
            cm_df=cm_df if not cm_df.empty else None,
            rca_df=rca_df if not rca_df.empty else None,
            ptw_df=ptw_df if not ptw_df.empty else None,
        )
        return StreamingResponse(
            io.BytesIO(excel_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f'attachment; filename="Solar_OM_Full_Workbook_{slug}.xlsx"'
            },
        )

    if fmt == "html":
        html_str = generate_html_report(results, config)
        return HTMLResponse(
            content=html_str,
            headers={
                "Content-Disposition": f'inline; filename="Solar_OM_Management_Summary_{slug}.html"'
            },
        )

    if fmt == "csv":
        csv_bytes = results.string_summary_df.to_csv(index=False).encode("utf-8")
        return StreamingResponse(
            io.BytesIO(csv_bytes),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="Solar_String_Summary_{slug}.csv"'
            },
        )

    raise HTTPException(
        status_code=400,
        detail=f"Unsupported report format '{report_format}'. Expected pdf, xlsx, html, or csv.",
    )
