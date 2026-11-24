// node --test ipswitcher/extension/test/
// Covers lib/net.js (the PROTOCOL.md validation table) and lib/store.js import / seeding.
import test from "node:test";
import assert from "node:assert/strict";

// In-memory chrome.storage.local stub (store.js reads globalThis.chrome lazily).
let mem = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        const keys = key == null ? Object.keys(mem) : Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (k in mem) out[k] = structuredClone(mem[k]);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) mem[k] = structuredClone(v); },
    },
  },
};

const net = await import("../lib/net.js");
const store = await import("../lib/store.js");
const { validateProfile, parseIPv4, parsePrefix, maskToPrefix, prefixToMask, formatConfig, findOverlaps, applyArgs } = net;

const base = { name: "T", mode: "static", ip: "10.100.35.1", prefix: 24, gateway: "10.100.35.254", dns: [], testHost: "10.100.35.254" };
const v = (patch) => validateProfile({ ...base, ...patch });

test("parseIPv4: dotted quads, no leading zeros", () => {
  assert.equal(parseIPv4("10.100.35.1"), 0x0a642301);
  assert.equal(parseIPv4("255.255.255.255"), 0xffffffff);
  assert.equal(parseIPv4("0.0.0.0"), 0);
  for (const bad of ["010.1.1.1", "10.01.1.1", "10.1.1.00", "256.1.1.1", "1.1.1", "1.1.1.1.1", " 1.1.1.1", "1.1.1.1 ", "a.b.c.d", "", "1..1.1", "+1.1.1.1", "1e2.1.1.1"]) {
    assert.equal(parseIPv4(bad), null, bad);
  }
  assert.equal(parseIPv4(123), null);
});

test("ip: leading zeros, reserved ranges", () => {
  assert.deepEqual(v({}), {});
  assert.ok(v({ ip: "10.100.035.1" }).ip, "leading zero");
  assert.ok(v({ ip: "0.0.0.0", gateway: "" }).ip, "0.0.0.0");
  assert.ok(v({ ip: "127.0.0.5", prefix: 8, gateway: "" }).ip, "loopback");
  assert.ok(v({ ip: "169.254.10.10", prefix: 16, gateway: "" }).ip, "link-local");
  assert.ok(v({ ip: "224.0.0.1", gateway: "" }).ip, "multicast");
  assert.ok(v({ ip: "240.1.1.1", gateway: "" }).ip, "reserved");
  assert.ok(v({ ip: "255.255.255.255", gateway: "" }).ip, "broadcast all");
  assert.deepEqual(v({ ip: "223.255.255.1", gateway: "", testHost: "" }), {});
  assert.deepEqual(v({ ip: "169.253.1.1", prefix: 24, gateway: "", testHost: "" }), {});
  assert.ok(v({ ip: "" }).ip, "required");
});

test("ip: network / broadcast at /24, allowed at /31 and /32", () => {
  assert.match(v({ ip: "10.100.35.0" }).ip, /network address of 10\.100\.35\.0\/24/);
  assert.match(v({ ip: "10.100.35.255" }).ip, /broadcast address of 10\.100\.35\.0\/24/);
  assert.ok(v({ ip: "10.0.0.4", prefix: 30, gateway: "" }).ip, "/30 network");
  assert.ok(v({ ip: "10.0.0.7", prefix: 30, gateway: "" }).ip, "/30 broadcast");
  assert.deepEqual(v({ ip: "10.0.0.4", prefix: 31, gateway: "10.0.0.5" }), {});
  assert.deepEqual(v({ ip: "10.0.0.5", prefix: 31, gateway: "10.0.0.4" }), {});
  assert.deepEqual(v({ ip: "10.0.0.0", prefix: 32, gateway: "" }), {});
  assert.deepEqual(v({ ip: "10.0.0.255", prefix: 32, gateway: "" }), {});
});

test("prefix: 24, /24, mask; range 8–32; non-contiguous mask rejected", () => {
  assert.equal(parsePrefix("24"), 24);
  assert.equal(parsePrefix("/24"), 24);
  assert.equal(parsePrefix(" 255.255.255.0 "), 24);
  assert.equal(parsePrefix("255.255.255.252"), 30);
  assert.equal(parsePrefix("255.255.255.255"), 32);
  assert.equal(parsePrefix(16), 16);
  assert.equal(parsePrefix("255.255.0.255"), null);
  assert.equal(parsePrefix("255.0.255.0"), null);
  assert.equal(parsePrefix("33"), null);
  assert.equal(parsePrefix("24.5"), null);
  assert.equal(parsePrefix(24.5), null);
  assert.equal(maskToPrefix("0.0.0.0"), 0);
  assert.equal(prefixToMask(24), "255.255.255.0");
  assert.equal(prefixToMask(32), "255.255.255.255");
  assert.equal(prefixToMask(8), "255.0.0.0");

  assert.deepEqual(v({ prefix: "255.255.255.0" }), {});
  assert.deepEqual(v({ prefix: "/24" }), {});
  assert.match(v({ prefix: "255.255.0.255" }).prefix, /mask/);
  assert.ok(v({ prefix: 7, gateway: "" }).prefix, "below 8");
  assert.ok(v({ prefix: "7", gateway: "" }).prefix, "below 8 (text)");
  assert.ok(v({ prefix: 33 }).prefix, "above 32");
  assert.ok(v({ prefix: "" }).prefix, "required");
  assert.ok(v({ prefix: "abc" }).prefix, "garbage");
  assert.deepEqual(v({ ip: "10.1.2.3", prefix: 8, gateway: "10.200.0.1" }), {});
});

