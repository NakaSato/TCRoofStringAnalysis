// Popup: current IP, adapters, profiles, inline confirm, pending Keep / Revert, ping console (spec §14.2).

import { t, applyStrings, setLang, currentLang, tValue } from "./lib/strings.js";
import { callHost, requestBadgeRefresh, PROTOCOL_VERSION } from "./lib/host.js";
import { el, clear, $ } from "./lib/dom.js";
import {
  validateProfile, formatConfig, prefixToMask, profileToConfig, profileSummary, findOverlaps, applyArgs,
  testHostProblem,
} from "./lib/net.js";
import { listProfiles, getSettings, saveSettings, seedIfEmpty, rememberRecent } from "./lib/store.js";

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
  if (a.status !== "Up") return tValue("st", a.status);
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
  renderCurrent();
}

// "This computer's IP": the selected adapter's live address, big, with mask / gateway / DNS / MAC.
function renderCurrent() {
  renderPingChips();
  const box = clear($("#current"));
  const a = selectedAdapter();
  if (!a || state.hostErr) return;
  const mode = a.config?.dhcp === false ? t("modeStatic") : t("modeDhcp");
  const ips = (a.ips || []).map((x) => { const [ip, pfx] = String(x).split("/"); return { ip, pfx: Number(pfx) }; });
  const main = ips[0];
  const copyBtn = main ? el("button", { type: "button", class: "small", onclick: async (ev) => {
    try { await navigator.clipboard.writeText(main.ip); ev.target.textContent = t("copied"); setTimeout(() => { ev.target.textContent = t("copy"); }, 1500); } catch { /* clipboard blocked */ }
  } }, t("copy")) : null;
  const kv = [];
  const add = (k, v) => { if (v) kv.push(el("dt", {}, k), el("dd", {}, v)); };
  if (main && main.pfx) add(t("cMask"), `/${main.pfx} · ${prefixToMask(main.pfx)}`);
  if (ips.length > 1) add("", ips.slice(1).map((x) => `${x.ip}/${x.pfx}`).join(", "));
  add(t("cGateway"), a.gateway || "—");
  add(t("cDns"), (a.dns || []).join(", ") || "—");
  add(t("cMac"), a.mac || "");
  box.append(el("div", { class: "current" },
    el("div", { class: "row gap" },
      el("span", { class: "grow small muted" }, t("currentIp"), " · ", a.name),
      el("span", { class: "chip" }, a.status === "Up" ? mode : tValue("st", a.status))),
    el("div", { class: "row gap" },
      el("span", { class: "bigip grow" }, main ? main.ip : t("cNoIp")),
      copyBtn),
    kv.length ? el("dl", { class: "kv small" }, kv) : null,
    backToAutoButton(a)));
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
  const row = (p) => {
    const active = state.confirm?.profile?.id === p.id;
    // "P2-055 · สถานีผลิตน้ำหนองกลางดง" → code in bold, the name underneath (no cut-off names).
    const cut = p.name.indexOf(" · ");
    const head = cut > 0 ? p.name.slice(0, cut) : p.name;
    const sub = cut > 0 ? p.name.slice(cut + 3) : "";
    return el("button", { type: "button", class: `item profile${active ? " sel" : ""}`, onclick: () => openConfirm(p), title: p.note || "" },
      el("span", { class: "pmain" }, el("span", { class: "phead" }, head), sub ? el("span", { class: "psub" }, sub) : null),
      el("span", { class: "live" }, profileSummary(p)));
  };
  const recentIds = q ? [] : (state.settings?.recent || []);
  const recent = recentIds.map((id) => state.profiles.find((p) => p.id === id)).filter(Boolean);
  const dhcp = shown.filter((p) => p.id === "dhcp");
  const rest = shown.filter((p) => p.id !== "dhcp" && !recent.includes(p));
  for (const p of dhcp) box.append(row(p));
  if (recent.length) {
    box.append(el("div", { class: "group" }, t("recent")));
    for (const p of recent) box.append(row(p));
    if (rest.length) box.append(el("div", { class: "group" }, t("allProfiles")));
  }
  for (const p of rest) box.append(row(p));
}

// "Back to automatic (DHCP)" button, shown inside the current-IP card while the selected adapter
// is static (one click: no confirm, no Keep window; see doApply).
function backToAutoButton(a) {
  const dhcp = state.profiles.find((p) => p.id === "dhcp");
  if (!a || !dhcp || a.config?.dhcp !== false || state.status.pending || state.confirm?.busy || !canApply()) return null;
  return el("button", { type: "button", class: "primary wide", onclick: () => { openConfirm(dhcp); doApply(false); } }, t("backToAuto"));
}

