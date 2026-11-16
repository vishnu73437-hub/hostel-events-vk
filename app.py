import os, hmac, hashlib, base64, json, sqlite3, secrets, csv, io
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DB_PATH = os.getenv("DATABASE_PATH", str(ROOT / "eventhub.sqlite3"))
VK_APP_SECRET = os.getenv("VK_APP_SECRET", "")
VK_APP_ID = os.getenv("VK_APP_ID", "")
ADMIN_IDS = {x.strip() for x in os.getenv("VK_ADMIN_IDS", "").split(",") if x.strip()}
DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
DEV_USER_ID = os.getenv("DEV_VK_USER_ID", "1")
EVENT_NAME = os.getenv("EVENT_NAME", "DEEPOTSAV 2026 — A Journey Through India")
EVENT_DATE = os.getenv("EVENT_DATE", "Set event date in Render environment")
EVENT_VENUE = os.getenv("EVENT_VENUE", "Set event venue in Render environment")
FOOD_COLLECTION_ENABLED = os.getenv("FOOD_COLLECTION_ENABLED", "true").lower() == "true"

app = FastAPI(title="VK EventHub API", version="1.0.0")

def now():
    return datetime.now(timezone.utc).isoformat()

def db():
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con

def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, event_date TEXT NOT NULL,
          venue TEXT NOT NULL, food_enabled INTEGER NOT NULL DEFAULT 1,
          active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS guests (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id),
          vk_user_id TEXT NOT NULL, full_name TEXT NOT NULL, phone TEXT NOT NULL,
          residence TEXT NOT NULL, hostel TEXT NOT NULL, room TEXT NOT NULL,
          food_preference TEXT, status TEXT NOT NULL DEFAULT 'pending',
          pass_code TEXT UNIQUE, qr_token TEXT UNIQUE, registered_at TEXT NOT NULL,
          approved_at TEXT, revoked_at TEXT, UNIQUE(event_id, vk_user_id)
        );
        CREATE TABLE IF NOT EXISTS volunteers (
          vk_user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '',
          added_by TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scans (
          id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id INTEGER NOT NULL REFERENCES guests(id),
          stage TEXT NOT NULL, scanned_by TEXT NOT NULL, scanned_at TEXT NOT NULL,
          UNIQUE(guest_id, stage)
        );
        CREATE TABLE IF NOT EXISTS pass_design (
          event_id INTEGER PRIMARY KEY REFERENCES events(id), design_json TEXT NOT NULL,
          updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sheets_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, guest_id INTEGER NOT NULL,
          action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
          synced_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
          target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """)
        row = c.execute("SELECT id FROM events ORDER BY id LIMIT 1").fetchone()
        if not row:
            c.execute("INSERT INTO events(name,event_date,venue,food_enabled,created_at) VALUES(?,?,?,?,?)",
                      (EVENT_NAME, EVENT_DATE, EVENT_VENUE, int(FOOD_COLLECTION_ENABLED), now()))
init_db()

def verify_launch_params(raw: str):
    params = {}
    for pair in raw.lstrip("?").split("&"):
        if not pair: continue
        k, _, v = pair.partition("=")
        from urllib.parse import unquote_plus
        params[unquote_plus(k)] = unquote_plus(v)
    uid = params.get("vk_user_id")
    if not uid: raise HTTPException(401, "Open this app inside VK.")
    if DEV_MODE and not params.get("sign"):
        return uid
    sign = params.pop("sign", None)
    if not sign or not VK_APP_SECRET:
        raise HTTPException(401, "VK launch signature is missing or server is not configured.")
    if VK_APP_ID and params.get("vk_app_id") != VK_APP_ID:
        raise HTTPException(401, "Unexpected VK application ID.")
    # VK Mini Apps signs the sorted launch parameters using URL-safe base64 HMAC-SHA256.
    signed = "&".join(f"{k}={params[k]}" for k in sorted(params))
    digest = hmac.new(VK_APP_SECRET.encode(), signed.encode(), hashlib.sha256).digest()
    expected = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    if not hmac.compare_digest(expected, sign):
        raise HTTPException(401, "VK launch signature verification failed.")
    return uid

def current_user(x_vk_launch_params: Optional[str] = Header(default=None)):
    if DEV_MODE and not x_vk_launch_params:
        return DEV_USER_ID
    if not x_vk_launch_params: raise HTTPException(401, "Missing VK launch parameters.")
    return verify_launch_params(x_vk_launch_params)

def is_admin(uid):
    return uid in ADMIN_IDS or (DEV_MODE and uid == DEV_USER_ID)

def require_admin(uid=Depends(current_user)):
    if not is_admin(uid): raise HTTPException(403, "Administrator access required.")
    return uid

def require_staff(uid=Depends(current_user)):
    if is_admin(uid): return uid
    with db() as c:
        row = c.execute("SELECT active FROM volunteers WHERE vk_user_id=?", (uid,)).fetchone()
    if not row or not row["active"]: raise HTTPException(403, "Approved volunteer access required.")
    return uid

def audit(c, actor, action, kind, target, details=None):
    c.execute("INSERT INTO audit_log(actor,action,target_type,target_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
              (actor, action, kind, str(target), json.dumps(details or {}, ensure_ascii=False), now()))

def active_event(c):
    row = c.execute("SELECT * FROM events WHERE active=1 ORDER BY id LIMIT 1").fetchone()
    if not row: raise HTTPException(404, "No active event configured.")
    return row

class RegisterBody(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: str = Field(min_length=5, max_length=30)
    residence: str = Field(min_length=2, max_length=120)
    hostel: str = Field(min_length=1, max_length=80)
    room: str = Field(min_length=1, max_length=40)
    food_preference: Optional[str] = None

class VolunteerBody(BaseModel):
    vk_user_id: str = Field(min_length=1, max_length=40)
    display_name: str = Field(default="", max_length=120)

class DesignBody(BaseModel):
    design: dict

class ScanBody(BaseModel):
    qr_token: str
    stage: str

@app.get("/api/health")
def health():
    return {"ok": True, "service": "vk-eventhub"}

@app.get("/api/bootstrap")
def bootstrap(uid=Depends(current_user)):
    with db() as c:
        e = active_event(c)
        guest = c.execute("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?", (e["id"],uid)).fetchone()
        scans = {}
        if guest:
            scans = {r["stage"]: r["scanned_at"] for r in c.execute("SELECT stage,scanned_at FROM scans WHERE guest_id=?", (guest["id"],))}
        return {"user":{"vk_user_id":uid,"is_admin":is_admin(uid),"is_volunteer":is_admin(uid) or bool(c.execute("SELECT 1 FROM volunteers WHERE vk_user_id=? AND active=1",(uid,)).fetchone())},
                "event":dict(e),"food_collection_enabled":bool(e["food_enabled"]),
                "registration":dict(guest) if guest else None,"scans":scans}

@app.post("/api/register")
def register(body: RegisterBody, uid=Depends(current_user)):
    with db() as c:
        e=active_event(c)
        if not e["food_enabled"] and body.food_preference:
            raise HTTPException(400,"Food preference is not collected for this event.")
        if e["food_enabled"] and body.food_preference not in ("Vegetarian","Non-vegetarian"):
            raise HTTPException(400,"Choose a valid food preference.")
        existing=c.execute("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?",(e["id"],uid)).fetchone()
        if existing: return {"registration":dict(existing),"message":"You are already registered."}
        cur=c.execute("""INSERT INTO guests(event_id,vk_user_id,full_name,phone,residence,hostel,room,food_preference,status,registered_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?)""",
                      (e["id"],uid,body.full_name.strip(),body.phone.strip(),body.residence.strip(),body.hostel.strip(),body.room.strip(),body.food_preference if e["food_enabled"] else None,"pending",now()))
        gid=cur.lastrowid
        payload={"guest_id":gid,"vk_user_id":uid,"full_name":body.full_name,"phone":body.phone,"residence":body.residence,"hostel":body.hostel,"room":body.room,"food_preference":body.food_preference,"status":"pending"}
        c.execute("INSERT INTO sheets_outbox(event_id,guest_id,action,payload_json,created_at) VALUES(?,?,?,?,?)",(e["id"],gid,"registered",json.dumps(payload,ensure_ascii=False),now()))
        audit(c,uid,"registration_submitted","guest",gid)
        row=c.execute("SELECT * FROM guests WHERE id=?",(gid,)).fetchone()
        return {"registration":dict(row),"message":"Registration submitted for admin approval."}

@app.get("/api/my-pass")
def my_pass(uid=Depends(current_user)):
    with db() as c:
        e=active_event(c)
        row=c.execute("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?",(e["id"],uid)).fetchone()
        if not row: raise HTTPException(404,"No registration found.")
        if row["status"]!="approved" or row["revoked_at"]: raise HTTPException(403,"Your pass is not currently active.")
        design=c.execute("SELECT design_json FROM pass_design WHERE event_id=?",(e["id"],)).fetchone()
        scans={r["stage"]:r["scanned_at"] for r in c.execute("SELECT stage,scanned_at FROM scans WHERE guest_id=?",(row["id"],))}
        return {"guest":dict(row),"event":dict(e),"design":json.loads(design["design_json"]) if design else {},"scans":scans}

@app.get("/api/admin/guests")
def admin_guests(status: Optional[str]=None, uid=Depends(require_admin)):
    with db() as c:
        e=active_event(c)
        sql="SELECT * FROM guests WHERE event_id=?"
        args=[e["id"]]
        if status in ("pending","approved","rejected"): sql+=" AND status=?"; args.append(status)
        sql+=" ORDER BY registered_at DESC"
        return {"guests":[dict(r) for r in c.execute(sql,args).fetchall()]}

@app.post("/api/admin/guests/{guest_id}/{decision}")
def decide_guest(guest_id:int, decision:str, uid=Depends(require_admin)):
    if decision not in ("approve","reject","revoke"): raise HTTPException(400,"Invalid decision.")
    with db() as c:
        row=c.execute("SELECT * FROM guests WHERE id=?",(guest_id,)).fetchone()
        if not row: raise HTTPException(404,"Guest not found.")
        if decision=="approve":
            code=row["pass_code"] or ("DP26-"+secrets.token_hex(4).upper())
            token=row["qr_token"] or secrets.token_urlsafe(32)
            c.execute("UPDATE guests SET status='approved',pass_code=?,qr_token=?,approved_at=?,revoked_at=NULL WHERE id=?",(code,token,now(),guest_id))
        elif decision=="reject":
            c.execute("UPDATE guests SET status='rejected' WHERE id=?",(guest_id,))
        else:
            c.execute("UPDATE guests SET status='revoked',revoked_at=? WHERE id=?",(now(),guest_id))
        audit(c,uid,f"guest_{decision}","guest",guest_id)
        updated=c.execute("SELECT * FROM guests WHERE id=?",(guest_id,)).fetchone()
        payload=dict(updated)
        c.execute("INSERT INTO sheets_outbox(event_id,guest_id,action,payload_json,created_at) VALUES(?,?,?,?,?)",(row["event_id"],guest_id,decision,json.dumps(payload,ensure_ascii=False),now()))
        return {"guest":dict(updated)}

@app.post("/api/admin/volunteers")
def add_volunteer(body:VolunteerBody, uid=Depends(require_admin)):
    with db() as c:
        c.execute("""INSERT INTO volunteers(vk_user_id,display_name,added_by,active,added_at) VALUES(?,?,?,1,?)
                     ON CONFLICT(vk_user_id) DO UPDATE SET display_name=excluded.display_name,active=1""",
                  (body.vk_user_id,body.display_name,uid,now()))
        audit(c,uid,"volunteer_added","volunteer",body.vk_user_id)
    return {"ok":True}

@app.get("/api/admin/volunteers")
def list_volunteers(uid=Depends(require_admin)):
    with db() as c: return {"volunteers":[dict(r) for r in c.execute("SELECT * FROM volunteers ORDER BY added_at DESC")]}

@app.delete("/api/admin/volunteers/{vk_user_id}")
def remove_volunteer(vk_user_id:str, uid=Depends(require_admin)):
    with db() as c:
        c.execute("UPDATE volunteers SET active=0 WHERE vk_user_id=?",(vk_user_id,))
        audit(c,uid,"volunteer_removed","volunteer",vk_user_id)
    return {"ok":True}

@app.post("/api/scan")
def scan(body:ScanBody, uid=Depends(require_staff)):
    allowed={"entry","proof_storage","food","exit","proof_return"}
    stage=body.stage.lower()
    if stage not in allowed: raise HTTPException(400,"Unknown checkpoint.")
    with db() as c:
        guest=c.execute("SELECT * FROM guests WHERE qr_token=?",(body.qr_token,)).fetchone()
        if not guest: raise HTTPException(404,"Invalid QR pass.")
        if guest["status"]!="approved" or guest["revoked_at"]: raise HTTPException(403,"Pass is not active.")
        try:
            c.execute("INSERT INTO scans(guest_id,stage,scanned_by,scanned_at) VALUES(?,?,?,?)",(guest["id"],stage,uid,now()))
        except sqlite3.IntegrityError:
            raise HTTPException(409,f"{stage.replace('_',' ').title()} already recorded.")
        audit(c,uid,"checkpoint_scan","guest",guest["id"],{"stage":stage})
        c.execute("INSERT INTO sheets_outbox(event_id,guest_id,action,payload_json,created_at) VALUES(?,?,?,?,?)",
                  (guest["event_id"],guest["id"],"scan",json.dumps({"guest_id":guest["id"],"stage":stage,"scanned_by":uid},ensure_ascii=False),now()))
        return {"ok":True,"stage":stage,"guest":{"full_name":guest["full_name"],"hostel":guest["hostel"],"room":guest["room"],"food_preference":guest["food_preference"]}}

@app.get("/api/admin/stats")
def stats(uid=Depends(require_admin)):
    with db() as c:
        e=active_event(c)
        total=c.execute("SELECT COUNT(*) n FROM guests WHERE event_id=?",(e["id"],)).fetchone()["n"]
        approved=c.execute("SELECT COUNT(*) n FROM guests WHERE event_id=? AND status='approved'",(e["id"],)).fetchone()["n"]
        pending=c.execute("SELECT COUNT(*) n FROM guests WHERE event_id=? AND status='pending'",(e["id"],)).fetchone()["n"]
        by_stage={r["stage"]:r["n"] for r in c.execute("SELECT s.stage,COUNT(*) n FROM scans s JOIN guests g ON g.id=s.guest_id WHERE g.event_id=? GROUP BY s.stage",(e["id"],))}
        outbox=c.execute("SELECT COUNT(*) n FROM sheets_outbox WHERE event_id=? AND synced_at IS NULL",(e["id"],)).fetchone()["n"]
        return {"total":total,"approved":approved,"pending":pending,"checkpoints":by_stage,"sheets_pending":outbox}

@app.get("/api/admin/export.csv")
def export_csv(uid=Depends(require_admin)):
    with db() as c:
        e=active_event(c)
        rows=c.execute("SELECT id,full_name,phone,residence,hostel,room,food_preference,status,pass_code,registered_at FROM guests WHERE event_id=? ORDER BY registered_at",(e["id"],)).fetchall()
    output=io.StringIO(); w=csv.writer(output)
    w.writerow(["ID","Full name","Phone","Residence","Hostel","Room","Food preference","Status","Pass code","Registered at"])
    for r in rows: w.writerow(list(r))
    return StreamingResponse(iter([output.getvalue()]),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=event-guests.csv"})

@app.get("/api/admin/design")
def get_design(uid=Depends(require_admin)):
    with db() as c:
        e=active_event(c); row=c.execute("SELECT design_json FROM pass_design WHERE event_id=?",(e["id"],)).fetchone()
        return {"design":json.loads(row["design_json"]) if row else {"title":e["name"],"subtitle":"A Journey Through India","show_food":bool(e["food_enabled"]),"show_residence":True,"show_hostel":True,"show_room":True,"qr_size":240,"background":"#21113d","accent":"#f8d68a"}}

@app.put("/api/admin/design")
def save_design(body:DesignBody, uid=Depends(require_admin)):
    with db() as c:
        e=active_event(c)
        c.execute("""INSERT INTO pass_design(event_id,design_json,updated_by,updated_at) VALUES(?,?,?,?)
                     ON CONFLICT(event_id) DO UPDATE SET design_json=excluded.design_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at""",
                  (e["id"],json.dumps(body.design,ensure_ascii=False),uid,now()))
        audit(c,uid,"pass_design_updated","event",e["id"])
    return {"ok":True,"message":"Pass design saved. Existing QR tokens and checkpoint history were preserved."}

@app.get("/")
def index(): return FileResponse(ROOT/"index.html")