test("gateway: invalid, outside the subnet, equal to the IP", () => {
  assert.deepEqual(v({ gateway: "" }), {}, "optional");
  assert.match(v({ gateway: "10.100.36.1" }).gateway, /inside 10\.100\.35\.0\/24/);
  assert.equal(v({ gateway: "10.100.36.1" }).gateway, "Gateway must be inside 10.100.35.0/24");
  assert.match(v({ gateway: "10.100.35.1" }).gateway, /same as the IP/);
  assert.ok(v({ gateway: "10.100.35.0254" }).gateway, "leading zero");
  assert.ok(v({ gateway: "127.0.0.1" }).gateway, "loopback");
  assert.ok(v({ ip: "10.0.0.1", prefix: 32, gateway: "10.0.0.2" }).gateway, "/32 has no room for a gateway");
});

test("dns: at most 2, each valid", () => {
  assert.deepEqual(v({ dns: ["8.8.8.8"] }), {});
  assert.deepEqual(v({ dns: ["8.8.8.8", "1.1.1.1"] }), {});
  assert.ok(v({ dns: ["8.8.8.8", "1.1.1.1", "9.9.9.9"] }).dns, "3 DNS");
  assert.match(v({ dns: ["8.8.8.8", "08.8.8.8"] }).dns, /^DNS 2:/);
  assert.ok(v({ dns: ["224.0.0.1"] }).dns);
  assert.deepEqual(v({ dns: ["9.9.9.9"], ip: "10.100.35.1" }), {}, "no subnet check for DNS");
});

test("testHost: dotted IPv4, not 0.0.0.0, below 224", () => {
  assert.deepEqual(v({ testHost: "" }), {});
  assert.deepEqual(v({ testHost: "8.8.8.8" }), {}, "outside subnet is fine");
  assert.deepEqual(v({ testHost: "127.0.0.1" }), {}, "loopback allowed for testHost");
  assert.ok(v({ testHost: "0.0.0.0" }).testHost);
  assert.ok(v({ testHost: "224.0.0.1" }).testHost);
  assert.ok(v({ testHost: "host.local" }).testHost);
});

test("dhcp profile: static fields must be empty; name and mode required", () => {
  assert.deepEqual(validateProfile({ name: "D", mode: "dhcp" }), {});
  assert.deepEqual(validateProfile({ name: "D", mode: "dhcp", ip: "", prefix: null, gateway: "", dns: [] }), {});
  assert.ok(validateProfile({ name: "D", mode: "dhcp", ip: "10.0.0.1" }).ip);
  assert.ok(validateProfile({ name: "D", mode: "dhcp", dns: ["8.8.8.8"] }).dns);
  assert.ok(validateProfile({ name: "", mode: "dhcp" }).name);
  assert.ok(validateProfile({ name: "x".repeat(65), mode: "dhcp" }).name);
  assert.ok(validateProfile({ name: "D", mode: "auto" }).mode);
});

test("openUrl: http(s) only", () => {
  assert.deepEqual(v({ openUrl: "http://192.168.1.1/" }), {});
  assert.deepEqual(v({ openUrl: "https://10.100.35.254:8443/login" }), {});
  assert.ok(v({ openUrl: "javascript:alert(1)" }).openUrl);
  assert.ok(v({ openUrl: "file:///C:/x" }).openUrl);
  assert.ok(v({ openUrl: "not a url" }).openUrl);
});

test("formatConfig", () => {
  assert.equal(formatConfig({ dhcp: true, addrs: [], gateway: "", dns: [] }), "DHCP");
  assert.equal(formatConfig({ dhcp: false, addrs: ["10.100.35.1/24"], gateway: "10.100.35.254", dns: [] }), "Static 10.100.35.1/24 · GW 10.100.35.254");
  assert.equal(formatConfig({ dhcp: false, addrs: ["10.100.35.1/24"], gateway: "", dns: ["8.8.8.8", "1.1.1.1"] }), "Static 10.100.35.1/24 · DNS 8.8.8.8, 1.1.1.1");
  assert.equal(formatConfig(null), "—");
});

