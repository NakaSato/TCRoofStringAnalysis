import React from "react";
import { Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { translate, useI18n } from "../../i18n";
import { notify } from "@/lib/notify";

export type Notice = { tone: "ok" | "warn" | "crit"; text: string } | null;

/** What a save's Firestore publish did, as one notice. */
export interface Published {
  sink: string | null;
  written: number;
  deferred?: boolean;
  error?: string;
}

export const publishNotice = (p: Published | null | undefined): Notice =>
  !p
    ? { tone: "ok", text: translate("Saved.") }
    : p.error
    ? { tone: "warn", text: translate("Saved. Publishing to {sink} failed ({error}); the next publish job retries.", { sink: p.sink ?? translate("the summary sink"), error: p.error }) }
    : p.deferred
    ? { tone: "warn", text: translate("Saved. Today's Firestore write budget is used up; it publishes on the next quota day.") }
    : { tone: "ok", text: translate("Saved and published to {sink} ({n} write).", { sink: p.sink === "firestore" ? "Firestore" : p.sink ?? "sink", n: p.written ?? 0 }) };

/** A save's outcome as a toast; checks before saving stay on the page as a `NoticeLine`. */
export const notifyNotice = (n: Notice) => {
  if (n) notify(n.tone, n.text);
};

/** "Default (not saved yet)" or "Saved by X · time", as a quiet badge. */
export const SavedStamp: React.FC<{ source: "default" | "saved"; by: string | null; at: string | null }> = ({ source, by, at }) => {
  const { t, locale } = useI18n();
  if (source === "default") return <Badge variant="warn">{t("Default (not saved yet)")}</Badge>;
  return (
    <span className="text-[11px] text-muted-foreground">
      {t("Saved by {user}", { user: by ?? "—" })}
      {at ? ` · ${new Date(at).toLocaleString(locale)}` : ""}
    </span>
  );
};

/** Title row of a settings section: what it is, what uses it, and when it was saved. */
export const SectionHeader: React.FC<{ title: string; description: string; aside?: React.ReactNode }> = ({ title, description, aside }) => (
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="max-w-2xl text-xs text-muted-foreground">{description}</p>
    </div>
    {aside}
  </div>
);

export const NoticeLine: React.FC<{ notice: Notice }> = ({ notice }) =>
  notice ? <div className={`callout-${notice.tone} text-xs`} role={notice.tone === "crit" ? "alert" : "status"}>{notice.text}</div> : null;

/** Sticky bar at the bottom of an editable section: shown while there are unsaved changes. */
export const SaveBar: React.FC<{
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  note?: string;
  label?: string;
  /** false = Save disabled (e.g. invalid values); the note says why */
  canSave?: boolean;
}> = ({ dirty, saving, onSave, onReset, note, label, canSave = true }) => {
  const { t } = useI18n();
  if (!dirty && !saving) return null;
  return (
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-solar-500/30 bg-ink-900/95 px-4 py-2.5 shadow-lg backdrop-blur">
      <div className="min-w-0 text-xs">
        <span className="font-medium text-solar-300">{t("Unsaved changes")}</span>
        {note && <span className="ml-2 text-muted-foreground">{note}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onReset} disabled={saving}>
          <Undo2 data-icon="inline-start" />
          {t("Discard")}
        </Button>
        <Button type="button" size="sm" variant="default" onClick={onSave} disabled={saving || !canSave}>
          {saving ? <Spinner className="size-3" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {saving ? t("Saving…") : label ?? t("Save")}
        </Button>
      </div>
    </div>
  );
};

/** A labelled number input with its unit on the right. */
export const NumberField: React.FC<{
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  step?: string;
  disabled?: boolean;
  hint?: string;
  invalid?: boolean;
  className?: string;
}> = ({ id, label, value, onChange, unit, step = "any", disabled, hint, invalid, className }) => (
  <Field className={cn("gap-1.5", className)} data-invalid={invalid || undefined}>
    <FieldLabel htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
      {label}
    </FieldLabel>
    <InputGroup>
      <InputGroupInput
        id={id}
        type="number"
        step={step}
        inputMode="decimal"
        className="num"
        placeholder="—"
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {unit && (
        <InputGroupAddon align="inline-end">
          <InputGroupText className="text-[11px]">{unit}</InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
    {hint && <FieldDescription className="text-[11px]">{hint}</FieldDescription>}
  </Field>
);

export const num = (v: string | undefined) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
