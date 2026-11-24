// Every UI string lives here so a Thai table can be added in phase 3.
// `t("key", {name: "x"})` replaces `{name}` placeholders. Static HTML text is filled
// from the same table through `data-s="key"` attributes (see applyStrings).

export const EN = {
  appName: "IP Switcher",
  settings: "Settings",
  openWindow: "Open in its own window",
  loading: "Loading…",
  working: "Working… (the helper can take a few seconds)",

  // Host / helper state
  hostMissingTitle: "The IP Switcher helper is not installed",
  hostMissingBody: "Run install.cmd from the IP Switcher folder, then open IP Switcher again. The installer needs this extension ID:",
  hostForbiddenTitle: "The IP Switcher helper does not allow this extension",
  hostForbiddenBody: "Run install.cmd again from the IP Switcher folder. It must list this extension ID:",
  hostCrashedTitle: "The IP Switcher helper did not answer",
  protocolTitle: "Update the IP Switcher helper",
  protocolBody: "This extension speaks protocol {want}; the installed helper speaks {got}. Run the newer install.cmd. Apply is disabled.",
  noWriteTitle: "This Windows account can't change network settings",
  noWriteBody: "Apply is disabled. Ask IT to add this account to the Network Configuration Operators group.",

  // Errors raised by the browser
  err_host_missing: "The IP Switcher helper is not installed (run install.cmd).",
  err_host_forbidden: "The IP Switcher helper does not allow this extension ID (run install.cmd again).",
  err_host_crashed: "The IP Switcher helper stopped unexpectedly.",
  err_timeout: "The helper did not answer in time.",
  err_bad_reply: "The helper sent an unexpected reply.",

  // Pending
  pendingOn: "⚠ Pending on {adapter} · {sec} s",
  pendingReverting: "⚠ Time is up on {adapter}: the helper is undoing the change…",
  pendingNoTimer: "⚠ Pending on {adapter}",
  keep: "Keep",
  revert: "Revert",
  kept: "Kept ✓ The new settings stay.",
  reverted: "Reverted ✓ {adapter} is back to {config}.",

  // Adapters
  adapters: "Adapters",
  showVirtual: "Show virtual adapters",
  noAdapters: "No network adapters found.",
  wifi: "Wi-Fi",
  internetTitle: "Internet adapter (default route)",
  staticFrom: "from {profile}",
  modeDhcp: "DHCP",
  modeStatic: "Static",
  noAddress: "no address",

  // Profiles
  profiles: "Profiles",
  searchProfiles: "Search plant code, name or IP",
  profileCount: "{shown} of {total}",
  noMatch: "No profile matches “{q}”.",
  devices: "Devices",
  newProfile: "+ New",
  custom: "Custom…",
  dhcpProfileName: "Automatic (DHCP)",
  noProfiles: "No saved profiles yet.",

  // Confirm panel
  applyTitle: "Apply ‘{profile}’ to {adapter}",
  now: "Now",
  next: "New",
  test: "Test",
  testPing: "ping {host}",
  noTest: "none",
  cancel: "Cancel",
  apply: "Apply",
  applyAnyway: "Apply anyway",
  rollbackNote: "Undone automatically after {sec} s unless you press Keep.",
  rollbackNone: "Automatic undo is off (Settings): the change is kept at once.",
  warnInternet: "{adapter} is your internet adapter. Changing it may cut your internet connection.",
  ackInternet: "I understand, change it anyway",
  warnWifi: "A static IP applies to this adapter, not only to this network.",
  warnOverlap: "{adapter} already has {addr}, which overlaps {subnet}. Traffic may go out the wrong adapter.",
  busyOther: "A change is pending on {adapter}. Keep or Revert it first.",
  selectAdapter: "Select an adapter first.",
  profileInvalid: "This profile has errors. Fix it in Settings.",
  hostAsks: "The helper asks you to confirm:",
  invalidFromHost: "The helper rejected these values:",

  // Results
  applied: "Applied ✓",
  pingOk: "ping {host} ✓ {ms} ms",
  pingFail: "ping {host} ✗ no reply",
  pingFailPending: "The device did not answer. The change is still pending: press Revert if you can't reach it.",
  openDevice: "Open device page",
  failed: "Failed: {message}",

  // Custom form
  customTitle: "Custom address",
  fIp: "IP address",
  fPrefix: "Prefix or mask",
  fGateway: "Gateway",
  fDns1: "DNS 1",
  fDns2: "DNS 2",
  fTestHost: "Test host",
  fName: "Name",
  fMode: "Mode",
  fOpenUrl: "Device page URL",
  fPreferredAdapter: "Preferred adapter",
  fNote: "Note",
  optional: "optional",
  saveAsProfile: "Save as profile",
  saved: "Saved ✓",
  nameForSave: "Give the profile a name to save it.",
  customName: "Custom",

  // Ping
  ping: "Ping",
  go: "Go",
  pingOkShort: "✓ {ms} ms",
  pingFailShort: "✗ no reply",

  // Validation (mirrors PROTOCOL.md "Validation")
  vRequired: "Required",
  vName: "Name is required (at most 64 characters)",
  vMode: "Mode must be static or DHCP",
  vIpFormat: "Not a valid IPv4 address (four numbers 0–255, no leading zeros)",
  vIpZero: "0.0.0.0 can't be used",
  vIpLoopback: "127.x.x.x is the loopback range and can't be used",
  vIpLinkLocal: "169.254.x.x is the link-local range and can't be used",
  vIpMulticast: "224.0.0.0 and above (multicast / reserved) can't be used",
  vIpNetwork: "{ip} is the network address of {subnet}",
  vIpBroadcast: "{ip} is the broadcast address of {subnet}",
  vPrefix: "Enter a prefix 8–32 (24, /24) or a mask like 255.255.255.0",
  vMask: "Not a valid subnet mask (the 1 bits must be contiguous)",
  vGatewaySubnet: "Gateway must be inside {subnet}",
  vGatewayEqual: "Gateway can't be the same as the IP address",
  vDnsMax: "At most 2 DNS servers",
  vDnsItem: "DNS {n}: {message}",
  vTestHost: "Not a usable IPv4 address (no 0.0.0.0, nothing at 224.0.0.0 or above)",
  vDhcpExtra: "Leave empty for DHCP",
  vOpenUrl: "Must start with http:// or https://",
  vTooLong: "Too long (at most {n} characters)",

  // Options page
  optionsTitle: "IP Switcher settings",
  edit: "Edit",
  delete: "Delete",
  confirmDelete: "Delete?",
  moveUp: "Move up",
  moveDown: "Move down",
  save: "Save",
  builtIn: "built-in",
  newProfileTitle: "New profile",
  editProfileTitle: "Edit profile",
  modeStaticOpt: "Static",
  modeDhcpOpt: "DHCP (automatic)",
  importExport: "Import / export",
  importBtn: "Import JSON…",
  exportBtn: "Export JSON",
  importResult: "Imported {added} profile(s), skipped {skipped} invalid.",
  importBad: "Not an IP Switcher profiles file: {message}",
  importNote: "Imported profiles are added to your list. A profile with the same ID replaces the existing one.",
  rollbackTitle: "Automatic undo",
  rollbackLabel: "Seconds before an unconfirmed change is undone",
  rollbackNote0: "0–300 seconds. 0 means no automatic undo: every change is kept at once.",
  rollbackBad: "Enter a whole number from 0 to 300",
  helperTitle: "Helper status",
  extId: "Extension ID",
  hostVersion: "Helper version",
  protocol: "Protocol",
  winUser: "Windows user",
  canWrite: "Can change settings",
  yes: "Yes",
  no: "No",
  recheck: "Check again",
  auditTitle: "Audit log",
  auditEmpty: "No entries yet.",
  aTime: "Time",
  aAction: "Action",
  aAdapter: "Adapter",
  aChange: "From → to",
  aProfile: "Profile",
  aResult: "Result",
};

let table = EN;

export function t(key, vars) {
  let s = table[key] ?? EN[key] ?? key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return s;
}

// Fill `data-s="key"` (textContent), `data-s-title`, `data-s-placeholder` and `data-s-aria`.
export function applyStrings(root) {
  for (const n of root.querySelectorAll("[data-s]")) n.textContent = t(n.dataset.s);
  for (const n of root.querySelectorAll("[data-s-title]")) n.title = t(n.dataset.sTitle);
  for (const n of root.querySelectorAll("[data-s-placeholder]")) n.placeholder = t(n.dataset.sPlaceholder);
  for (const n of root.querySelectorAll("[data-s-aria]")) n.setAttribute("aria-label", t(n.dataset.sAria));
}
