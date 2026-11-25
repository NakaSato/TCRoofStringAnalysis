/**
 * String Check monthly files — Solar Rooftop กปภ. (Google Apps Script, standalone)
 *
 * Everything is linked through the Overview workbook "00_Overview_รายงานการแก้ไข" (a Google Sheet in
 * the root Drive folder). Data moves in two directions, each value with one place where it is typed:
 *
 *   Overview ─► plant files     plant name, kWp, contract, start date, Inverter S/N, จำนวนสตริง
 *                               (typed in the Overview sheets "สถานี" and "Inverter")
 *   plant files ─► Overview     ผิดปกติ / สตริงที่มีปัญหา / Inverter Status / รายละเอียด, and for each
 *                               problem: การแก้ไข, สถานะ, ผู้รับผิดชอบ, วันที่แก้ไขเสร็จ
 *                               (typed in the yellow cells of the day sheets)
 *
 * Creating the month
 *   1) the month folder "yyyy-MM" inside the folder "String Check" of the root folder (CONFIG.MONTHS_FOLDER;
 *      both made if they are not there yet)
 *   2) one Google Sheet per plant, "<code>_<plant name>_<yyyy-MM>":
 *        สรุปเดือน            one row per day, read from the day sheets
 *        วันที่ 1 … 28-31     the daily String Check form, one sheet per day
 *        _ข้อมูลสถานี (hidden)  the plant's data from the Overview; every day sheet reads from it
 *
 * Sync (syncNow; automatically every CONFIG.SYNC_EVERY_MIN minutes during the day, and at each "ซิงก์"
 * event of the calendar) — for every plant file of the month:
 *   - _ข้อมูลสถานี is rewritten from the Overview when anything differs (name, kWp, S/N, จำนวนสตริง …)
 *   - Overview "รายงานการแก้ไข": one row per problem (an inverter that is ผิดปกติ > 0, Fault or Offline,
 *     from the first day it is seen until a later day shows it normal), with the newest รายละเอียด,
 *     การแก้ไข, สถานะ, ผู้รับผิดชอบ, วันที่แก้ไขเสร็จ and a link to the day sheet.
 *     The summary boxes above the table become formulas over the table.
 *     Do not type in that table: the day sheets are the source and a sync rewrites the row.
 *     Columns the script does not know (e.g. ผลการตรวจสอบ) are kept as typed.
 *   - Overview "Inverter": columns "Inverter Status" and "สถานะ ณ วันที่" (added if missing) = the newest
 *     status typed in the day sheets
 *   - Overview "สถานี": จำนวน Inverter, จำนวนสตริงรวม (formulas over "Inverter"), ไฟล์รายงาน (link) and
 *     รายงานล่าสุด (added if missing) = the newest day whose day sheet has a checked inverter row
 *   - Overview "รายงานการแก้ไข" box รายงานวันนี้ (added next to the other boxes if missing) = "xxx/233":
 *     plants whose รายงานล่าสุด is today, out of every plant in "สถานี" (a formula: it goes back to 0 at midnight)
 *   - Overview sheet "รายงานวันนี้" (made if missing): the plants that reported today and the ones that have
 *     not yet, as FILTER formulas over "สถานี" (they follow TODAY(); the script only writes them once)
 *
 * Where things are: the root folder is the folder the Overview sheet is in (rootId_), so the
 * folder "String Check" sits next to the Overview, with the month folders "yyyy-MM" inside "String Check".
 * A month folder still left directly in the root folder is used where it is (never made twice).
 * No Drive id is written in this file; a copy of the
 * Overview in another folder or account works on its own folder as soon as setup() is run there.
 * The live copy belongs to engineer@tcrenewable.com (upload with `clasp push --user engineer`); the
 * triggers run as the account that ran setup().
 * The script is bound to the Overview Google Sheet: everything below is in the sheet's menu "String Check".
 * The same functions can be run from the Apps Script editor:
 *   convertOverview()   once, when the Overview in Drive is still an .xlsx: makes the Google Sheet copy
 *                       that becomes the master (edit that one from then on, not the .xlsx)
 *   createTestPlant()   one plant only (CONFIG.TEST_CODE), to look at the layout first
 *   createThisMonth() / createNextMonth()   every plant
 *   syncNow()           sync the current month now
 *   setup()             run once: creates the Google Calendar CONFIG.CALENDAR_NAME with the default events;
 *                       from then on the automatic runs happen at the start time of that calendar's events
 *                       (move, add or delete events to change the schedule — see "schedule = Google Calendar")
 *   planTriggers()      re-reads the calendar now
 *   setSyncInterval(n)  how often the automatic sync looks for edits (minutes; 0 = off). It is on by
 *                       default: every CONFIG.SYNC_EVERY_MIN minutes, CONFIG.SYNC_FROM_HOUR–SYNC_TO_HOUR.
 *                       Apps Script cannot react to an edit in another file, so "realtime" means this poll:
 *                       a run that finds no edited file ends in about a second, without touching the Overview
 *   status() / cancelJob()
 *
 * Apps Script stops a run after 6 minutes, so a job works in batches: each run works for about
 * CONFIG.RUN_SECONDS, then schedules itself again one minute later until every plant is done.
 * Creating is safe to run again: a plant that already has its file is skipped, never rebuilt.
 * The plant's old Excel report "<name>.xlsx" in the month folder is moved to the trash (CONFIG.REPLACE_XLSX).
 * A plant whose number of active inverters changed needs a new file (the sync reports it in "_log").
 *
 * Needs two advanced services (both in appsscript.json; in the editor: Services): Drive API v3, Sheets API v4.
 */

