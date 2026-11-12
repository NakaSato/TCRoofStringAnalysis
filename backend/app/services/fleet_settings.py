"""Fleet-wide settings (global data), stored in SQL `app_settings` and mirrored to Firestore.

`fleet_module` is the PV module used across all plants. Until someone saves it, the operator's
stated module is returned with `source = "default"`: ZNShine ZXM7-UHLDD144 570 W, STC values
from the manufacturer datasheet (ZXM7-UHLDD144 2301.E, 555-580 W series).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.db.models import AppSetting

FLEET_MODULE_KEY = "fleet_module"

DEFAULT_FLEET_MODULE: Dict[str, Any] = {
    "manufacturer": "ZNShine",
    "model": "ZXM7-UHLDD144-570",
    "wp": 570.0,
    "vmp_stc": 42.40,
    "imp_stc": 13.45,
    "voc_stc": 51.10,
    "isc_stc": 14.23,
    "efficiency_pct": 22.07,
    "temp_coeff_pmax_pct": -0.30,
    "temp_coeff_voc_pct": -0.25,
    "temp_coeff_isc_pct": 0.046,
    "bifacial_factor_pct": 80.0,
    "datasheet_url": "https://solarpvpros.com/content/Products/ZNShine/ZXM7-UHLDD144-580W.pdf",
}


def get_fleet_module(db: Session) -> Dict[str, Any]:
    row = db.get(AppSetting, FLEET_MODULE_KEY)
    if row is None:
        return {**DEFAULT_FLEET_MODULE, "source": "default", "updated_by": None, "updated_at": None}
    return {
        **row.value,
        "source": "saved",
        "updated_by": row.updated_by,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def put_fleet_module(db: Session, value: Dict[str, Any], username: Optional[str]) -> Dict[str, Any]:
    row = db.get(AppSetting, FLEET_MODULE_KEY)
    if row is None:
        db.add(AppSetting(key=FLEET_MODULE_KEY, value=value, updated_by=username))
    else:
        row.value = value
        row.updated_by = username
    db.commit()
    return get_fleet_module(db)


def config_docs(db: Session) -> List[Tuple[str, Dict[str, Any]]]:
    """Firestore `config/*` documents (the timestamp is left out so unchanged content is skipped)."""
    m = get_fleet_module(db)
    m.pop("updated_at", None)
    return [(f"config/{FLEET_MODULE_KEY}", m)]
