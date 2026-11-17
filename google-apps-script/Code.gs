/**
 * EventHub Google Sheets receiver v5.
 *
 * Accepts Cloudflare EventHub outbox actions: "upsert" and "event_log".
 * One set of tabs is created per numeric event_id. Existing Sheet1 and legacy
 * tabs are never renamed, cleared, or deleted.
 *
 * Script Properties required:
 *   SCRIPT_SECRET   Shared secret matching the Cloudflare SHEETS_SYNC_SECRET.
 *   SPREADSHEET_ID  1zYn-20i1fzdGWOzimmusUrHJhTpHncCZY7o6elFkwao
 *
 * Optional:
 *   DEFAULT_TIMEZONE  Europe/Moscow
 */

const EH_VERSION = "5";
const EH_DEFAULT_TZ = "Europe/Moscow";

const EH_LIVE = [
  ["Guest ID","guest_id"],["Serial Number","serial_number"],["Guest Name","name"],
  ["Phone","phone"],["Residence","residence"],["Hostel Number","hostel_number"],
  ["Room Number","room_number"],["Food Preference","food"],["Registration Status","registration_status"],
  ["Pass Code","pass_code"],["QR Status","qr_status"],["Entry Status","entry_status"],
  ["Food Collection Status","food_status"],["Registered At","registered_at"],["Entry Time","entry_time"],
  ["Food Collection Time","food_collection_time"],["Timezone","timezone"],["Last Updated","last_updated"],
  ["Event ID","event_id"],["Proof Status","proof_status"],["Storage Box","storage_box"],
  ["Storage Section","storage_section"],["Storage Slot","storage_slot"],["Storage Number","storage_number"],
  ["Storage Label","storage_label"],["Proof Assigned Time","proof_assigned_time"],["Proof Stored Time","proof_stored_time"],
  ["Proof Return Time","proof_return_time"],["Proof No-Proof Time","proof_no_proof_time"],
  ["Proof Volunteer ID","proof_volunteer_id"],["Proof Return Volunteer ID","proof_return_volunteer_id"],
  ["Proof No-Proof Volunteer ID","proof_no_proof_volunteer_id"],["Exit Time","exit_time"],["Exit Volunteer ID","exit_volunteer_id"]
];

const EH_FOOD = [
  ["Serial Number","serial_number"],["Guest ID","guest_id"],["Guest Name","name"],
  ["Pass Code","pass_code"],["Food Preference","food"],["Food Status","food_status"],
  ["Collection Time","food_collection_time"],["Volunteer Name","food_volunteer_name"],
  ["Last Updated","last_updated"],["Volunteer ID","last_volunteer_id"]
];

const EH_STORAGE = [
  ["Serial Number","serial_number"],["Guest ID","guest_id"],["Guest Name","name"],
  ["Pass Code","pass_code"],["Proof Status","proof_status"],["Storage Number","storage_number"],
  ["Storage Location","storage_label"],["Storage Box","storage_box"],["Storage Section","storage_section"],
  ["Storage Slot","storage_slot"],["Assigned Time","proof_assigned_time"],["Stored Time","proof_stored_time"],
  ["Return Time","proof_return_time"],["No-Proof Time","proof_no_proof_time"],
  ["Storage Volunteer","proof_volunteer_name"],["Return Volunteer","proof_return_volunteer_name"],
  ["No-Proof Volunteer","proof_no_proof_volunteer_name"],["Last Updated","last_updated"],
  ["Volunteer ID","last_volunteer_id"]
];

const EH_EVENT_LOG_HEADERS = [
  "Action S. No.","Action ID","Guest S. No.","Guest ID","Guest Name","Pass Code",
  "Action","Action Time","Storage Number","Storage Location","Food Preference",
  "Volunteer Name","Volunteer ID","Details","Time Zone","Checkpoint ID","Checkpoint Name"
];

