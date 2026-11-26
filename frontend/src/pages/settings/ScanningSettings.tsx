import React, { useEffect, useRef, useState } from "react";
import { Printer, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type RedTagBatch, type ScanFieldHint } from "../../api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "../../context/AuthContext";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { signal, unlockAudio } from "../../lib/scan/feedback";
import { BurstDetector, DEFAULT_SCAN_SETTINGS, keyLike, readScanSettings, saveScanSettings, type KeyLike, type ScanSettings } from "../../lib/scan/hidScanner";
import { hasThai } from "../../lib/scan/keymap";
import { GS } from "../../lib/scan/parse";
import { NumberField, SectionHeader, num } from "./shared";

interface TestResult {
  value: string;
  keys: string;
  gaps: number[];
  end: "enter" | "tab" | "none";
  scan: boolean;
}

/** shows control characters (GS) visibly */
const visible = (s: string) => s.replace(new RegExp(GS, "g"), "␝");

/** "Test your scanner": scan into the box; it shows what arrived and how the app reads it. */
const ScannerTest: React.FC<{ settings: ScanSettings }> = ({ settings }) => {
  const { t } = useI18n();
  const events = useRef<KeyLike[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const [res, setRes] = useState<TestResult | null>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const finish = () => {
    const evs = events.current;
    events.current = [];
    if (!evs.length) return;
    const det = new BurstDetector(settings);
    let scan = false;
    let value = "";
    let keys = "";
    let gaps: number[] = [];
    for (const e of evs) {
      const s = det.feed(e);
      if (s.kind === "scan") {
        scan = true;
        ({ value, keys, gaps } = s.burst);
      }
    }
    if (!scan) {
      // no Enter / Tab: what the idle end would make of it, and the raw text either way
      const s = det.idle((evs.at(-1)?.time ?? 0) + settings.idleEndMs + 1);
      if (s?.kind === "scan") {
        scan = true;
        ({ value, keys, gaps } = s.burst);
      } else {
        const typed = evs.filter((e) => e.key.length === 1);
        keys = typed.map((e) => e.key).join("");
        value = keys;
        gaps = typed.slice(1).map((e, i) => Math.round(e.time - typed[i].time));
      }
    }
    const last = evs.at(-1)!;
    const end = last.key === "Enter" || last.code === "Enter" || last.code === "NumpadEnter" ? "enter" : last.key === "Tab" ? "tab" : "none";
    setRes({ value, keys, gaps, end, scan });
    signal(scan ? "ok" : "warn");
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === "Escape") return;
    ev.preventDefault();
    events.current.push(keyLike(ev.nativeEvent));
    window.clearTimeout(timer.current);
    if (ev.key === "Enter" || ev.key === "Tab") finish();
    else timer.current = window.setTimeout(finish, 300);
  };

  const g = res?.gaps ?? [];
  const maxGap = g.length ? Math.max(...g) : null;
  const avgGap = g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : null;

  return (
    <div className="flex flex-col gap-3">
      <div
        data-scan-field
        tabIndex={0}
        role="textbox"
        aria-label={t("Scanner test box")}
        onKeyDown={onKeyDown}
        onFocus={unlockAudio}
        className="flex min-h-20 items-center justify-center rounded-lg border border-dashed border-white/15 bg-ink-900/60 p-4 text-center text-xs text-muted-foreground outline-none focus:border-solar-400/60 focus:text-slate-200"
      >
        {t("Click here, then scan any barcode or QR label.")}
      </div>
      {res && (
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">{t("Read as")}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <code className="truncate rounded bg-ink-900 px-1.5 py-0.5 font-mono text-slate-100">{visible(res.value) || "—"}</code>
            <Badge variant={res.scan ? "ok" : "warn"}>{res.scan ? t("Taken as a scan") : t("Not taken as a scan")}</Badge>
          </dd>
          <dt className="text-muted-foreground">{t("Characters received")}</dt>
          <dd className="truncate font-mono">{visible(res.keys) || "—"}</dd>
          <dt className="text-muted-foreground">{t("Time between keys")}</dt>
          <dd className="num">
            {maxGap == null ? "—" : t("avg {avg} ms · max {max} ms (limit {limit} ms)", { avg: avgGap, max: maxGap, limit: settings.maxGapMs })}
          </dd>
          <dt className="text-muted-foreground">{t("End key (suffix)")}</dt>
          <dd>{res.end === "enter" ? "Enter" : res.end === "tab" ? "Tab" : t("None: the code ends when the keys stop")}</dd>
          {res.value.length > 0 && res.value.length < settings.minLength && (
            <dd className="col-span-2 callout-warn">{t("Shorter than the minimum length ({n}).", { n: settings.minLength })}</dd>
          )}
          {maxGap != null && maxGap > settings.maxGapMs && (
            <dd className="col-span-2 callout-warn">{t("Keys came slower than the limit: raise the gap a little, or check the scanner's transmit speed.")}</dd>
          )}
          {hasThai(res.keys) && (
            <dd className="col-span-2 callout-warn">
              {t("Thai characters arrived: the keyboard is on Thai. The app still reads the code correctly from the keys, but switch to English for other apps.")}
            </dd>
          )}
        </dl>
      )}
    </div>
  );
};

