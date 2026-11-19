/** Calendar Team crews (admin): create, rename, recolour, set members, deactivate or delete a team.
 * A team with no members is a contractor crew without logins; tasks can still be planned for it.
 * Deleting a team keeps its tasks (they lose the team, keep their assignees). */
import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import type { OmPerson, OmTeam } from "../../api/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { personName } from "./format";

const COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#f472b6", "#2dd4bf", "#fb923c"];

interface Draft {
  id: number | null;
  name: string;
  color: string | null;
  active: boolean;
  member_ids: number[];
}

const blank: Draft = { id: null, name: "", color: null, active: true, member_ids: [] };

const Dot: React.FC<{ color: string | null; className?: string }> = ({ color, className }) => (
  <span className={cn("inline-block size-2.5 shrink-0 rounded-full border border-white/20", className)} style={{ background: color ?? "transparent" }} />
);

export const TeamsDialog: React.FC<{ open: boolean; onClose: () => void; onChanged: () => void }> = ({ open, onClose, onChanged }) => {
  const [teams, setTeams] = useState<OmTeam[] | null>(null);
  const [users, setUsers] = useState<OmPerson[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [t, a] = await Promise.all([api.listOmTeams(true), api.listOmAssignees()]);
      setTeams(t);
      setUsers(a.users);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setTeams(null);
    void load();
  }, [open]);

  const edit = (t: OmTeam | null) => {
    setConfirmDelete(false);
    setError(null);
    setDraft(t ? { id: t.id, name: t.name, color: t.color, active: t.active, member_ids: t.members.map((m) => m.id) } : { ...blank, color: COLORS[(teams?.length ?? 0) % COLORS.length] });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setDraft(null);
      setConfirmDelete(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft) return;
    // only active users can be members (an inactive one drops out on save)
    const body = { name: draft.name.trim(), color: draft.color, active: draft.active, member_ids: draft.member_ids.filter((id) => users.some((u) => u.id === id)) };
    void run(() => (draft.id == null ? api.createOmTeam(body) : api.patchOmTeam(draft.id, body)));
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.id == null ? "New team" : "Edit team") : "Teams"}</DialogTitle>
          <DialogDescription>
            {draft
              ? "A team with no members works as a contractor crew without logins."
              : "Crews that tasks can be planned for. Work given to a team with no people assigned gets the team's own row in the week view."}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-red-300">{error}</p>}

        {!draft ? (
          teams == null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="size-4" />
            </div>
          ) : teams.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No teams yet.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06] rounded-md border border-white/[0.06]">
              {teams.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => edit(t)} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-white/[0.03]">
                    <Dot color={t.color} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {t.name}
                        {!t.active && <Badge variant="outline">Inactive</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {t.members.length ? t.members.map(personName).join(", ") : "No members (contractor crew)"}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Name</Label>
              <Input id="team-name" value={draft.name} maxLength={80} autoFocus onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Cleaning crew A" />
            </div>
            <div className="space-y-1.5">
              <Label>Colour</Label>
              <div className="flex flex-wrap items-center gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    aria-pressed={draft.color === c}
                    onClick={() => set({ color: c })}
                    className={cn("size-6 rounded-full border-2 transition", draft.color === c ? "border-white" : "border-transparent opacity-70 hover:opacity-100")}
                    style={{ background: c }}
                  />
                ))}
                <Button variant="ghost" size="sm" onClick={() => set({ color: null })} disabled={draft.color == null}>
                  None
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Members</Label>
              {users.length === 0 ? (
                <p className="text-xs text-muted-foreground">No active users.</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {users.map((u) => (
                    <label key={u.id} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={draft.member_ids.includes(u.id)}
                        onCheckedChange={(c) => set({ member_ids: c ? [...draft.member_ids, u.id] : draft.member_ids.filter((x) => x !== u.id) })}
                      />
                      <span className="truncate">{personName(u)}</span>
                      {u.role === "admin" && <span className="text-muted-foreground">admin</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={draft.active} onCheckedChange={(c) => set({ active: c === true })} />
              Active (inactive teams can't be picked for new tasks)
            </label>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {draft?.id != null &&
              (confirmDelete ? (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(() => api.deleteOmTeam(draft.id!))}>
                  Delete team: its tasks keep their people
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Delete…
                </Button>
              ))}
          </div>
          <div className="flex gap-2">
            {draft ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                  Back
                </Button>
                <Button size="sm" disabled={busy || !draft.name.trim()} onClick={save}>
                  {busy && <Spinner data-icon="inline-start" className="size-3" />}
                  {draft.id == null ? "Create team" : "Save"}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => edit(null)} disabled={teams == null}>
                <Plus data-icon="inline-start" />
                New team
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
