/**
 * Thai text, keyed by the English text used in the code (`t("Sign in")`). A key with no entry shows in
 * English. One file per area under `th/` so pages can be translated independently; a key may appear in
 * more than one file (the later file wins), so keep the same Thai for the same English.
 * Keep units, product names and codes (kW, kWp, PR, Growatt, O&M, SN, CSV) as they are.
 */
import { TH_CORE } from "./th/core";
import { TH_CENTER } from "./th/center";
import { TH_ALARMS } from "./th/alarms";
import { TH_OVERVIEW } from "./th/overview";
import { TH_PLANT } from "./th/plant";
import { TH_STRINGS } from "./th/strings";
import { TH_CALENDAR } from "./th/calendar";
import { TH_CLAIMS } from "./th/claims";
import { TH_ADMIN } from "./th/admin";
import { TH_LEASE } from "./th/lease";
import { TH_PVSYST } from "./th/pvsyst";
import { TH_KB } from "./th/kb";
import { TH_ROUTE } from "./th/route";
import { TH_SITE_REGISTER } from "./th/siteRegister";
import { TH_CURTAILMENT } from "./th/curtailment";
import { TH_DEVICES } from "./th/devices";
import { TH_DEVICES_TABS } from "./th/devicesTabs";
import { TH_SCAN } from "./th/scan";
import { TH_STOCK } from "./th/stock";
import { TH_STOCK_INSTALLED } from "./th/stockInstalled";
import { TH_STOCK_LINKS } from "./th/stockLinks";
import { TH_SHARED } from "./th/shared";

export const TH: Record<string, string> = { ...TH_CORE, ...TH_CENTER, ...TH_ALARMS, ...TH_OVERVIEW, ...TH_PLANT, ...TH_STRINGS, ...TH_CALENDAR, ...TH_CLAIMS, ...TH_ADMIN, ...TH_LEASE, ...TH_PVSYST, ...TH_KB, ...TH_ROUTE, ...TH_SITE_REGISTER, ...TH_CURTAILMENT, ...TH_DEVICES, ...TH_DEVICES_TABS, ...TH_SCAN, ...TH_STOCK, ...TH_STOCK_INSTALLED, ...TH_STOCK_LINKS, ...TH_SHARED };
