// Every UI string lives here, in English (EN) and Thai (TH; spec §14, field crews use TH).
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
  rollbackNone: "Kept at once (no automatic undo).",
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
  winUser: "Computer user",
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

  // Confirm panel (new layout)
  newIp: "New IP",
  nowOn: "{adapter} now: {config}",
  factPing: "test ping {host}",
  factUndo: "auto undo in {sec} s unless you press Keep",
  factKept: "kept at once",
  autoAddr: "address from the network",
  noGateway: "no gateway",

  // Ping console
  pingConsole: "Ping console",
  pingStart: "Start",
  pingStop: "Stop",
  pingReply: "reply from {host}: {ms} ms",
  pingTimeout: "no reply from {host}",
  pingStats: "sent {sent} · received {recv} · lost {loss}%",
  pingRtt: "{min} / {avg} / {max} ms",
  pingGateway: "Gateway",

  // Current IP card
  currentIp: "This computer's IP",
  cMask: "Mask",
  cGateway: "Gateway",
  cDns: "DNS",
  cMac: "MAC",
  cNoIp: "No IP address yet",
  copy: "Copy",
  copied: "Copied ✓",

  // Quick actions
  recent: "Recent",
  allProfiles: "All profiles",
  backToAuto: "Back to automatic (DHCP)",

  // Options page (tabs)
  tabGeneral: "General",
  tabHelper: "Helper & log",
  profilesCount: "{n} profiles",
  showMore: "Show {n} more",
  secNetwork: "Network",
  secDns: "DNS",
  secTest: "Test and device page",
  secOther: "Other",
  dropHere: "Drop a profiles JSON file here",
  orChoose: "or choose a file…",
  exportTitle: "Back up / copy to another laptop",
  exportNote: "Download every profile as one JSON file.",
  undoOff: "Off",
  secUnit: "{n} s",
  customSec: "Other",
  helperOk: "The helper is working",
  langHelp: "Auto follows the browser's language.",
  langAutoShort: "Auto",
  importTitle: "Import profiles",
  rowEdit: "Edit",

  // Language
  language: "Language",
  langAuto: "Automatic (browser language)",
  langToggle: "ภาษาไทย",
  langToggleTitle: "เปลี่ยนเป็นภาษาไทย",

  // Adapter status (Windows Get-NetAdapter Status)
  st_Up: "Up",
  st_Disconnected: "Disconnected",
  st_Disabled: "Disabled",
  st_NotPresent: "Not present",

  // Audit actions and results
  act_apply: "apply",
  act_keep: "keep",
  act_revert: "revert",
  act_rollback: "auto undo",
  act_rollback_failed: "auto undo failed",
  res_ok: "ok",
  res_error: "error",

  // Toolbar badge tooltip
  badgePending: "Change pending on {adapter}",
  badgeStaticLong: "{adapter} has been static for more than 4 h. Switch back to DHCP?",
  badgeStatic: "{adapter} is static ({profile})",
};

