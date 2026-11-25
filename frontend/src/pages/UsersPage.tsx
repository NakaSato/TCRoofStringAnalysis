import React, { useEffect, useMemo, useState } from "react";
import { UserPlus, MapPin, Save, Search, KeyRound } from "lucide-react";
import { api, UserProfile, UserRole } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { SkeletonRows, fmt } from "../components/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Field } from "./tools/dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { useI18n } from "../i18n";
import { notify } from "@/lib/notify";

/**
 * Admin only. Two roles:
 * - admin: everything.
 * - engineer: only the Growatt plants assigned here (checked by the backend on every request,
 *   so a change applies at once, without the engineer signing in again).
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const UsersPage: React.FC = () => {
  const { user: me, growattPlants } = useAppContext();
  const { t } = useI18n();
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  // action outcomes are toasts; only a failed load is shown on the page
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<UserProfile | null>(null);

  const load = () =>
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setLoadError(t("Failed to load users: {error}", { error: errText(e) })));

  useEffect(() => {
    load();
  }, []);

  const replace = (u: UserProfile) => setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)));
  const selected = users?.find((u) => u.id === selectedId) ?? null;

  const run = async (fn: () => Promise<UserProfile>, ok: string) => {
    try {
      replace(await fn());
      notify("ok", ok);
    } catch (e) {
      notify("crit", errText(e));
    }
  };

  const changeRole = (u: UserProfile, role: UserRole) =>
    run(() => api.updateUser(u.id, { role }), t("{user} is now {role}.", { user: u.username, role: t(role) }));
  const toggleActive = (u: UserProfile) =>
    run(() => api.updateUser(u.id, { is_active: !u.is_active }), u.is_active ? t("{user} disabled.", { user: u.username }) : t("{user} enabled.", { user: u.username }));
  const resetPassword = (u: UserProfile, pw: string) =>
    run(() => api.updateUser(u.id, { password: pw }), t("Password for {user} changed.", { user: u.username }));
  const admins = users?.filter((u) => u.role === "admin" && u.is_active).length ?? 0;
  const engineers = users?.filter((u) => u.role === "engineer" && u.is_active).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Users & Access")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("Admins see and manage everything. Engineers see and work on only the plants assigned to them here.")}
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <UserPlus data-icon="inline-start" />
          {t("Add user")}
        </Button>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("Accounts")}
            {users && (
              <span className="num text-xs font-normal text-muted-foreground">
                {t("{admins} admin · {engineers} engineer active", { admins, engineers })}
              </span>
            )}
          </CardTitle>
          <CardDescription>{t("Accounts are disabled, never deleted")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
        {!users ? (
          <SkeletonRows rows={5} className="px-4" />
        ) : (
          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{t("Username")}</TableHead>
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Role")}</TableHead>
                  <TableHead>{t("Plants")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead className="pr-4 text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <TableRow key={u.id} className={selectedId === u.id ? "bg-solar-500/10" : ""}>
                      <TableCell className="pl-4 font-mono text-xs">{u.username ?? u.email}</TableCell>
                      <TableCell>{u.full_name}</TableCell>
                      <TableCell>
                        <Select value={u.role} disabled={self} onValueChange={(v) => changeRole(u, v as UserRole)}>
                          <SelectTrigger
                            size="sm"
                            className="w-28 text-[11px]"
                            title={self ? t("You cannot change your own role") : undefined}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">{t("admin")}</SelectItem>
                            <SelectItem value="engineer">{t("engineer")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {u.role === "admin" ? (
                          <Badge variant="info">{t("All plants")}</Badge>
                        ) : (
                          <Button size="sm" variant={selectedId === u.id ? "accent" : "secondary"} onClick={() => setSelectedId(u.id)}>
                            <MapPin className="size-3.5" />
                            {t("{n} assigned", { n: u.plant_ids?.length ?? 0 })}
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.is_active ? "ok" : "neutral"}>
                          {u.is_active ? t("Active") : t("Disabled")}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <div className="inline-flex gap-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="icon-sm" onClick={() => setPwFor(u)} aria-label={t("Reset password")}>
                                <KeyRound className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("Reset password")}</TooltipContent>
                          </Tooltip>
                          {!self && (
                            <Button size="sm" variant={u.is_active ? "destructive" : "secondary"} onClick={() => toggleActive(u)}>
                              {u.is_active ? t("Disable") : t("Enable")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
          </Table>
        )}
        </CardContent>
      </Card>

      {selected && selected.role === "engineer" && (
        <PlantAssignmentPanel
          key={selected.id}
          user={selected}
          plants={growattPlants}
          onSaved={(u) => {
            replace(u);
            notify("ok", t("{user}: {n} plant(s) assigned.", { user: u.username, n: u.plant_ids?.length ?? 0 }));
          }}
          onError={(text) => notify("crit", text)}
        />
      )}

      <CreateUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(u) => {
          setAdding(false);
          setUsers((list) => [...(list ?? []), u]);
          if (u.role === "engineer") setSelectedId(u.id);
          notify("ok", t("User {user} created.", { user: u.username }));
        }}
      />
      <PasswordDialog
        user={pwFor}
        onClose={() => setPwFor(null)}
        onSave={async (pw) => {
          if (pwFor) await resetPassword(pwFor, pw);
          setPwFor(null);
        }}
      />
    </div>
  );
};

/** Reset another user's password (was `window.prompt`). */
const PasswordDialog: React.FC<{ user: UserProfile | null; onClose: () => void; onSave: (pw: string) => Promise<void> }> = ({ user, onClose, onSave }) => {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setPw(""), [user]);
  const ok = pw.length >= 8;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      await onSave(pw);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={user != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("Reset password")}</DialogTitle>
            <DialogDescription>{t("New password for {user} (at least 8 characters):", { user: user?.username ?? "" })}</DialogDescription>
          </DialogHeader>
          <Field id="pw-new" label={t("Password")} hint={pw && !ok ? t("Password must be at least 8 characters.") : undefined}>
            <Input id="pw-new" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button type="submit" variant="default" disabled={!ok || busy}>
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const CreateUserDialog: React.FC<{ open: boolean; onClose: () => void; onCreated: (u: UserProfile) => void }> = ({ open, onClose, onCreated }) => {
  const empty = { username: "", full_name: "", email: "", password: "", role: "engineer" as UserRole };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    if (open) {
      setForm(empty);
      setError(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.createUser({ ...form, email: form.email.trim() || null, plant_ids: [] }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("Add user")}</DialogTitle>
            <DialogDescription>{t("New engineers start with no plants; assign them below")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="nu-username" label={t("Username")}>
              <Input id="nu-username" required minLength={2} pattern="[A-Za-z0-9._\-]+" autoCapitalize="none" spellCheck={false} autoFocus
                value={form.username} onChange={(e) => set("username", e.target.value)} />
            </Field>
            <Field id="nu-role" label={t("Role")}>
              <Select value={form.role} onValueChange={(v) => set("role", v)}>
                <SelectTrigger id="nu-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="engineer">{t("engineer")}</SelectItem>
                  <SelectItem value="admin">{t("admin")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="nu-name" label={t("Full name")} wide>
              <Input id="nu-name" required value={form.full_name} onChange={(e) => set("full_name", e.target.value)} />
            </Field>
            <Field id="nu-email" label={t("Email (optional)")}>
              <Input id="nu-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field id="nu-password" label={t("Password")}>
              <Input id="nu-password" type="password" autoComplete="new-password" required minLength={8}
                value={form.password} onChange={(e) => set("password", e.target.value)} />
            </Field>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t("Cancel")}
            </Button>
            <Button type="submit" variant="default" disabled={saving}>
              {saving ? <Spinner data-icon="inline-start" className="size-3" /> : <UserPlus data-icon="inline-start" />}
              {saving ? t("Adding…") : t("Add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const PlantAssignmentPanel: React.FC<{
  user: UserProfile;
  plants: { plant_id: number; name: string; phase?: number | null; city: string | null; peak_power_kwp: number | null }[];
  onSaved: (u: UserProfile) => void;
  onError: (text: string) => void;
}> = ({ user, plants, onSaved, onError }) => {
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(user.plant_ids ?? []));
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();

  const phases = useMemo(
    () => [...new Set(plants.map((p) => p.phase ?? null))].sort((a, b) => (a ?? 99) - (b ?? 99)),
    [plants]
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...plants]
      .filter((p) => phase === "all" || String(p.phase ?? "none") === phase)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.plant_id).includes(q) || (p.city ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [plants, query, phase]);

  const toggle = (id: number) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setVisible = (on: boolean) =>
    setChosen((s) => {
      const n = new Set(s);
      visible.forEach((p) => (on ? n.add(p.plant_id) : n.delete(p.plant_id)));
      return n;
    });

  const dirty =
    chosen.size !== (user.plant_ids?.length ?? 0) || (user.plant_ids ?? []).some((id) => !chosen.has(id));

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await api.setUserPlants(user.id, [...chosen]));
    } catch (e) {
      onError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{t("Plants assigned to {user}", { user: user.username ?? user.email })}</CardTitle>
          <CardDescription>{t("{n} of {total} plants selected", { n: chosen.size, total: plants.length })}</CardDescription>
        </div>
        <Button size="sm" variant="default" onClick={save} disabled={!dirty || saving}>
          {saving ? <Spinner data-icon="inline-start" className="size-3" /> : <Save data-icon="inline-start" />}
          {saving ? t("Saving…") : t("Save assignments")}
        </Button>
      </CardHeader>
      <CardContent>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <InputGroup className="h-8 min-w-[200px] flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput placeholder={t("Search plant name, id or city")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </InputGroup>
        <Select value={phase} onValueChange={setPhase}>
          <SelectTrigger size="sm" className="w-36" aria-label={t("Phase")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All phases")}</SelectItem>
            {phases.map((ph) => (
              <SelectItem key={ph ?? "none"} value={ph == null ? "none" : String(ph)}>
                {ph == null ? t("Untagged") : t("Phase {n}", { n: ph })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setVisible(true)}>{t("Select shown")}</Button>
        <Button size="sm" onClick={() => setVisible(false)}>{t("Clear shown")}</Button>
      </div>
      {plants.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("No Growatt plants in the registry yet")}</EmptyTitle>
            <EmptyDescription>{t("Run the fleet sync first.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <label
              key={p.plant_id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition ${
                chosen.has(p.plant_id) ? "border-solar-400/40 bg-solar-500/10" : "border-white/[0.06] hover:bg-white/[0.03]"
              }`}
            >
              <Checkbox checked={chosen.has(p.plant_id)} onCheckedChange={() => toggle(p.plant_id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{p.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  #{p.plant_id} · {p.phase != null ? t("Phase {n}", { n: p.phase }) : t("Untagged")}
                  {p.city ? ` · ${p.city}` : ""} · {p.peak_power_kwp != null ? `${fmt(p.peak_power_kwp, 1)} kWp` : "—"}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      </CardContent>
    </Card>
  );
};