const HINT_CATEGORY: Record<string, string> = {
  datalogger: "Data logger",
  weather_station: "Weather station",
  revenue_meter: "Revenue meter",
  router: "4G router",
  pqm: "PQM",
  shinemaster: "ShineMaster",
};

/** Admin: which field of a multi-field label is the serial, per category + model (shared by everyone). */
const FieldHints: React.FC = () => {
  const { t } = useI18n();
  const [hints, setHints] = useState<ScanFieldHint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listScanFieldHints()
      .then(setHints)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const category = (c: string) => {
    if (c.startsWith("tool:")) return t("Instrument");
    if (c.endsWith(":sim")) return `${t(HINT_CATEGORY[c.slice(0, -4)] ?? c.slice(0, -4))} · SIM`;
    return t(HINT_CATEGORY[c] ?? c);
  };
  const remove = async (h: ScanFieldHint) => {
    try {
      await api.deleteScanFieldHint(h.id);
      setHints((cur) => cur?.filter((x) => x.id !== h.id) ?? null);
      notify("ok", t("Forgotten: the next {model} label asks again.", { model: h.model }));
    } catch (e) {
      notify("crit", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("Remembered label fields")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        <p className="text-[11px] text-muted-foreground">
          {t("When a label holds several values with no SN key, the field picked first is remembered for that model and pre-selected for everyone. Forget one to have the next label ask again.")}
        </p>
        {error && <p className="text-amber-200">{error}</p>}
        {hints && hints.length === 0 && <p className="text-muted-foreground">{t("Nothing remembered yet.")}</p>}
        {hints && hints.length > 0 && (
          <ul className="flex flex-col divide-y divide-white/[0.06] rounded-md border border-white/[0.07]">
            {hints.map((h) => (
              <li key={h.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <span className="w-28 shrink-0 truncate text-muted-foreground">{category(h.category)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-100">{h.model}</span>
                <span className="shrink-0 font-mono text-slate-300">
                  {h.field_key ?? t("field {n} of {total}", { n: h.field_index + 1, total: h.field_count })}
                </span>
                <Button size="icon-xs" variant="ghost" aria-label={t("Forget {model}", { model: h.model })} onClick={() => void remove(h)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

/** Admin: reserve pre-printed red tag numbers in batches and print them (plan §13 decision 3). */
const RedTags: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [batches, setBatches] = useState<RedTagBatch[] | null>(null);
  const [count, setCount] = useState("40");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .listRedTagBatches()
      .then(setBatches)
      .catch(() => setBatches([]));
  }, []);
  const n = num(count);
  const valid = n != null && Number.isInteger(n) && n >= 1 && n <= 500;
  const reserve = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const r = await api.reserveRedTags(n!);
      notify("ok", t("Reserved {first} – {last}.", { first: r.first, last: r.last }));
      navigate(`/labels?kind=rt&batch=${r.batch}`);
    } catch (e) {
      notify("crit", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("Red tags")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        <p className="text-[11px] text-muted-foreground">
          {t("Pre-printed tags for failed units. Reserve the next numbers, print them on paper tags, and crews tag a failed unit on site. Numbers are never reused.")}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <NumberField id="rt-count" label={t("How many")} unit={t("tags")} value={count} onChange={setCount} hint={t("1–500; 8 a sheet")} />
          <Button size="sm" disabled={!valid || busy} onClick={() => void reserve()}>
            {t("Reserve and print")}
          </Button>
        </div>
        {batches && batches.length > 0 && (
          <ul className="flex flex-col divide-y divide-white/[0.06] rounded-md border border-white/[0.07]">
            {batches.map((b) => (
              <li key={b.batch} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <span className="num shrink-0 font-mono text-slate-100">
                  {b.first} – {b.last}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t("{n} tags · {used} used", { n: b.count, used: b.bound })}
                  {b.reserved_by ? ` · ${b.reserved_by}` : ""}
                  {b.reserved_at ? ` · ${b.reserved_at.slice(0, 10)}` : ""}
                </span>
                <Button asChild size="icon-xs" variant="ghost" aria-label={t("Print {first} – {last}", { first: b.first, last: b.last })}>
                  <Link to={`/labels?kind=rt&batch=${b.batch}`}>
                    <Printer className="size-3.5" />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

/**
 * Settings → Scanning (docs/plans/barcode-scanning.md §4, §8): keyboard-scanner timing, prefix and
 * sound, kept per device in this browser (not on the server), and a scanner test box.
 */
export const ScanningSettings: React.FC = () => {
  const { t } = useI18n();
  const { user } = useAuth();
  const [saved, setSaved] = useState<ScanSettings>(readScanSettings);
  const [gap, setGap] = useState(String(saved.maxGapMs));
  const [minLen, setMinLen] = useState(String(saved.minLength));
  const [idle, setIdle] = useState(String(saved.idleEndMs));
  const [prefix, setPrefix] = useState(saved.prefix);

  const draft: ScanSettings = {
    maxGapMs: num(gap) ?? saved.maxGapMs,
    minLength: num(minLen) ?? saved.minLength,
    idleEndMs: num(idle) ?? saved.idleEndMs,
    prefix,
    sound: saved.sound,
  };
  const dirty = draft.maxGapMs !== saved.maxGapMs || draft.minLength !== saved.minLength || draft.idleEndMs !== saved.idleEndMs || draft.prefix !== saved.prefix;

  const save = (s: ScanSettings) => {
    saveScanSettings(s);
    const back = readScanSettings();
    setSaved(back);
    setGap(String(back.maxGapMs));
    setMinLen(String(back.minLength));
    setIdle(String(back.idleEndMs));
    setPrefix(back.prefix);
    notify("ok", t("Saved on this device."));
  };

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t("Scanning")}
        description={t("Barcode readers in keyboard mode (USB or Bluetooth) and the camera. These settings are kept on this device only, so set them up on each PC, phone or iPad.")}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Test your scanner")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ScannerTest settings={draft} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Keyboard scanner")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField id="scan-gap" label={t("Longest gap between keys")} unit="ms" value={gap} onChange={setGap} hint={t("Scanners: 2–15 ms; people: over 80 ms")} />
            <NumberField id="scan-min" label={t("Shortest code")} unit={t("characters")} value={minLen} onChange={setMinLen} />
            <NumberField id="scan-idle" label={t("End without Enter after")} unit="ms" value={idle} onChange={setIdle} hint={t("For scanners with no suffix")} />
            <div className="flex flex-col gap-1">
              <Label htmlFor="scan-prefix" className="text-xs">
                {t("Prefix")}
              </Label>
              <Input id="scan-prefix" value={prefix} maxLength={4} onChange={(e) => setPrefix(e.target.value)} placeholder={t("none")} className="font-mono" />
              <span className="text-[11px] text-muted-foreground">{t("Programmed on the scanner; a code that starts with it is a scan even inside a text field")}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!dirty} onClick={() => save(draft)}>
              {t("Save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => save({ ...DEFAULT_SCAN_SETTINGS, sound: saved.sound })}>
              {t("Back to defaults")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("Set the scanner to keyboard (HID) mode, suffix Enter, no AIM symbology ID, keyboard country US. On iPad / iPhone pair it as a keyboard in Bluetooth settings; most scanners have a scan or button to show the on-screen keyboard again.")}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Feedback")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-xs">
          <Switch
            id="scan-sound"
            checked={saved.sound}
            onCheckedChange={(on: boolean) => {
              unlockAudio();
              saveScanSettings({ ...saved, sound: on });
              setSaved(readScanSettings());
              if (on) window.setTimeout(() => signal("ok"), 50);
            }}
          />
          <Label htmlFor="scan-sound">{t("Beep on each read")}</Label>
          <span className="text-muted-foreground">{t("The box flashes green either way; phones that support it also vibrate (not iPhone).")}</span>
        </CardContent>
      </Card>
      {user?.role === "admin" && <RedTags />}
      {user?.role === "admin" && <FieldHints />}
    </div>
  );
};
