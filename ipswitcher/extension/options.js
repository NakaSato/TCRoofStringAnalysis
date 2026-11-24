// Options page: tabs (profiles, import / export, general, helper & log), profile editor dialog.

import { t, applyStrings, setLang, tValue } from "./lib/strings.js";
import { callHost, requestBadgeRefresh, PROTOCOL_VERSION } from "./lib/host.js";
import { el, clear, $ } from "./lib/dom.js";
import { validateProfile, profileSummary, formatConfig } from "./lib/net.js";
import {
  listProfiles, saveProfile, deleteProfile, moveProfile, getSettings, saveSettings,
  exportJSON, importJSON, seedIfEmpty,
} from "./lib/store.js";

const PAGE = 60;
const TABS = ["profiles", "import", "general", "helper"];
const UNDO_PRESETS = [0, 15, 30, 60, 120];

let profiles = [];
let shown = PAGE;           // rows rendered before "Show more"
let form = null;            // editor values, or null when closed
let pendingDelete = false;  // second click deletes
let helperLoaded = false;

// ---------- tabs ----------

function currentTab() {
  const h = location.hash.slice(1);
  if (h === "new") return "profiles";
  return TABS.includes(h) ? h : "profiles";
}

function showTab() {
  const tab = currentTab();
  for (const name of TABS) {
    $(`#tab-${name}`).hidden = name !== tab;
    const link = $(`.tabs a[data-tab="${name}"]`);
    link.classList.toggle("active", name === tab);
    link.setAttribute("aria-selected", String(name === tab));
  }
  if (tab === "helper" && !helperLoaded) { helperLoaded = true; loadHelper(); loadAudit(); }
  if (location.hash === "#new") openEditor(null);
}

// ---------- profile list ----------

const fold = (s) => String(s || "").toLowerCase();
const squash = (s) => s.replace(/[-\s·]/g, "");

function matches(p, words) {
  if (!words.length) return true;
  const hay = fold([p.name, p.ip, p.gateway, p.testHost, p.note].join(" "));
  const hay2 = squash(hay);
  return words.every((w) => hay.includes(w) || hay2.includes(squash(w)));
}

async function reloadProfiles() {
  profiles = await listProfiles();
  $("#tabCount").textContent = String(profiles.length - 1);
  renderList();
}

function renderList() {
  const body = clear($("#profileList"));
  const words = fold($("#search").value).split(/\s+/).filter(Boolean);
  const hits = profiles.filter((p) => p.builtin || matches(p, words));
  const userHits = hits.filter((p) => !p.builtin);
  const total = profiles.length - 1;
  $("#listCount").textContent = words.length ? t("profileCount", { shown: userHits.length, total }) : t("profilesCount", { n: total });
  $("#noMatch").hidden = !(words.length && !userHits.length);
  $("#noMatch").textContent = t("noMatch", { q: $("#search").value.trim() });

  const visible = hits.slice(0, shown + 1); // + the built-in DHCP row
  for (const p of visible) {
    const cut = p.name.indexOf(" · ");
    const head = cut > 0 ? p.name.slice(0, cut) : p.name;
    const sub = cut > 0 ? p.name.slice(cut + 3) : "";
    const open = p.builtin ? null : () => openEditor(p);
    body.append(el("tr", { class: p.builtin ? "builtin" : "clickable", onclick: open, title: p.note || "" },
      el("td", {}, el("div", { class: "p-head" }, head), sub ? el("div", { class: "p-sub" }, sub) : null),
      el("td", { class: "mono" }, profileSummary(p)),
      el("td", { class: "mono muted" }, p.mode === "static" && p.gateway ? p.gateway : "—"),
      el("td", { class: "mono muted" }, p.testHost || "—"),
      el("td", { class: "act" }, p.builtin
        ? el("span", { class: "tag" }, t("builtIn"))
        : el("button", { type: "button", class: "ghost", onclick: (ev) => { ev.stopPropagation(); openEditor(p); } }, t("rowEdit")))));
  }
  const rest = hits.length - visible.length;
  const more = $("#moreBtn");
  more.hidden = rest <= 0;
  more.textContent = t("showMore", { n: rest });
}

