import React, { useEffect, useMemo, useState } from "react";
import { Users, UserPlus, MapPin, Save, Search, KeyRound, CheckCircle2, AlertTriangle } from "lucide-react";
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

/**
 * Admin only. Two roles:
 * - admin: everything.
 * - engineer: only the Growatt plants assigned here (checked by the backend on every request,
 *   so a change applies at once, without the engineer signing in again).
 */
type Msg = { tone: "ok" | "crit"; text: string } | null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const UsersPage: React.FC = () => {
  const { user: me, growattPlants } = useAppContext();
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = () =>
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setMsg({ tone: "crit", text: `Failed to load users: ${errText(e)}` }));

  useEffect(() => {
    load();
  }, []);

  const replace = (u: UserProfile) => setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)));
  const selected = users?.find((u) => u.id === selectedId) ?? null;

  const run = async (fn: () => Promise<UserProfile>, ok: string) => {
    setMsg(null);
    try {
      replace(await fn());
      setMsg({ tone: "ok", text: ok });
    } catch (e) {
      setMsg({ tone: "crit", text: errText(e) });
    }
  };

  const changeRole = (u: UserProfile, role: UserRole) =>
    run(() => api.updateUser(u.id, { role }), `${u.username} is now ${role}.`);
  const toggleActive = (u: UserProfile) =>
    run(() => api.updateUser(u.id, { is_active: !u.is_active }), `${u.username} ${u.is_active ? "disabled" : "enabled"}.`);
  const resetPassword = (u: UserProfile) => {
    const pw = window.prompt(`New password for ${u.username} (at least 8 characters):`);
    if (pw == null) return;
    if (pw.length < 8) {
      setMsg({ tone: "crit", text: "Password must be at least 8 characters." });
      return;
    }
    run(() => api.updateUser(u.id, { password: pw }), `Password for ${u.username} changed.`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        eyebrow="System · Access Control"
        title="Users & Access"
        description="Admins see and manage everything. Engineers see and work on only the plants assigned to them here."
      />

      {msg && (
        <div className={`flex items-center gap-2 font-medium ${msg.tone === "ok" ? "callout-ok" : "callout-crit"}`}>
          {msg.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}

      <CreateUserPanel
        onCreated={(u) => {
          setUsers((list) => [...(list ?? []), u]);
          if (u.role === "engineer") setSelectedId(u.id);
          setMsg({ tone: "ok", text: `User ${u.username} created.` });
        }}
        onError={(text) => setMsg({ tone: "crit", text })}
      />

      <Panel icon={Users} title="Accounts" subtitle="Accounts are disabled, never deleted" bodyClassName="">
        {!users ? (
          <LoadingState label="Loading users…" shape="table" />
        ) : (
          <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Plants</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
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
                            title={self ? "You cannot change your own role" : undefined}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="engineer">engineer</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {u.role === "admin" ? (
                          <Badge variant="info">All plants</Badge>
                        ) : (
                          <Button size="sm" onClick={() => setSelectedId(u.id)}>
                            <MapPin className="size-3.5" />
                            {u.plant_ids?.length ?? 0} assigned
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.is_active ? "ok" : "neutral"}>
                          {u.is_active ? "Active" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="icon-sm" onClick={() => resetPassword(u)} aria-label="Reset password">
                                <KeyRound className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Reset password</TooltipContent>
                          </Tooltip>
                          {!self && (
                            <Button size="sm" variant={u.is_active ? "destructive" : "secondary"} onClick={() => toggleActive(u)}>
                              {u.is_active ? "Disable" : "Enable"}
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
            setMsg({ tone: "ok", text: `${u.username}: ${u.plant_ids?.length ?? 0} plant(s) assigned.` });
          }}
          onError={(text) => setMsg({ tone: "crit", text })}
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
    <Panel icon={UserPlus} title="Add user" subtitle="New engineers start with no plants; assign them below">
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-username">Username</Label>
          <Input id="nu-username" required minLength={2} pattern="[A-Za-z0-9._\-]+"
            autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => set("username", e.target.value)} />
        </div>
        <div className="lg:col-span-2">
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-name">Full name</Label>
          <Input id="nu-name" required value={form.full_name} onChange={(e) => set("full_name", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-email">Email (optional)</Label>
          <Input id="nu-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-password">Password</Label>
          <Input id="nu-password" type="password" autoComplete="new-password" required minLength={8}
            value={form.password} onChange={(e) => set("password", e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-medium text-slate-400" htmlFor="nu-role">Role</Label>
          <div className="flex gap-2">
            <Select value={form.role} onValueChange={(v) => set("role", v)}>
              <SelectTrigger id="nu-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="engineer">engineer</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="default" className="shrink-0" disabled={saving}>
              <UserPlus className="size-4" />
              {saving ? "Adding…" : "Add"}
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
      title={`Plants assigned to ${user.username ?? user.email}`}
      subtitle={`${chosen.size} of ${plants.length} plants selected`}
      actions={
        <Button variant="default" onClick={save} disabled={!dirty || saving}>
          <Save className="size-4" />
          {saving ? "Saving…" : "Save assignments"}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input className="pl-8" placeholder="Search plant name, id or city" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={phase} onValueChange={setPhase}>
          <SelectTrigger className="w-36" aria-label="Phase">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All phases</SelectItem>
            {phases.map((ph) => (
              <SelectItem key={ph ?? "none"} value={ph == null ? "none" : String(ph)}>
                {ph == null ? "Untagged" : `Phase ${ph}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setVisible(true)}>Select shown</Button>
        <Button size="sm" onClick={() => setVisible(false)}>Clear shown</Button>
      </div>
      {plants.length === 0 ? (
        <EmptyState icon={MapPin} title="No Growatt plants in the registry yet" description="Run the fleet sync first." />
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <label
              key={p.plant_id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition ${
                chosen.has(p.plant_id) ? "border-solar-400/40 bg-solar-500/10" : "border-white/[0.06] hover:bg-white/[0.03]"
              }`}
            >
              <input type="checkbox" checked={chosen.has(p.plant_id)} onChange={() => toggle(p.plant_id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-200">{p.name}</span>
                <span className="block truncate text-[11px] text-slate-500">
                  #{p.plant_id} · {p.phase != null ? `Phase ${p.phase}` : "Untagged"}
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
