/* Start of the route: a saved office (listed first; a fresh page starts from the default one), the
   phone's location (asked only on click), a plant, or a point picked on the map. A failed or denied
   location request keeps the previous start and says why. Shown in the settings bar's start popover
   (desktop) and the settings sheet (phone); `onDone` closes them once a start is set or picking on
   the map begins.

   Admins manage the offices here (`/growatt/routes/offices`): a point start (my location / on the
   map) can be saved as an office, and each office row has a ⋯ menu to rename it, make it the default
   or delete it (a confirm step in the row). Engineers only pick from the list. */
import React, { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Briefcase, BookmarkPlus, Building2, Crosshair, LocateFixed, MapPin, MoreHorizontal, Pencil, Star, Trash2, X } from "lucide-react";
import type { RouteOffice } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { useI18n } from "../../i18n";
import { fmtInt } from "../../components/ui";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { FleetPicker } from "./FleetPicker";
import { apiErrorText } from "./format";
import { officeStart, type StartChoice, type VisitRoute } from "./useVisitRoute";

type T = (en: string, vars?: Record<string, string | number | null | undefined>) => string;

/** Backend limits of an office's name and address. */
const NAME_MAX = 80;
const ADDRESS_MAX = 200;

/** Icon, name and one detail line of a start (the popover / sheet card and the settings chip). */
export const startSummary = (start: StartChoice, t: T): { icon: LucideIcon; text: string; sub: string } => {
  if (start.kind === "plant") return { icon: Building2, text: start.name, sub: t("Plant") };
  if (start.kind === "office") return { icon: Briefcase, text: start.name, sub: start.address ? `${t("Office")} · ${start.address}` : t("Office") };
  return start.source === "gps"
    ? {
        icon: LocateFixed,
        text: t("My location"),
        sub: start.accuracy_m != null ? t("± {m} m (phone)", { m: fmtInt(start.accuracy_m) }) : `${start.lat.toFixed(4)}, ${start.lon.toFixed(4)}`,
      }
    : { icon: MapPin, text: t("Point on the map"), sub: `${start.lat.toFixed(4)}, ${start.lon.toFixed(4)}` };
};

const geoErrorText = (e: GeolocationPositionError | null): string => {
  if (!e) return "This browser cannot share its location.";
  if (e.code === e.PERMISSION_DENIED) return "Location permission was denied. Allow it in the browser's site settings, or pick a plant or a point on the map.";
  if (e.code === e.POSITION_UNAVAILABLE) return "Your position is not available right now.";
  if (e.code === e.TIMEOUT) return "Finding your position took too long.";
  return "Could not read your location.";
};

const fieldCls = "h-8 text-xs";

/* ---------------------------- name + address fields ---------------------------- */

const OfficeFields: React.FC<{
  name: string;
  setName: (v: string) => void;
  address: string;
  setAddress: (v: string) => void;
  disabled: boolean;
  onSubmit: () => void;
}> = ({ name, setName, address, setAddress, disabled, onSubmit }) => {
  const { t } = useI18n();
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={enter}
        maxLength={NAME_MAX}
        placeholder={t("Office name")}
        aria-label={t("Office name")}
        disabled={disabled}
        className={fieldCls}
      />
      <Input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        onKeyDown={enter}
        maxLength={ADDRESS_MAX}
        placeholder={t("Address (optional)")}
        aria-label={t("Address (optional)")}
        disabled={disabled}
        className={fieldCls}
      />
    </>
  );
};

/* ---------------------------- save a point as an office ---------------------------- */

