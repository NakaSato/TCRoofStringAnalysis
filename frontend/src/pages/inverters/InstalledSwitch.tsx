/**
 * Inverters Growatt lists but that are not installed on site. An admin switches an inverter to
 * Inactive (with an optional note): the backend then leaves it out of every job, live call, count
 * and analysis and dismisses its open issues; its stored data stays. `NotInstalledCard` lists the
 * marked inverters, where an admin switches them back to Active. Engineers see the state only.
 */
import React, { useState } from "react";
import { api } from "../../api/client";
import type { GrowattInverter } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { notify } from "@/lib/notify";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Save the mark, tell the user, re-read the plant (the inverter moves between the lists). */
const useSetInstalled = () => {
  const { t } = useI18n();
  const { reloadPlant } = useAppContext();
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (plantId: number, sn: string, name: string, installed: boolean, note?: string) => {
    setBusy(sn);
    try {
      const r = await api.setInverterInstalled(plantId, sn, installed, note);
      notify(
        "ok",
        installed
          ? t("{name} is active again.", { name })
          : r.issues_closed
            ? t("{name} is marked not installed; {n} open issues dismissed.", { name, n: r.issues_closed })
            : t("{name} is marked not installed.", { name })
      );
      await reloadPlant();
      return true;
    } catch (e) {
      notify("crit", errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, save };
};

/** Active switch in the selected inverter's card: admins only; switching off asks first. */
export const InverterActiveSwitch: React.FC<{ plantId: number; sn: string; name: string }> = ({ plantId, sn, name }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const { busy, save } = useSetInstalled();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  if (!isAdmin(user)) return null;
  const id = `inv-active-${sn}`;
  const confirm = async () => {
    if (await save(plantId, sn, name, false, note)) setAsking(false);
  };
  return (
    <>
      <Field orientation="horizontal" className="w-auto gap-2">
        <Switch
          id={id}
          size="sm"
          checked={!asking}
          disabled={busy != null}
          onCheckedChange={(on) => {
            if (!on) {
              setNote("");
              setAsking(true);
            }
          }}
        />
        <FieldLabel htmlFor={id} className="text-xs font-normal">
          {t("Active")}
        </FieldLabel>
      </Field>
      <Dialog open={asking} onOpenChange={(o) => busy == null && setAsking(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Mark {name} as not installed?", { name })}</DialogTitle>
            <DialogDescription>
              {t(
                "For an inverter Growatt lists but that is not on site. It leaves every count, alarm, live call and analysis, and its open issues are dismissed. Its stored data is kept; switch it back to Active any time."
              )}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>{t("Note")}</FieldLabel>
            <Textarea
              id={`${id}-note`}
              rows={2}
              maxLength={255}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("e.g. registered in Growatt, never installed on the roof")}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy != null}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirm()} disabled={busy != null}>
              {busy != null && <Spinner data-icon="inline-start" />}
              {t("Mark not installed")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** The plant's inverters marked not installed; admins switch one back to Active. */
export const NotInstalledCard: React.FC<{ plantId: number; inverters: GrowattInverter[] }> = ({ plantId, inverters }) => {
  const { t, locale } = useI18n();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const { busy, save } = useSetInstalled();
  if (!inverters.length) return null;
  const name = (i: GrowattInverter) => i.alias || i.device_sn;
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>
          {t("Not installed")}
          <Badge variant="neutral">{inverters.length}</Badge>
        </CardTitle>
        <CardDescription>{t("Listed in Growatt but not on site: left out of every figure, alarm and live call on this page and the others.")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table containerClassName="border-t border-white/[0.06]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("Inverter")}</TableHead>
              <TableHead>{t("Model")}</TableHead>
              <TableHead>{t("Added to Growatt")}</TableHead>
              <TableHead>{t("Marked")}</TableHead>
              <TableHead>{t("Note")}</TableHead>
              <TableHead className="text-right">{t("Status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inverters.map((i) => {
              const id = `inv-active-${i.device_sn}`;
              const mark = i.not_installed;
              return (
                <TableRow key={i.device_sn}>
                  <TableCell>
                    <div className="font-medium text-slate-200">{name(i)}</div>
                    {i.alias && <div className="num text-[11px] text-muted-foreground">{i.device_sn}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{i.device_model || i.model || "—"}</TableCell>
                  <TableCell className="num text-muted-foreground">{i.growatt_created_at ? i.growatt_created_at.slice(0, 10) : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {mark ? [new Date(mark.at).toLocaleDateString(locale, { dateStyle: "medium" }), mark.by].filter(Boolean).join(" · ") : "—"}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={mark?.note ?? undefined}>
                    {mark?.note || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {admin ? (
                      <Field orientation="horizontal" className="w-auto justify-end gap-2">
                        {busy === i.device_sn && <Spinner className="size-3" />}
                        <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">
                          {t("Inactive")}
                        </FieldLabel>
                        <Switch
                          id={id}
                          size="sm"
                          checked={busy === i.device_sn}
                          disabled={busy != null}
                          onCheckedChange={(on) => {
                            if (on) void save(plantId, i.device_sn, name(i), true);
                          }}
                          aria-label={t("Set {name} active", { name: name(i) })}
                        />
                      </Field>
                    ) : (
                      <Badge variant="neutral">{t("Inactive")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};