const CONFIG = {
  // Nothing here names a Drive location: the Overview is the sheet this script is bound to, and the root
  // folder is the folder that sheet is in. Move or copy the sheet and everything follows it.
  ROOT_FOLDER_ID: '',             // blank = the folder the Overview is in; an id = month folders go there instead
  MONTHS_FOLDER: 'String Check',  // the month folders "yyyy-MM" are in this folder of the root folder (blank = in the root folder itself)
  OVERVIEW_ID: '',                // blank = the sheet this script is bound to; an id = that Google Sheet instead
  OVERVIEW_NAME: '00_Overview',   // only without a bound sheet: the Overview is the file in the root folder whose name starts with this
  CALENDAR_NAME: 'String Check',  // Google Calendar whose events are the schedule of the automatic runs
  CREATE_ON_DAY: 25,              // setup(): default event — next month's files on this day, 01:00
  SYNC_HOURS: [12, 18],           // setup(): default events — sync every day at these hours (Bangkok)
  SYNC_EVERY_MIN: 5,              // interval sync, on by default: look for edits this often (one of SYNC_INTERVALS; 0 = off)
                                  // until another value is chosen in the menu "ตั้งรอบซิงก์อัตโนมัติ"
  SYNC_FROM_HOUR: 6,              // the interval sync only runs from this hour ...
  SYNC_TO_HOUR: 20,               // ... until this hour (Bangkok), to stay inside Google's daily run time
  PREV_MONTH_SYNC_DAYS: 7,        // on days 1–7 of a month the automatic sync also reads last month's files when they
                                  // were edited (a report typed late, after the month ended); 0 = current month only
  RUN_SECONDS: 240,               // work per run (the Apps Script limit is 6 minutes)
  REPLACE_XLSX: true,             // a plant's old "<name>.xlsx" in the month folder goes to the trash once its Google Sheet exists
  TEST_CODE: 'P3-002',            // plant used by createTestPlant()
  FONT: 'Sarabun',
  FONT_SIZE: 11,
};