test("findOverlaps: same rule as the host's overlap guardrail", () => {
  const adapters = [
    { index: 1, name: "Ethernet", status: "Up", ips: ["192.168.1.50/24"] },
    { index: 2, name: "Wi-Fi", status: "Up", ips: ["10.100.35.77/24"] },
    { index: 3, name: "USB", status: "Disconnected", ips: ["10.100.35.9/24"] },
    { index: 4, name: "VPN", status: "Up", ips: ["10.0.0.5/8"] },
  ];
  // New 10.100.35.1/24 on Ethernet: Wi-Fi has an address inside it; VPN's /8 contains the new IP.
  const o = findOverlaps(adapters, 1, "10.100.35.1", 24);
  assert.deepEqual(o.map((x) => x.adapter).sort(), ["VPN", "Wi-Fi"]);
  // Target adapter itself and Down adapters are ignored.
  assert.deepEqual(findOverlaps(adapters, 2, "10.100.35.1", 24).map((x) => x.adapter), ["VPN"]);
  assert.deepEqual(findOverlaps(adapters, 1, "172.16.0.1", 24), []);
  // A wide new subnet swallowing another adapter's address.
  assert.deepEqual(findOverlaps(adapters, 2, "192.168.0.1", 16).map((x) => x.adapter), ["Ethernet"]);
  // Mask input accepted.
  assert.equal(findOverlaps(adapters, 1, "10.100.35.1", "255.255.255.0").length, 2);
});

test("applyArgs builds PROTOCOL.md apply args", () => {
  assert.deepEqual(applyArgs({ ...base, name: "TC", prefix: "255.255.255.0" }, 12, 30, ["internet", "internet"]), {
    index: 12, mode: "static", rollbackSec: 30, source: "popup", ip: "10.100.35.1", prefix: 24,
    gateway: "10.100.35.254", testHost: "10.100.35.254", profile: "TC", ack: ["internet"],
  });
  assert.deepEqual(applyArgs({ name: "Automatic (DHCP)", mode: "dhcp", ip: "", dns: [] }, 3, 0), {
    index: 3, mode: "dhcp", rollbackSec: 0, source: "popup", profile: "Automatic (DHCP)",
  });
});

// ---------- store ----------

test("store: seeds the Growatt Ecosystem and Huawei SmartLogger profiles once, DHCP built-in first", async () => {
  mem = {};
  assert.equal(await store.seedIfEmpty(), true);
  assert.equal(await store.seedIfEmpty(), false);
  const list = await store.listProfiles();
  assert.deepEqual(list.map((p) => p.name), ["Automatic (DHCP)", "Growatt Ecosystem · 192.168.10.x", "Huawei SmartLogger · 192.168.0.10"]);
  assert.equal(list[0].id, "dhcp");
  const g = list[1];
  assert.deepEqual(validateProfile(g), {});
  assert.equal(g.id, store.GROWATT_ECOSYSTEM_ID);
  assert.equal(g.ip, "192.168.10.250");
  assert.equal(g.prefix, 24);
  assert.equal(g.gateway, "");
  assert.deepEqual(g.dns, []);
  const h = list[2];
  assert.deepEqual(validateProfile(h), {});
  assert.equal(h.id, store.HUAWEI_SMARTLOGGER_ID);
  assert.equal(h.ip, "192.168.0.250");
  assert.equal(h.testHost, "192.168.0.10");
  assert.equal(h.gateway, "");
  // Deleting everything does not re-seed.
  for (const p of list.slice(1)) await store.deleteProfile(p.id);
  assert.equal(await store.seedIfEmpty(), false);
  assert.equal((await store.listProfiles()).length, 1);
  assert.equal(await store.deleteProfile("dhcp"), false);
});

