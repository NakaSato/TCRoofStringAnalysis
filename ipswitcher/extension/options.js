// Options page: profile CRUD, import / export, rollback seconds, helper status, audit log.

import { t, applyStrings } from "./lib/strings.js";
import { callHost, requestBadgeRefresh, PROTOCOL_VERSION } from "./lib/host.js";
import { el, clear, $ } from "./lib/dom.js";
import { validateProfile, profileSummary, formatConfig } from "./lib/net.js";
import {
  listProfiles, saveProfile, deleteProfile, moveProfile, getSettings, saveSettings,
  exportJSON, importJSON, seedIfEmpty,
} from "./lib/store.js";

let profiles = [];
let form = null;          // current form values, or null when closed
let pendingDelete = null; // id awaiting a second click

// ---------- profile list ----------

async function reloadProfiles() {
  profiles = await listProfiles();
  renderList();
}

function renderList() {
  const body = clear($("#profileList"));
  const stored = profiles.filter((p) => !p.builtin);
  for (const p of profiles) {
    const i = stored.indexOf(p);
    const actions = el("td", { class: "actions" });
    if (p.builtin) {
      actions.append(el("span", { class: "muted small" }, t("builtIn")));
    } else {
      actions.append(
        el("button", { type: "button", title: t("moveUp"), "aria-label": t("moveUp"), disabled: i === 0, onclick: () => move(p.id, -1) }, "↑"),
        el("button", { type: "button", title: t("moveDown"), "aria-label": t("moveDown"), disabled: i === stored.length - 1, onclick: () => move(p.id, 1) }, "↓"),
        el("button", { type: "button", onclick: () => openForm(p) }, t("edit")),
        el("button", { type: "button", class: pendingDelete === p.id ? "danger" : "", onclick: () => onDelete(p.id) },
          pendingDelete === p.id ? t("confirmDelete") : t("delete")));
    }
    body.append(el("tr", {},
      el("td", { class: "strong" }, p.name, p.note ? el("div", { class: "muted small" }, p.note) : null),
      el("td", {}, profileSummary(p),
        p.mode === "static" && p.gateway ? el("div", { class: "muted small" }, `GW ${p.gateway}`) : null),
      el("td", { class: "muted small" }, p.testHost ? t("testPing", { host: p.testHost }) : ""),
      actions));
  }
}

async function move(id, delta) {
  await moveProfile(id, delta);
  await reloadProfiles();
}

async function onDelete(id) {
  if (pendingDelete !== id) {
    pendingDelete = id;
    renderList();
    setTimeout(() => { if (pendingDelete === id) { pendingDelete = null; renderList(); } }, 4000);
    return;
  }
  pendingDelete = null;
  await deleteProfile(id);
  if (form?.id === id) closeForm();
  await reloadProfiles();
}

// ---------- profile form ----------

function openForm(p) {
  form = p
    ? {
        id: p.id, name: p.name, mode: p.mode, ip: p.ip || "", prefix: p.prefix == null ? "" : String(p.prefix),
        gateway: p.gateway || "", dns1: p.dns?.[0] || "", dns2: p.dns?.[1] || "", testHost: p.testHost || "",
        openUrl: p.openUrl || "", preferredAdapter: p.preferredAdapter || "", note: p.note || "",
      }
    : { id: "", name: "", mode: "static", ip: "", prefix: "24", gateway: "", dns1: "", dns2: "", testHost: "", openUrl: "", preferredAdapter: "", note: "" };
  renderForm();
  $("#profileForm input")?.focus();
}

function closeForm() {
  form = null;
  renderForm();
  if (location.hash) history.replaceState(null, "", location.pathname);
}

function formProfile() {
  const f = form;
  const base = { id: f.id, name: f.name.trim(), mode: f.mode, testHost: f.testHost.trim(), openUrl: f.openUrl.trim(), preferredAdapter: f.preferredAdapter.trim(), note: f.note };
  if (f.mode === "dhcp") return { ...base, ip: "", prefix: null, gateway: "", dns: [] };
  return { ...base, ip: f.ip.trim(), prefix: f.prefix.trim(), gateway: f.gateway.trim(), dns: [f.dns1, f.dns2].map((s) => s.trim()).filter(Boolean) };
}

