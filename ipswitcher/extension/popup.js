// Popup: adapters, profiles, inline confirm, pending Keep / Revert, custom address, ping (spec §14.2).

import { t, applyStrings } from "./lib/strings.js";
import { callHost, requestBadgeRefresh, PROTOCOL_VERSION } from "./lib/host.js";
import { el, clear, $ } from "./lib/dom.js";
import {
  validateProfile, formatConfig, profileToConfig, profileSummary, findOverlaps, applyArgs,
  parsePrefix, testHostProblem,
} from "./lib/net.js";
import { listProfiles, getSettings, saveSettings, saveProfile, seedIfEmpty } from "./lib/store.js";

const state = {
  health: null,          // health data, or null
  hostErr: null,         // HostError from health
  adapters: [],
  adaptersLoading: true,
  adaptersErr: null,
  status: { pending: null, statics: [] },
  profiles: [],
  settings: null,
  selectedIndex: null,
  confirm: null,         // {profile, internetTicked, busy, hostConfirm, invalid, error}
  result: null,          // {kind, lines: [string], openUrl}
  pendingBusy: false,
  customOpen: false,
};

// ---------- helpers ----------

function canApply() {
  const h = state.health;
  return !!h && h.protocol === PROTOCOL_VERSION && h.canWrite === true;
}

function selectedAdapter() {
  return state.adapters.find((a) => a.index === state.selectedIndex) || null;
}

function errText(e) {
  return e?.message || String(e);
}

function chooseDefaultAdapter() {
  const list = state.adapters;
  if (!list.length) { state.selectedIndex = null; return; }
  if (list.some((a) => a.index === state.selectedIndex)) return;
  const byGuid = state.settings?.lastAdapterGuid && list.find((a) => a.guid === state.settings.lastAdapterGuid);
  const pick = byGuid || list.find((a) => a.status === "Up" && !a.isInternet && !a.isWifi) || list[0];
  state.selectedIndex = pick.index;
}

async function rememberAdapter(a) {
  if (!a?.guid || state.settings.lastAdapterGuid === a.guid) return;
  try { state.settings = await saveSettings({ lastAdapterGuid: a.guid }); } catch { /* ignore */ }
}

function replaceAdapter(a) {
  if (!a) return;
  const i = state.adapters.findIndex((x) => x.index === a.index);
  if (i >= 0) state.adapters[i] = a;
}

// ---------- loading ----------

async function loadAdapters() {
  state.adaptersLoading = true;
  renderAdapters();
  try {
    state.adapters = (await callHost("listAdapters", { showAll: !!state.settings.showAll })) || [];
    state.adaptersErr = null;
  } catch (e) {
    state.adaptersErr = e;
  }
  state.adaptersLoading = false;
  chooseDefaultAdapter();
  renderAdapters();
  renderConfirm();
}

async function loadStatus() {
  try {
    state.status = (await callHost("status")) || { pending: null, statics: [] };
  } catch {
    state.status = { pending: null, statics: [] };
  }
  renderPending();
  renderAdapters();
  renderConfirm();
}

async function refreshAll() {
  await Promise.all([loadAdapters(), loadStatus()]);
  requestBadgeRefresh();
}

// ---------- banners ----------

function renderBanners() {
  const box = clear($("#banners"));
  const e = state.hostErr;
  if (e) {
    if (e.code === "host_missing" || e.code === "host_forbidden") {
      const missing = e.code === "host_missing";
      box.append(el("div", { class: "banner err" },
        el("strong", {}, t(missing ? "hostMissingTitle" : "hostForbiddenTitle")),
        el("p", {}, t(missing ? "hostMissingBody" : "hostForbiddenBody")),
        el("code", { class: "extid" }, chrome.runtime.id)));
    } else {
      box.append(el("div", { class: "banner err" },
        el("strong", {}, t("hostCrashedTitle")), el("p", {}, errText(e))));
    }
    return;
  }
  const h = state.health;
  if (!h) return;
  if (h.protocol !== PROTOCOL_VERSION) {
    box.append(el("div", { class: "banner warn" },
      el("strong", {}, t("protocolTitle")),
      el("p", {}, t("protocolBody", { want: PROTOCOL_VERSION, got: h.protocol }))));
  } else if (h.canWrite !== true) {
    box.append(el("div", { class: "banner warn" },
      el("strong", {}, t("noWriteTitle")), el("p", {}, t("noWriteBody"))));
  }
}