// ---------- editor dialog ----------

function openEditor(p) {
  form = p
    ? {
        id: p.id, name: p.name, mode: p.mode, ip: p.ip || "", prefix: p.prefix == null ? "" : String(p.prefix),
        gateway: p.gateway || "", dns1: p.dns?.[0] || "", dns2: p.dns?.[1] || "", testHost: p.testHost || "",
        openUrl: p.openUrl || "", preferredAdapter: p.preferredAdapter || "", note: p.note || "",
      }
    : { id: "", name: "", mode: "static", ip: "", prefix: "24", gateway: "", dns1: "", dns2: "", testHost: "", openUrl: "", preferredAdapter: "", note: "" };
  pendingDelete = false;
  renderEditor();
  const dlg = $("#editor");
  if (!dlg.open) dlg.showModal();
  dlg.querySelector("input")?.focus();
}

function closeEditor() {
  form = null;
  const dlg = $("#editor");
  if (dlg.open) dlg.close();
  if (location.hash === "#new") history.replaceState(null, "", "#profiles");
}

function formProfile() {
  const f = form;
  const base = { id: f.id, name: f.name.trim(), mode: f.mode, testHost: f.testHost.trim(), openUrl: f.openUrl.trim(), preferredAdapter: f.preferredAdapter.trim(), note: f.note };
  if (f.mode === "dhcp") return { ...base, ip: "", prefix: null, gateway: "", dns: [] };
  return { ...base, ip: f.ip.trim(), prefix: f.prefix.trim(), gateway: f.gateway.trim(), dns: [f.dns1, f.dns2].map((s) => s.trim()).filter(Boolean) };
}

