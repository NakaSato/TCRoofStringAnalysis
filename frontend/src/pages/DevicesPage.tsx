/**
 * Devices (`/devices`, Operations; docs/plans/devices-page.md): every inverter, weather sensor,
 * meter and datalogger the user may see, by tab, and the computed device checks.
 *
 * Header strip: inverters installed (DB list), the live Normal / Waiting / Fault / Offline / Not
 * checked counts (fleet inverter snapshot, memory only; the plant directory's rule) and open device
 * checks (`/growatt/devices/checks`, read on mount and Refresh). The tab is `?tab=` (inverters by
 * default); switching tab drops the other tab's query keys. The Weather sensors tab is the old
 * `/sensors` page (`SensorsView`, its Status / Info view in `?view=`), which redirects here.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { DeviceCheckList } from "../api/client";
import { fmtInt } from "../components/ui";
import { pick } from "@/lib/useUrlState";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatTile } from "./overview/StatTile";
import { hhmm } from "./sensors/format";
import { SensorsView } from "./sensors/SensorsView";
import { InvertersTab } from "./devices/InvertersTab";
import { MetersTab } from "./devices/MetersTab";
import { DataloggersTab } from "./devices/DataloggersTab";
import { ChecksTab } from "./devices/ChecksTab";
import { useDeviceInverters } from "./devices/inverters";
import type { LiveFilter } from "./devices/inverters";
import { useI18n } from "../i18n";

const TABS = ["inverters", "sensors", "meters", "dataloggers", "checks"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  inverters: "Inverters",
  sensors: "Weather sensors",
  meters: "Meters",
  dataloggers: "Dataloggers",
  checks: "Checks",
};

export const DevicesPage: React.FC = () => {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab: Tab = pick(params.get("tab"), TABS, "inverters");
  const ni = tab === "inverters" && params.get("ni") === "1";

  const inv = useDeviceInverters(ni);

  // open device checks: read once on mount and on Refresh
  const [checks, setChecks] = useState<DeviceCheckList | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [checksLoading, setChecksLoading] = useState(true);
  const [checksTick, setChecksTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setChecksLoading(true);
    api
      .listDeviceChecks()
      .then((r) => !cancelled && (setChecks(r), setChecksError(null)))
      .catch((e) => !cancelled && setChecksError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setChecksLoading(false));
    return () => {
      cancelled = true;
    };
  }, [checksTick]);

  // bumped by the page Refresh so the open Meters / Dataloggers tab re-reads too
  const [reloadSignal, setReloadSignal] = useState(0);
  const { reload } = inv;
  const refresh = useCallback(() => {
    reload();
    setChecksTick((n) => n + 1);
    setReloadSignal((n) => n + 1);
  }, [reload]);
  const busy = inv.loading || checksLoading;

  /** A new tab starts from its own defaults: the other tab's filters (same key names) are dropped. */
  const goTab = (next: Tab) => setParams(next === "inverters" ? {} : { tab: next }, { replace: true });
  /** a live tile: the Inverters tab filtered to that state (clicking the active one clears it) */
  const statusHref = (s: LiveFilter) => (tab === "inverters" && params.get("status") === s ? "/devices" : `/devices?status=${s}`);

  const c = inv.counts;
  const snap = inv.snap;
  const liveTag = !snap ? undefined : inv.sweepDone ? `${t("Live")} ${hhmm(snap.fetched_at)}` : `${fmtInt(c?.checked ?? 0)}/${fmtInt(c?.total ?? 0)}`;
  const installed = inv.list?.summary.installed;
  // first reads still on the way: skeletons in the tiles (a failed read shows "—" with its reason)
  const listLoading = !inv.list && inv.loading;
  const liveLoading = !snap && !inv.snapError;
  const checksFirst = !checks && checksLoading;
  /** a live tile's figure counts up when it first arrives */
  const live = { loading: liveLoading, countUp: true, digits: 0 } as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Devices")}</h1>
          <p className="text-xs text-muted-foreground">{t("Every inverter, sensor, meter and datalogger of your plants, with device checks")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
            {t("Refresh")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <StatTile
          label={t("Inverters installed")}
          num={installed ?? null}
          digits={0}
          countUp
          loading={listLoading}
          footer={
            inv.list
              ? t("{plants} plants · {n} not installed", { plants: fmtInt(inv.list.summary.plants), n: fmtInt(inv.list.summary.not_installed) })
              : inv.error
                ? t("List unavailable")
                : undefined
          }
          href="/devices"
          linkLabel={t("Inverters")}
        />
        <StatTile label={t("Normal")} tag={liveTag} tagWarn={!!snap && !inv.sweepDone} num={c?.normal ?? null} {...live} tone="text-emerald-300" footer={t("status 1, today")} href={statusHref("normal")} linkLabel={t("Show normal inverters")} />
        <StatTile label={t("Waiting")} num={c?.waiting ?? null} {...live} tone="text-amber-300" footer={t("status 0, today")} href={statusHref("waiting")} linkLabel={t("Show waiting inverters")} />
        <StatTile label={t("Fault")} num={c?.fault ?? null} {...live} tone="text-red-300" footer={t("status 3, today")} href={statusHref("fault")} linkLabel={t("Show inverters in fault")} />
        <StatTile label={t("Offline")} num={c?.offline ?? null} {...live} tone="text-red-300" footer={t("no record today")} href={statusHref("offline")} linkLabel={t("Show offline inverters")} />
        <StatTile
          label={t("Not checked")}
          num={c?.unchecked ?? null}
          {...live}
          footer={inv.snapError && !snap ? t("Live unavailable") : inv.sweepDone ? t("no live answer") : t("live check in progress")}
          href={statusHref("unchecked")}
          linkLabel={t("Show inverters not checked")}
        />
        <StatTile
          label={t("Open device checks")}
          num={checks ? checks.summary.total : null}
          digits={0}
          countUp
          loading={checksFirst}
          tone={checks?.summary.warn ? "text-amber-300" : undefined}
          footer={
            checks
              ? t("{warn} warn · {info} info", { warn: fmtInt(checks.summary.warn), info: fmtInt(checks.summary.info) })
              : checksError
                ? <span title={checksError}>{t("Checks unavailable")}</span>
                : undefined
          }
          href="/devices?tab=checks"
          linkLabel={t("Checks")}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => goTab(pick(v, TABS, "inverters"))} className="gap-4">
        <TabsList variant="line" className="border-0 p-0">
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k} className="px-3 py-2.5 text-sm">
              {t(TAB_LABEL[k])}
              {k === "inverters" && installed != null && <AnimatedNumber value={installed} digits={0} countUp flash={false} className="text-muted-foreground" />}
              {k === "checks" && checks && checks.summary.total > 0 && <AnimatedNumber value={checks.summary.total} digits={0} countUp flash={false} className="text-muted-foreground" />}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="inverters">{tab === "inverters" && <InvertersTab d={inv} />}</TabsContent>
        <TabsContent value="sensors">{tab === "sensors" && <SensorsView viewKey="view" embedded />}</TabsContent>
        <TabsContent value="meters">{tab === "meters" && <MetersTab reloadSignal={reloadSignal} />}</TabsContent>
        <TabsContent value="dataloggers">{tab === "dataloggers" && <DataloggersTab reloadSignal={reloadSignal} />}</TabsContent>
        <TabsContent value="checks">{tab === "checks" && <ChecksTab data={checks} error={checksError} loading={checksLoading} refresh={() => setChecksTick((n) => n + 1)} />}</TabsContent>
      </Tabs>
    </div>
  );
};

export default DevicesPage;
