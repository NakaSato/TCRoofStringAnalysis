"""SQLAlchemy 2.0 ORM models for the TC Roof Solar PV Full-Stack Application.

One module per domain: `users`, `legacy` (local plants of the upload / analysis pages), `growatt`
(Growatt mirror and Google Weather hours), `rules` (daily rows, I-V sweeps, issues, site events),
`om` (Calendar Team: planned O&M tasks, crews, recurring plans, per-plant planning figures), `claims`
(warranty / insurance claims), `tools` (Measuring Tools: instruments, check-outs, calibrations), `kb` (Knowledge Base: manuals and their revisions, the PDF document library), `pwa` (PWA daily meter report), `route` (Visit Route offices) and `system` (bookkeeping). Every model is imported here, so `import app.db.models` registers
them all on `Base.metadata` and `from app.db.models import X` works as before.
"""

from __future__ import annotations

from app.db.session import Base  # noqa: F401
from app.db.models.base import (  # noqa: F401
    _utcnow,
)
from app.db.models.users import (  # noqa: F401
    AlarmPushMark,
    PushToken,
    User,
    UserPlantAssignment,
)
from app.db.models.legacy import (  # noqa: F401
    AnalysisRun,
    CMWorkOrder,
    Dataset,
    Plant,
    PMTask,
    PTWPermit,
    RCARecord,
    StringSpecModel,
    TelemetryRow,
)
from app.db.models.growatt import (  # noqa: F401
    GoogleWeatherHourly,
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    inverter_installed,
    not_installed_sns,
    GrowattInverterEnergyDay,
    GrowattInverterRaw,
    GrowattInverterReading,
    GrowattMeter,
    GrowattMeterReading,
    GrowattPlant,
    GrowattPlantEnergyDay,
    GrowattPlantPower,
    GrowattStringLayout,
    GrowattStringReading,
    GrowattStringRecord,
    GrowattStringRemoved,
)
from app.db.models.rules import (  # noqa: F401
    GrowattInverterDaily,
    GrowattIssue,
    GrowattIvSweep,
    GrowattPlantDaily,
    GrowattPlantEpiFit,
    GrowattStringDaily,
    SiteEvent,
)
from app.db.models.om import (  # noqa: F401
    OmCleaningSuggestionMark,
    OmIcsFeed,
    OmPlan,
    OmPlanAssignee,
    OmPlanPlant,
    OmPlantSettings,
    OmPushMark,
    OmTask,
    OmTaskAssignee,
    OmTaskHistory,
    OmTeam,
    OmTeamMember,
)
from app.db.models.claims import (  # noqa: F401
    Claim,
    ClaimEvent,
    ClaimEvidence,
    ClaimLink,
)
from app.db.models.tools import (  # noqa: F401
    Instrument,
    InstrumentCheckout,
    InstrumentDueRecord,
)
from app.db.models.kb import (  # noqa: F401
    KbArticle,
    KbDocLink,
    KbDocPage,
    KbDocPin,
    KbDocRevision,
    KbDocument,
    KbRevision,
)
from app.db.models.pwa import (  # noqa: F401
    PwaMeterDay,
    PwaMeterExpected,
    PwaMeterSite,
)
from app.db.models.pvsyst import (  # noqa: F401
    PvsystPhase,
    PvsystStation,
)
from app.db.models.tfrs16 import (  # noqa: F401
    Tfrs16Import,
    Tfrs16Period,
    Tfrs16Phase,
    Tfrs16Remeasurement,
    Tfrs16RevenueMonth,
    Tfrs16RolloutStation,
)
from app.db.models.plant_docs import PlantDocument  # noqa: F401
from app.db.models.site_register import SiteDevice, SiteRegister  # noqa: F401
from app.db.models.route import RouteOffice  # noqa: F401
from app.db.models.system import (  # noqa: F401
    AiUsage,
    AppLog,
    AppSetting,
    ExternalApiCallCount,
    PublishedDoc,
    PublishWriteCount,
    PwaCheckSlot,
    SyncRun,
)