function doGet() {
  return ehJson_({ok:true,service:"EventHub Google Sheets Sync",version:Number(EH_VERSION)});
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
    const body = JSON.parse(raw || "{}");
    const props = PropertiesService.getScriptProperties();
    const expected = String(props.getProperty("SCRIPT_SECRET") || "");
    const supplied = String(body.secret || "");
    if (!expected || !ehSafeEqual_(expected,supplied)) return ehJson_({ok:false,error:"Unauthorized."});

    const action = String(body.action || "");
    const eventId = Number(body.event_id || 0);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return ehJson_({ok:false,error:"A positive event_id is required."});
    if (action !== "upsert" && action !== "event_log") return ehJson_({ok:false,error:"Unsupported action."});

    lock.waitLock(20000);
    try {
      const ss = ehSpreadsheet_();
      if (action === "upsert") {
        if (!body.guest_id) return ehJson_({ok:false,error:"guest_id is required for upsert."});
        ehUpsertEvent_(ss,eventId,body);
        return ehJson_({ok:true,action,event_id:eventId,version:Number(EH_VERSION)});
      }
      if (!body.action_id || !body.guest_id) return ehJson_({ok:false,error:"action_id and guest_id are required for event_log."});
      ehHandleEventLog_(ss,eventId,body);
      return ehJson_({ok:true,action,event_id:eventId,version:Number(EH_VERSION)});
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return ehJson_({ok:false,error:String(err && err.message ? err.message : err).slice(0,350)});
  }
}

function setupEventHubSheets() {
  const ss = ehSpreadsheet_();
  const tz = String(PropertiesService.getScriptProperties().getProperty("DEFAULT_TIMEZONE") || EH_DEFAULT_TZ);
  ss.setSpreadsheetTimeZone(tz);
  return "EventHub Sheets receiver v" + EH_VERSION + " ready.";
}

function ehSpreadsheet_() {
  const id = String(PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "");
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("Set SPREADSHEET_ID in Apps Script properties.");
  return active;
}

function ehSafeEqual_(a,b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ehJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function ehTabName_(kind,eventId) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,"eventhub:"+kind+":"+eventId);
  const suffix = Utilities.base64EncodeWebSafe(digest).replace(/=+$/,"").slice(0,6).toUpperCase();
  return kind + " - " + eventId + " - " + suffix;
}

function ehEnsureSheet_(ss,name,headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 || sh.getLastColumn() === 0) {
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length).setFontWeight("bold");
  } else {
    const existing = sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(String);
    const missing = headers.filter(h => existing.indexOf(h) < 0);
    if (missing.length) sh.getRange(1,sh.getLastColumn()+1,1,missing.length).setValues([missing]);
    sh.setFrozenRows(1);
  }
  const rows = Math.max(2,sh.getLastRow());
  const cols = Math.max(1,sh.getLastColumn());
  const range = sh.getRange(1,1,rows,cols);
  const filter = sh.getFilter();
  if (!filter) range.createFilter();
  else if (filter.getRange().getNumRows() < rows || filter.getRange().getNumColumns() !== cols) filter.setRange(range);
  return sh;
}

function ehDate_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.indexOf("T") >= 0) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return value;
}

function ehMillis_(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return 0;
  const n = new Date(value).getTime();
  return isNaN(n) ? 0 : n;
}