function openConfirm(profile) {
  const pref = (profile.preferredAdapter || "").toLowerCase();
  if (pref) {
    const match = state.adapters.find((a) => a.name.toLowerCase().includes(pref));
    if (match) { state.selectedIndex = match.index; renderAdapters(); }
  }
  if (profile.testHost) $("#pingHost").value = profile.testHost;
  setTimeout(renderPingChips, 0);
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

// "DHCP" or "10.100.200.250/24" for the "now" line.
function shortConfig(c) {
  if (!c || c.dhcp) return t("modeDhcp");
  return c.addrs?.[0] || t("noAddress");
}

// Plant notes look like "Router 10.1.1.254 · ShineMaster 10.1.1.100 · Meter 10.1.1.1, 10.1.1.2":
// split them into rows. Anything else (free text) returns null and is shown as a paragraph.
function noteDevices(note) {
  if (!note) return null;
  const parts = String(note).split(" · ").map((x) => x.trim()).filter(Boolean);
  const rows = parts.map((x) => /^(\S+)\s+(\d{1,3}(\.\d{1,3}){3}(,\s*\d{1,3}(\.\d{1,3}){3})*)$/.exec(x)).map((m) => m && [m[1], m[2]]);
  return rows.length && rows.every(Boolean) ? rows : null;
}

function renderConfirm() {
  const box = clear($("#confirm"));
  const c = state.confirm;
  if (!c) return;
  const { a, p, errors, overlaps, busyOther } = confirmChecks();
  const panel = el("div", { class: "panel" });
  box.append(panel);

  // Clean, IP-first layout: plant title, the new IP big, everything else one short muted line.
  const cut = p.name.indexOf(" · ");
  panel.append(el("div", { class: "c-head" },
    el("span", { class: "c-title" }, cut > 0 ? p.name.slice(0, cut) : p.name),
    cut > 0 ? el("span", { class: "c-sub" }, p.name.slice(cut + 3)) : null));
  if (!a) {
    panel.append(el("p", { class: "error" }, t("selectAdapter")));
  } else {
    const next = profileToConfig(p);
    const [ip, pfx] = String(next.addrs?.[0] || "").split("/");
    panel.append(el("div", { class: "c-hero" },
      el("div", { class: "c-label" }, t("newIp")),
      el("div", { class: "c-big" }, next.dhcp ? t("modeDhcp") : ip),
      el("div", { class: "c-small" }, next.dhcp ? t("autoAddr")
        : [`/${pfx} · ${prefixToMask(Number(pfx))}`, next.gateway ? `GW ${next.gateway}` : t("noGateway")].join(" · ")),
      el("div", { class: "c-now" }, t("nowOn", { adapter: a.name, config: shortConfig(a.config) }))));
    const sec = p.mode === "dhcp" ? 0 : state.settings.rollbackSec;
    const facts = [p.testHost ? t("factPing", { host: p.testHost }) : null, sec > 0 ? t("factUndo", { sec }) : t("factKept")].filter(Boolean);
    panel.append(el("p", { class: "c-facts" }, facts.join(" · ")));
    const devs = noteDevices(p.note);
    if (devs) {
      panel.append(el("details", { class: "c-devs" },
        el("summary", {}, t("devices"), el("span", { class: "muted" }, ` · ${devs.map(([k]) => k).join(", ")}`)),
        el("dl", { class: "kv small" }, devs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))));
    } else if (p.note) {
      panel.append(el("p", { class: "c-facts" }, p.note));
    }
  }

  const errList = Object.values(errors);
  if (errList.length) {
    panel.append(el("div", { class: "warn-box err" }, el("strong", {}, t("profileInvalid")), el("ul", {}, errList.map((m) => el("li", {}, m)))));
  }
  // Back to DHCP is the safe direction: no internet-adapter tick needed for it.
  if (a?.isInternet && p.mode !== "dhcp") {
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

  const blocked = !canApply() || !a || errList.length > 0 || busyOther || c.busy || (a.isInternet && p.mode !== "dhcp" && !c.internetTicked);
  const buttons = el("div", { class: "row gap end c-buttons" },
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
  if (a.isInternet && (c.internetTicked || p.mode === "dhcp")) ack.push("internet");
  if (overlaps.length) ack.push("overlap");
  if (anyway && c.hostConfirm) for (const d of c.hostConfirm) if (d?.code) ack.push(d.code);
  // Back to DHCP (returning to normal) is kept at once; static changes get the Keep / Revert window.
  const args = applyArgs(p, a.index, p.mode === "dhcp" ? 0 : state.settings.rollbackSec, ack);

  Object.assign(c, { busy: true, error: null, invalid: null });
  renderConfirm();
  try {
    const data = await callHost("apply", args);
    replaceAdapter(data?.adapter);
    rememberAdapter(a);
    if (state.profiles.some((x) => x.id === p.id)) state.settings = await rememberRecent(p.id);
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




// ---------- ping ----------

// ---------- ping console (continuous, one try a second, like `ping -t`) ----------

const PING_EVERY_MS = 1000;
const PING_MAX_LINES = 300;
const ping = { running: false, host: "", sent: 0, recv: 0, min: Infinity, max: 0, sum: 0 };

function pingLine(cls, text) {
  const log = $("#pingLog");
  log.hidden = false;
  const now = new Date().toLocaleTimeString([], { hour12: false });
  log.append(el("div", { class: `pl ${cls}` }, el("span", { class: "pt" }, now), " ", text));
  while (log.childElementCount > PING_MAX_LINES) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function pingStatsText() {
  if (!ping.sent) return "";
  const loss = Math.round(((ping.sent - ping.recv) / ping.sent) * 100);
  let s = t("pingStats", { sent: ping.sent, recv: ping.recv, loss });
  if (ping.recv) s += " · " + t("pingRtt", { min: ping.min, avg: Math.round(ping.sum / ping.recv), max: ping.max });
  return s;
}

function setPingButton() {
  const b = $("#pingGo");
  b.textContent = ping.running ? t("pingStop") : t("pingStart");
  b.className = ping.running ? "danger" : "primary";
}

function stopPing() {
  ping.running = false;
  setPingButton();
}

async function startPing(host) {
  const err = testHostProblem(host);
  if (err) { pingLine("err", err); return; }
  Object.assign(ping, { running: true, host, sent: 0, recv: 0, min: Infinity, max: 0, sum: 0 });
  clear($("#pingLog"));
  $("#pingStats").textContent = "";
  setPingButton();
  while (ping.running && ping.host === host) {
    const started = Date.now();
    try {
      const r = await callHost("ping", { host, once: true });
      if (!ping.running || ping.host !== host) break;
      ping.sent++;
      if (r?.ok) {
        ping.recv++;
        ping.min = Math.min(ping.min, r.rttMs);
        ping.max = Math.max(ping.max, r.rttMs);
        ping.sum += r.rttMs;
        pingLine("ok", t("pingReply", { host, ms: r.rttMs }));
      } else {
        pingLine("bad", t("pingTimeout", { host }));
      }
      $("#pingStats").textContent = pingStatsText();
    } catch (e) {
      pingLine("err", errText(e));
      stopPing();
      break;
    }
    const wait = PING_EVERY_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

function onPing(ev) {
  ev.preventDefault();
  if (ping.running) { stopPing(); return; }
  startPing($("#pingHost").value.trim());
}

// Quick targets: the selected adapter's gateway and the devices of the plant last picked.
function renderPingChips() {
  const box = clear($("#pingChips"));
  const a = selectedAdapter();
  const items = [];
  const add = (label, ip) => { if (ip && !items.some((x) => x[1] === ip)) items.push([label, ip]); };
  if (a?.gateway) add(t("pingGateway"), a.gateway);
  const p = state.confirm?.profile || state.profiles.find((x) => x.id === state.settings?.recent?.[0]);
  for (const [label, ips] of noteDevices(p?.note) || []) for (const ip of ips.split(/,\s*/)) add(label, ip);
  if (p?.testHost) add(t("test"), p.testHost);
  for (const [label, ip] of items.slice(0, 8)) {
    box.append(el("button", { type: "button", class: "chip-btn", title: ip, onclick: () => {
      $("#pingHost").value = ip;
      stopPing();
      startPing(ip);
    } }, el("span", { class: "muted" }, label), " ", ip));
  }
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
  try { setLang((await getSettings()).lang); } catch { setLang(""); }
  applyStrings(document);
  $("#langToggle").addEventListener("click", async () => {
    // EN ⇄ TH; reload so every string (including rendered lists) switches.
    await saveSettings({ lang: currentLang() === "th" ? "en" : "th" });
    location.reload();
  });
  $("#openWindow").addEventListener("click", openOwnWindow);
  $("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#pingForm").addEventListener("submit", onPing);
  $("#pingHost").addEventListener("input", () => { if (ping.running) stopPing(); });
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
  // Ping box: the test host of the last plant used (not some unrelated profile).
  const lastUsed = state.profiles.find((p) => p.id === state.settings.recent[0]);
  if (lastUsed?.testHost) $("#pingHost").value = lastUsed.testHost;
  renderProfiles();
  renderAdapters();

  try {
    state.health = await callHost("health");
  } catch (e) {
    state.hostErr = e;
  }
  renderBanners();
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