export const TH = {
  appName: "IP Switcher",
  settings: "ตั้งค่า",
  openWindow: "เปิดเป็นหน้าต่างแยก",
  loading: "กำลังโหลด…",
  working: "กำลังทำงาน… (ตัวช่วยอาจใช้เวลาสักครู่)",

  hostMissingTitle: "ยังไม่ได้ติดตั้งตัวช่วย IP Switcher",
  hostMissingBody: "เปิด install.cmd ในโฟลเดอร์ IP Switcher แล้วเปิด IP Switcher ใหม่ ตัวติดตั้งต้องใช้รหัสส่วนขยายนี้:",
  hostForbiddenTitle: "ตัวช่วย IP Switcher ไม่อนุญาตส่วนขยายนี้",
  hostForbiddenBody: "เปิด install.cmd ในโฟลเดอร์ IP Switcher อีกครั้ง โดยต้องมีรหัสส่วนขยายนี้:",
  hostCrashedTitle: "ตัวช่วย IP Switcher ไม่ตอบสนอง",
  protocolTitle: "กรุณาอัปเดตตัวช่วย IP Switcher",
  protocolBody: "ส่วนขยายนี้ใช้โปรโตคอล {want} แต่ตัวช่วยที่ติดตั้งใช้ {got} ให้เปิด install.cmd เวอร์ชันใหม่ ปุ่ม “ใช้” ถูกปิดไว้",
  noWriteTitle: "บัญชี Windows นี้เปลี่ยนการตั้งค่าเครือข่ายไม่ได้",
  noWriteBody: "ปุ่ม “ใช้” ถูกปิดไว้ ให้ฝ่าย IT เพิ่มบัญชีนี้เข้ากลุ่ม Network Configuration Operators",

  err_host_missing: "ยังไม่ได้ติดตั้งตัวช่วย IP Switcher (เปิด install.cmd)",
  err_host_forbidden: "ตัวช่วย IP Switcher ไม่อนุญาตรหัสส่วนขยายนี้ (เปิด install.cmd อีกครั้ง)",
  err_host_crashed: "ตัวช่วย IP Switcher หยุดทำงานโดยไม่คาดคิด",
  err_timeout: "ตัวช่วยไม่ตอบภายในเวลาที่กำหนด",
  err_bad_reply: "ตัวช่วยตอบกลับในรูปแบบที่ไม่ถูกต้อง",

  pendingOn: "⚠ รอยืนยันที่ {adapter} · {sec} วินาที",
  pendingReverting: "⚠ หมดเวลาที่ {adapter}: ตัวช่วยกำลังเปลี่ยนกลับ…",
  pendingNoTimer: "⚠ รอยืนยันที่ {adapter}",
  keep: "ใช้ต่อ",
  revert: "เปลี่ยนกลับ",
  kept: "ใช้ต่อแล้ว ✓ การตั้งค่าใหม่ยังคงอยู่",
  reverted: "เปลี่ยนกลับแล้ว ✓ {adapter} กลับเป็น {config}",

  adapters: "การ์ดเครือข่าย",
  showVirtual: "แสดงการ์ดเสมือน",
  noAdapters: "ไม่พบการ์ดเครือข่าย",
  wifi: "Wi-Fi",
  internetTitle: "การ์ดที่ใช้ต่ออินเทอร์เน็ต (เส้นทางหลัก)",
  staticFrom: "จาก {profile}",
  modeDhcp: "DHCP",
  modeStatic: "Static",
  noAddress: "ไม่มี IP",

  profiles: "โปรไฟล์",
  searchProfiles: "ค้นหารหัสสถานี ชื่อ หรือ IP",
  profileCount: "{shown} จาก {total}",
  noMatch: "ไม่พบโปรไฟล์ที่ตรงกับ “{q}”",
  devices: "อุปกรณ์",
  newProfile: "+ เพิ่ม",
  custom: "กำหนดเอง…",
  dhcpProfileName: "อัตโนมัติ (DHCP)",
  noProfiles: "ยังไม่มีโปรไฟล์ที่บันทึกไว้",

  applyTitle: "ใช้ ‘{profile}’ กับ {adapter}",
  now: "ตอนนี้",
  next: "ใหม่",
  test: "ทดสอบ",
  testPing: "ping {host}",
  noTest: "ไม่มี",
  cancel: "ยกเลิก",
  apply: "ใช้",
  applyAnyway: "ใช้ต่อไป",
  rollbackNote: "จะเปลี่ยนกลับเองใน {sec} วินาที ถ้าไม่กด “ใช้ต่อ”",
  rollbackNone: "มีผลทันที (ไม่เปลี่ยนกลับอัตโนมัติ)",
  warnInternet: "{adapter} คือการ์ดที่ใช้ต่ออินเทอร์เน็ต ถ้าเปลี่ยน อินเทอร์เน็ตอาจหลุด",
  ackInternet: "เข้าใจแล้ว ต้องการเปลี่ยน",
  warnWifi: "IP แบบ Static จะใช้กับการ์ดนี้ทั้งหมด ไม่ใช่เฉพาะเครือข่ายนี้",
  warnOverlap: "{adapter} มี {addr} อยู่แล้ว ซึ่งซ้อนกับ {subnet} ข้อมูลอาจออกผิดการ์ด",
  busyOther: "มีการเปลี่ยนที่รอยืนยันอยู่ที่ {adapter} กด “ใช้ต่อ” หรือ “เปลี่ยนกลับ” ก่อน",
  selectAdapter: "เลือกการ์ดเครือข่ายก่อน",
  profileInvalid: "โปรไฟล์นี้มีข้อผิดพลาด ให้แก้ในตั้งค่า",
  hostAsks: "ตัวช่วยขอให้ยืนยัน:",
  invalidFromHost: "ตัวช่วยไม่รับค่าเหล่านี้:",

  applied: "เปลี่ยนแล้ว ✓",
  pingOk: "ping {host} ✓ {ms} ms",
  pingFail: "ping {host} ✗ ไม่ตอบ",
  pingFailPending: "อุปกรณ์ไม่ตอบ การเปลี่ยนยังรอยืนยันอยู่ ถ้าเชื่อมต่อไม่ได้ให้กด “เปลี่ยนกลับ”",
  openDevice: "เปิดหน้าเว็บอุปกรณ์",
  failed: "ไม่สำเร็จ: {message}",

  customTitle: "กำหนด IP เอง",
  fIp: "IP address",
  fPrefix: "Prefix หรือ Subnet mask",
  fGateway: "Gateway",
  fDns1: "DNS 1",
  fDns2: "DNS 2",
  fTestHost: "IP สำหรับทดสอบ",
  fName: "ชื่อ",
  fMode: "รูปแบบ",
  fOpenUrl: "URL หน้าเว็บอุปกรณ์",
  fPreferredAdapter: "การ์ดที่ต้องการ",
  fNote: "หมายเหตุ",
  optional: "ไม่บังคับ",
  saveAsProfile: "บันทึกเป็นโปรไฟล์",
  saved: "บันทึกแล้ว ✓",
  nameForSave: "ตั้งชื่อโปรไฟล์ก่อนบันทึก",
  customName: "กำหนดเอง",

  ping: "Ping",
  go: "ทดสอบ",
  pingOkShort: "✓ {ms} ms",
  pingFailShort: "✗ ไม่ตอบ",

  vRequired: "ต้องกรอก",
  vName: "ต้องมีชื่อ (ไม่เกิน 64 ตัวอักษร)",
  vMode: "รูปแบบต้องเป็น Static หรือ DHCP",
  vIpFormat: "IPv4 ไม่ถูกต้อง (ตัวเลข 0–255 สี่ชุด ไม่ขึ้นต้นด้วย 0)",
  vIpZero: "ใช้ 0.0.0.0 ไม่ได้",
  vIpLoopback: "127.x.x.x เป็นช่วง loopback ใช้ไม่ได้",
  vIpLinkLocal: "169.254.x.x เป็นช่วง link-local ใช้ไม่ได้",
  vIpMulticast: "224.0.0.0 ขึ้นไป (multicast / สงวนไว้) ใช้ไม่ได้",
  vIpNetwork: "{ip} เป็น network address ของ {subnet}",
  vIpBroadcast: "{ip} เป็น broadcast address ของ {subnet}",
  vPrefix: "ใส่ prefix 8–32 (24, /24) หรือ mask เช่น 255.255.255.0",
  vMask: "Subnet mask ไม่ถูกต้อง (บิต 1 ต้องเรียงติดกัน)",
  vGatewaySubnet: "Gateway ต้องอยู่ใน {subnet}",
  vGatewayEqual: "Gateway ต้องไม่ซ้ำกับ IP address",
  vDnsMax: "DNS ได้ไม่เกิน 2 ตัว",
  vDnsItem: "DNS {n}: {message}",
  vTestHost: "IPv4 ใช้ไม่ได้ (ห้าม 0.0.0.0 และ 224.0.0.0 ขึ้นไป)",
  vDhcpExtra: "เว้นว่างไว้สำหรับ DHCP",
  vOpenUrl: "ต้องขึ้นต้นด้วย http:// หรือ https://",
  vTooLong: "ยาวเกินไป (ไม่เกิน {n} ตัวอักษร)",

  optionsTitle: "ตั้งค่า IP Switcher",
  edit: "แก้ไข",
  delete: "ลบ",
  confirmDelete: "ลบ?",
  moveUp: "เลื่อนขึ้น",
  moveDown: "เลื่อนลง",
  save: "บันทึก",
  builtIn: "มีในระบบ",
  newProfileTitle: "โปรไฟล์ใหม่",
  editProfileTitle: "แก้ไขโปรไฟล์",
  modeStaticOpt: "Static",
  modeDhcpOpt: "DHCP (อัตโนมัติ)",
  importExport: "นำเข้า / ส่งออก",
  importBtn: "นำเข้า JSON…",
  exportBtn: "ส่งออก JSON",
  importResult: "นำเข้า {added} โปรไฟล์ ข้ามที่ไม่ถูกต้อง {skipped}",
  importBad: "ไม่ใช่ไฟล์โปรไฟล์ของ IP Switcher: {message}",
  importNote: "โปรไฟล์ที่นำเข้าจะถูกเพิ่มในรายการ ถ้ามีรหัส (ID) เดียวกัน จะแทนที่โปรไฟล์เดิม",
  rollbackTitle: "เปลี่ยนกลับอัตโนมัติ",
  rollbackLabel: "จำนวนวินาทีก่อนเปลี่ยนกลับ ถ้าไม่ได้ยืนยัน",
  rollbackNote0: "0–300 วินาที ถ้าใส่ 0 จะไม่เปลี่ยนกลับอัตโนมัติ: ทุกการเปลี่ยนมีผลทันที",
  rollbackBad: "ใส่จำนวนเต็ม 0 ถึง 300",
  helperTitle: "สถานะตัวช่วย",
  extId: "รหัสส่วนขยาย",
  hostVersion: "เวอร์ชันตัวช่วย",
  protocol: "โปรโตคอล",
  winUser: "ผู้ใช้เครื่อง",
  canWrite: "เปลี่ยนการตั้งค่าได้",
  yes: "ได้",
  no: "ไม่ได้",
  recheck: "ตรวจอีกครั้ง",
  auditTitle: "ประวัติการเปลี่ยน",
  auditEmpty: "ยังไม่มีรายการ",
  aTime: "เวลา",
  aAction: "การทำงาน",
  aAdapter: "การ์ด",
  aChange: "จาก → เป็น",
  aProfile: "โปรไฟล์",
  aResult: "ผล",

  newIp: "IP ใหม่",
  nowOn: "{adapter} ตอนนี้: {config}",
  factPing: "ทดสอบ ping {host}",
  factUndo: "เปลี่ยนกลับเองใน {sec} วิ ถ้าไม่กด “ใช้ต่อ”",
  factKept: "มีผลทันที",
  autoAddr: "รับ IP จากเครือข่ายอัตโนมัติ",
  noGateway: "ไม่มี Gateway",
  pingConsole: "ทดสอบ Ping",
  pingStart: "เริ่ม",
  pingStop: "หยุด",
  pingReply: "ตอบกลับจาก {host}: {ms} ms",
  pingTimeout: "ไม่มีการตอบกลับจาก {host}",
  pingStats: "ส่ง {sent} · ได้รับ {recv} · หาย {loss}%",
  pingRtt: "{min} / {avg} / {max} ms",
  pingGateway: "Gateway",
  currentIp: "IP ของเครื่องนี้",
  cMask: "Mask",
  cGateway: "Gateway",
  cDns: "DNS",
  cMac: "MAC",
  cNoIp: "ยังไม่มี IP",
  copy: "คัดลอก",
  copied: "คัดลอกแล้ว ✓",
  recent: "ใช้ล่าสุด",
  allProfiles: "ทั้งหมด",
  backToAuto: "กลับเป็นอัตโนมัติ (DHCP)",

  tabGeneral: "ทั่วไป",
  tabHelper: "ตัวช่วยและประวัติ",
  profilesCount: "{n} โปรไฟล์",
  showMore: "แสดงอีก {n} รายการ",
  secNetwork: "เครือข่าย",
  secDns: "DNS",
  secTest: "ทดสอบและหน้าเว็บอุปกรณ์",
  secOther: "อื่น ๆ",
  dropHere: "ลากไฟล์ JSON ของโปรไฟล์มาวางที่นี่",
  orChoose: "หรือเลือกไฟล์…",
  exportTitle: "สำรอง / คัดลอกไปเครื่องอื่น",
  exportNote: "ดาวน์โหลดโปรไฟล์ทั้งหมดเป็นไฟล์ JSON ไฟล์เดียว",
  undoOff: "ปิด",
  secUnit: "{n} วิ",
  customSec: "อื่น ๆ",
  helperOk: "ตัวช่วยทำงานปกติ",
  langHelp: "อัตโนมัติ = ตามภาษาของเบราว์เซอร์",
  langAutoShort: "อัตโนมัติ",
  importTitle: "นำเข้าโปรไฟล์",
  rowEdit: "แก้ไข",

  language: "ภาษา",
  langAuto: "อัตโนมัติ (ตามภาษาของเบราว์เซอร์)",
  langToggle: "English",
  langToggleTitle: "Switch to English",

  st_Up: "เชื่อมต่อ",
  st_Disconnected: "ไม่ได้เสียบสาย",
  st_Disabled: "ปิดใช้งาน",
  st_NotPresent: "ไม่พบอุปกรณ์",

  act_apply: "เปลี่ยน",
  act_keep: "ใช้ต่อ",
  act_revert: "เปลี่ยนกลับ",
  act_rollback: "เปลี่ยนกลับอัตโนมัติ",
  act_rollback_failed: "เปลี่ยนกลับอัตโนมัติไม่สำเร็จ",
  res_ok: "สำเร็จ",
  res_error: "ผิดพลาด",

  badgePending: "รอยืนยันการเปลี่ยนที่ {adapter}",
  badgeStaticLong: "{adapter} ใช้ IP แบบ Static มานานกว่า 4 ชม. เปลี่ยนกลับเป็น DHCP ไหม?",
  badgeStatic: "{adapter} ใช้ IP แบบ Static ({profile})",
};

const TABLES = { en: EN, th: TH };

let table = EN;
let lang = "en";

/** Setting "" = follow the browser's UI language (Thai → th, else en). */
export function resolveLang(setting) {
  if (setting === "en" || setting === "th") return setting;
  let ui = "";
  try { ui = globalThis.chrome?.i18n?.getUILanguage?.() || ""; } catch { /* not in a browser */ }
  if (!ui) ui = globalThis.navigator?.language || "";
  return ui.toLowerCase().startsWith("th") ? "th" : "en";
}

export function setLang(setting) {
  lang = resolveLang(setting);
  table = TABLES[lang];
  if (globalThis.document?.documentElement) document.documentElement.lang = lang;
  return lang;
}

export const currentLang = () => lang;

/** A translated label for a Windows / audit value, or the value itself when there's none. */
export function tValue(prefix, value) {
  const key = `${prefix}_${value}`;
  return key in EN ? t(key) : String(value ?? "");
}

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
