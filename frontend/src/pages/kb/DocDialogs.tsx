/** Knowledge Base library dialogs: upload a PDF (new document), upload a new revision, edit the
 * details, edit the links (fault codes, equipment, plants; each with an optional page), withdraw
 * and supersede. Each saves on its own and reports through a toast. docs/plans/kb-documents.md. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type {
  KbDiscipline,
  KbDocCatalog,
  KbDocCreateMeta,
  KbDocDetail,
  KbDocLanguage,
  KbDocLinkInput,
  KbDocType,
  UserProfile,
} from "../../api/client";
import { isAdmin } from "../../auth/access";
import { useFleet } from "../../context/FleetContext";
import { useI18n } from "../../i18n";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PlantMultiPicker } from "../calendar/fields";
import { DISCIPLINES, DOC_TYPES, LANGUAGES, faultLabel, fmtBytes } from "./docFormat";
import { errText } from "./format";
import { invalidateKbContext, useLoad } from "./useDocs";

// --------------------------------------------------------------------------- shared

let catalogCache: Promise<KbDocCatalog> | null = null;
/** link-picker choices (fault codes from the alarm log, inverter models), read once per tab */
export const useCatalog = (enabled: boolean) =>
  useLoad<KbDocCatalog>(enabled ? "catalog" : null, () => {
    catalogCache ??= api.getKbDocCatalog().catch((e) => {
      catalogCache = null;
      throw e;
    });
    return catalogCache;
  });

const Row: React.FC<{ label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  label,
  htmlFor,
  hint,
  children,
  className,
}) => (
  <div className={cn("flex flex-col gap-1.5", className)}>
    <Label htmlFor={htmlFor} className="text-xs">
      {label}
    </Label>
    {children}
    {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
  </div>
);

const parseTags = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);

/** a PDF picked by the file input or dropped on the box */
const FilePick: React.FC<{ file: File | null; onFile: (f: File | null) => void; maxMb: number }> = ({ file, onFile, maxMb }) => {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center text-xs",
        over ? "border-solar-400/60 bg-solar-400/5" : "border-white/15 bg-white/[0.02]"
      )}
    >
      <FileUp className="size-5 text-slate-400" aria-hidden />
      {file ? (
        <span className="text-slate-200">
          {file.name} <span className="text-muted-foreground">· {fmtBytes(file.size)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{t("Drop a PDF here, or choose a file (at most {n} MB).", { n: maxMb })}</span>
      )}
      <input ref={ref} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <Button type="button" variant="outline" size="xs" onClick={() => ref.current?.click()}>
        {file ? t("Choose another file") : t("Choose a file")}
      </Button>
    </div>
  );
};

const fileProblem = (f: File | null, maxMb: number): string | null => {
  if (!f) return "Choose a PDF file.";
  if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") return "Only PDF files can be uploaded.";
  if (f.size > maxMb * 1024 * 1024) return "The file is larger than the upload limit.";
  return null;
};

// --------------------------------------------------------------------------- upload (new document)