// ---------- pending ----------

let countdownTimer = null;
let expiryPolls = 0;
let lastDeadline = null;

function renderPending() {
  const box = clear($("#pending"));
  clearInterval(countdownTimer);
  const p = state.status.pending;
  if (!p) return;
  if (p.deadline !== lastDeadline) { lastDeadline = p.deadline; expiryPolls = 0; }
  const text = el("span", { class: "grow" });
  const keepBtn = el("button", { type: "button", class: "primary", disabled: state.pendingBusy, onclick: onKeep }, t("keep"));
  const revertBtn = el("button", { type: "button", disabled: state.pendingBusy, onclick: onRevert }, t("revert"));
  box.append(el("div", { class: "banner pending row gap", role: "status" }, text, keepBtn, revertBtn));

  const tick = () => {
    if (typeof p.deadline !== "number") { text.textContent = t("pendingNoTimer", { adapter: p.adapter }); return; }
    const sec = Math.ceil((p.deadline - Date.now()) / 1000);
    if (sec > 0) { text.textContent = t("pendingOn", { adapter: p.adapter, sec }); return; }
    text.textContent = t("pendingReverting", { adapter: p.adapter });
    keepBtn.disabled = true;
    clearInterval(countdownTimer);
    // The watchdog reverts at the deadline; look again shortly (a few times if it is slow).
    if (expiryPolls < 5) {
      expiryPolls++;
      setTimeout(() => refreshAll(), 2000);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

async function onKeep() {
  state.pendingBusy = true;
  renderPending();
  try {
    await callHost("confirm");
    state.result = { kind: "ok", lines: [t("kept")] };
  } catch (e) {
    if (e.code !== "no_pending") state.result = { kind: "err", lines: [t("failed", { message: errText(e) })] };
  }
  state.pendingBusy = false;
  renderResult();
  await refreshAll();
}

async function onRevert() {
  state.pendingBusy = true;
  renderPending();
  try {
    const data = await callHost("revert");
    replaceAdapter(data?.adapter);
    state.result = { kind: "ok", lines: [t("reverted", { adapter: data?.adapter?.name ?? "", config: formatConfig(data?.adapter?.config) })] };
  } catch (e) {
    if (e.code !== "no_pending") state.result = { kind: "err", lines: [t("failed", { message: errText(e) })] };
  }
  state.pendingBusy = false;
  renderResult();
  await refreshAll();
}

// ---------- result ----------

function renderResult() {
  const box = clear($("#result"));
  const r = state.result;
  if (!r) return;
  const div = el("div", { class: `banner ${r.kind}`, role: "status" }, r.lines.map((l, i) => el(i ? "p" : "strong", {}, l)));
  if (r.openUrl) {
    div.append(el("div", { class: "row" },
      el("button", { type: "button", class: "primary", onclick: () => chrome.tabs.create({ url: r.openUrl }) }, t("openDevice"))));
  }
  box.append(div);
}

// ---------- adapters ----------

function liveText(a) {
  if (a.status !== "Up") return a.status;
  const mode = a.dhcp ? t("modeDhcp") : t("modeStatic");
  return a.ips?.length ? `${mode} ${a.ips.join(", ")}` : `${mode} · ${t("noAddress")}`;
}

function renderAdapters() {
  const box = clear($("#adapters"));
  if (state.hostErr) return;
  if (state.adaptersLoading && !state.adapters.length) { box.append(el("p", { class: "muted" }, t("loading"))); return; }
  if (state.adaptersErr) { box.append(el("p", { class: "error" }, errText(state.adaptersErr))); return; }
  if (!state.adapters.length) { box.append(el("p", { class: "muted" }, t("noAdapters"))); return; }
  const statics = state.status.statics || [];
  for (const a of state.adapters) {
    const st = statics.find((s) => s.guid === a.guid);
    const id = `ad-${a.index}`;
    box.append(el("label", { class: `item adapter${a.index === state.selectedIndex ? " sel" : ""}${a.status !== "Up" ? " down" : ""}`, for: id, title: a.description || "" },
      el("input", { type: "radio", name: "adapter", id, value: String(a.index), checked: a.index === state.selectedIndex, onchange: () => onSelectAdapter(a.index) }),
      el("span", { class: "name" },
        a.name,
        a.isInternet ? el("span", { class: "tag", title: t("internetTitle") }, " 🌐") : null,
        a.isWifi ? el("span", { class: "chip" }, t("wifi")) : null),
      el("span", { class: "live" }, liveText(a), st ? el("span", { class: "muted" }, ` · ${t("staticFrom", { profile: st.profile || t("customName") })}`) : null)));
  }
}

function onSelectAdapter(index) {
  state.selectedIndex = index;
  const a = selectedAdapter();
  rememberAdapter(a);
  if (state.confirm) Object.assign(state.confirm, { internetTicked: false, hostConfirm: null, invalid: null, error: null });
  renderAdapters();
  renderConfirm();
}

// ---------- profiles ----------

// Search: every word must appear in the name, IPs or note ("p2-055", "p2055", "หนองกลางดง",
// "10.100.35"). The built-in DHCP profile always stays at the top.
const fold = (s) => String(s || "").toLowerCase();
const squash = (s) => s.replace(/[-\s·]/g, "");
function matchesSearch(p, words) {
  if (!words.length || p.id === "dhcp") return true;
  const hay = fold([p.name, p.ip, p.gateway, p.testHost, p.note].join(" "));
  const hay2 = squash(hay);
  return words.every((w) => hay.includes(w) || hay2.includes(squash(w)));
}
function searchWords() {
  return fold($("#profileSearch").value).split(/\s+/).filter(Boolean);
}
function filteredProfiles() {
  const words = searchWords();
  return state.profiles.filter((p) => matchesSearch(p, words));
}

function renderProfiles() {
  const box = clear($("#profiles"));
  const shown = filteredProfiles();
  const q = $("#profileSearch").value.trim();
  $("#profileCount").textContent = q ? t("profileCount", { shown: shown.filter((p) => p.id !== "dhcp").length, total: state.profiles.length - 1 }) : "";
  if (q && !shown.some((p) => p.id !== "dhcp")) box.append(el("p", { class: "muted small" }, t("noMatch", { q })));
  for (const p of shown) {
    const active = state.confirm?.profile?.id === p.id;
    box.append(el("button", { type: "button", class: `item profile${active ? " sel" : ""}`, onclick: () => openConfirm(p) },
      el("span", { class: "name" }, "▶ ", p.name),
      el("span", { class: "live" }, profileSummary(p))));
  }
}

function openConfirm(profile) {
  const pref = (profile.preferredAdapter || "").toLowerCase();
  if (pref) {
    const match = state.adapters.find((a) => a.name.toLowerCase().includes(pref));
    if (match) { state.selectedIndex = match.index; renderAdapters(); }
  }
  state.confirm = { profile, internetTicked: false, busy: false, hostConfirm: null, invalid: null, error: null };
  state.result = null;
  renderResult();
  renderProfiles();
  renderConfirm();
  $("#confirm").scrollIntoView({ block: "nearest" });
}

function closeConfirm() {
  state.confirm = null;
  renderProfiles();
  renderConfirm();
}

function confirmChecks() {
  const c = state.confirm;
  const a = selectedAdapter();
  const p = c.profile;
  const errors = validateProfile(p);
  const overlaps = a && p.mode === "static" && !errors.ip && !errors.prefix
    ? findOverlaps(state.adapters, a.index, p.ip, p.prefix) : [];
  const pend = state.status.pending;
  const busyOther = !!(pend && a && pend.index !== a.index);
  return { a, p, errors, overlaps, busyOther };
}

function renderConfirm() {
  const box = clear($("#confirm"));
  const c = state.confirm;
  if (!c) return;
  const { a, p, errors, overlaps, busyOther } = confirmChecks();
  const panel = el("div", { class: "panel" });
  box.append(panel);

  panel.append(el("h3", {}, t("applyTitle", { profile: p.name, adapter: a ? a.name : "—" })));
  if (!a) {
    panel.append(el("p", { class: "error" }, t("selectAdapter")));
  } else {
    panel.append(el("dl", { class: "kv" },
      el("dt", {}, t("now")), el("dd", {}, formatConfig(a.config)),
      el("dt", {}, t("next")), el("dd", { class: "strong" }, formatConfig(profileToConfig(p))),
      el("dt", {}, t("test")), el("dd", {}, p.testHost ? t("testPing", { host: p.testHost }) : t("noTest")),
      ...(p.note ? [el("dt", {}, t("devices")), el("dd", { class: "small" }, p.note)] : [])));
    const sec = state.settings.rollbackSec;
    panel.append(el("p", { class: "muted small" }, sec > 0 ? t("rollbackNote", { sec }) : t("rollbackNone")));
  }

  const errList = Object.values(errors);
  if (errList.length) {
    panel.append(el("div", { class: "warn-box err" }, el("strong", {}, t("profileInvalid")), el("ul", {}, errList.map((m) => el("li", {}, m)))));
  }
  if (a?.isInternet) {
    panel.append(el("div", { class: "warn-box" },
      el("p", {}, t("warnInternet", { adapter: a.name })),
      el("label", { class: "check" },
        el("input", { type: "checkbox", checked: c.internetTicked, onchange: (ev) => { c.internetTicked = ev.target.checked; renderConfirm(); } }),
        " ", t("ackInternet"))));
  }
  if (a?.isWifi && p.mode === "static") panel.append(el("div", { class: "warn-box info" }, t("warnWifi")));
  for (const o of overlaps) panel.append(el("div", { class: "warn-box" }, t("warnOverlap", o)));
  if (busyOther) panel.append(el("div", { class: "warn-box err" }, t("busyOther", { adapter: state.status.pending.adapter })));

  if (c.hostConfirm?.length) {
    panel.append(el("div", { class: "warn-box" }, el("strong", {}, t("hostAsks")),
      el("ul", {}, c.hostConfirm.map((d) => el("li", {}, d?.message || d?.code || String(d))))));
  }
  if (c.invalid?.length) {
    panel.append(el("div", { class: "warn-box err" }, el("strong", {}, t("invalidFromHost")),
      el("ul", {}, c.invalid.map((d) => el("li", {}, d?.field ? `${d.field}: ${d.message}` : String(d?.message ?? d))))));
  }
  if (c.error) panel.append(el("p", { class: "error" }, c.error));
  if (c.busy) panel.append(el("p", { class: "muted" }, el("span", { class: "spin" }), " ", t("working")));

  const blocked = !canApply() || !a || errList.length > 0 || busyOther || c.busy || (a.isInternet && !c.internetTicked);
  const buttons = el("div", { class: "row gap end" },
    el("button", { type: "button", onclick: closeConfirm, disabled: c.busy }, t("cancel")));
  if (c.hostConfirm?.length) {
    buttons.append(el("button", { type: "button", class: "primary danger", disabled: !canApply() || !a || errList.length > 0 || busyOther || c.busy, onclick: () => doApply(true) }, t("applyAnyway")));
  } else {
    buttons.append(el("button", { type: "button", class: "primary", disabled: blocked, onclick: () => doApply(false) }, t("apply")));
  }
  panel.append(buttons);
}

async function doApply(anyway) {
  const c = state.confirm;
  const { a, p, overlaps } = confirmChecks();
  if (!a) return;
  const ack = [];
  if (a.isInternet && c.internetTicked) ack.push("internet");
  if (overlaps.length) ack.push("overlap");
  if (anyway && c.hostConfirm) for (const d of c.hostConfirm) if (d?.code) ack.push(d.code);
  const args = applyArgs(p, a.index, state.settings.rollbackSec, ack);

  Object.assign(c, { busy: true, error: null, invalid: null });
  renderConfirm();
  try {
    const data = await callHost("apply", args);
    replaceAdapter(data?.adapter);
    rememberAdapter(a);
    const lines = [];
    let head = t("applied");
    const test = data?.test;
    if (test) head += " · " + (test.ok ? t("pingOk", { host: test.host, ms: test.rttMs }) : t("pingFail", { host: test.host }));
    lines.push(head);
    for (const w of data?.warnings || []) lines.push(String(w));
    if (test && !test.ok && data?.pending) lines.push(t("pingFailPending"));
    state.result = { kind: test && !test.ok ? "warn" : "ok", lines, openUrl: p.openUrl || null };
    state.status.pending = data?.pending ?? null;
    state.confirm = null;
    expiryPolls = 0;
  } catch (e) {
    c.busy = false;
    if (e.code === "needs_confirm") c.hostConfirm = Array.isArray(e.detail) ? e.detail : [{ message: e.message }];
    else if (e.code === "invalid") c.invalid = Array.isArray(e.detail) ? e.detail : [{ message: e.message }];
    else c.error = t("failed", { message: errText(e) });
  }
  renderResult();
  renderProfiles();
  renderConfirm();
  renderPending();
  renderAdapters();
  if (!state.confirm) {
    await loadStatus();
    requestBadgeRefresh();
  }
}

// ---------- custom ----------

const customVals = { name: "", ip: "", prefix: "24", gateway: "", dns1: "", dns2: "", testHost: "" };

function customProfile(name) {
  return {
    name, mode: "static", ip: customVals.ip.trim(), prefix: customVals.prefix.trim(),
    gateway: customVals.gateway.trim(), dns: [customVals.dns1, customVals.dns2].map((s) => s.trim()).filter(Boolean),
    testHost: customVals.testHost.trim(),
  };
}

function renderCustom() {
  const box = clear($("#custom"));
  box.hidden = !state.customOpen;
  if (!state.customOpen) return;
  const errs = {};
  const field = (key, label, ph, errKey = key) => {
    const err = el("span", { class: "ferr", "aria-live": "polite" });
    errs[errKey] = errs[errKey] || [];
    errs[errKey].push(err);
    return el("label", { class: "field" },
      el("span", {}, label),
      el("input", { value: customVals[key], placeholder: ph, inputmode: key === "name" ? null : "decimal", autocomplete: "off", spellcheck: "false",
        oninput: (ev) => { customVals[key] = ev.target.value; validate(); } }),
      err);
  };
  const status = el("p", { class: "small" });
  const applyBtn = el("button", { type: "button", class: "primary", onclick: () => {
    const p = { ...customProfile(t("customName")), id: "custom" };
    p.prefix = parsePrefix(p.prefix);
    openConfirm(p);
  } }, t("apply"));
  const saveBtn = el("button", { type: "button", onclick: async () => {
    if (!customVals.name.trim()) { status.textContent = t("nameForSave"); status.className = "small error"; return; }
    try {
      await saveProfile(customProfile(customVals.name.trim()));
      state.profiles = await listProfiles();
      renderProfiles();
      status.textContent = t("saved");
      status.className = "small ok";
    } catch (e) {
      status.textContent = e.errors ? Object.values(e.errors).join(" · ") : errText(e);
      status.className = "small error";
    }
  } }, t("saveAsProfile"));

  box.append(el("div", { class: "panel" },
    el("h3", {}, t("customTitle")),
    el("div", { class: "grid" },
      field("ip", t("fIp"), "10.100.35.1"),
      field("prefix", t("fPrefix"), "24 / 255.255.255.0"),
      field("gateway", `${t("fGateway")} (${t("optional")})`, "10.100.35.254"),
      field("testHost", `${t("fTestHost")} (${t("optional")})`, "10.100.35.254"),
      field("dns1", `${t("fDns1")} (${t("optional")})`, "", "dns"),
      field("dns2", `${t("fDns2")} (${t("optional")})`, "", "dns"),
      field("name", `${t("fName")} (${t("saveAsProfile").toLowerCase()})`, "Inverter LAN")),
    el("div", { class: "row gap end" }, saveBtn, applyBtn),
    status));

  function validate() {
    const e = validateProfile(customProfile(customVals.name.trim() || t("customName")));
    for (const [k, nodes] of Object.entries(errs)) {
      // Show DNS errors once (under DNS 1).
      nodes.forEach((n, i) => { n.textContent = i === 0 && e[k] ? e[k] : ""; });
    }
    if (!customVals.ip.trim()) errs.ip[0].textContent = "";
    const bad = Object.keys(e).length > 0;
    applyBtn.disabled = bad || !canApply();
    saveBtn.disabled = bad;
  }
  validate();
}

// ---------- ping ----------

async function onPing(ev) {
  ev.preventDefault();
  const out = $("#pingOut");
  const host = $("#pingHost").value.trim();
  const err = testHostProblem(host);
  if (err) { out.textContent = err; out.className = "ping-out error"; return; }
  out.textContent = "…";
  out.className = "ping-out muted";
  $("#pingGo").disabled = true;
  try {
    const r = await callHost("ping", { host });
    out.textContent = r?.ok ? t("pingOkShort", { ms: r.rttMs }) : t("pingFailShort");
    out.className = `ping-out ${r?.ok ? "ok" : "error"}`;
  } catch (e) {
    out.textContent = errText(e);
    out.className = "ping-out error";
  }
  $("#pingGo").disabled = false;
}

// ---------- init ----------

// Opened as its own window (desktop shortcut runs `--app=…/popup.html?mode=window`, or ⧉ below).
const IN_WINDOW = new URLSearchParams(location.search).get("mode") === "window";
const WINDOW_URL = chrome.runtime.getURL("popup.html?mode=window");

async function openOwnWindow() {
  // Focus the window if it's already open (getContexts needs no "tabs" permission).
  try {
    const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [WINDOW_URL] });
    if (ctx && ctx.windowId >= 0) {
      await chrome.windows.update(ctx.windowId, { focused: true });
      window.close();
      return;
    }
  } catch { /* older browser: just open a new one */ }
  await chrome.windows.create({ url: WINDOW_URL, type: "popup", width: 440, height: 720, focused: true });
  window.close();
}

async function init() {
  if (IN_WINDOW) document.documentElement.classList.add("window");
  applyStrings(document);
  $("#openWindow").addEventListener("click", openOwnWindow);
  $("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#newProfile").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#new") }));
  $("#customBtn").addEventListener("click", () => { state.customOpen = !state.customOpen; renderCustom(); });
  $("#pingForm").addEventListener("submit", onPing);
  const search = $("#profileSearch");
  search.addEventListener("input", renderProfiles);
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      // Enter opens the first matching plant profile (not the DHCP one).
      const first = filteredProfiles().find((p) => p.id !== "dhcp");
      if (first && searchWords().length) { ev.preventDefault(); openConfirm(first); }
    } else if (ev.key === "Escape" && search.value) {
      ev.preventDefault(); ev.stopPropagation(); search.value = ""; renderProfiles();
    }
  });
  $("#showAll").addEventListener("change", async (ev) => {
    state.settings = await saveSettings({ showAll: ev.target.checked });
    loadAdapters();
  });

  try { await seedIfEmpty(); } catch { /* storage unavailable */ }
  state.settings = await getSettings();
  state.profiles = await listProfiles();
  search.hidden = state.profiles.length <= 6;
  if (!search.hidden) search.focus();
  $("#showAll").checked = state.settings.showAll;
  const firstTest = state.profiles.find((p) => p.testHost)?.testHost;
  if (firstTest) $("#pingHost").value = firstTest;
  renderProfiles();
  renderAdapters();

  try {
    state.health = await callHost("health");
  } catch (e) {
    state.hostErr = e;
  }
  renderBanners();
  renderCustom();
  if (state.hostErr) {
    state.adaptersLoading = false;
    renderAdapters();
    $("#pingGo").disabled = true;
    requestBadgeRefresh();
    return;
  }
  await refreshAll();
  if (IN_WINDOW) {
    // A window stays open for hours: re-read the adapters when it comes back to the front, and
    // the pending state every 15 s (cheap: `status` reads files only).
    let last = Date.now();
    window.addEventListener("focus", () => { if (Date.now() - last > 5000) { last = Date.now(); refreshAll(); } });
    setInterval(() => { if (!document.hidden) loadStatus(); }, 15000);
  }
}

// Keep the popup in step with changes made from the options page.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.profiles) {
    state.profiles = await listProfiles();
    $("#profileSearch").hidden = state.profiles.length <= 6;
    renderProfiles();
  }
  if (changes.settings) state.settings = await getSettings();
});

init();
