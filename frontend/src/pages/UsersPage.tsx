import React, { useEffect, useMemo, useState } from "react";
import { Users, UserPlus, MapPin, Save, Search, KeyRound, AlertTriangle } from "lucide-react";
import { api, UserProfile, UserRole } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { PageHeader, Panel, EmptyState, LoadingState, fmt } from "../components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const resetPassword = (u: UserProfile) => {
    const pw = window.prompt(t("New password for {user} (at least 8 characters):", { user: u.username }));
    if (pw == null) return;
    if (pw.length < 8) {
      notify("crit", t("Password must be at least 8 characters."));
      return;
    }
    run(() => api.updateUser(u.id, { password: pw }), t("Password for {user} changed.", { user: u.username }));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        eyebrow={t("System · Access Control")}
        title={t("Users & Access")}
        description={t("Admins see and manage everything. Engineers see and work on only the plants assigned to them here.")}
      />

      {loadError && (
        <div className="callout-crit flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      <CreateUserPanel
        onCreated={(u) => {
          setUsers((list) => [...(list ?? []), u]);
          if (u.role === "engineer") setSelectedId(u.id);
          notify("ok", t("User {user} created.", { user: u.username }));
        }}
        onError={(text) => notify("crit", text)}
      />

      <Panel icon={Users} title={t("Accounts")} subtitle={t("Accounts are disabled, never deleted")} bodyClassName="">
        {!users ? (
          <LoadingState label={t("Loading users…")} shape="table" />
        ) : (
          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Username")}</TableHead>
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Role")}</TableHead>
                  <TableHead>{t("Plants")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead className="text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <TableRow key={u.id} className={selectedId === u.id ? "bg-solar-500/10" : ""}>
                      <TableCell className="font-mono text-xs">{u.username ?? u.email}</TableCell>
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
                          <Button size="sm" onClick={() => setSelectedId(u.id)}>
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
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="icon-sm" onClick={() => resetPassword(u)} aria-label={t("Reset password")}>
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
      </Panel>

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
    </div>
  );
};

const CreateUserPanel: React.FC<{ onCreated: (u: UserProfile) => void; onError: (text: string) => void }> = ({
  onCreated,
  onError,
}) => {
  const empty = { username: "", full_name: "", email: "", password: "", role: "engineer" as UserRole };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const u = await api.createUser({ ...form, email: form.email.trim() || null, plant_ids: [] });
      setForm(empty);
      onCreated(u);
    } catch (err) {
      onError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel icon={UserPlus} title={t("Add user")} subtitle={t("New engineers start with no plants; assign them below")}>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-username">{t("Username")}</Label>
          <Input id="nu-username" required minLength={2} pattern="[A-Za-z0-9._\-]+"
            autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => set("username", e.target.value)} />
        </div>
        <div className="lg:col-span-2">
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-name">{t("Full name")}</Label>
          <Input id="nu-name" required value={form.full_name} onChange={(e) => set("full_name", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-email">{t("Email (optional)")}</Label>
          <Input id="nu-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-password">{t("Password")}</Label>
          <Input id="nu-password" type="password" autoComplete="new-password" required minLength={8}
            value={form.password} onChange={(e) => set("password", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-role">{t("Role")}</Label>
          <div className="flex gap-2">
            <Select value={form.role} onValueChange={(v) => set("role", v)}>
              <SelectTrigger id="nu-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="engineer">{t("engineer")}</SelectItem>
                <SelectItem value="admin">{t("admin")}</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="default" className="shrink-0" disabled={saving}>
              <UserPlus className="size-4" />
              {saving ? t("Adding…") : t("Add")}
            </Button>
          </div>
        </div>
      </form>
    </Panel>
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
    <Panel
      icon={MapPin}
      title={t("Plants assigned to {user}", { user: user.username ?? user.email })}
      subtitle={t("{n} of {total} plants selected", { n: chosen.size, total: plants.length })}
      actions={
        <Button variant="default" onClick={save} disabled={!dirty || saving}>
          <Save className="size-4" />
          {saving ? t("Saving…") : t("Save assignments")}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input className="pl-8" placeholder={t("Search plant name, id or city")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={phase} onValueChange={setPhase}>
          <SelectTrigger className="w-36" aria-label={t("Phase")}>
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
        <EmptyState icon={MapPin} title={t("No Growatt plants in the registry yet")} description={t("Run the fleet sync first.")} />
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
                <span className="block truncate font-medium text-slate-200">{p.name}</span>
                <span className="block truncate text-[11px] text-slate-500">
                  #{p.plant_id} · {p.phase != null ? t("Phase {n}", { n: p.phase }) : t("Untagged")}
                  {p.city ? ` · ${p.city}` : ""} · {p.peak_power_kwp != null ? `${fmt(p.peak_power_kwp, 1)} kWp` : "—"}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </Panel>
  );
};
