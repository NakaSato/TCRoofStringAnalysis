/** "Someone saved a newer version": shown when a save answers 409. A diff of their text against
 * mine, and three ways on: Keep mine (save again over theirs), Take theirs (drop my changes), Merge
 * by hand (their text into the editor, mine kept beside it). */
import React from "react";
import type { KbArticle, KbCategory } from "../../api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../../i18n";
import { DiffView } from "./DiffView";
import { categoryOf, fmtDateTime, timeAgo } from "./format";

export interface MineForm {
  title: string;
  category: KbCategory;
  tags: string[];
  body_md: string;
}

export const ConflictDialog: React.FC<{
  theirs: KbArticle | null;
  mine: MineForm;
  message?: string;
  busy: boolean;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  onMerge: () => void;
  onClose: () => void;
}> = ({ theirs, mine, message, busy, onKeepMine, onTakeTheirs, onMerge, onClose }) => {
  const { t } = useI18n();
  const meta = theirs
    ? [
        theirs.title !== mine.title && t("Title: theirs “{a}”, yours “{b}”", { a: theirs.title, b: mine.title }),
        theirs.category !== mine.category &&
          t("Category: theirs {a}, yours {b}", { a: t(categoryOf(theirs.category).label), b: t(categoryOf(mine.category).label) }),
        theirs.tags.join("\u0000") !== mine.tags.join("\u0000") &&
          t("Tags: theirs {a}, yours {b}", {
            a: theirs.tags.map((x) => `#${x}`).join(" ") || "—",
            b: mine.tags.map((x) => `#${x}`).join(" ") || "—",
          }),
      ].filter((x): x is string => typeof x === "string")
    : [];
  const when = theirs?.updated_at ?? theirs?.created_at ?? null;

  return (
    <Dialog open={theirs != null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("Someone saved a newer version")}</DialogTitle>
          <DialogDescription>
            {theirs &&
              t("{name} saved version {v} {ago} ({when}), after you started editing. Your text is not saved yet.", {
                name: theirs.updated_by ?? "—",
                v: theirs.version,
                ago: timeAgo(when),
                when: fmtDateTime(when),
              })}
            {message ? ` ${message}` : ""}
          </DialogDescription>
        </DialogHeader>
        {theirs && (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {meta.length > 0 && (
              <ul className="callout space-y-0.5">
                {meta.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <DiffView a={theirs.body_md} b={mine.body_md} delLabel={t("Only in their version")} addLabel={t("Only in yours")} />
          </div>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onTakeTheirs} disabled={busy}>
            {t("Take theirs")}
          </Button>
          <Button variant="outline" onClick={onMerge} disabled={busy}>
            {t("Merge by hand")}
          </Button>
          <Button onClick={onKeepMine} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Keep mine")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