function renderForm() {
  const box = clear($("#profileForm"));
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
          oninput: (ev) => { form[key] = ev.target.value; touched.add(errKey); validate(); } });
    return el("label", { class: `field${opts.staticOnly ? " static-only" : ""}${opts.wide ? " wide" : ""}` }, el("span", {}, label), ctl, err);
  };

  const modeSel = el("select", { onchange: (ev) => { form.mode = ev.target.value; syncMode(); validate(); } },
    el("option", { value: "static", selected: form.mode === "static" }, t("modeStaticOpt")),
    el("option", { value: "dhcp", selected: form.mode === "dhcp" }, t("modeDhcpOpt")));
  const modeErr = el("span", { class: "ferr" });
  errNodes.mode = [modeErr];

  const opt = (s) => `${s} (${t("optional")})`;
  const grid = el("div", { class: "grid" },
    input("name", t("fName"), { ph: "Inverter LAN", wide: true }),
    el("label", { class: "field" }, el("span", {}, t("fMode")), modeSel, modeErr),
    input("ip", t("fIp"), { ph: "192.168.1.100", inputmode: "decimal", staticOnly: true }),
    input("prefix", t("fPrefix"), { ph: "24 / 255.255.255.0", inputmode: "decimal", staticOnly: true }),
    input("gateway", opt(t("fGateway")), { ph: "192.168.1.1", inputmode: "decimal", staticOnly: true }),
    input("dns1", opt(t("fDns1")), { inputmode: "decimal", staticOnly: true, errKey: "dns" }),
    input("dns2", opt(t("fDns2")), { inputmode: "decimal", staticOnly: true, errKey: "dns" }),
    input("testHost", opt(t("fTestHost")), { ph: "192.168.1.1", inputmode: "decimal" }),
    input("openUrl", opt(t("fOpenUrl")), { ph: "http://192.168.1.1/" }),
    input("preferredAdapter", opt(t("fPreferredAdapter")), { ph: "Ethernet, USB" }),
    input("note", opt(t("fNote")), { textarea: true, wide: true }));

  const status = el("span", { class: "small", "aria-live": "polite" });
  const saveBtn = el("button", { type: "submit", class: "primary" }, t("save"));
  const formEl = el("form", { class: "panel", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    for (const k of Object.keys(errNodes)) touched.add(k);
    if (!validate()) return;
    try {
      const saved = await saveProfile(formProfile());
      form.id = saved.id;
      status.textContent = t("saved");
      status.className = "small ok";
      await reloadProfiles();
      setTimeout(closeForm, 600);
    } catch (e) {
      status.textContent = e.errors ? Object.values(e.errors).join(" · ") : String(e.message || e);
      status.className = "small error";
    }
  } },
    el("h3", {}, form.id ? t("editProfileTitle") : t("newProfileTitle")),
    grid,
    el("div", { class: "row gap end" }, status, el("button", { type: "button", onclick: closeForm }, t("cancel")), saveBtn));
  box.append(formEl);

  function syncMode() {
    for (const n of grid.querySelectorAll(".static-only")) n.hidden = form.mode !== "static";
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

async function onImport(ev) {
  const out = $("#importOut");
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const r = await importJSON(text);
    out.textContent = t("importResult", r);
    out.className = r.skipped ? "small warn-text" : "small ok";
    await reloadProfiles();
  } catch (e) {
    out.textContent = String(e.message || e);
    out.className = "small error";
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

// ---------- rollback ----------

async function onRollbackSave(ev) {
  ev.preventDefault();
  const out = $("#rollbackOut");
  const raw = $("#rollbackSec").value.trim();
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 300) {
    out.textContent = t("rollbackBad");
    out.className = "small error";
    return;
  }
  await saveSettings({ rollbackSec: n });
  out.textContent = t("saved");
  out.className = "small ok";
}

// ---------- helper status ----------

async function loadHelper() {
  const box = clear($("#helper"));
  box.append(el("p", { class: "muted" }, t("loading")));
  const rows = [[t("extId"), el("code", { class: "extid" }, chrome.runtime.id)]];
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
  } catch (e) {
    if (e.code === "host_missing" || e.code === "host_forbidden") {
      const missing = e.code === "host_missing";
      banner = el("div", { class: "banner err" }, el("strong", {}, t(missing ? "hostMissingTitle" : "hostForbiddenTitle")), el("p", {}, t(missing ? "hostMissingBody" : "hostForbiddenBody")));
    } else {
      banner = el("div", { class: "banner err" }, el("strong", {}, t("hostCrashedTitle")), el("p", {}, String(e.message || e)));
    }
  }
  clear(box);
  if (banner) box.append(banner);
  box.append(el("dl", { class: "kv" }, rows.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])));
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
      el("td", { class: "nowrap" }, fmtTime(a?.time)),
      el("td", {}, String(a?.action ?? ""), a?.source ? el("div", { class: "muted small" }, String(a.source)) : null),
      el("td", {}, String(a?.adapter ?? "")),
      el("td", {}, formatConfig(a?.from), el("div", { class: "muted" }, "→ ", formatConfig(a?.to))),
      el("td", {}, String(a?.profile ?? "")),
      el("td", {}, String(a?.result ?? ""),
        a?.test ? el("div", { class: "muted small" }, a.test.ok ? t("pingOk", { host: a.test.host, ms: a.test.rttMs }) : t("pingFail", { host: a.test.host })) : null,
        a?.detail ? el("div", { class: "muted small" }, typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)) : null)))))));
}

// ---------- init ----------

function onHash() {
  if (location.hash === "#new") openForm(null);
}

async function init() {
  applyStrings(document);
  $("#newBtn").addEventListener("click", () => openForm(null));
  $("#importFile").addEventListener("change", onImport);
  $("#exportBtn").addEventListener("click", onExport);
  $("#rollbackForm").addEventListener("submit", onRollbackSave);
  $("#recheckBtn").addEventListener("click", loadHelper);
  $("#auditBtn").addEventListener("click", loadAudit);
  window.addEventListener("hashchange", onHash);

  try { await seedIfEmpty(); } catch { /* ignore */ }
  const settings = await getSettings();
  $("#rollbackSec").value = String(settings.rollbackSec);
  await reloadProfiles();
  onHash();
  loadHelper();
  loadAudit();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.profiles) reloadProfiles();
});

init();