export const UploadDocDialog: React.FC<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user: UserProfile | null;
  onDone: (d: KbDocDetail) => void;
  /** start with these plants linked (the plant Documents tab) */
  initialPlantIds?: number[];
  initialType?: KbDocType;
}> = ({ open, onOpenChange, user, onDone, initialPlantIds, initialType }) => {
  const { t } = useI18n();
  const admin = isAdmin(user);
  const { growattPlants } = useFleet();
  const catalog = useCatalog(open);
  const maxMb = catalog.data?.max_upload_mb ?? 30;
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<KbDocType>("manual");
  const [discipline, setDiscipline] = useState<KbDiscipline>("INV");
  const [titleEn, setTitleEn] = useState("");
  const [titleTh, setTitleTh] = useState("");
  const [language, setLanguage] = useState<KbDocLanguage>("en");
  const [label, setLabel] = useState("");
  const [tags, setTags] = useState("");
  const [general, setGeneral] = useState(true);
  const [plants, setPlants] = useState<number[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [number, setNumber] = useState("");
  const [nextNo, setNextNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitleEn("");
    setTitleTh("");
    setLabel("");
    setTags("");
    setGeneral(true);
    setPlants(initialPlantIds ?? []);
    setModels([]);
    setNumber("");
    setProblem(null);
    if (initialType) {
      setDocType(initialType);
      setDiscipline(initialType === "drawing" ? "ELE" : initialType === "report" ? "INS" : "INV");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setNextNo(null);
    api.getKbNextNumber(docType, discipline).then((r) => !cancelled && setNextNo(r.number), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, docType, discipline]);
  // a picked file names the title when it is still empty
  const pick = (f: File | null) => {
    setFile(f);
    if (f && !titleEn && !titleTh) setTitleEn(f.name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200));
  };

  const submit = async () => {
    const fp = fileProblem(file, maxMb);
    if (fp) return setProblem(t(fp));
    if (!titleEn.trim() && !titleTh.trim()) return setProblem(t("Give the document a title (English or Thai)."));
    if (!general && plants.length === 0) return setProblem(t("Pick at least one plant, or make the document general."));
    const links: KbDocLinkInput[] = [
      ...plants.map((p) => ({ target_type: "plant" as const, target_id: String(p) })),
      ...models.map((m) => ({ target_type: "equipment" as const, target_id: m, label: m })),
    ];
    const meta: KbDocCreateMeta = {
      doc_type: docType,
      discipline,
      title_en: titleEn.trim(),
      title_th: titleTh.trim(),
      language,
      tags: parseTags(tags),
      general,
      number: admin && number.trim() ? number.trim().toUpperCase() : null,
      label: label.trim() || null,
      links,
    };
    setBusy(true);
    setProblem(null);
    try {
      const d = await api.uploadKbDoc(file!, meta);
      invalidateKbContext();
      notify("ok", t("Uploaded {number} as a draft", { number: d.number }));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Upload PDF")}</DialogTitle>
          <DialogDescription>
            {t("The file is stored as it is and never changed; its text is read page by page for the search. It starts as a draft until an admin releases it.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FilePick file={file} onFile={pick} maxMb={maxMb} />
          </div>
          <Row label={t("Type")} htmlFor="kb-up-type">
            <Select value={docType} onValueChange={(v) => setDocType(v as KbDocType)}>
              <SelectTrigger id="kb-up-type" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(x.label)} · {x.prefix}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Discipline")} htmlFor="kb-up-disc">
            <Select value={discipline} onValueChange={(v) => setDiscipline(v as KbDiscipline)}>
              <SelectTrigger id="kb-up-disc" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISCIPLINES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.value} · {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Title (English)")} htmlFor="kb-up-ten">
            <Input id="kb-up-ten" value={titleEn} maxLength={200} onChange={(e) => setTitleEn(e.target.value)} className="h-8 text-xs" />
          </Row>
          <Row label={t("Title (Thai)")} htmlFor="kb-up-tth">
            <Input id="kb-up-tth" value={titleTh} maxLength={200} onChange={(e) => setTitleTh(e.target.value)} className="h-8 text-xs" />
          </Row>
          <Row label={t("Document number")} htmlFor="kb-up-no" hint={admin ? t("Empty = the next free number.") : t("Given automatically.")}>
            <Input
              id="kb-up-no"
              value={admin ? number : ""}
              placeholder={nextNo ?? "…"}
              disabled={!admin}
              maxLength={40}
              onChange={(e) => setNumber(e.target.value.toUpperCase())}
              className="num h-8 text-xs"
            />
          </Row>
          <Row label={t("Source version")} htmlFor="kb-up-label" hint={t("The vendor's own version, e.g. v1.2 or Rev C (optional).")}>
            <Input id="kb-up-label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} className="h-8 text-xs" />
          </Row>
          <Row label={t("Language")} htmlFor="kb-up-lang">
            <Select value={language} onValueChange={(v) => setLanguage(v as KbDocLanguage)}>
              <SelectTrigger id="kb-up-lang" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Tags")} htmlFor="kb-up-tags" hint={t("Comma separated.")}>
            <Input id="kb-up-tags" value={tags} onChange={(e) => setTags(e.target.value)} className="h-8 text-xs" />
          </Row>
          <Row label={t("Equipment")} className="sm:col-span-2" hint={t("Inverter models the document is about; it then shows on their inverter pages and plants.")}>
            <ModelPicker catalog={catalog.data} value={models} onChange={setModels} />
          </Row>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Switch id="kb-up-general" checked={general} onCheckedChange={(v) => setGeneral(!!v)} size="sm" />
              <Label htmlFor="kb-up-general" className="text-xs">
                {t("General: everyone can read it")}
              </Label>
            </div>
            <Row label={general ? t("Plants (optional)") : t("Plants (only users of these plants can read it)")} htmlFor="kb-up-plants">
              <PlantMultiPicker id="kb-up-plants" plants={growattPlants} value={plants} onChange={setPlants} />
            </Row>
          </div>
        </div>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <FileUp data-icon="inline-start" />}
            {busy ? t("Uploading…") : t("Upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** inverter models from the registry and the datasheet catalog, as removable chips + a Select */
const ModelPicker: React.FC<{ catalog: KbDocCatalog | null; value: string[]; onChange: (v: string[]) => void }> = ({ catalog, value, onChange }) => {
  const { t } = useI18n();
  const left = (catalog?.equipment ?? []).filter((m) => !value.includes(m.model));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((m) => (
        <span key={m} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 py-0.5 pr-1 pl-2 text-[11px] text-slate-200">
          {m}
          <button type="button" className="rounded-full p-0.5 hover:bg-white/10" aria-label={t("Remove {name}", { name: m })} onClick={() => onChange(value.filter((x) => x !== m))}>
            <Trash2 className="size-3" />
          </button>
        </span>
      ))}
      <Select value="" onValueChange={(v) => v && onChange([...value, v])} disabled={!catalog || left.length === 0}>
        <SelectTrigger size="sm" className="h-7 w-52 text-xs" aria-label={t("Add a model")}>
          <SelectValue placeholder={catalog ? t("Add a model") : t("Loading…")} />
        </SelectTrigger>
        <SelectContent>
          {left.map((m) => (
            <SelectItem key={m.key} value={m.model}>
              {m.model}
              {m.inverters > 0 && <span className="text-muted-foreground"> · {t("{n} inverters", { n: m.inverters })}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

// --------------------------------------------------------------------------- new revision

export const RevisionDialog: React.FC<{ doc: KbDocDetail; open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: KbDocDetail) => void }> = ({
  doc,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const catalog = useCatalog(open);
  const maxMb = catalog.data?.max_upload_mb ?? 30;
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const needNote = doc.status !== "draft";
  useEffect(() => {
    if (open) {
      setFile(null);
      setLabel("");
      setNote("");
      setProblem(null);
    }
  }, [open]);
  const submit = async () => {
    const fp = fileProblem(file, maxMb);
    if (fp) return setProblem(t(fp));
    if (needNote && !note.trim()) return setProblem(t("Say what changed (change note)."));
    setBusy(true);
    setProblem(null);
    try {
      const d = await api.uploadKbDocRevision(doc.id, file!, label, note);
      notify("ok", t("{number}: revision {n} uploaded", { number: d.number, n: d.current_revision?.rev_no ?? "—" }));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Upload a new revision")}</DialogTitle>
          <DialogDescription>{t("The new file becomes the current revision. Older revisions stay readable.")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <FilePick file={file} onFile={setFile} maxMb={maxMb} />
          <Row label={t("Source version")} htmlFor="kb-rev-label">
            <Input id="kb-rev-label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} className="h-8 text-xs" />
          </Row>
          <Row label={needNote ? t("Change note (required)") : t("Change note")} htmlFor="kb-rev-note">
            <Textarea id="kb-rev-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} rows={3} className="text-xs" />
          </Row>
        </div>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// --------------------------------------------------------------------------- details

export const DetailsDialog: React.FC<{ doc: KbDocDetail; admin: boolean; open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: KbDocDetail) => void }> = ({
  doc,
  admin,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const [f, setF] = useState(() => ({ ...doc, tagsText: doc.tags.join(", ") }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setF({ ...doc, tagsText: doc.tags.join(", ") });
      setProblem(null);
    }
  }, [open, doc]);
  const submit = async () => {
    if (!f.title_en.trim() && !f.title_th.trim()) return setProblem(t("Give the document a title (English or Thai)."));
    setBusy(true);
    setProblem(null);
    try {
      const d = await api.patchKbDoc(doc.id, {
        doc_type: f.doc_type,
        discipline: f.discipline,
        title_en: f.title_en.trim(),
        title_th: f.title_th.trim(),
        language: f.language,
        tags: parseTags(f.tagsText),
        general: f.general,
        ...(admin && f.number.trim().toUpperCase() !== doc.number ? { number: f.number.trim().toUpperCase() } : {}),
      });
      invalidateKbContext();
      notify("ok", t("Saved {number}", { number: d.number }));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Edit details")}</DialogTitle>
          <DialogDescription>{t("The file is not changed.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label={t("Title (English)")} htmlFor="kb-ed-ten">
            <Input id="kb-ed-ten" value={f.title_en} maxLength={200} onChange={(e) => setF({ ...f, title_en: e.target.value })} className="h-8 text-xs" />
          </Row>
          <Row label={t("Title (Thai)")} htmlFor="kb-ed-tth">
            <Input id="kb-ed-tth" value={f.title_th} maxLength={200} onChange={(e) => setF({ ...f, title_th: e.target.value })} className="h-8 text-xs" />
          </Row>
          <Row label={t("Type")} htmlFor="kb-ed-type" hint={t("Changing the type keeps the number.")}>
            <Select value={f.doc_type} onValueChange={(v) => setF({ ...f, doc_type: v as KbDocType })}>
              <SelectTrigger id="kb-ed-type" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Discipline")} htmlFor="kb-ed-disc">
            <Select value={f.discipline} onValueChange={(v) => setF({ ...f, discipline: v as KbDiscipline })}>
              <SelectTrigger id="kb-ed-disc" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISCIPLINES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.value} · {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Document number")} htmlFor="kb-ed-no" hint={admin ? undefined : t("Only an admin changes the number.")}>
            <Input id="kb-ed-no" value={f.number} disabled={!admin} maxLength={40} onChange={(e) => setF({ ...f, number: e.target.value.toUpperCase() })} className="num h-8 text-xs" />
          </Row>
          <Row label={t("Language")} htmlFor="kb-ed-lang">
            <Select value={f.language} onValueChange={(v) => setF({ ...f, language: v as KbDocLanguage })}>
              <SelectTrigger id="kb-ed-lang" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(x.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("Tags")} htmlFor="kb-ed-tags" className="sm:col-span-2" hint={t("Comma separated.")}>
            <Input id="kb-ed-tags" value={f.tagsText} onChange={(e) => setF({ ...f, tagsText: e.target.value })} className="h-8 text-xs" />
          </Row>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch id="kb-ed-general" checked={f.general} onCheckedChange={(v) => setF({ ...f, general: !!v })} size="sm" />
            <Label htmlFor="kb-ed-general" className="text-xs">
              {t("General: everyone can read it")}
            </Label>
          </div>
          {!f.general && !doc.links.some((l) => l.target_type === "plant") && (
            <p className="callout-warn text-xs sm:col-span-2">{t("Add a plant under Links, or only admins will see it.")}</p>
          )}
        </div>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// --------------------------------------------------------------------------- links

interface LinkRow {
  key: number;
  target_type: KbDocLinkInput["target_type"];
  target_id: string;
  label: string | null;
  page: string;
}

const FAULT_TYPES = ["Error", "Warning"];

export const LinksDialog: React.FC<{ doc: KbDocDetail; open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: KbDocDetail) => void }> = ({
  doc,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const catalog = useCatalog(open);
  const { growattPlants } = useFleet();
  const pages = doc.current_revision?.page_count ?? 1;
  const seq = useRef(0);
  const toRows = () =>
    doc.links.map((l) => ({ key: ++seq.current, target_type: l.target_type, target_id: l.target_id, label: l.label, page: l.page != null ? String(l.page) : "" }));
  const [rows, setRows] = useState<LinkRow[]>(toRows);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // the fault code being added
  const [ft, setFt] = useState("Error");
  const [code, setCode] = useState("");
  const [codePage, setCodePage] = useState("");
  useEffect(() => {
    if (open) {
      setRows(toRows());
      setProblem(null);
      setCode("");
      setCodePage("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc]);

  const plantIds = rows.filter((r) => r.target_type === "plant").map((r) => Number(r.target_id));
  const setPlants = (ids: number[]) =>
    setRows((rs) => [
      ...rs.filter((r) => r.target_type !== "plant"),
      ...ids.map((id) => rs.find((r) => r.target_type === "plant" && Number(r.target_id) === id) ?? { key: ++seq.current, target_type: "plant" as const, target_id: String(id), label: null, page: "" }),
    ]);
  const addRow = (r: Omit<LinkRow, "key">) => setRows((rs) => [...rs, { ...r, key: ++seq.current }]);
  const setPage = (key: number, page: string) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, page: page.replace(/\D/g, "").slice(0, 5) } : r)));
  const remove = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));
  const codeMsg = useMemo(() => {
    const k = `${ft}:${code.trim()}`;
    return catalog.data?.fault_codes.find((c) => c.key === k)?.message ?? null;
  }, [catalog.data, ft, code]);

  const submit = async () => {
    for (const r of rows) {
      if (r.page && (Number(r.page) < 1 || Number(r.page) > pages)) return setProblem(t("Page {n} is not in the document (1–{max}).", { n: r.page, max: pages }));
    }
    setBusy(true);
    setProblem(null);
    try {
      const d = await api.putKbDocLinks(
        doc.id,
        rows.map((r) => ({ target_type: r.target_type, target_id: r.target_id, page: r.page ? Number(r.page) : null, label: r.label }))
      );
      invalidateKbContext();
      notify("ok", t("Links saved"));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const section = (type: LinkRow["target_type"], title: string, name: (r: LinkRow) => string) => {
    const list = rows.filter((r) => r.target_type === type);
    if (list.length === 0) return null;
    return (
      <div className="flex flex-col gap-1">
        <p className="eyebrow">{title}</p>
        <ul className="flex flex-col divide-y divide-white/[0.05] rounded-md border border-white/[0.07]">
          {list.map((r) => (
            <li key={r.key} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-slate-200">{name(r)}</span>
              <Label className="text-[11px] text-muted-foreground" htmlFor={`kb-lp-${r.key}`}>
                {t("Page")}
              </Label>
              <Input id={`kb-lp-${r.key}`} value={r.page} onChange={(e) => setPage(r.key, e.target.value)} placeholder="—" inputMode="numeric" className="num h-7 w-16 text-xs" />
              <Button variant="ghost" size="icon-sm" onClick={() => remove(r.key)} aria-label={t("Remove {name}", { name: name(r) })}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const plantName = (r: LinkRow) => growattPlants.find((p) => p.plant_id === Number(r.target_id))?.name ?? r.label ?? t("Plant {id}", { id: r.target_id });
  const faultText = (r: LinkRow) => {
    const msg = catalog.data?.fault_codes.find((c) => c.key === r.target_id)?.message;
    return msg ? `${faultLabel(r.target_id)} · ${msg}` : faultLabel(r.target_id);
  };
  const usedModels = rows.filter((r) => r.target_type === "equipment").map((r) => r.label ?? r.target_id);

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Links of {number}", { number: doc.number })}</DialogTitle>
          <DialogDescription>
            {t("What the document is about. A fault code with a page makes the alarm rows open the manual at that page.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-md border border-white/[0.07] p-3">
            <p className="eyebrow">{t("Add a fault code")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <Select value={ft} onValueChange={setFt}>
                <SelectTrigger size="sm" className="h-8 w-28 text-xs" aria-label={t("Fault type")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FAULT_TYPES.map((x) => (
                    <SelectItem key={x} value={x}>
                      {x}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9A-Za-z_.-]/g, "").slice(0, 16))} placeholder={t("Code, e.g. 203")} className="num h-8 w-32 text-xs" aria-label={t("Code")} />
              <Input value={codePage} onChange={(e) => setCodePage(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder={t("Page")} inputMode="numeric" className="num h-8 w-20 text-xs" aria-label={t("Page")} />
              <Button
                size="sm"
                variant="outline"
                disabled={!code.trim()}
                onClick={() => {
                  addRow({ target_type: "fault_code", target_id: `${ft}:${code.trim()}`, label: null, page: codePage });
                  setCode("");
                  setCodePage("");
                }}
              >
                <Plus data-icon="inline-start" />
                {t("Add")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{codeMsg ? t("Growatt reports it as “{msg}”.", { msg: codeMsg }) : t("Codes as Growatt reports them in the alarm log.")}</p>
            {catalog.data && catalog.data.fault_codes.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {catalog.data.fault_codes.slice(0, 12).map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => {
                      setFt(FAULT_TYPES.includes(c.fault_type) ? c.fault_type : "Error");
                      setCode(c.code);
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:border-solar-400/40 hover:text-solar-200"
                    title={t("{n} records in the alarm log", { n: c.records })}
                  >
                    {faultLabel(c.key)}
                    {c.message ? ` · ${c.message}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label={t("Equipment")}>
              <ModelPicker
                catalog={catalog.data}
                value={usedModels}
                onChange={(v) => {
                  const added = v.filter((m) => !usedModels.includes(m));
                  const removed = usedModels.filter((m) => !v.includes(m));
                  setRows((rs) => rs.filter((r) => !(r.target_type === "equipment" && removed.includes(r.label ?? r.target_id))));
                  added.forEach((m) => addRow({ target_type: "equipment", target_id: m, label: m, page: "" }));
                }}
              />
            </Row>
            <Row label={t("Plants")} htmlFor="kb-links-plants">
              <PlantMultiPicker id="kb-links-plants" plants={growattPlants} value={plantIds} onChange={setPlants} />
            </Row>
          </div>
          {section("fault_code", t("Fault codes"), faultText)}
          {section("equipment", t("Equipment"), (r) => r.label ?? r.target_id)}
          {section("plant", t("Plants"), plantName)}
          {rows.length === 0 && <p className="text-xs text-muted-foreground">{t("No links yet.")}</p>}
        </div>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Save links")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// --------------------------------------------------------------------------- withdraw / supersede

export const WithdrawDialog: React.FC<{ doc: KbDocDetail; open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: KbDocDetail) => void }> = ({
  doc,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setProblem(null);
    }
  }, [open]);
  const submit = async () => {
    if (!reason.trim()) return setProblem(t("Give a reason."));
    setBusy(true);
    try {
      const d = await api.withdrawKbDoc(doc.id, reason.trim());
      invalidateKbContext();
      notify("ok", t("{number} withdrawn", { number: d.number }));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Withdraw {number}", { number: doc.number })}</DialogTitle>
          <DialogDescription>{t("Engineers no longer see it, and alarm rows stop linking to it. Admins can release it again.")}</DialogDescription>
        </DialogHeader>
        <Row label={t("Reason")} htmlFor="kb-wd-reason">
          <Textarea id="kb-wd-reason" value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} className="text-xs" />
        </Row>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Withdraw")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const SupersedeDialog: React.FC<{ doc: KbDocDetail; open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: KbDocDetail) => void }> = ({
  doc,
  open,
  onOpenChange,
  onDone,
}) => {
  const { t } = useI18n();
  const list = useLoad(open ? `sup:${doc.id}` : null, () => api.listKbDocs({ status: "released", sort: "number", limit: 200 }));
  const [by, setBy] = useState<string>("none");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setBy("none");
      setNote("");
      setProblem(null);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    try {
      const d = await api.supersedeKbDoc(doc.id, by === "none" ? null : Number(by), note.trim());
      invalidateKbContext();
      notify("ok", t("{number} marked superseded", { number: d.number }));
      onDone(d);
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const options = (list.data?.items ?? []).filter((x) => x.id !== doc.id);
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Supersede {number}", { number: doc.number })}</DialogTitle>
          <DialogDescription>{t("It stays readable with a banner pointing to the replacement.")}</DialogDescription>
        </DialogHeader>
        <Row label={t("Replaced by")} htmlFor="kb-sup-by">
          <Select value={by} onValueChange={setBy}>
            <SelectTrigger id="kb-sup-by" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("No replacement")}</SelectItem>
              {options.map((x) => (
                <SelectItem key={x.id} value={String(x.id)}>
                  {x.number} · {x.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t("Note")} htmlFor="kb-sup-note">
          <Textarea id="kb-sup-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} className="text-xs" />
        </Row>
        {problem && <p className="callout-crit text-xs">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" className="size-3" />}
            {t("Mark superseded")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