function ehUpsertRow_(ss,tabName,columns,payload) {
  const headers = columns.map(c => c[0]);
  const sh = ehEnsureSheet_(ss,tabName,headers);
  const allHeaders = sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(String);
  const keyCol = allHeaders.indexOf("Guest ID") + 1;
  const key = String(payload.guest_id || "");
  if (!keyCol || !key) throw new Error("Guest ID is missing from the sheet update.");
  let rowNumber = 0;
  if (sh.getLastRow() > 1) {
    const match = sh.getRange(2,keyCol,sh.getLastRow()-1,1).createTextFinder(key).matchEntireCell(true).findNext();
    if (match) rowNumber = match.getRow();
  }
  const mapping = {};
  columns.forEach(pair => mapping[pair[0]] = pair[1]);
  const row = rowNumber ? sh.getRange(rowNumber,1,1,allHeaders.length).getValues()[0] : new Array(allHeaders.length).fill("");
  if (rowNumber) {
    const updatedCol = allHeaders.indexOf("Last Updated") + 1;
    if (updatedCol) {
      const oldTime = ehMillis_(row[updatedCol-1]);
      const newTime = ehMillis_(payload.last_updated);
      if (oldTime && newTime && newTime < oldTime) return {updated:false,stale:true};
    }
  }
  allHeaders.forEach((header,i) => {
    const keyName = mapping[header];
    if (!keyName || !Object.prototype.hasOwnProperty.call(payload,keyName)) return;
    let value = payload[keyName];
    if (/_time|_at|last_updated|^entry_time$|^exit_time$/i.test(keyName)) value = ehDate_(value);
    row[i] = value === null || value === undefined ? "" : value;
  });
  if (rowNumber) sh.getRange(rowNumber,1,1,allHeaders.length).setValues([row]);
  else {
    rowNumber = sh.getLastRow()+1;
    sh.getRange(rowNumber,1,1,allHeaders.length).setValues([row]);
  }
  allHeaders.forEach((header,i) => {
    if (/time|timestamp/i.test(header) && header !== "Time Zone") sh.getRange(rowNumber,i+1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  });
  return {updated:true,stale:false};
}

function ehUpsertEvent_(ss,eventId,payload) {
  ehUpsertRow_(ss,ehTabName_("Guests",eventId),EH_LIVE,payload);
  ehUpsertRow_(ss,ehTabName_("Food",eventId),EH_FOOD,payload);
  ehUpsertRow_(ss,ehTabName_("Storage",eventId),EH_STORAGE,payload);
}

function ehHandleEventLog_(ss,eventId,p) {
  const snapshot = p.guest_snapshot && typeof p.guest_snapshot === "object" ? Object.assign({},p.guest_snapshot) : {};
  const action = String(p.action_type || "EVENT").toUpperCase();
  const volunteer = String(p.volunteer_name || "Unknown volunteer");
  const volunteerId = String(p.volunteer_id || "");
  const actionTime = p.action_time_utc || p.action_time_local || "";
  snapshot.guest_id = String(p.guest_id || snapshot.guest_id || "");
  snapshot.last_action_type = action;
  snapshot.last_action_time = actionTime;
  snapshot.last_volunteer_name = volunteer;
  snapshot.last_volunteer_id = volunteerId;
  if (actionTime) snapshot.last_updated = actionTime;
  if (action === "ENTRY") snapshot.entry_volunteer_name = volunteer;
  if (action === "FOOD") snapshot.food_volunteer_name = volunteer;
  if (action === "PROOF_STORAGE" || action === "PROOF_DEPOSIT") snapshot.proof_volunteer_name = volunteer;
  if (action === "PROOF_RETURN") snapshot.proof_return_volunteer_name = volunteer;
  if (action === "PROOF_NO_PROOF") snapshot.proof_no_proof_volunteer_name = volunteer;
  if (action === "EXIT") snapshot.exit_volunteer_name = volunteer;
  ehUpsertEvent_(ss,eventId,snapshot);

  const sh = ehEnsureSheet_(ss,ehTabName_("Event Log",eventId),EH_EVENT_LOG_HEADERS);
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(String);
  const actionCol = headers.indexOf("Action ID")+1;
  if (!actionCol) throw new Error("Event Log tab is missing the Action ID column.");
  const actionId = String(p.action_id || "");
  if (sh.getLastRow() > 1) {
    const match = sh.getRange(2,actionCol,sh.getLastRow()-1,1).createTextFinder(actionId).matchEntireCell(true).findNext();
    if (match) return; // idempotent retry: already appended
  }
  const props = PropertiesService.getScriptProperties();
  const serialKey = "EVENTHUB_ACTION_SERIAL_" + eventId;
  const serial = Number(props.getProperty(serialKey) || Math.max(0,sh.getLastRow()-1)) + 1;
  const values = {
    "Action S. No.":serial,"Action ID":actionId,"Guest S. No.":p.guest_serial_number || snapshot.serial_number || "",
    "Guest ID":p.guest_id || "","Guest Name":p.guest_name || snapshot.name || "",
    "Pass Code":p.pass_code || snapshot.pass_code || "","Action":action,
    "Action Time":ehDate_(actionTime),"Storage Number":p.storage_number || snapshot.storage_number || "",
    "Storage Location":p.storage_label || snapshot.storage_label || "","Food Preference":p.food_preference || snapshot.food || "",
    "Volunteer Name":volunteer,"Volunteer ID":volunteerId,"Details":p.details || "",
    "Time Zone":p.timezone || EH_DEFAULT_TZ,"Checkpoint ID":p.checkpoint_id || "",
    "Checkpoint Name":p.checkpoint_name || ""
  };
  const row = headers.map(h => Object.prototype.hasOwnProperty.call(values,h) ? values[h] : "");
  sh.appendRow(row);
  props.setProperty(serialKey,String(serial));
  const last = sh.getLastRow();
  const timeCol = headers.indexOf("Action Time")+1;
  if (timeCol) sh.getRange(last,timeCol).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}