test("store: importJSON skips invalid profiles and reports counts", async () => {
  mem = {};
  await store.seedIfEmpty();
  const before = await store.listProfiles();
  const doc = {
    version: 1,
    profiles: [
      { name: "Inverter LAN", mode: "static", ip: "192.168.1.100", prefix: 24, gateway: "192.168.1.1", dns: [], testHost: "192.168.1.1" },
      { name: "Mask input", mode: "static", ip: "192.168.0.50", prefix: "255.255.255.0" },
      { name: "DHCP copy", mode: "dhcp" },
      { name: "Bad gateway", mode: "static", ip: "10.0.0.1", prefix: 24, gateway: "10.0.1.1" },
      { name: "Leading zero", mode: "static", ip: "10.0.0.01", prefix: 24 },
      { name: "Three DNS", mode: "static", ip: "10.0.0.1", prefix: 24, dns: ["1.1.1.1", "8.8.8.8", "9.9.9.9"] },
      { name: "", mode: "dhcp" },
      { id: "dhcp", name: "Hijack built-in", mode: "dhcp" },
      "not an object",
      { ...before[1], name: "Renamed seed" },
    ],
  };
  const r = await store.importJSON(JSON.stringify(doc));
  assert.deepEqual(r, { added: 4, skipped: 6 });
  const after = await store.listProfiles();
  assert.deepEqual(after.map((p) => p.name), ["Automatic (DHCP)", "Renamed seed", "Huawei SmartLogger · 192.168.0.10", "Inverter LAN", "Mask input", "DHCP copy"]);
  assert.equal(after.find((p) => p.name === "Mask input").prefix, 24);
  assert.ok(after.every((p, i) => i === 0 || /^[0-9a-f-]{36}$/.test(p.id)));

  await assert.rejects(store.importJSON("{"), /Not an IP Switcher profiles file/);
  await assert.rejects(store.importJSON(JSON.stringify({ version: 2, profiles: [] })), /Not an IP Switcher profiles file/);
  await assert.rejects(store.importJSON(JSON.stringify([])), /Not an IP Switcher profiles file/);

  // Export round-trips.
  const exported = JSON.parse(await store.exportJSON());
  assert.equal(exported.version, 1);
  assert.equal(exported.profiles.length, 5);
  mem = { profiles: [] };
  assert.deepEqual(await store.importJSON(JSON.stringify(exported)), { added: 5, skipped: 0 });
});

test("store: saveProfile validates, moveProfile keeps DHCP first, settings bounds", async () => {
  mem = { profiles: [] };
  await assert.rejects(store.saveProfile({ name: "x", mode: "static", ip: "10.0.0.0", prefix: 24 }), (e) => !!e.errors?.ip);
  await assert.rejects(store.saveProfile({ id: "dhcp", name: "x", mode: "dhcp" }));
  const a = await store.saveProfile({ name: "A", mode: "static", ip: "10.0.0.1", prefix: "/24" });
  const b = await store.saveProfile({ name: "B", mode: "dhcp" });
  assert.equal(a.prefix, 24);
  assert.equal(await store.moveProfile(b.id, -1), true);
  assert.equal(await store.moveProfile(b.id, -1), false);
  assert.deepEqual((await store.listProfiles()).map((p) => p.name), ["Automatic (DHCP)", "B", "A"]);
  await store.saveProfile({ ...a, name: "A2" });
  assert.deepEqual((await store.listProfiles()).map((p) => p.name), ["Automatic (DHCP)", "B", "A2"]);

  assert.equal((await store.getSettings()).rollbackSec, 30);
  await store.saveSettings({ rollbackSec: 0 });
  assert.equal((await store.getSettings()).rollbackSec, 0);
  await assert.rejects(store.saveSettings({ rollbackSec: 301 }));
  await assert.rejects(store.saveSettings({ rollbackSec: 1.5 }));
  await store.saveSettings({ lastAdapterGuid: "{abc}" });
  assert.equal((await store.getSettings()).lastAdapterGuid, "{abc}");
});

test("store: migrates v1 installs (unchanged TC LAN seeds removed, current seeds added once)", async () => {
  const old = (ip, name = `TC LAN · ${ip}`) => ({ id: crypto.randomUUID(), name, mode: "static", ip, prefix: 24,
    gateway: "10.100.35.254", dns: [], testHost: "10.100.35.254", openUrl: "", preferredAdapter: "", note: "" });
  const edited = old("10.100.35.2", "My meter LAN");
  mem = { profiles: [old("10.100.35.1"), edited, old("10.100.35.2")] };
  assert.equal(await store.seedIfEmpty(), false);
  const names = (await store.listProfiles()).map((p) => p.name);
  assert.deepEqual(names, ["Automatic (DHCP)", "My meter LAN", "Growatt Ecosystem · 192.168.10.x", "Huawei SmartLogger · 192.168.0.10"]);
  // Runs once: deleting a seed afterwards does not bring it back.
  await store.deleteProfile(store.GROWATT_ECOSYSTEM_ID);
  await store.seedIfEmpty();
  assert.equal((await store.listProfiles()).length, 3);
});

test("strings: Thai table covers every English key with the same placeholders", async () => {
  const { EN, TH, setLang, t, tValue } = await import("../lib/strings.js");
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(TH).sort(), Object.keys(EN).sort());
  for (const k of Object.keys(EN)) assert.deepEqual(vars(TH[k]), vars(EN[k]), k);
  assert.equal(setLang("th"), "th");
  assert.equal(t("pendingOn", { adapter: "Ethernet", sec: 21 }), "⚠ รอยืนยันที่ Ethernet · 21 วินาที");
  assert.equal(tValue("st", "Disconnected"), "ไม่ได้เสียบสาย");
  assert.equal(tValue("st", "Unknown"), "Unknown");
  assert.equal(setLang("en"), "en");
  assert.equal(t("keep"), "Keep");
});
