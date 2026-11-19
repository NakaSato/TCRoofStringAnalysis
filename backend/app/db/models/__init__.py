"""SQLAlchemy 2.0 ORM models for the TC Roof Solar PV Full-Stack Application.

One module per domain: `users`, `legacy` (local plants of the upload / analysis pages), `growatt`
(Growatt mirror and Google Weather hours), `rules` (daily rows, I-V sweeps, issues, site events),
`om` (Calendar Team: planned O&M tasks, crews, recurring plans, per-plant planning figures) and `system` (bookkeeping). Every model is imported here, so `import app.db.models` registers
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
    OmPlan,
    OmPlanAssignee,
    OmPlanPlant,
    OmPlantSettings,
    OmTask,
    OmTaskAssignee,
    OmTaskHistory,
    OmTeam,
    OmTeamMember,
)
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