const SaveOfficeForm: React.FC<{ d: VisitRoute; lat: number; lon: number; onClose: () => void }> = ({ d, lat, lon, onClose }) => {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const hasOffices = (d.offices?.length ?? 0) > 0;
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = name.trim() !== "";

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const o = await d.createOffice({
        name: name.trim(),
        address: address.trim() || null,
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        ...(makeDefault ? { is_default: true } : {}),
      });
      notify("ok", t("Saved {name} as an office", { name: o.name }));
      onClose();
    } catch (e) {
      notify("crit", t("Could not save the office: {error}", { error: apiErrorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-2">
      <div className="text-[11px] text-muted-foreground">
        {t("Save this point as an office")} <span className="num">({lat.toFixed(4)}, {lon.toFixed(4)})</span>
      </div>
      <OfficeFields name={name} setName={setName} address={address} setAddress={setAddress} disabled={busy} onSubmit={() => void save()} />
      {hasOffices ? (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <Checkbox checked={makeDefault} onCheckedChange={(c) => setMakeDefault(c === true)} disabled={busy} />
          {t("Make default")}
        </label>
      ) : (
        <div className="text-[11px] text-muted-foreground">{t("The first office becomes the default start.")}</div>
      )}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button size="xs" onClick={() => void save()} disabled={!ok || busy}>
          {busy && <Spinner data-icon="inline-start" className="size-3" />}
          {t("Save office")}
        </Button>
      </div>
    </div>
  );
};

/* ---------------------------- one office ---------------------------- */

const OfficeRow: React.FC<{
  d: VisitRoute;
  office: RouteOffice;
  current: boolean;
  admin: boolean;
  onPick: () => void;
}> = ({ d, office, current, admin, onPick }) => {
  const { t } = useI18n();
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [name, setName] = useState(office.name);
  const [address, setAddress] = useState(office.address ?? "");
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(true);
    try {
      await work();
      notify("ok", done);
      setMode("view");
    } catch (e) {
      notify("crit", t(failed, { error: apiErrorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const rename = () => {
    const n = name.trim();
    if (!n || busy) return;
    const a = address.trim();
    const patch: { name?: string; address?: string | null } = {};
    if (n !== office.name) patch.name = n;
    if (a !== (office.address ?? "")) patch.address = a || null;
    if (!Object.keys(patch).length) {
      setMode("view");
      return;
    }
    void run(() => d.updateOffice(office.id, patch), t("Office saved"), "Could not save the office: {error}");
  };
  const makeDefault = () =>
    void run(() => d.updateOffice(office.id, { is_default: true }), t("{name} is now the default start", { name: office.name }), "Could not change the default: {error}");
  const remove = () => void run(() => d.deleteOffice(office.id), t("Deleted {name}", { name: office.name }), "Could not delete the office: {error}");

  if (mode === "edit") {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-white/[0.03] p-2">
        <OfficeFields name={name} setName={setName} address={address} setAddress={setAddress} disabled={busy} onSubmit={rename} />
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setMode("view")} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="xs" onClick={rename} disabled={!name.trim() || busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Save")}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "confirm") {
    const others = (d.offices?.length ?? 0) > 1;
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-red-400/30 bg-red-500/[0.06] p-2">
        <div className="text-xs text-slate-100">{t("Delete the office {name}?", { name: office.name })}</div>
        {office.is_default && others && <div className="text-[11px] text-muted-foreground">{t("The oldest remaining office becomes the default.")}</div>}
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setMode("view")} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" size="xs" onClick={remove} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <Trash2 data-icon="inline-start" />}
            {t("Delete office")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center rounded-md border", current ? "border-solar-400/40 bg-solar-500/10" : "border-white/10 bg-white/[0.02]")}>
      <button
        type="button"
        onClick={onPick}
        aria-pressed={current}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Briefcase className={cn("size-3.5 shrink-0", current ? "text-solar-300" : "text-slate-400")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-slate-100">{office.name}</span>
            {office.is_default && (
              <Badge variant="neutral" className="shrink-0 text-solar-300">
                <Star data-icon="inline-start" className="fill-current" aria-hidden />
                {t("Default")}
              </Badge>
            )}
          </span>
          {office.address && <span className="block truncate text-[11px] text-muted-foreground">{office.address}</span>}
        </span>
      </button>
      {admin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="mr-1 shrink-0" aria-label={t("Office actions")} disabled={busy}>
              {busy ? <Spinner className="size-3" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          {/* the row turns into a form: don't hand the focus back to the trigger */}
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem
              onSelect={() => {
                setName(office.name);
                setAddress(office.address ?? "");
                setMode("edit");
              }}
            >
              <Pencil />
              {t("Rename")}
            </DropdownMenuItem>
            {!office.is_default && (
              <DropdownMenuItem onSelect={makeDefault}>
                <Star />
                {t("Make default")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setMode("confirm")}>
              <Trash2 />
              {t("Delete…")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};

/* ---------------------------- the picker ---------------------------- */

export const StartPicker: React.FC<{
  d: VisitRoute;
  picking: boolean;
  setPicking: (on: boolean) => void;
  onDone?: () => void;
}> = ({ d, picking, setPicking, onDone }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  /** the point being saved as an office ("lat,lon"); another start closes the form */
  const [saving, setSaving] = useState<string | null>(null);
  const { start, setStart, offices } = d;
  const pointKey = start?.kind === "point" ? `${start.lat},${start.lon}` : null;

  const useMyLocation = () => {
    setGeoError(null);
    setPicking(false);
    if (!("geolocation" in navigator) || !navigator.geolocation) {
      setGeoError(geoErrorText(null));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setStart({
          kind: "point",
          source: "gps",
          label: "My location",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        });
        onDone?.();
      },
      (err) => {
        setLocating(false);
        setGeoError(geoErrorText(err));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  };

  const located = d.growattPlants;
  const summary = start == null ? null : startSummary(start, t);
  const showOffices = admin || (offices?.length ?? 0) > 0 || d.officesError != null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        {summary ? (
          <>
            <summary.icon className="size-4 shrink-0 text-solar-300" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-100">{summary.text}</div>
              <div className="truncate text-[11px] text-muted-foreground">{summary.sub}</div>
            </div>
            <Button variant="ghost" size="icon-xs" onClick={() => setStart(null)} aria-label={t("Clear the start")}>
              <X />
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{t("Choose where the day starts.")}</span>
        )}
      </div>
      {admin && start?.kind === "point" &&
        (saving != null && saving === pointKey ? (
          <SaveOfficeForm d={d} lat={start.lat} lon={start.lon} onClose={() => setSaving(null)} />
        ) : (
          <Button variant="outline" size="xs" onClick={() => setSaving(pointKey)} className="self-start">
            <BookmarkPlus data-icon="inline-start" />
            {t("Save as office")}
          </Button>
        ))}

      {showOffices && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("Office")}</div>
          {offices == null ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              {t("Loading offices…")}
            </div>
          ) : d.officesError && offices.length === 0 ? (
            <p className="callout-warn rounded-md px-2.5 py-1.5 text-[11px]">{t("Could not load the offices: {error}", { error: d.officesError })}</p>
          ) : offices.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("No offices yet. Pick a point on the map or use your location, then save it as an office.")}
            </p>
          ) : (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {offices.map((o) => (
                <OfficeRow
                  key={o.id}
                  d={d}
                  office={o}
                  admin={admin}
                  current={start?.kind === "office" && start.office_id === o.id}
                  onPick={() => {
                    setGeoError(null);
                    setPicking(false);
                    setStart(officeStart(o));
                    onDone?.();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {showOffices && <div className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("Or start from")}</div>}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={useMyLocation} disabled={locating}>
            {locating ? <Spinner data-icon="inline-start" className="size-3" /> : <LocateFixed data-icon="inline-start" />}
            {t("Use my location")}
          </Button>
          <FleetPicker
            plants={located}
            ariaLabel={t("Start at a plant")}
            label={
              <span className="inline-flex items-center gap-1">
                <Building2 className="size-3" aria-hidden />
                {t("A plant")}
              </span>
            }
            onPick={(id) => {
              const p = d.plantById.get(id);
              if (!p || p.latitude == null || p.longitude == null) return;
              setGeoError(null);
              setPicking(false);
              setStart({ kind: "plant", plant_id: id, name: p.name, lat: p.latitude, lon: p.longitude });
              onDone?.();
            }}
          />
          <Button
            variant={picking ? "secondary" : "outline"}
            size="sm"
            aria-pressed={picking}
            onClick={() => {
              setPicking(!picking);
              if (!picking) onDone?.();
            }}
          >
            <Crosshair data-icon="inline-start" />
            {picking ? t("Cancel picking") : t("Pick on map")}
          </Button>
        </div>
      </div>
      {geoError && <p className="callout-warn rounded-md px-2.5 py-1.5 text-[11px]">{t(geoError)}</p>}
    </div>
  );
};
