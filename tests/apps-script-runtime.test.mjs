import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const source = await readFile(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8");

function makeReceiver() {
  class Range {
    constructor(sheet,row,col,numRows=1,numCols=1) { Object.assign(this,{sheet,row,col,numRows,numCols}); }
    setValues(values) {
      for(let r=0;r<this.numRows;r++) for(let c=0;c<this.numCols;c++) {
        this.sheet.ensureCell(this.row+r,this.col+c);
        this.sheet.rows[this.row+r-1][this.col+c-1]=values[r]?.[c] ?? "";
      }
      return this;
    }
    getValues() {
      return Array.from({length:this.numRows},(_,r)=>Array.from({length:this.numCols},(_,c)=>this.sheet.rows[this.row+r-1]?.[this.col+c-1] ?? ""));
    }
    getDisplayValues() { return this.getValues().map(row=>row.map(v=>v instanceof Date?v.toISOString():String(v??""))); }
    getValue() { return this.getValues()[0][0]; }
    getDisplayValue() { return String(this.getValue()??""); }
    setFontWeight() { return this; }
    setNumberFormat() { return this; }
    getNumRows() { return this.numRows; }
    getNumColumns() { return this.numCols; }
    getRow() { return this.row; }
    createFilter() { this.sheet.filter={range:this}; return this.sheet.filter; }
    createTextFinder(query) {
      const range=this;
      return {
        matchEntireCell() { return this; },
        findNext() {
          for(let r=0;r<range.numRows;r++) for(let c=0;c<range.numCols;c++) {
            const value=range.sheet.rows[range.row+r-1]?.[range.col+c-1];
            if(String(value??"")===String(query)) return new Range(range.sheet,range.row+r,range.col+c);
          }
          return null;
        }
      };
    }
  }
  class Sheet {
    constructor(name) { this.name=name;this.rows=[];this.filter=null; }
    ensureCell(row,col) {
      while(this.rows.length<row)this.rows.push([]);
      while(this.rows[row-1].length<col)this.rows[row-1].push("");
    }
    getLastRow() { for(let i=this.rows.length-1;i>=0;i--) if(this.rows[i].some(v=>v!==""&&v!==null&&v!==undefined))return i+1;return 0; }
    getLastColumn() { return this.rows.reduce((m,row)=>Math.max(m,row.length),0); }
    getRange(r,c,nr=1,nc=1) { return new Range(this,r,c,nr,nc); }
    getFilter() { return this.filter; }
    setFrozenRows() {}
    appendRow(row) { this.rows.push([...row]); }
  }
  class Spreadsheet {
    constructor() { this.sheets=new Map(); }
    getSheetByName(name) { return this.sheets.get(name)||null; }
    insertSheet(name) { const sh=new Sheet(name);this.sheets.set(name,sh);return sh; }
    setSpreadsheetTimeZone(tz) { this.timezone=tz; }
    getActiveSpreadsheet() { return this; }
  }
  const ss=new Spreadsheet();
  const props=new Map([["SCRIPT_SECRET","test-secret"],["SPREADSHEET_ID","test-sheet-id"]]);
  const scriptProps={getProperty:k=>props.get(k)||"",setProperty:(k,v)=>props.set(k,String(v))};
  const context={
    SpreadsheetApp:{openById:()=>ss,getActiveSpreadsheet:()=>ss},
    PropertiesService:{getScriptProperties:()=>scriptProps},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    Utilities:{
      DigestAlgorithm:{SHA_256:"sha256"},
      computeDigest(_algorithm,value){return createHash("sha256").update(value).digest();},
      base64EncodeWebSafe(value){return Buffer.from(value).toString("base64url");}
    },
    ContentService:{MimeType:{JSON:"application/json"},createTextOutput(content){return {content,setMimeType(){return this;},getContent(){return content;}}}}
  };
  const api=new Function("SpreadsheetApp","PropertiesService","LockService","Utilities","ContentService",source+"\nreturn {doPost,doGet};")(
    context.SpreadsheetApp,context.PropertiesService,context.LockService,context.Utilities,context.ContentService
  );
  const post=body=>api.doPost({postData:{contents:JSON.stringify(body)}}).getContent();
  return {ss,api,post};
}

function tab(ss,prefix,eventId) {
  return [...ss.sheets.values()].find(sh=>sh.name.startsWith(prefix+" - "+eventId+" - "));
}

test("Apps Script receiver handles authenticated upserts and event-log retries without cross-event mixing", () => {
  const {ss,post,api}=makeReceiver();
  const guestId="event:4:vk:9001";
  const snapshot={
    event_id:4,guest_id:guestId,serial_number:11,name:"=IMPORTXML(\"bad\")",
    phone:"+70000000000",residence:"Hostel",hostel_number:"5",room_number:"101",
    food:"Vegetarian",registration_status:"approved",pass_code:"EH-ABC123",
    qr_status:"Active",entry_status:"Recorded",food_status:"Not collected",
    registered_at:"2026-11-17T10:00:00.000Z",entry_time:"2026-11-17T10:10:00.000Z",
    timezone:"Europe/Moscow",last_updated:"2026-11-17T10:10:00.000Z"
  };
  const upsert=JSON.parse(post({secret:"test-secret",action:"upsert",event_id:4,...snapshot}));
  assert.equal(upsert.ok,true);
  const guests=tab(ss,"Guests",4);
  assert.ok(guests);
  assert.equal(guests.getRange(1,1,1,34).getDisplayValues()[0][0],"Guest ID");
  assert.equal(guests.getRange(2,1).getValue(),guestId);
  assert.equal(guests.getRange(2,3).getValue(),"'=IMPORTXML(\"bad\")");

  const eventLog={secret:"test-secret",action:"event_log",event_id:4,action_id:"action-1",
    guest_id:guestId,guest_serial_number:11,guest_name:"=IMPORTXML(\"bad\")",
    pass_code:"EH-ABC123",action_type:"ENTRY",action_time_utc:"2026-11-17T10:11:00.000Z",
    volunteer_name:"VK user 700",volunteer_id:"700",timezone:"Europe/Moscow",
    guest_snapshot:{...snapshot,last_updated:"2026-11-17T10:11:00.000Z"}};
  assert.equal(JSON.parse(post(eventLog)).ok,true);
  const logs=tab(ss,"Event Log",4);
  assert.equal(logs.getLastRow(),2);
  assert.equal(JSON.parse(post(eventLog)).ok,true);
  assert.equal(logs.getLastRow(),2,"retry must not append a duplicate event action");

  const older={...eventLog,action_id:"action-older",action_time_utc:"2026-11-16T10:00:00.000Z",
    guest_snapshot:{...snapshot,name:"Old Name",last_updated:"2026-11-16T10:00:00.000Z"}};
  assert.equal(JSON.parse(post(older)).ok,true);
  assert.equal(guests.getRange(2,3).getValue(),"'=IMPORTXML(\"bad\")","older snapshots must not overwrite current guest data");
  assert.equal(logs.getLastRow(),3,"new action still belongs in the append-only event log");

  assert.equal(JSON.parse(post({secret:"test-secret",action:"upsert",event_id:5,guest_id:"event:5:vk:9001",name:"Other event"})).ok,true);
  assert.ok(tab(ss,"Guests",5));
  assert.notEqual(tab(ss,"Guests",4).name,tab(ss,"Guests",5).name);
  assert.equal(JSON.parse(post({secret:"wrong",action:"upsert",event_id:4,guest_id:guestId})).ok,false);
  assert.equal(JSON.parse(api.doGet().getContent()).version,5);
});
