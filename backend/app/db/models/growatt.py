"""Growatt OpenAPI mirror (synced by app.services.growatt_sync): registry, readings, alarm log,
string layout; and the Google Weather hours stored per plant cell."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, ForeignKeyConstraint, Index, Integer, JSON, String, select
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.db.models.base import _utcnow


class GrowattPlant(Base):
    """Plant as listed by Growatt `plant/list` (keyed by Growatt plant_id).

    Static registry fields only. Current power, lifetime energy and status are realtime
    and come from `/growatt/live/*` (memory only); they are never stored.
    """

    __tablename__ = "growatt_plants"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    # Project phase = the Growatt account (token) that lists this plant. NULL until the
    # fleet job has seen it under a phase token; treated as the first configured phase.
    phase: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    city: Mapped[Optional[str]] = mapped_column(String(255))
    country: Mapped[Optional[str]] = mapped_column(String(100))
    latitude: Mapped[Optional[float]] = mapped_column(Float)
    longitude: Mapped[Optional[float]] = mapped_column(Float)
    peak_power_kwp: Mapped[Optional[float]] = mapped_column(Float)
    create_date: Mapped[Optional[str]] = mapped_column(String(32))
    # from `plant/details` (fleet job, every growatt_sync.DETAILS_REFRESH_DAYS)
    timezone: Mapped[Optional[str]] = mapped_column(String(32))  # e.g. "GMT+7"
    address: Mapped[Optional[str]] = mapped_column(String(255))
    growatt_inverter_count: Mapped[Optional[int]] = mapped_column(Integer)  # as entered in Growatt, not counted
    growatt_datalogger_count: Mapped[Optional[int]] = mapped_column(Integer)
    details_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    inverters: Mapped[List["GrowattInverter"]] = relationship(back_populates="plant", cascade="all, delete-orphan")


class GrowattInverter(Base):
    """Inverter from Growatt `device/list` (MAX type 1/4 entries merged by serial).

    Static registry fields only; status / lost / last upload time are realtime (`/growatt/live/*`).
    """

    __tablename__ = "growatt_inverters"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), index=True, nullable=False)
    datalogger_sn: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(64))
    device_types: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "inverter,max"
    # from `device/max/max_data_info` (refreshed by the fleet job, see growatt_sync.INFO_REFRESH_DAYS)
    alias: Mapped[Optional[str]] = mapped_column(String(64))  # name set in Growatt, e.g. "INVERTER 7"
    nominal_power_w: Mapped[Optional[float]] = mapped_column(Float)  # rated AC power (`normalPower`)
    fw_version: Mapped[Optional[str]] = mapped_column(String(32))
    inner_version: Mapped[Optional[str]] = mapped_column(String(32))
    # inverter settings from the same call (configured values, not measurements)
    active_rate_pct: Mapped[Optional[float]] = mapped_column(Float)  # active power limit; < 100 = curtailed
    reactive_rate_pct: Mapped[Optional[float]] = mapped_column(Float)
    pf_setting: Mapped[Optional[float]] = mapped_column(Float)
    pf_model: Mapped[Optional[int]] = mapped_column(Integer)
    export_limit: Mapped[Optional[int]] = mapped_column(Integer)
    export_limit_rate_pct: Mapped[Optional[float]] = mapped_column(Float)
    on_off: Mapped[Optional[int]] = mapped_column(Integer)  # 1 = on, 0 = switched off
    info_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # active power limit read from the inverter (`new-api/readPower`, daytime `power_limits` job);
    # max_data_info answers its activeRate as 0, so this is the one that counts when set
    power_limit_pct: Mapped[Optional[float]] = mapped_column(Float)
    power_limit_read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # from `new-api/queryDeviceInfoParam` (fleet job, every growatt_sync.PARAM_REFRESH_DAYS)
    device_model: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "MAX 80KTL3 LV"
    datalogger_model: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. "ShineMaster"
    rated_power_w: Mapped[Optional[float]] = mapped_column(Float)  # nominal power as Growatt lists the model
    param_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # when the device was added to Growatt (`device/all/create_date`, fleet job), naive as Growatt
    # reports it (time zone not verified); not a commissioning date
    growatt_created_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    # Marked by an admin as listed in Growatt but not installed on site (`set_installed`): left
    # out of every job, live call, count and analysis (`inverter_installed()`); its stored rows stay.
    not_installed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    not_installed_by: Mapped[Optional[str]] = mapped_column(String(64))
    not_installed_note: Mapped[Optional[str]] = mapped_column(String(255))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    plant: Mapped[GrowattPlant] = relationship(back_populates="inverters")

    @property
    def active_limit_pct(self) -> Optional[float]:
        """Configured active power limit, % of rated: `readPower` when read, else `max_data_info`'s
        activeRate (usually unknown); None = unknown, never assumed 100."""
        return self.power_limit_pct if self.power_limit_pct is not None else self.active_rate_pct

    @property
    def installed(self) -> bool:
        return self.not_installed_at is None


def inverter_installed():
    """SQL condition: the inverter is not marked "not installed" (see `GrowattInverter.not_installed_at`)."""
    return GrowattInverter.not_installed_at.is_(None)


def not_installed_sns():
    """SELECT of the serials marked not installed, for `device_sn.not_in(...)` on per-inverter tables."""
    return select(GrowattInverter.device_sn).where(GrowattInverter.not_installed_at.is_not(None))


class GrowattInverterReading(Base):
    """Inverter-level 5-minute record from `device/max/max_data` (timestamp is plant-local time)."""

    __tablename__ = "growatt_inverter_readings"
    # fleet-wide time filters (newest record, one day's energy) would otherwise scan the table
    __table_args__ = (Index("ix_growatt_inv_ts", "timestamp"),)

    device_sn: Mapped[str] = mapped_column(String(64), ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    status: Mapped[Optional[int]] = mapped_column(Integer)
    pac_w: Mapped[Optional[float]] = mapped_column(Float)
    ppv_w: Mapped[Optional[float]] = mapped_column(Float)
    eac_today_kwh: Mapped[Optional[float]] = mapped_column(Float)
    eac_total_kwh: Mapped[Optional[float]] = mapped_column(Float)
    temperature_c: Mapped[Optional[float]] = mapped_column(Float)
    fac_hz: Mapped[Optional[float]] = mapped_column(Float)
    mppt_json: Mapped[Optional[Any]] = mapped_column(JSON)  # [{"mppt": n, "v": .., "i": .., "p": ..}]
    # the record's `faultType` / `warnCode` (null = none, or stored before these were kept)
    fault_code: Mapped[Optional[int]] = mapped_column(Integer)
    warn_code: Mapped[Optional[int]] = mapped_column(Integer)


class GrowattInverterRaw(Base):
    """The whole `device/max/max_data` record of an inverter reading, as Growatt reports it
    (about 255 fields: PID, ISO, DCI, GFCI, CT, bus, all temperatures, debug words, per-MPPT
    energy, ...). `data` keeps Growatt's own field names and values; nothing is derived.
    `growatt_inverter_readings` stays the table the app computes from; this one is the full
    copy for export and later use. Kept `HISTORY_RAW_RETENTION_DAYS` (it is about 4 kB a row)."""

    __tablename__ = "growatt_inverter_raw"
    __table_args__ = (Index("ix_growatt_inv_raw_ts", "timestamp"),)

    device_sn: Mapped[str] = mapped_column(String(64), ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)  # plant-local, the record's `time`
    data: Mapped[Any] = mapped_column(JSON, nullable=False)


class GrowattPlantEnergyDay(Base):
    """Growatt's own daily energy of a plant (`plant/energy`), finished days only (today's value
    is realtime). A cross-check on the energy integrated from stored records, and a figure for
    days without records. Kept indefinitely (`retention` skips it)."""

    __tablename__ = "growatt_plant_energy_days"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattInverterEnergyDay(Base):
    """Growatt's own daily energy of one inverter (`device/inverter/day_energy`), finished days
    only. Kept indefinitely (`retention` skips it)."""

    __tablename__ = "growatt_inverter_energy_days"
    __table_args__ = (Index("ix_growatt_inv_energy_plant_day", "plant_id", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    energy_kwh: Mapped[Optional[float]] = mapped_column(Float)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattPlantPower(Base):
    """Growatt's own 5-minute AC power curve of a plant (`plant/power`; timestamp plant-local),
    finished days only. Slots Growatt answers as null are not stored. Deleted with the raw
    readings after HISTORY_RETENTION_DAYS."""

    __tablename__ = "growatt_plant_power"

    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    power_w: Mapped[float] = mapped_column(Float, nullable=False)


class GrowattStringReading(Base):
    """Per-string 5-minute record (`vString{n}` / `currentString{n}`), stored only while the inverter
    produces (ppv > 0) and only for wired inputs (`growatt_sync.inverters._wired_only`, the daily
    open-string check's definition): an input with no current now, no String Layout row, no daily
    energy in 30 days and no current today is not stored."""

    __tablename__ = "growatt_string_readings"
    # No timestamp index: every read filters by device_sn (the primary key's first column), and
    # retention deletes per inverter. `ix_growatt_str_ts` (a fifth of the table's size) is dropped
    # from existing databases by `session._DROPPED_INDEXES`.

    device_sn: Mapped[str] = mapped_column(String(64), ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    mppt_no: Mapped[int] = mapped_column(Integer, nullable=False)
    voltage_v: Mapped[float] = mapped_column(Float, nullable=False)
    current_a: Mapped[float] = mapped_column(Float, nullable=False)

    # String power is V × I, so it is derived, not stored (the column was dropped Nov 2026;
    # `session._DROPPED_COLUMNS`). In a query `S.power_w` is `voltage_v * current_a`.
    @hybrid_property
    def power_w(self) -> float:
        return round(self.voltage_v * self.current_a, 1)

    @power_w.inplace.expression
    @classmethod
    def _power_w_expression(cls):
        return (cls.voltage_v * cls.current_a).label("power_w")


class GrowattEnvSensor(Base):
    """Weather (environmental) sensor on a plant's datalogger, from `device/env/env_list`.

    Keyed by (datalogger SN, bus address): Growatt lists every such sensor with `device_sn`
    "env", so the serial is useless as a key. Online state / last upload are realtime and
    are not stored.
    """

    __tablename__ = "growatt_env_sensors"

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), index=True, nullable=False)
    device_name: Mapped[Optional[str]] = mapped_column(String(64))
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattEnvReading(Base):
    """5-minute weather-sensor record from `device/env/env_data` (timestamp is plant-local time).

    Values as reported; a probe the sensor is not fitted with reads 0 (nulled per day when read).
    """

    __tablename__ = "growatt_env_readings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["datalogger_sn", "address"],
            ["growatt_env_sensors.datalogger_sn", "growatt_env_sensors.address"],
            ondelete="CASCADE",
        ),
        Index("ix_growatt_env_ts", "timestamp"),
    )

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    irradiance_wm2: Mapped[Optional[float]] = mapped_column(Float)
    ambient_temp_c: Mapped[Optional[float]] = mapped_column(Float)
    module_temp_c: Mapped[Optional[float]] = mapped_column(Float)
    humidity_pct: Mapped[Optional[float]] = mapped_column(Float)
    wind_speed_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_dir_deg: Mapped[Optional[float]] = mapped_column(Float)


class GrowattMeter(Base):
    """Energy meter on a plant's datalogger, from `device/ammeter/meter_list` (keyed like a
    weather sensor: device/list names every meter "meter"). Online state is realtime, not stored."""

    __tablename__ = "growatt_meters"

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), index=True, nullable=False)
    device_name: Mapped[Optional[str]] = mapped_column(String(64))  # e.g. CHNT_THREE
    device_type: Mapped[Optional[str]] = mapped_column(String(16))
    history_synced_until: Mapped[Optional[datetime]] = mapped_column(DateTime)  # latest reading stored
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattMeterReading(Base):
    """5-minute meter record from `device/ammeter/meter_data` (timestamp is plant-local time),
    values as reported (see `solar_core.growatt.METER_FIELDS` for what each one is known to be)."""

    __tablename__ = "growatt_meter_readings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["datalogger_sn", "address"],
            ["growatt_meters.datalogger_sn", "growatt_meters.address"],
            ondelete="CASCADE",
        ),
        Index("ix_growatt_meter_ts", "timestamp"),
    )

    datalogger_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    address: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    active_power_w: Mapped[Optional[float]] = mapped_column(Float)
    active_power_l1_w: Mapped[Optional[float]] = mapped_column(Float)
    active_power_l2_w: Mapped[Optional[float]] = mapped_column(Float)
    active_power_l3_w: Mapped[Optional[float]] = mapped_column(Float)
    reactive_power_var: Mapped[Optional[float]] = mapped_column(Float)
    power_factor: Mapped[Optional[float]] = mapped_column(Float)
    frequency_hz: Mapped[Optional[float]] = mapped_column(Float)
    import_counter_kwh: Mapped[Optional[float]] = mapped_column(Float)  # lifetime energy drawn from the grid
    forward_today_kwh: Mapped[Optional[float]] = mapped_column(Float)
    rever_active_power_raw: Mapped[Optional[float]] = mapped_column(Float)  # meaning not confirmed
    reverse_today_kwh: Mapped[Optional[float]] = mapped_column(Float)


class GrowattAlarm(Base):
    """Alarm / fault record from `device/max/alarm_data` (one inverter-day per call), synced by the
    worker's `alarms` jobs.

    Source-timestamped history (Growatt's own start/end times, plant-local, naive), not a
    realtime value. The rows of one inverter-day are replaced as a whole on each successful read,
    so an alarm's `end_time` appears once Growatt closes it. `day` is the plant-local day queried.
    """

    __tablename__ = "growatt_alarms"
    __table_args__ = (Index("ix_growatt_alarms_day_plant", "day", "plant_id"), Index("ix_growatt_alarms_sn_day", "device_sn", "day"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_sn: Mapped[str] = mapped_column(String(64), nullable=False)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[Optional[datetime]] = mapped_column(DateTime)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime)  # null = still open (as Growatt reports it)
    alarm_code: Mapped[Optional[str]] = mapped_column(String(32))
    alarm_message: Mapped[Optional[str]] = mapped_column(String(255))
    fault_type: Mapped[Optional[str]] = mapped_column(String(32))  # "Warning" / "Fault" …
    status: Mapped[Optional[int]] = mapped_column(Integer)


class GrowattAlarmSync(Base):
    """When each inverter's alarm log for a plant-local day was last read successfully (UTC).

    No row = never read: the UI shows that inverter-day as not synced, never as "no alarms".
    """

    __tablename__ = "growatt_alarm_syncs"
    __table_args__ = (Index("ix_growatt_alarm_syncs_day", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    alarm_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class GrowattStringLayout(Base):
    """As-built module count per Growatt string input, entered by an engineer.

    Growatt does not report how many modules each string has. Strings on one inverter can
    differ (e.g. 16 vs 18 modules), so peer comparisons normalize by this count when every
    string of the inverter has one. Optional `azimuth_deg` and `tilt_deg` group peers by
    orientation and tilt so East and West strings are not compared against each other.
    No FK on device_sn: the registry outlives inverter re-syncs.
    """

    __tablename__ = "growatt_string_layouts"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    modules: Mapped[int] = mapped_column(Integer, nullable=False)
    module_wp: Mapped[Optional[float]] = mapped_column(Float)  # null = not recorded
    azimuth_deg: Mapped[Optional[float]] = mapped_column(Float)  # 0..360; null = default/same group
    tilt_deg: Mapped[Optional[float]] = mapped_column(Float)  # 0..90; null = default/same group
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class GrowattStringRemoved(Base):
    """A string input an engineer removed from the String Layout editor.

    Layout only: the input is left out of `get_string_layout` even when it carried current in
    the last week. Its readings stay, and every analysis (wired inputs, string checks, daily
    rules, summaries) ignores this table. Saving a module count at the same input clears it.
    No FK on device_sn: the registry outlives inverter re-syncs.
    """

    __tablename__ = "growatt_string_removed"

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    string_no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    removed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class GoogleWeatherHourly(Base):
    """Hourly weather from the Google Maps Weather API (`history/hours`), per grid cell.

    Modelled by Google for the cell's coordinates, not measured at the plant. Plants share a
    cell when their coordinates round to the same `GOOGLE_WEATHER_CELL_DEG` grid point (see
    `services/google_weather.cell_of`). `hour` is the plant-local (Bangkok) start of the hour,
    naive like the Growatt reading tables. Only history is stored; current conditions stay in memory.
    """

    __tablename__ = "google_weather_hourly"
    __table_args__ = (Index("ix_google_weather_hour", "hour"),)

    cell_key: Mapped[str] = mapped_column(String(32), primary_key=True)  # "13.75,100.50"
    hour: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    condition: Mapped[Optional[str]] = mapped_column(String(48))
    is_daytime: Mapped[Optional[bool]] = mapped_column(Boolean)
    temp_c: Mapped[Optional[float]] = mapped_column(Float)
    feels_like_c: Mapped[Optional[float]] = mapped_column(Float)
    dew_point_c: Mapped[Optional[float]] = mapped_column(Float)
    humidity_pct: Mapped[Optional[float]] = mapped_column(Float)
    cloud_cover_pct: Mapped[Optional[float]] = mapped_column(Float)
    uv_index: Mapped[Optional[float]] = mapped_column(Float)
    precip_mm: Mapped[Optional[float]] = mapped_column(Float)
    precip_prob_pct: Mapped[Optional[float]] = mapped_column(Float)
    thunder_prob_pct: Mapped[Optional[float]] = mapped_column(Float)
    wind_speed_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_gust_ms: Mapped[Optional[float]] = mapped_column(Float)
    wind_dir_deg: Mapped[Optional[float]] = mapped_column(Float)
    pressure_hpa: Mapped[Optional[float]] = mapped_column(Float)
    visibility_km: Mapped[Optional[float]] = mapped_column(Float)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