function renderEditor() {
  const dlg = clear($("#editor"));
  if (!form) return;
  const errNodes = {};
  const touched = new Set();

  const input = (key, label, opts = {}) => {
    const errKey = opts.errKey || key;
    const err = el("span", { class: "ferr", "aria-live": "polite" });
    (errNodes[errKey] ||= []).push(err);
    const ctl = opts.textarea
      ? el("textarea", { rows: "2", oninput: (ev) => { form[key] = ev.target.value; touched.add(errKey); validate(); } }, form[key])
      : el("input", { value: form[key], placeholder: opts.ph || "", autocomplete: "off", spellcheck: "false", inputmode: opts.inputmode || null,
          class: opts.mono ? "mono" : null, oninput: (ev) => { form[key] = ev.target.value; touched.add(errKey); validate(); } });
    return el("label", { class: `field${opts.wide ? " wide" : ""}` },
      el("span", { class: "flabel" }, label, opts.optional ? el("span", { class: "opt" }, ` · ${t("optional")}`) : null), ctl, err);
  };
  const group = (title, cls, ...fields) => el("fieldset", { class: `group ${cls || ""}` }, el("legend", {}, title), el("div", { class: "grid" }, fields));

  // Mode as a two-button switch.
  const modeSeg = el("div", { class: "seg", role: "radiogroup", "aria-label": t("fMode") },
    ["static", "dhcp"].map((m) => el("button", { type: "button", role: "radio", class: form.mode === m ? "on" : "", "aria-checked": String(form.mode === m),
      onclick: () => { form.mode = m; for (const b of modeSeg.children) { const on = b.dataset.m === form.mode; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); } syncMode(); validate(); },
      dataset: { m } }, m === "static" ? t("modeStaticOpt") : t("modeDhcpOpt"))));
  const modeErr = el("span", { class: "ferr" });
  errNodes.mode = [modeErr];

  const body = el("div", { class: "dlg-body" },
    input("name", t("fName"), { ph: "P2-055 · …", wide: true }),
    el("div", { class: "field wide" }, el("span", { class: "flabel" }, t("fMode")), modeSeg, modeErr),
    group(t("secNetwork"), "static-only",
      input("ip", t("fIp"), { ph: "192.168.1.250", inputmode: "decimal", mono: true }),
      input("prefix", t("fPrefix"), { ph: "24 / 255.255.255.0", inputmode: "decimal", mono: true }),
      input("gateway", t("fGateway"), { ph: "192.168.1.254", inputmode: "decimal", mono: true, optional: true })),
    group(t("secDns"), "static-only",
      input("dns1", t("fDns1"), { inputmode: "decimal", errKey: "dns", mono: true, optional: true }),
      input("dns2", t("fDns2"), { inputmode: "decimal", errKey: "dns", mono: true, optional: true })),
    group(t("secTest"), "",
      input("testHost", t("fTestHost"), { ph: "192.168.1.254", inputmode: "decimal", mono: true, optional: true }),
      input("openUrl", t("fOpenUrl"), { ph: "http://192.168.1.1/", mono: true, optional: true })),
    group(t("secOther"), "",
      input("preferredAdapter", t("fPreferredAdapter"), { ph: "Ethernet, USB", optional: true }),
      input("note", t("fNote"), { textarea: true, wide: true, optional: true })));

  const status = el("span", { class: "small", "aria-live": "polite" });
  const saveBtn = el("button", { type: "submit", class: "primary" }, t("save"));
  const left = el("div", { class: "row gap" });
  if (form.id) {
    const delBtn = el("button", { type: "button", class: "ghost danger-text", onclick: async () => {
      if (!pendingDelete) {
        pendingDelete = true;
        delBtn.textContent = t("confirmDelete");
        delBtn.className = "danger";
        setTimeout(() => { if (pendingDelete && form) { pendingDelete = false; delBtn.textContent = t("delete"); delBtn.className = "ghost danger-text"; } }, 4000);
        return;
      }
      await deleteProfile(form.id);
      closeEditor();
      await reloadProfiles();
    } }, t("delete"));
    const stored = profiles.filter((p) => !p.builtin);
    const i = stored.findIndex((p) => p.id === form.id);
    const mv = (d) => async () => { await moveProfile(form.id, d); await reloadProfiles(); };
    left.append(delBtn,
      el("button", { type: "button", class: "ghost", title: t("moveUp"), "aria-label": t("moveUp"), disabled: i <= 0, onclick: mv(-1) }, "↑"),
      el("button", { type: "button", class: "ghost", title: t("moveDown"), "aria-label": t("moveDown"), disabled: i < 0 || i >= stored.length - 1, onclick: mv(1) }, "↓"));
  }

  const formEl = el("form", { method: "dialog", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    for (const k of Object.keys(errNodes)) touched.add(k);
    if (!validate()) return;
    try {
      const saved = await saveProfile(formProfile());
      form.id = saved.id;
      status.textContent = t("saved");
      status.className = "small ok";
      await reloadProfiles();
      setTimeout(closeEditor, 500);
    } catch (e) {
      status.textContent = e.errors ? Object.values(e.errors).join(" · ") : String(e.message || e);
      status.className = "small error";
    }
  } },
    el("div", { class: "dlg-head" },
      el("h2", { id: "editorTitle" }, form.id ? t("editProfileTitle") : t("newProfileTitle")),
      el("button", { type: "button", class: "ghost close", "aria-label": t("cancel"), onclick: closeEditor }, "✕")),
    body,
    el("div", { class: "dlg-foot" }, left, el("div", { class: "row gap" }, status,
      el("button", { type: "button", onclick: closeEditor }, t("cancel")), saveBtn)));
  dlg.append(formEl);

  function syncMode() {
    for (const n of body.querySelectorAll(".static-only")) n.hidden = form.mode !== "static";
  }
  function validate() {
    const e = validateProfile(formProfile());
    for (const [k, nodes] of Object.entries(errNodes)) {
      nodes.forEach((n, i) => { n.textContent = i === 0 && e[k] && (touched.has(k) || form.id) ? e[k] : ""; });
    }
    const ok = Object.keys(e).length === 0;
    saveBtn.disabled = !ok;
    return ok;
  }
  syncMode();
  validate();
}

