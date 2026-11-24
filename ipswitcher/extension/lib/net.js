// IPv4 helpers and profile validation. Mirrors the "Validation" table in ipswitcher/PROTOCOL.md
// (the host enforces the same rules; this copy only gives instant feedback).

import { t } from "./strings.js";

const OCTET = "(?:0|[1-9]\\d{0,2})";
const DOTTED = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** Dotted IPv4 (no leading zeros, each part 0–255) → unsigned 32-bit int, or null. */
export function parseIPv4(s) {
  if (typeof s !== "string" || !DOTTED.test(s)) return null;
  const parts = s.split(".").map(Number);
  if (parts.some((n) => n > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

export function intToIPv4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function prefixToMaskInt(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function prefixToMask(prefix) {
  return intToIPv4(prefixToMaskInt(prefix));
}

/** Dotted mask → prefix length, or null if not a contiguous mask. */
export function maskToPrefix(mask) {
  const m = parseIPv4(mask);
  if (m === null) return null;
  const inv = ~m >>> 0;
  if ((inv & (inv + 1)) !== 0) return null; // 1 bits not contiguous
  let p = 0;
  for (let x = m; x; x = (x << 1) >>> 0) p++;
  return p;
}

/**
 * Prefix input: 24, "24", "/24" or "255.255.255.0" → integer 0–32, or null.
 * (Range 8–32 is checked by validateProfile.)
 */
export function parsePrefix(v) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 32 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.includes(".")) return maskToPrefix(s);
  const m = /^\/?(\d{1,2})$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 32 ? n : null;
}

/** Why a host address can't be used, or null. Shared by ip, gateway and dns. */
export function ipProblem(s) {
  const n = parseIPv4(s);
  if (n === null) return t("vIpFormat");
  if (n === 0) return t("vIpZero");
  if (n >>> 24 === 127) return t("vIpLoopback");
  if (n >>> 16 === ((169 << 8) | 254)) return t("vIpLinkLocal");
  if (n >>> 24 >= 224) return t("vIpMulticast");
  return null;
}

/** testHost rule: dotted IPv4, not 0.0.0.0, not ≥ 224.0.0.0. */
export function testHostProblem(s) {
  const n = parseIPv4(s);
  if (n === null || n === 0 || n >>> 24 >= 224) return t("vTestHost");
  return null;
}

export function networkOf(ipInt, prefix) {
  return (ipInt & prefixToMaskInt(prefix)) >>> 0;
}

export function subnetLabel(ip, prefix) {
  const n = typeof ip === "number" ? ip : parseIPv4(ip);
  return `${intToIPv4(networkOf(n, prefix))}/${prefix}`;
}

export function sameSubnet(aInt, bInt, prefix) {
  return networkOf(aInt, prefix) === networkOf(bInt, prefix);
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isEmpty = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Validate a profile (or the custom form). Returns {field: message}; empty object = valid.
 * `prefix` may be an int or the raw input text ("24", "/24", "255.255.255.0").
 */
export function validateProfile(p) {
  const e = {};
  const name = str(p?.name);
  if (!name || name.length > 64) e.name = t("vName");
  const mode = p?.mode;
  if (mode !== "static" && mode !== "dhcp") e.mode = t("vMode");

  const dns = Array.isArray(p?.dns) ? p.dns.map(str).filter(Boolean) : [];

  if (mode === "dhcp") {
    if (!isEmpty(p.ip)) e.ip = t("vDhcpExtra");
    if (!isEmpty(p.prefix)) e.prefix = t("vDhcpExtra");
    if (!isEmpty(p.gateway)) e.gateway = t("vDhcpExtra");
    if (dns.length) e.dns = t("vDhcpExtra");
  } else if (mode === "static") {
    const ip = str(p.ip);
    const ipErr = ip ? ipProblem(ip) : t("vRequired");
    if (ipErr) e.ip = ipErr;

    let prefix = null;
    if (isEmpty(p.prefix)) e.prefix = t("vRequired");
    else {
      prefix = parsePrefix(typeof p.prefix === "number" ? p.prefix : String(p.prefix));
      if (prefix === null) {
        e.prefix = typeof p.prefix === "string" && p.prefix.includes(".") ? t("vMask") : t("vPrefix");
      } else if (prefix < 8) {
        e.prefix = t("vPrefix");
        prefix = null;
      }
    }

    const ipInt = ipErr ? null : parseIPv4(ip);
    if (ipInt !== null && prefix !== null && prefix <= 30) {
      const mask = prefixToMaskInt(prefix);
      const net = (ipInt & mask) >>> 0;
      const bcast = (net | ~mask) >>> 0;
      const subnet = `${intToIPv4(net)}/${prefix}`;
      if (ipInt === net) e.ip = t("vIpNetwork", { ip, subnet });
      else if (ipInt === bcast) e.ip = t("vIpBroadcast", { ip, subnet });
    }

    const gw = str(p.gateway);
    if (gw) {
      const gwErr = ipProblem(gw);
      if (gwErr) e.gateway = gwErr;
      else if (ipInt !== null && prefix !== null) {
        const gwInt = parseIPv4(gw);
        if (gwInt === ipInt) e.gateway = t("vGatewayEqual");
        else if (!sameSubnet(gwInt, ipInt, prefix)) e.gateway = t("vGatewaySubnet", { subnet: subnetLabel(ipInt, prefix) });
      }
    }

    if (dns.length > 2) e.dns = t("vDnsMax");
    else {
      for (let i = 0; i < dns.length; i++) {
        const err = ipProblem(dns[i]);
        if (err) { e.dns = t("vDnsItem", { n: i + 1, message: err }); break; }
      }
    }
  }

  const th = str(p?.testHost);
  if (th) {
    const err = testHostProblem(th);
    if (err) e.testHost = err;
  }

  const url = str(p?.openUrl);
  if (url) {
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
    } catch { ok = false; }
    if (!ok) e.openUrl = t("vOpenUrl");
    else if (url.length > 2048) e.openUrl = t("vTooLong", { n: 2048 });
  }
  if (str(p?.preferredAdapter).length > 64) e.preferredAdapter = t("vTooLong", { n: 64 });
  if (str(p?.note).length > 500) e.note = t("vTooLong", { n: 500 });
  return e;
}

/** Config → "DHCP" | "Static 10.100.35.1/24 · GW 10.100.35.254 · DNS 8.8.8.8". */
export function formatConfig(c) {
  if (!c) return "—";
  if (c.dhcp) {
    const dns = c.dns?.length ? ` · DNS ${c.dns.join(", ")}` : "";
    return t("modeDhcp") + dns;
  }
  const addrs = c.addrs?.length ? c.addrs.join(", ") : t("noAddress");
  let s = `${t("modeStatic")} ${addrs}`;
  if (c.gateway) s += ` · GW ${c.gateway}`;
  if (c.dns?.length) s += ` · DNS ${c.dns.join(", ")}`;
  return s;
}

/** The Config a profile would produce (for the "New:" line). */
export function profileToConfig(p) {
  if (p.mode === "dhcp") return { dhcp: true, addrs: [], gateway: "", dns: [] };
  const prefix = parsePrefix(typeof p.prefix === "number" ? p.prefix : String(p.prefix ?? ""));
  return {
    dhcp: false,
    addrs: [`${str(p.ip)}/${prefix}`],
    gateway: str(p.gateway),
    dns: (p.dns || []).map(str).filter(Boolean),
  };
}

/** Short summary for the profile list: "10.100.35.1/24" or "DHCP". */
export function profileSummary(p) {
  if (p.mode === "dhcp") return t("modeDhcp");
  return `${p.ip}/${p.prefix}`;
}

/**
 * Same rule as the host's `overlap` guardrail: another Up adapter (not `targetIndex`) has an
 * address inside the new subnet, or its own subnet contains the new IP.
 * Returns [{adapter, addr, subnet}] (empty = no overlap).
 */
export function findOverlaps(adapters, targetIndex, ip, prefix) {
  const ipInt = parseIPv4(ip);
  const p = parsePrefix(typeof prefix === "number" ? prefix : String(prefix ?? ""));
  if (ipInt === null || p === null) return [];
  const out = [];
  for (const a of adapters || []) {
    if (a.index === targetIndex || a.status !== "Up") continue;
    for (const cidr of a.ips || []) {
      const [addr, len] = String(cidr).split("/");
      const aInt = parseIPv4(addr);
      const aLen = len === undefined ? 32 : Number(len);
      if (aInt === null || !Number.isInteger(aLen) || aLen < 0 || aLen > 32) continue;
      if (sameSubnet(aInt, ipInt, p) || sameSubnet(ipInt, aInt, aLen)) {
        out.push({ adapter: a.name, addr: cidr, subnet: subnetLabel(ipInt, p) });
      }
    }
  }
  return out;
}

/** Build `apply` args (PROTOCOL.md) from a validated profile. */
export function applyArgs(profile, index, rollbackSec, ack = []) {
  const args = { index, mode: profile.mode, rollbackSec, source: "popup" };
  if (profile.mode === "static") {
    args.ip = str(profile.ip);
    args.prefix = parsePrefix(typeof profile.prefix === "number" ? profile.prefix : String(profile.prefix));
    const gw = str(profile.gateway);
    if (gw) args.gateway = gw;
    const dns = (profile.dns || []).map(str).filter(Boolean);
    if (dns.length) args.dns = dns;
  }
  const th = str(profile.testHost);
  if (th) args.testHost = th;
  if (profile.name) args.profile = profile.name;
  if (ack.length) args.ack = [...new Set(ack)];
  return args;
}