const TH_MONTH = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const PROJECT = 'โครงการจัดการพลังงานไฟฟ้าจากระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ที่ติดตั้งบนหลังคา (Solar Rooftop)';
const OWNER = 'การประปาส่วนภูมิภาค';
const STATUSES = ['รอดำเนินการ', 'กำลังแก้ไข', 'แก้ไขแล้ว', 'ปิดงาน'];   // same list as the Overview
const INV_STATUSES = ['Online', 'Waiting', 'Fault', 'Offline'];
const PROBLEM_STATUSES = ['Fault', 'Offline'];                       // an inverter in one of these is a problem
const DONE_STATUSES = ['แก้ไขแล้ว', 'ปิดงาน'];
const COLOR = { BLUE: '#B4C6E7', GREY: '#EDEDED', ORANGE: '#F7CAAC', RED: '#F8CBAD', YELLOW: '#FFEB9C',
  GREEN: '#C6EFCE', HEAD_GREEN: '#D9EAD3', INPUT: '#FFFF00', LINK: '#0563C1' };
const INFO = '_ข้อมูลสถานี';
const SUMMARY = 'สรุปเดือน';
const ISSUES = 'รายงานการแก้ไข';   // Overview sheets
const ISSUE_DATES = ['วันที่พบ', 'วันเข้าแก้ไข', 'วันที่แก้ไขเสร็จ'];   // shown as text dd/mm/พ.ศ. in the Overview
const LAST_REPORT = 'รายงานล่าสุด';   // Overview "สถานี": the newest day a plant's day sheet was filled (dd/mm/พ.ศ.)
const REPORTED_TODAY = 'รายงานวันนี้';  // Overview "รายงานการแก้ไข" box: plants with a report today / all plants
const REPORT_LOG = 'บันทึกรายงานรายวัน';   // Overview: one row per day, plants that reported that day / not yet
const STATIONS = 'สถานี';
const INVERTERS = 'Inverter';
const LOG = '_log';
const ARCHIVE_PREFIX = 'รายงานการแก้ไข_เก็บ_';   // + พ.ศ.: the file in the root folder that keeps a year's closed problems
const LOG_KEEP_ROWS = 1000;  // _log keeps this many newest lines (under its header); older ones are deleted
const EVENT_SYNC = 'String Check: ซิงก์ Overview';              // titles of the events setup() creates
const EVENT_CREATE = 'String Check: สร้างไฟล์เดือนถัดไป';
const MAX_PLANNED = 12;      // event triggers planned at a time (Apps Script allows 20 triggers per script)
const SUMMARY_SUBTITLE = `="กำลังการผลิต "&'${INFO}'!B2&"   ·   "&'${INFO}'!B5`;   // สรุปเดือน!A3
const TEMPLATE_VERSION = 3;  // in the info sheet (B7); sync brings a file of an older version up to date
const INFO_INV0 = 11;        // first inverter row in the info sheet
const DAY_INV0 = 17;         // first inverter row in a day sheet
const TEMP_OVERVIEW = '_overview_tmp';
const JOB_KEYS = ['job', 'ym', 'idx', 'folder', 'ov', 'ovTemp', 'only', 'made', 'skipped', 'errors', 'warn', 'fails',
  'full', 'sig', 'since', 'began', 'same', 'root', 'why'];
const SYNC_VERSION = '9';            // raised when sync starts repairing something new: every file is read once
const SYNC_INTERVALS = [1, 5, 10, 15, 30, 60, 120, 240, 360, 720];   // minutes; what a time trigger can do
const SYNC_MARGIN_MS = 15 * 60000;   // a file with no edit time on record (seen_<ym>) edited this long before the last sync started is read again
const SEEN_MAX_CHARS = 8500;         // seen_<ym> must fit one script property (9 kB); bigger = not kept, the margin rule applies
const DAYS_MAX_CHARS = 8500;         // days_<ym> (the days each plant reported) must fit one script property too
const WATCHDOG_MIN = 7;      // Google stops a run at 6 minutes; this trigger, set before the work, carries the job on
const NEXT_RUN_MS = 10000;   // pause between two runs of a job
const COPY_UNTIL_S = 300;    // create job: plants are copied until this second of a run (a copy takes about 5 s)
const TEMPLATE_BY_S = 120;   // ... but a template (up to about 130 s to build) is only started before this second
const MAX_FAILS = 3;         // failures in a row (plants, or whole runs) before the job stops and reports why