// ---------- import / export ----------

async function importFile(file) {
  const out = $("#importOut");
  if (!file) return;
  out.hidden = false;
  try {
    const r = await importJSON(await file.text());
    out.textContent = `${r.skipped ? "⚠" : "✓"} ${t("importResult", r)}`;
    out.className = `result ${r.skipped ? "warn" : "ok"}`;
    await reloadProfiles();
  } catch (e) {
    out.textContent = `✕ ${String(e.message || e)}`;
    out.className = "result err";
  }
}

async function onExport() {
  const blob = new Blob([await exportJSON()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = el("a", { href: url, download: `ipswitcher-profiles-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- general ----------

function markSeg(seg, pick) {
  for (const b of seg.children) {
    const on = pick(b);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

async function saveUndo(n) {
  const out = $("#rollbackOut");
  if (!Number.isInteger(n) || n < 0 || n > 300) {
    out.textContent = t("rollbackBad");
    out.className = "small error";
    return;
  }
  await saveSettings({ rollbackSec: n });
  $("#rollbackSec").value = String(n);
  markSeg($("#undoSeg"), (b) => Number(b.dataset.sec) === n);
  out.textContent = t("saved");
  out.className = "small ok";
  setTimeout(() => { out.textContent = ""; }, 1500);
}

// ---------- helper status ----------

async function loadHelper() {
  const box = clear($("#helper"));
  box.append(el("p", { class: "muted" }, t("loading")));
  const idRow = el("span", { class: "row gap" }, el("code", { class: "extid" }, chrome.runtime.id),
    el("button", { type: "button", class: "ghost small", onclick: async (ev) => {
      try { await navigator.clipboard.writeText(chrome.runtime.id); ev.target.textContent = t("copied"); } catch { /* blocked */ }
    } }, t("copy")));
  const rows = [[t("extId"), idRow]];
  let banner = null;
  try {
    const h = await callHost("health");
    rows.push(
      [t("hostVersion"), String(h?.hostVersion ?? "—")],
      [t("protocol"), String(h?.protocol ?? "—")],
      [t("winUser"), String(h?.user ?? "—")],
      [t("canWrite"), h?.canWrite ? t("yes") : t("no")]);
    if (h?.protocol !== PROTOCOL_VERSION) banner = el("div", { class: "banner warn" }, el("strong", {}, t("protocolTitle")), el("p", {}, t("protocolBody", { want: PROTOCOL_VERSION, got: h?.protocol })));
    else if (h?.canWrite !== true) banner = el("div", { class: "banner warn" }, el("strong", {}, t("noWriteTitle")), el("p", {}, t("noWriteBody")));
    else banner = el("div", { class: "status ok" }, el("span", { class: "dot" }), t("helperOk"));
  } catch (e) {
    if (e.code === "host_missing" || e.code === "host_forbidden") {
      const missing = e.code === "host_missing";
      banner = el("div", { class: "banner err" }, el("strong", {}, t(missing ? "hostMissingTitle" : "hostForbiddenTitle")), el("p", {}, t(missing ? "hostMissingBody" : "hostForbiddenBody")));
    } else {
      banner = el("div", { class: "banner err" }, el("strong", {}, t("hostCrashedTitle")), el("p", {}, String(e.message || e)));
    }
  }
  clear(box);
  box.append(banner, el("dl", { class: "kv" }, rows.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])));
  requestBadgeRefresh();
}

// ---------- audit log ----------

function fmtTime(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s ?? "") : d.toLocaleString();
}

async function loadAudit() {
  const box = clear($("#audit"));
  box.append(el("p", { class: "muted" }, t("loading")));
  let entries;
  try {
    entries = await callHost("log", { limit: 100 });
  } catch (e) {
    clear(box).append(el("p", { class: "error" }, String(e.message || e)));
    return;
  }
  clear(box);
  if (!Array.isArray(entries) || !entries.length) { box.append(el("p", { class: "muted" }, t("auditEmpty"))); return; }
  box.append(el("div", { class: "scroll" }, el("table", { class: "tbl audit" },
    el("thead", {}, el("tr", {}, [t("aTime"), t("aAction"), t("aAdapter"), t("aChange"), t("aProfile"), t("aResult")].map((h) => el("th", {}, h)))),
    el("tbody", {}, entries.map((a) => el("tr", { class: a?.result === "error" ? "bad" : "" },
      el("td", { class: "nowrap muted" }, fmtTime(a?.time)),
      el("td", {}, el("span", { class: `badge act-${a?.action || ""}` }, tValue("act", a?.action ?? ""))),
      el("td", {}, String(a?.adapter ?? "")),
      el("td", { class: "mono" }, formatConfig(a?.from), el("div", {}, "→ ", formatConfig(a?.to))),
      el("td", {}, String(a?.profile ?? "")),
      el("td", {}, el("span", { class: a?.result === "error" ? "error" : "ok" }, tValue("res", a?.result ?? "")),
        a?.test ? el("div", { class: "muted small" }, a.test.ok ? t("pingOk", { host: a.test.host, ms: a.test.rttMs }) : t("pingFail", { host: a.test.host })) : null,
        a?.detail ? el("div", { class: "muted small" }, typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)) : null)))))));
}

// ---------- init ----------

async function init() {
  let settings;
  try { settings = await getSettings(); setLang(settings.lang); } catch { setLang(""); }
  applyStrings(document);

  // Profiles
  $("#search").addEventListener("input", () => { shown = PAGE; renderList(); });
  $("#search").addEventListener("keydown", (ev) => { if (ev.key === "Escape" && ev.target.value) { ev.target.value = ""; renderList(); } });
  $("#newBtn").addEventListener("click", () => openEditor(null));
  $("#moreBtn").addEventListener("click", () => { shown += PAGE * 4; renderList(); });
  $("#editor").addEventListener("cancel", (ev) => { ev.preventDefault(); closeEditor(); });
  $("#editor").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) closeEditor(); }); // backdrop

  // Import / export
  $("#importFile").addEventListener("change", (ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; importFile(f); });
  const drop = $("#drop");
  for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  for (const type of ["dragleave", "drop"]) drop.addEventListener(type, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => { ev.preventDefault(); importFile(ev.dataTransfer?.files?.[0]); });
  $("#exportBtn").addEventListener("click", onExport);

  // General
  const langSeg = $("#langSeg");
  markSeg(langSeg, (b) => b.dataset.lang === (settings?.lang ?? ""));
  langSeg.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    await saveSettings({ lang: b.dataset.lang });
    location.reload();
  });
  const undoSeg = $("#undoSeg");
  for (const n of UNDO_PRESETS) {
    undoSeg.append(el("button", { type: "button", role: "radio", dataset: { sec: String(n) }, onclick: () => saveUndo(n) }, n === 0 ? t("undoOff") : t("secUnit", { n })));
  }
  const sec = settings?.rollbackSec ?? 30;
  $("#rollbackSec").value = String(sec);
  markSeg(undoSeg, (b) => Number(b.dataset.sec) === sec);
  $("#rollbackSec").addEventListener("change", (ev) => {
    const raw = ev.target.value.trim();
    saveUndo(/^\d{1,3}$/.test(raw) ? Number(raw) : NaN);
  });

  // Helper & log
  $("#recheckBtn").addEventListener("click", loadHelper);
  $("#auditBtn").addEventListener("click", loadAudit);

  window.addEventListener("hashchange", showTab);
  try { await seedIfEmpty(); } catch { /* ignore */ }
  await reloadProfiles();
  showTab();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.profiles) reloadProfiles();
  if (area === "local" && changes.settings && changes.settings.oldValue?.lang !== changes.settings.newValue?.lang) location.reload();
});

init();
