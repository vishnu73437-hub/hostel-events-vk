const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const STAGES = new Set(["entry", "proof_storage", "food", "exit", "proof_return"]);
const now = () => new Date().toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (message, status = 400) => json({ detail: message }, status);
const asBool = value => value === true || value === 1 || value === "1" || value === "true";
const safeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
};

export async function verifyLaunchParams(raw, env) {
  if (!raw) throw new Error("Open this app inside VK.");
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  const uid = params.get("vk_user_id");
  const appId = params.get("vk_app_id");
  const sign = params.get("sign");
  if (!uid || !appId || !sign) throw new Error("VK launch parameters are incomplete.");
  if (env.VK_APP_ID && appId !== String(env.VK_APP_ID)) throw new Error("Unexpected VK application ID.");
  if (!env.VK_APP_SECRET) throw new Error("Server authentication is not configured.");
  const signedParams = [...params.entries()]
    .filter(([key]) => key.startsWith("vk_"))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => [key, value]);
  const signedQuery = new URLSearchParams(signedParams).toString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.VK_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedQuery)));
  const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (!safeEqual(expected, sign)) throw new Error("VK launch signature verification failed.");
  const ts = Number(params.get("vk_ts"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 3600) throw new Error("VK launch parameters expired. Reopen the app.");
  return uid;
}
async function authenticate(request, env) {
  return verifyLaunchParams(request.headers.get("X-VK-Launch-Params"), env);
}

function isAdmin(uid, env) {
  const ids = String(env.VK_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return ids.includes(uid);
}
async function hasAdmin(uid, env) {
  if (isAdmin(uid, env)) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM app_admins WHERE vk_user_id=?").bind(uid).first();
  return !!row;
}
async function requireUser(request, env) {
  try { return await authenticate(request, env); }
  catch (e) { throw Object.assign(new Error(e.message), { status: 401 }); }
}
async function requireAdmin(request, env) {
  const uid = await requireUser(request, env);
  if (!(await hasAdmin(uid, env))) throw Object.assign(new Error("Administrator access required."), { status: 403 });
  return uid;
}
async function requireStaff(request, env) {
  const uid = await requireUser(request, env);
  if (await hasAdmin(uid, env)) return uid;
  const row = await env.DB.prepare("SELECT active FROM volunteers WHERE vk_user_id=?").bind(uid).first();
  if (!row || !row.active) throw Object.assign(new Error("Approved volunteer access required."), { status: 403 });
  return uid;
}
async function activeEvent(env) {
  await env.DB.prepare("INSERT INTO events(name,event_date,venue,food_enabled,status,active,registration_open,created_at) SELECT ?,?,?,?,'active',1,1,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE active=1)")
    .bind(env.EVENT_NAME || "EventHub", env.EVENT_DATE || "Set event date", env.EVENT_VENUE || "Set event venue", asBool(env.FOOD_COLLECTION_ENABLED) ? 1 : 0, now()).run();
  const event = await env.DB.prepare("SELECT * FROM events WHERE active=1 ORDER BY id DESC LIMIT 1").first();
  if (!event) throw Object.assign(new Error("No active event configured."), { status: 404 });
  return event;
}
async function audit(env, actor, action, type, target, details = {}, eventId = null) {
  await env.DB.prepare("INSERT INTO audit_log(event_id,actor,actor_vk_user_id,action,target_type,target_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(eventId, actor, actor, action, type, String(target), JSON.stringify(details), now()).run();
}
async function outbox(env, eventId, guestId, action, payload) {
  await env.DB.prepare("INSERT INTO sheets_outbox(event_id,guest_id,action,event_key,payload_json,created_at) VALUES(?,?,?,?,?,?)")
    .bind(eventId, guestId, action, crypto.randomUUID(), JSON.stringify(payload), now()).run();
}
async function body(request) {
  try { return await request.json(); } catch { throw Object.assign(new Error("Invalid JSON body."), { status: 400 }); }
}
const asGuest = row => row ? { ...row } : null;


async function eventRole(uid, eventId, env) {
  if (await hasAdmin(uid, env)) return "admin";
  const global = await env.DB.prepare("SELECT 1 AS ok FROM global_volunteers WHERE vk_user_id=?").bind(uid).first();
  const legacyGlobal = await env.DB.prepare("SELECT 1 AS ok FROM volunteers WHERE vk_user_id=?").bind(uid).first();
  if (global || legacyGlobal) return "global";
  const assigned = await env.DB.prepare("SELECT role FROM event_volunteers WHERE event_id=? AND vk_user_id=?").bind(eventId, uid).first();
  return assigned?.role || null;
}

async function roleApi(request, env) {
  const uid = await requireUser(request, env);
  const data = await body(request);
  const eventId = Number(data.event_id || 0);
  const user = await env.DB.prepare("INSERT INTO app_users(vk_user_id,first_seen_at,last_seen_at,display_name,screen_name) VALUES(?,?,?,?,?) ON CONFLICT(vk_user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at RETURNING vk_user_id")
    .bind(uid, now(), now(), "VK user " + uid, "").first();
  const admin = await hasAdmin(uid, env);
  const global = await env.DB.prepare("SELECT 1 AS ok FROM global_volunteers WHERE vk_user_id=? UNION SELECT 1 AS ok FROM volunteers WHERE vk_user_id=? LIMIT 1").bind(uid, uid).first();
  let events;
  if (admin || global) {
    events = await env.DB.prepare("SELECT id,name,description,event_date,event_time,venue,status FROM events WHERE status='active' ORDER BY id DESC").all();
  } else {
    events = await env.DB.prepare("SELECT e.id,e.name,e.description,e.event_date,e.event_time,e.venue,e.status FROM events e JOIN event_volunteers v ON v.event_id=e.id WHERE v.vk_user_id=? AND e.status='active' ORDER BY e.id DESC").bind(uid).all();
    if (!events.results.length) events = await env.DB.prepare("SELECT id,name,description,event_date,event_time,venue,status FROM events WHERE status='active' ORDER BY id DESC").all();
  }
  const workspaces = admin ? await env.DB.prepare("SELECT id,name,description,event_date,event_time,venue,status FROM events ORDER BY id DESC").all() : { results: [] };
  let selectedRole = admin ? "admin" : (global ? "global" : null);
  if (eventId) {
    const event = await env.DB.prepare("SELECT id,status FROM events WHERE id=?").bind(eventId).first();
    if (!event || (event.status !== "active" && !admin)) throw Object.assign(new Error("This event page is not available."), { status: 404 });
    selectedRole = await eventRole(uid, eventId, env);
  }
  return json({ ok: true, role: admin ? "admin" : (selectedRole ? "volunteer" : "guest"), staff_role: selectedRole || "", user: { id: uid, name: user?.display_name || ("VK user " + uid) }, events: events.results, workspaces: workspaces.results });
}

async function eventDetailsApi(request, env) {
  const uid = await requireUser(request, env);
  const data = await body(request);
  const eventId = Number(data.event_id || 0);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return fail("A valid event ID is required.");
  const event = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!event || (event.status !== "active" && !(await hasAdmin(uid, env)))) return fail("This event page is unavailable or archived.", 404);
  const foodEnabled = asBool(event.food_enabled);
  return json({ ok: true, event, event_id: eventId, food_collection_enabled: foodEnabled, time: event.event_time || "To be announced" });
}

async function registerApi(request, env) {
  const uid = await requireUser(request, env);
  const data = await body(request);
  const eventId = Number(data.event_id || 0);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return fail("A valid event ID is required.");
  const event = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!event || event.status !== "active" || !event.registration_open) return fail("Registration for this event is currently closed.", 409);
  let schema;
  try { schema = JSON.parse(event.registration_schema || "[]"); } catch { schema = []; }
  if (!Array.isArray(schema) || schema.length < 1 || schema.length > 30) return fail("This event's registration form is not configured correctly.", 409);
  const fields = data.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fail("Registration fields are missing.");
  const foodEnabled = asBool(event.food_enabled);
  const cleaned = {};
  const allowed = new Set(["text","tel","email","number","date","textarea","select","checkbox"]);
  for (const field of schema) {
    if (!field || typeof field.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.key) || !allowed.has(field.type || "text")) return fail("The event registration form contains an invalid field.");
    const key = field.key, type = field.type || "text", label = String(field.label || key).slice(0,80);
    let value = fields[key] ?? (type === "checkbox" ? false : "");
    if (type === "checkbox") {
      if (typeof value !== "boolean") return fail("Invalid checkbox value for " + label + ".");
    } else {
      value = String(value ?? "").trim().replace(/\s+/g," ").slice(0,1000);
    }
    const required = !!field.required && !(key === "food_preference" && !foodEnabled);
    if (required && (value === "" || value === false)) return fail("Please complete: " + label + ".");
    if (key === "food_preference" && !foodEnabled) value = "";
    if (type === "select" && value && !((field.options || []).map(String).includes(value))) return fail("Choose a valid option for " + label + ".");
    if (type === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return fail("Enter a valid email address for " + label + ".");
    if (type === "tel" && value) {
      value = value.replace(/[\s().-]/g,"");
      if (!/^\+?[0-9]{7,15}$/.test(value)) return fail("Enter a valid phone number for " + label + ".");
    }
    cleaned[key] = value;
  }
  const fullName = String(cleaned.full_name || "").trim();
  if (fullName.length < 2 || fullName.length > 100) return fail("The form must include a valid full name (2–100 characters).");
  const existing = await env.DB.prepare("SELECT status FROM guests WHERE event_id=? AND vk_user_id=?").bind(eventId,uid).first();
  if (existing?.status === "approved") return fail("You already have an approved pass for this event. Open My Pass instead.",409);
  if (existing?.status === "revoked") return fail("A previous pass for this event was revoked. Contact an admin.",409);
  const registrationData = JSON.stringify(cleaned);
  const stamp = now();
  const food = foodEnabled ? String(cleaned.food_preference || "Not specified") : "Not applicable";
  const result = await env.DB.prepare("INSERT INTO pending_registrations(event_id,vk_user_id,full_name,phone,food_preference,residence_type,hostel_number,room_number,registration_data,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,'pending') ON CONFLICT(event_id,vk_user_id) DO UPDATE SET full_name=excluded.full_name,phone=excluded.phone,food_preference=excluded.food_preference,residence_type=excluded.residence_type,hostel_number=excluded.hostel_number,room_number=excluded.room_number,registration_data=excluded.registration_data,created_at=excluded.created_at,status='pending'")
    .bind(eventId,uid,fullName,String(cleaned.phone || ""),food,String(cleaned.residence_type || "Apartment"),String(cleaned.hostel_number || ""),String(cleaned.room_number || ""),registrationData,stamp).run();
  await audit(env,uid,"registration_submitted","pending_registration",result.meta?.last_row_id || uid,{event_id:eventId},eventId);
  return json({ ok:true, request_id:result.meta?.last_row_id || null, message:"Registration submitted. Your request is awaiting admin approval." },201);
}

async function myPassApi(request, env) {
  const uid = await requireUser(request, env);
  const data = await body(request);
  const eventId = Number(data.event_id || 0);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return fail("A valid event ID is required.");
  const guest = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?").bind(eventId,uid).first();
  if (!guest) {
    const pending = await env.DB.prepare("SELECT status FROM pending_registrations WHERE event_id=? AND vk_user_id=?").bind(eventId,uid).first();
    return fail(pending?.status === "pending" ? "Your registration is awaiting admin approval." : "No approved pass was found for this event.",404);
  }
  if (guest.status !== "approved" || guest.revoked_at) return fail("This pass is not active.",403);
  const event = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  const design = await env.DB.prepare("SELECT design_json FROM pass_design WHERE event_id=?").bind(eventId).first();
  const scans = await env.DB.prepare("SELECT stage,scanned_at FROM scans WHERE guest_id=?").bind(guest.id).all();
  return json({ ok:true, pass:{ name:guest.full_name, passCode:guest.pass_code, qrToken:guest.qr_token, qrPayload:"EVENTHUB:"+eventId+":"+guest.qr_token, residence:guest.residence, roomNumber:guest.room, food:guest.food_preference, status:guest.status, entryUsed:!!guest.entry_used, foodUsed:!!guest.food_used }, event, design:design ? JSON.parse(design.design_json) : {}, scans:Object.fromEntries(scans.results.map(x=>[x.stage,x.scanned_at])) });
}


async function guestLookupApi(request, env) {
  const uid = await requireUser(request, env), data = await body(request);
  const eventId = Number(data.event_id || 0), value = String(data.qr || "").trim();
  if (!eventId || !value) return fail("An event and QR value are required.");
  const role = await eventRole(uid,eventId,env);
  if (!role) return fail("Volunteer access required for this event.",403);
  let token = value;
  const parts = value.split("|");
  if (parts.length === 2) token = parts[1];
  const colon = value.match(/^EVENTHUB:(\d+):(.+)$/);
  if (colon) {
    if (Number(colon[1]) !== eventId) return fail("This QR belongs to a different event.",409);
    token = colon[2];
  }
  const guest = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND (qr_token=? OR pass_code=?)").bind(eventId,token,token).first();
  if (!guest) return fail("Pass not found in this event.",404);
  if (guest.status !== "approved" || guest.revoked_at) return fail("This pass is not active.",403);
  const proof = await env.DB.prepare("SELECT * FROM proof_storage WHERE guest_id=?").bind(guest.id).first();
  const noProof = await env.DB.prepare("SELECT * FROM proof_not_collected WHERE guest_id=?").bind(guest.id).first();
  const exit = await env.DB.prepare("SELECT * FROM event_exit_records WHERE guest_id=?").bind(guest.id).first();
  return json({ ok:true, guest:{ id:guest.id, name:guest.full_name, full_name:guest.full_name, phone:guest.phone, residence:guest.residence, hostel:guest.hostel, roomNumber:guest.room, food:guest.food_preference, passCode:guest.pass_code, qrToken:guest.qr_token, status:guest.status, entryUsed:!!guest.entry_used, foodUsed:!!guest.food_used }, proof:{ assigned:!!proof, box:proof?.box_number ?? null, section:proof?.section_letter ?? null, slot:proof?.slot_number ?? null, deposited:!!proof?.deposited_at, returned:!!proof?.returned_at, noProof:!!noProof, exitRecorded:!!exit } });
}

async function actionApi(request, env) {
  const uid = await requireUser(request, env), data = await body(request);
  const eventId = Number(data.event_id || 0), action = String(data.action || "").trim(), value = String(data.qr || "").trim();
  const allowed = new Set(["entry","food","proof_deposit","proof_no_proof","proof_return","exit"]);
  if (!eventId || !allowed.has(action) || !value) return fail("Choose a valid event, action and QR pass.");
  const role = await eventRole(uid,eventId,env);
  if (!role) return fail("You do not have volunteer access to this event.",403);
  const roleActions = { entry:["entry","proof_deposit","proof_no_proof"], food:["food"], proof:["proof_deposit","proof_no_proof","proof_return","exit"], checkpoint:[], scanner:[...allowed], event_lead:[...allowed], global:[...allowed], admin:[...allowed] };
  if (role !== "global" && role !== "admin" && !(roleActions[role] || []).includes(action)) return fail("Your event role does not include this action.",403);
  const event = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!event || event.status !== "active") return fail("This event is not active.",409);
  if (action === "food" && !asBool(event.food_enabled)) return fail("Food collection is disabled for this event.",409);
  let token=value, split=value.split("|");
  if (split.length===2) token=split[1];
  const colon=value.match(/^EVENTHUB:(\d+):(.+)$/);
  if (colon) { if(Number(colon[1])!==eventId) return fail("This QR belongs to a different event.",409); token=colon[2]; }
  const guest=await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND (qr_token=? OR pass_code=?)").bind(eventId,token,token).first();
  if(!guest) return fail("Pass not found in this event.",404);
  if(guest.status!=="approved" || guest.revoked_at) return fail("This pass is not active.",403);
  const stamp=now();
  const proof=await env.DB.prepare("SELECT * FROM proof_storage WHERE guest_id=?").bind(guest.id).first();
  const noProof=await env.DB.prepare("SELECT * FROM proof_not_collected WHERE guest_id=?").bind(guest.id).first();
  const exited=await env.DB.prepare("SELECT 1 AS ok FROM event_exit_records WHERE guest_id=?").bind(guest.id).first();
  if(exited) return fail("Exit is already recorded. No further event-day actions are allowed.",409);
  if(action==="entry") {
    if(guest.entry_used) return fail("Entry already recorded for this pass.",409);
    await env.DB.prepare("UPDATE guests SET entry_used=1,entry_used_at=? WHERE id=? AND entry_used=0 AND status='approved'").bind(stamp,guest.id).run();
  } else if(action==="food") {
    if(!guest.entry_used) return fail("Entry must be recorded before food collection.",409);
    if(guest.food_used) return fail("Food collection already recorded for this pass.",409);
    if(!((proof && proof.deposited_at && !proof.returned_at) || noProof)) return fail("Record proof storage or confirm no proof was provided before food collection.",409);
    await env.DB.prepare("UPDATE guests SET food_used=1,food_used_at=? WHERE id=? AND food_used=0 AND entry_used=1 AND status='approved'").bind(stamp,guest.id).run();
  } else if(action==="proof_deposit") {
    if(!guest.entry_used) return fail("Record entry before storing proof.",409);
    if(noProof) return fail("No-proof status is already recorded for this guest.",409);
    if(proof && proof.deposited_at && !proof.returned_at) return fail("Proof is already stored in the assigned slot.",409);
    if(proof && proof.returned_at) return fail("Proof was already returned. Ask an admin for correction.",409);
    const cfg=await env.DB.prepare("SELECT * FROM event_storage_configs WHERE event_id=?").bind(eventId).first();
    const units=Number(cfg?.unit_count||5), sections=Number(cfg?.sections_per_unit||4), capacity=Number(cfg?.capacity_per_section||10);
    const occupied=await env.DB.prepare("SELECT box_number,section_letter,slot_number FROM proof_storage WHERE event_id=? AND returned_at IS NULL AND slot_number IS NOT NULL").bind(eventId).all();
    const used=new Set(occupied.results.map(x=>x.box_number+":"+x.section_letter+":"+x.slot_number));
    let slot=null;
    for(let box=1;box<=units&&!slot;box++) for(let si=0;si<sections&&!slot;si++) for(let n=1;n<=capacity;n++) {
      const section=String.fromCharCode(65+si);
      if(!used.has(box+":"+section+":"+n)){slot={box,section,n};break;}
    }
    if(!slot) return fail("Proof storage is full. Ask an admin to review capacity.",409);
    await env.DB.prepare("INSERT INTO proof_storage(event_id,guest_id,box_number,section_letter,slot_number,assigned_at,assigned_by,deposited_at,deposited_by) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(eventId,guest.id,slot.box,slot.section,slot.n,stamp,uid,stamp,uid).run();
    await env.DB.prepare("DELETE FROM proof_not_collected WHERE guest_id=?").bind(guest.id).run();
  } else if(action==="proof_no_proof") {
    if(!guest.entry_used) return fail("Record entry before accepting a guest without proof.",409);
    if(proof && proof.deposited_at && !proof.returned_at) return fail("This guest already has proof stored.",409);
    if(noProof) return fail("No-proof confirmation was already recorded.",409);
    await env.DB.prepare("INSERT INTO proof_not_collected(event_id,guest_id,recorded_at,recorded_by) VALUES(?,?,?,?)").bind(eventId,guest.id,stamp,uid).run();
  } else if(action==="proof_return") {
    if(!proof || !proof.deposited_at) return fail("No stored proof record found.",409);
    if(proof.returned_at) return fail("Proof return was already recorded.",409);
    await env.DB.prepare("UPDATE proof_storage SET returned_at=?,returned_by=? WHERE guest_id=? AND returned_at IS NULL").bind(stamp,uid,guest.id).run();
  } else if(action==="exit") {
    if(!guest.entry_used) return fail("Guest entry has not been recorded.",409);
    if(proof && proof.deposited_at && !proof.returned_at) return fail("Return the guest's stored proof before completing exit.",409);
    await env.DB.prepare("INSERT INTO event_exit_records(event_id,guest_id,exit_at,exit_by) VALUES(?,?,?,?)").bind(eventId,guest.id,stamp,uid).run();
  }
  await audit(env,uid,action.toUpperCase()+"_RECORDED","guest",guest.id,{stage:action},eventId);
  await outbox(env,eventId,guest.id,action,{guest_id:guest.id,event_id:eventId,action,scanned_by:uid,scanned_at:stamp});
  const fresh=await env.DB.prepare("SELECT * FROM guests WHERE id=?").bind(guest.id).first();
  const currentProof=await env.DB.prepare("SELECT * FROM proof_storage WHERE guest_id=?").bind(guest.id).first();
  const currentNoProof=await env.DB.prepare("SELECT 1 AS ok FROM proof_not_collected WHERE guest_id=?").bind(guest.id).first();
  const currentExit=await env.DB.prepare("SELECT 1 AS ok FROM event_exit_records WHERE guest_id=?").bind(guest.id).first();
  const storageLabel=currentProof ? ("Box "+currentProof.box_number+" / Section "+currentProof.section_letter+" / Slot "+String(currentProof.slot_number||"—")) : (currentNoProof ? "Accepted without proof — no slot assigned" : "");
  return json({ok:true,message:storageLabel || (action.replaceAll("_"," ")+" recorded for "+fresh.full_name),guest:{id:fresh.id,name:fresh.full_name,food:fresh.food_preference,passCode:fresh.pass_code,entryUsed:!!fresh.entry_used,foodUsed:!!fresh.food_used},proof:{assigned:!!currentProof,box:currentProof?.box_number??null,section:currentProof?.section_letter??null,slot:currentProof?.slot_number??null,deposited:!!currentProof?.deposited_at,returned:!!currentProof?.returned_at,noProof:!!currentNoProof,exitRecorded:!!currentExit}});
}

async function checkpointsApi(request, env) {
  const uid=await requireUser(request,env), data=await body(request), eventId=Number(data.event_id||0);
  const role=await eventRole(uid,eventId,env);
  if(!role) return fail("Volunteer access required for this event.",403);
  const rows=await env.DB.prepare("SELECT id,name,checkpoint_type FROM event_checkpoints WHERE event_id=? AND enabled=1 ORDER BY id").bind(eventId).all();
  return json({ok:true,checkpoints:rows.results});
}
async function checkpointScanApi(request, env) {
  const uid=await requireUser(request,env), data=await body(request);
  const eventId=Number(data.event_id||0), checkpointId=Number(data.checkpoint_id||0), value=String(data.qr||"").trim();
  const role=await eventRole(uid,eventId,env);
  if(!role) return fail("Volunteer access required for this event.",403);
  if(!eventId||!checkpointId||!value) return fail("A guest QR and enabled checkpoint are required.");
  const checkpoint=await env.DB.prepare("SELECT * FROM event_checkpoints WHERE id=? AND event_id=? AND enabled=1").bind(checkpointId,eventId).first();
  if(!checkpoint) return fail("Checkpoint not found or disabled.",404);
  let token=value; const colon=value.match(/^EVENTHUB:(\d+):(.+)$/); if(colon){if(Number(colon[1])!==eventId)return fail("This QR belongs to another event.",409);token=colon[2];}
  const parts=token.split("|"); if(parts.length===2)token=parts[1];
  const guest=await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND (qr_token=? OR pass_code=?) AND status='approved'").bind(eventId,token,token).first();
  if(!guest) return fail("Active guest pass not found.",404);
  try {
    await env.DB.prepare("INSERT INTO event_checkpoint_scans(event_id,checkpoint_id,guest_id,volunteer_vk_user_id,scanned_at) VALUES(?,?,?,?,?)").bind(eventId,checkpointId,guest.id,uid,now()).run();
  } catch(e) {
    if(String(e.message).toLowerCase().includes("unique")) return fail("This guest was already scanned at this checkpoint.",409);
    throw e;
  }
  await audit(env,uid,"CHECKPOINT_SCAN","guest",guest.id,{checkpoint_id:checkpointId,checkpoint_name:checkpoint.name},eventId);
  return json({ok:true,message:checkpoint.name+" recorded for "+guest.full_name,guest:{id:guest.id,name:guest.full_name}});
}


async function adminApi(request, env) {
  const uid=await requireAdmin(request,env), data=await body(request), action=String(data.action||"");
  const eventId=Number(data.event_id||0);
  const getEvent=async()=>env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  const log=async(name,type="event",target=eventId,details={})=>audit(env,uid,name,type,target,details,eventId||null);
  if(action==="events") {
    const rows=await env.DB.prepare("SELECT id,name,description,event_date,event_time,venue,status,registration_open,food_enabled,theme_json,registration_schema FROM events ORDER BY id DESC").all();
    return json({ok:true,events:rows.results});
  }
  if(action==="create_event") {
    const name=String(data.name||"").trim().slice(0,120);
    if(name.length<3) return fail("Enter an event name (at least 3 characters).");
    const description=String(data.description||"").slice(0,1000), eventDate=String(data.event_date||"").slice(0,20), eventTime=String(data.event_time||"").slice(0,40), venue=String(data.venue||"").slice(0,200);
    const schema=Array.isArray(data.registration_schema)&&data.registration_schema.length?data.registration_schema:[{key:"full_name",label:"Full name",type:"text",required:true},{key:"phone",label:"Phone",type:"tel",required:true}];
    const theme=data.theme&&typeof data.theme==="object"?data.theme:{primary:"#25113b",accent:"#ff7518",background:"#171321",gold:"#ffd166"};
    const foodEnabled=data.food_enabled===undefined?true:asBool(data.food_enabled);
    const result=await env.DB.prepare("INSERT INTO events(name,description,event_date,event_time,venue,theme_json,registration_schema,status,active,registration_open,food_enabled,created_by,created_at) VALUES(?,?,?,?,?,?,?,'draft',0,1,?,?,?)")
      .bind(name,description,eventDate,eventTime,venue,JSON.stringify(theme),JSON.stringify(schema),foodEnabled?1:0,uid,now()).run();
    const id=result.meta.last_row_id;
    await env.DB.prepare("INSERT INTO event_checkpoints(event_id,name,checkpoint_type,created_at) VALUES(?,?,?,?)").bind(id,"Main Entry","entry",now()).run();
    await env.DB.prepare("INSERT INTO event_storage_configs(event_id,updated_at,updated_by) VALUES(?,?,?)").bind(id,now(),uid).run();
    await env.DB.prepare("INSERT INTO event_app_settings(event_id,updated_at,updated_by) VALUES(?,?,?)").bind(id,now(),uid).run();
    await log("EVENT_CREATED","event",id,{name});
    return json({ok:true,event_id:id,message:"Event workspace created as a draft. Configure its registration form and activate it when ready."},201);
  }
  if(action==="update_event") {
    const event=await getEvent();
    if(!event) return fail("Event workspace not found.",404);
    if(event.status==="archived") return fail("Archived event settings are read-only.",409);
    const name=String(data.name||event.name).trim().slice(0,120);
    if(name.length<3) return fail("Event name must contain at least 3 characters.");
    const theme=data.theme&&typeof data.theme==="object"?JSON.stringify(data.theme):event.theme_json;
    const schema=Array.isArray(data.registration_schema)?JSON.stringify(data.registration_schema):event.registration_schema;
    await env.DB.prepare("UPDATE events SET name=?,description=?,event_date=?,event_time=?,venue=?,theme_json=?,registration_schema=?,food_enabled=? WHERE id=?")
      .bind(name,String(data.description??event.description).slice(0,1000),String(data.event_date??event.event_date).slice(0,20),String(data.event_time??event.event_time).slice(0,40),String(data.venue??event.venue).slice(0,200),theme,schema,data.food_enabled===undefined?event.food_enabled:(asBool(data.food_enabled)?1:0),eventId).run();
    await log("EVENT_UPDATED","event",eventId,{name});
    return json({ok:true,event_id:eventId,message:"Event details and registration form saved."});
  }
  if(action==="activate_event") {
    const event=await getEvent(); if(!event) return fail("Event workspace not found.",404);
    if(event.status==="archived") return fail("Archived events cannot be activated.",409);
    await env.DB.prepare("UPDATE events SET status='active',active=1 WHERE id=?").bind(eventId).run();
    await log("EVENT_ACTIVATED"); return json({ok:true,message:"Event activated. It is now visible to guests."});
  }
  if(action==="archive_event") {
    const event=await getEvent(); if(!event) return fail("Event workspace not found.",404);
    await env.DB.prepare("UPDATE events SET status='archived',active=0,archived_at=? WHERE id=?").bind(now(),eventId).run();
    await log("EVENT_ARCHIVED"); return json({ok:true,message:"Event archived. Existing registrations and event history were retained."});
  }
  if(action==="set_registration_status") {
    if(typeof data.registration_open!=="boolean") return fail("registration_open must be true or false.");
    const event=await getEvent(); if(!event||event.status==="archived") return fail("Active or draft event not found.",404);
    await env.DB.prepare("UPDATE events SET registration_open=? WHERE id=?").bind(data.registration_open?1:0,eventId).run();
    await log(data.registration_open?"REGISTRATION_OPENED":"REGISTRATION_CLOSED");
    return json({ok:true,registration_open:data.registration_open,message:data.registration_open?"Registration is open.":"Registration is closed. Existing passes and attendance history are unchanged."});
  }
  if(action==="stats") {
    const event=await getEvent(); if(!event) return fail("Event not found.",404);
    const [total,entered,meals,volunteers,proof,exits]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) n FROM guests WHERE event_id=? AND status='approved'").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM guests WHERE event_id=? AND status='approved' AND entry_used=1").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM guests WHERE event_id=? AND status='approved' AND food_used=1").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM event_volunteers WHERE event_id=?").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM proof_storage WHERE event_id=? AND deposited_at IS NOT NULL AND returned_at IS NULL").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM event_exit_records WHERE event_id=?").bind(eventId).first()
    ]);
    return json({ok:true,stats:{approvedGuests:total.n,checkedIn:entered.n,mealsServed:meals.n,volunteers:volunteers.n,proofCurrentlyStored:proof.n,exited:exits.n}});
  }
  if(action==="guest_search") {
    const query=String(data.query||"").trim().slice(0,120), status=String(data.status||"all");
    if(!eventId) return fail("Event ID required.");
    if(!["all","approved","pending","rejected","revoked"].includes(status)) return fail("Invalid guest status filter.");
    const like="%"+query+"%";
    const rows=await env.DB.prepare("SELECT id,vk_user_id,legacy_telegram_id,full_name,phone,residence_type,hostel_number,room_number,food_preference,pass_code,status,entry_used,food_used,registered_at FROM guests WHERE event_id=? AND (?='all' OR status=?) AND (?='' OR full_name LIKE ? OR phone LIKE ? OR pass_code LIKE ? OR vk_user_id LIKE ? OR legacy_telegram_id LIKE ?) ORDER BY id DESC LIMIT 100")
      .bind(eventId,status,status,query,like,like,like,like,like).all();
    return json({ok:true,guests:rows.results,limit:100});
  }
  if(action==="pending_registrations") {
    const rows=await env.DB.prepare("SELECT id,vk_user_id,legacy_telegram_id,full_name,phone,residence_type,hostel_number,room_number,food_preference,registration_data,created_at,status FROM pending_registrations WHERE event_id=? AND status='pending' ORDER BY created_at DESC LIMIT 100").bind(eventId).all();
    return json({ok:true,registrations:rows.results});
  }
  if(action==="registration_decision") {
    const requestId=Number(data.request_id||0), decision=String(data.decision||"");
    if(!requestId||!["approve","reject"].includes(decision)) return fail("Choose a valid pending request and approve/reject decision.");
    const pending=await env.DB.prepare("SELECT * FROM pending_registrations WHERE id=? AND event_id=? AND status='pending'").bind(requestId,eventId).first();
    if(!pending) return fail("Pending registration not found or already handled.",409);
    if(decision==="reject") {
      await env.DB.prepare("UPDATE pending_registrations SET status='rejected' WHERE id=?").bind(requestId).run();
      await log("REGISTRATION_REJECTED","pending_registration",requestId,{full_name:pending.full_name});
      return json({ok:true,decision,message:"Registration rejected. The previous record remains in history."});
    }
    const code="EH-"+crypto.randomUUID().slice(0,8).toUpperCase();
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
    const insert=await env.DB.prepare("INSERT INTO guests(event_id,vk_user_id,legacy_telegram_id,full_name,email,phone,residence,residence_type,hostel,hostel_number,room,room_number,food_preference,registration_data,status,pass_code,qr_token,registered_at,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?)")
      .bind(eventId,pending.vk_user_id,pending.legacy_telegram_id,pending.full_name,pending.email,pending.phone,pending.residence_type,pending.residence_type,pending.hostel_number,pending.hostel_number,pending.room_number,pending.room_number,pending.food_preference,pending.registration_data,code,token,pending.created_at,pending.created_at,now()).run();
    const guestId=insert.meta.last_row_id;
    await env.DB.prepare("UPDATE pending_registrations SET status='approved' WHERE id=?").bind(requestId).run();
    await outbox(env,eventId,guestId,"approved",{guest_id:guestId,event_id:eventId,status:"approved",pass_code:code});
    await log("REGISTRATION_APPROVED","guest",guestId,{request_id:requestId});
    return json({ok:true,decision,guest_id:guestId,passCode:code,message:pending.vk_user_id?"Registration approved. The guest can now open My Pass.":"Registration approved, but this legacy record is not linked to a VK account yet."});
  }
  if(action==="guest_action") {
    const guestId=Number(data.guest_id||0), operation=String(data.operation||""), target=String(data.target||"");
    const guest=await env.DB.prepare("SELECT * FROM guests WHERE id=? AND event_id=?").bind(guestId,eventId).first();
    if(!guest) return fail("Guest record not found.",404);
    if(operation==="revoke_pass") {
      if(guest.status!=="approved") return fail("This pass is not currently active.",409);
      await env.DB.prepare("UPDATE guests SET status='revoked',revoked_at=? WHERE id=?").bind(now(),guestId).run();
    } else if(operation==="reissue_pass"||operation==="reactivate_pass") {
      if(operation==="reissue_pass"&&guest.status!=="approved") return fail("Only an approved pass can be reissued.",409);
      if(operation==="reactivate_pass"&&guest.status!=="revoked") return fail("Only a revoked pass can be reactivated.",409);
      const code="EH-"+crypto.randomUUID().slice(0,8).toUpperCase();
      const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
      await env.DB.prepare("UPDATE guests SET pass_code=?,qr_token=?,status='approved',revoked_at=NULL WHERE id=?").bind(code,token,guestId).run();
    } else if(operation==="reset_status") {
      if(!["entry","food","both"].includes(target)) return fail("Choose entry, food, or both.");
      const proof=await env.DB.prepare("SELECT 1 AS ok FROM proof_storage WHERE guest_id=? AND deposited_at IS NOT NULL AND returned_at IS NULL").bind(guestId).first();
      if(proof&&target==="entry"||proof&&target==="both") return fail("Cannot reset entry while the guest's proof is still stored. Return the proof first.",409);
      if(target==="entry"||target==="both") await env.DB.prepare("UPDATE guests SET entry_used=0,entry_used_at=NULL WHERE id=?").bind(guestId).run();
      if(target==="food"||target==="both") await env.DB.prepare("UPDATE guests SET food_used=0,food_used_at=NULL WHERE id=?").bind(guestId).run();
    } else return fail("Invalid guest action.");
    const fresh=await env.DB.prepare("SELECT * FROM guests WHERE id=?").bind(guestId).first();
    await log("GUEST_"+operation.toUpperCase(),"guest",guestId,{status:fresh.status});
    await outbox(env,eventId,guestId,operation,{guest_id:guestId,event_id:eventId,operation,status:fresh.status,pass_code:fresh.pass_code});
    return json({ok:true,guest:{id:guestId,status:fresh.status,passCode:fresh.pass_code,entryUsed:!!fresh.entry_used,foodUsed:!!fresh.food_used},message:"Guest record updated. Existing attendance and proof history were preserved unless the selected status reset applied."});
  }
  if(action==="link_legacy_guest"||action==="link_legacy_pending") {
    const legacyId=String(data.legacy_telegram_id||"").trim(), vkId=String(data.vk_user_id||"").trim();
    if(!legacyId||!vkId) return fail("Both the legacy Telegram ID and verified VK user ID are required.");
    if(action==="link_legacy_guest") {
      const result=await env.DB.prepare("UPDATE guests SET vk_user_id=? WHERE event_id=? AND legacy_telegram_id=? AND vk_user_id IS NULL").bind(vkId,eventId,legacyId).run();
      if(!result.meta.changes) return fail("Legacy guest not found or already linked.",409);
    } else {
      const result=await env.DB.prepare("UPDATE pending_registrations SET vk_user_id=? WHERE event_id=? AND legacy_telegram_id=? AND vk_user_id IS NULL").bind(vkId,eventId,legacyId).run();
      if(!result.meta.changes) return fail("Legacy pending registration not found or already linked.",409);
    }
    await log("LEGACY_IDENTITY_LINKED",action==="link_legacy_guest"?"guest":"pending_registration",legacyId,{vk_user_id:vkId,verification:"admin_manual"});
    return json({ok:true,message:"Legacy record linked to the verified VK account. The original Telegram ID remains in migration history."});
  }
  if(action==="volunteers") {
    const rows=await env.DB.prepare("SELECT * FROM global_volunteers ORDER BY added_at DESC").all();
    return json({ok:true,volunteers:rows.results});
  }
  if(action==="add_volunteer"||action==="remove_volunteer") {
    const vkId=String(data.vk_user_id||"").trim();
    if(!vkId) return fail("Enter a VK user ID.");
    if(action==="add_volunteer") await env.DB.prepare("INSERT INTO global_volunteers(vk_user_id,display_name,added_at,added_by) VALUES(?,?,?,?) ON CONFLICT(vk_user_id) DO UPDATE SET display_name=excluded.display_name").bind(vkId,String(data.display_name||"").slice(0,120),now(),uid).run();
    else await env.DB.prepare("DELETE FROM global_volunteers WHERE vk_user_id=?").bind(vkId).run();
    await log(action==="add_volunteer"?"GLOBAL_VOLUNTEER_ADDED":"GLOBAL_VOLUNTEER_REMOVED","volunteer",vkId);
    return json({ok:true,message:action==="add_volunteer"?"Global volunteer access granted.":"Global volunteer access removed."});
  }
  if(action==="event_volunteers") {
    const rows=await env.DB.prepare("SELECT * FROM event_volunteers WHERE event_id=? ORDER BY assigned_at DESC").bind(eventId).all();
    return json({ok:true,volunteers:rows.results});
  }
  if(action==="assign_event_volunteer") {
    const vkId=String(data.vk_user_id||"").trim(), role=String(data.role||"scanner");
    if(!vkId||!["entry","food","proof","checkpoint","scanner","event_lead"].includes(role)) return fail("Choose a VK user ID and valid event role.");
    await env.DB.prepare("INSERT INTO event_volunteers(event_id,vk_user_id,role,assigned_by,assigned_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id,vk_user_id) DO UPDATE SET role=excluded.role,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at").bind(eventId,vkId,role,uid,now()).run();
    await log("EVENT_VOLUNTEER_ASSIGNED","volunteer",vkId,{role});
    return json({ok:true,message:"Volunteer assigned to this event."});
  }
  if(action==="remove_event_volunteer") {
    const vkId=String(data.vk_user_id||"").trim();
    await env.DB.prepare("DELETE FROM event_volunteers WHERE event_id=? AND vk_user_id=?").bind(eventId,vkId).run();
    await log("EVENT_VOLUNTEER_REMOVED","volunteer",vkId);
    return json({ok:true,message:"Event-specific volunteer access removed. Global roles are unchanged."});
  }
  if(action==="checkpoints") {
    const rows=await env.DB.prepare("SELECT id,name,checkpoint_type,enabled FROM event_checkpoints WHERE event_id=? ORDER BY id").bind(eventId).all();
    return json({ok:true,checkpoints:rows.results});
  }
  if(action==="create_checkpoint") {
    const name=String(data.name||"").trim().slice(0,100), type=String(data.checkpoint_type||"entry");
    if(!name||!["entry","food","workshop","other"].includes(type)) return fail("Valid checkpoint name and type are required.");
    const r=await env.DB.prepare("INSERT INTO event_checkpoints(event_id,name,checkpoint_type,created_at) VALUES(?,?,?,?)").bind(eventId,name,type,now()).run();
    await log("CHECKPOINT_CREATED","checkpoint",r.meta.last_row_id,{name,type});
    return json({ok:true,checkpoint_id:r.meta.last_row_id});
  }
  if(action==="update_checkpoint") {
    const checkpointId=Number(data.checkpoint_id||0), name=String(data.name||"").trim().slice(0,100), enabled=data.enabled===undefined?1:(asBool(data.enabled)?1:0);
    if(!checkpointId||!name) return fail("Checkpoint ID and name are required.");
    const r=await env.DB.prepare("UPDATE event_checkpoints SET name=?,enabled=? WHERE id=? AND event_id=?").bind(name,enabled,checkpointId,eventId).run();
    if(!r.meta.changes) return fail("Checkpoint not found.",404);
    await log("CHECKPOINT_UPDATED","checkpoint",checkpointId,{name,enabled});
    return json({ok:true});
  }
  if(action==="delete_checkpoint") {
    const checkpointId=Number(data.checkpoint_id||0);
    const scans=await env.DB.prepare("SELECT COUNT(*) n FROM event_checkpoint_scans WHERE checkpoint_id=?").bind(checkpointId).first();
    if(scans.n) return fail("This checkpoint has scan history. Disable it instead of deleting it.",409);
    await env.DB.prepare("DELETE FROM event_checkpoint_assignments WHERE event_id=? AND checkpoint_id=?").bind(eventId,checkpointId).run();
    await env.DB.prepare("DELETE FROM event_checkpoints WHERE event_id=? AND id=?").bind(eventId,checkpointId).run();
    await log("CHECKPOINT_DELETED","checkpoint",checkpointId);
    return json({ok:true});
  }
  if(action==="storage_config") {
    const config=await env.DB.prepare("SELECT * FROM event_storage_configs WHERE event_id=?").bind(eventId).first();
    return json({ok:true,config:config||{unit_count:5,sections_per_unit:4,capacity_per_section:10,unit_prefix:"Box",section_prefix:"Section"}});
  }
  if(action==="save_storage_config") {
    const units=Number(data.unit_count),sections=Number(data.sections_per_unit),capacity=Number(data.capacity_per_section);
    if(!Number.isInteger(units)||units<1||units>100||!Number.isInteger(sections)||sections<1||sections>26||!Number.isInteger(capacity)||capacity<1||capacity>500) return fail("Storage layout values are outside allowed limits.");
    const active=await env.DB.prepare("SELECT box_number,section_letter,slot_number FROM proof_storage WHERE event_id=? AND deposited_at IS NOT NULL AND returned_at IS NULL").bind(eventId).all();
    for(const p of active.results) {
      const section=p.section_letter.charCodeAt(0)-65;
      if(p.box_number>units||section<0||section>=sections||!p.slot_number||p.slot_number>capacity) return fail("The new layout would invalidate an active stored-proof slot. Return or relocate that proof first.",409);
    }
    await env.DB.prepare("INSERT INTO event_storage_configs(event_id,unit_count,sections_per_unit,capacity_per_section,unit_prefix,section_prefix,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET unit_count=excluded.unit_count,sections_per_unit=excluded.sections_per_unit,capacity_per_section=excluded.capacity_per_section,unit_prefix=excluded.unit_prefix,section_prefix=excluded.section_prefix,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
      .bind(eventId,units,sections,capacity,String(data.unit_prefix||"Box").slice(0,30),String(data.section_prefix||"Section").slice(0,30),now(),uid).run();
    await log("STORAGE_LAYOUT_UPDATED","event",eventId,{units,sections,capacity});
    return json({ok:true,message:"Storage layout saved. Existing assignments and history were preserved."});
  }
  if(action==="proof_storage_report") {
    const [rows,summary,noProof,exits,cfg]=await Promise.all([
      env.DB.prepare("SELECT p.*,g.full_name,g.phone,g.pass_code,g.id AS guest_serial_number FROM proof_storage p LEFT JOIN guests g ON g.id=p.guest_id WHERE p.event_id=? ORDER BY p.box_number,p.section_letter,p.slot_number").bind(eventId).all(),
      env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN deposited_at IS NOT NULL AND returned_at IS NULL THEN 1 ELSE 0 END) currently_stored,SUM(CASE WHEN returned_at IS NOT NULL THEN 1 ELSE 0 END) returned FROM proof_storage WHERE event_id=?").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM proof_not_collected WHERE event_id=?").bind(eventId).first(),
      env.DB.prepare("SELECT COUNT(*) n FROM event_exit_records WHERE event_id=?").bind(eventId).first(),
      env.DB.prepare("SELECT * FROM event_storage_configs WHERE event_id=?").bind(eventId).first()
    ]);
    const capacity=(cfg?.unit_count||5)*(cfg?.sections_per_unit||4)*(cfg?.capacity_per_section||10);
    return json({ok:true,summary:{tracked:summary.total||0,currentlyStored:summary.currently_stored||0,returned:summary.returned||0,noProof:noProof.n,exited:exits.n,capacity},records:rows.results});
  }
  if(action==="audit") {
    const rows=await env.DB.prepare("SELECT actor_vk_user_id AS actor_id,action,target_type, target_id,details_json,created_at FROM audit_log WHERE event_id=? ORDER BY id DESC LIMIT 100").bind(eventId).all();
    return json({ok:true,logs:rows.results});
  }
  if(action==="sheets_queue_status") {
    const row=await env.DB.prepare("SELECT COUNT(*) pending,SUM(CASE WHEN attempts>0 THEN 1 ELSE 0 END) retrying,MIN(created_at) oldest FROM sheets_outbox WHERE event_id=? AND synced_at IS NULL").bind(eventId).first();
    return json({ok:true,configured:!!env.SHEETS_SYNC_URL&&!!env.SHEETS_SYNC_SECRET,pending:row.pending||0,retrying:row.retrying||0,oldestCreatedAt:row.oldest||""});
  }
  if(action==="admins") {
    const rows=await env.DB.prepare("SELECT vk_user_id,added_at,added_by FROM app_admins ORDER BY added_at").all();
    return json({ok:true,admins:rows.results,configured_admin_ids:String(env.VK_ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean)});
  }
  if(action==="add_admin") {
    const target=String(data.vk_user_id||"").trim(); if(!target)return fail("VK user ID required.");
    await env.DB.prepare("INSERT INTO app_admins(vk_user_id,added_at,added_by) VALUES(?,?,?) ON CONFLICT(vk_user_id) DO NOTHING").bind(target,now(),uid).run();
    await log("ADMIN_ADDED","admin",target);
    return json({ok:true,message:"EventHub admin access granted."});
  }
  if(action==="remove_admin") {
    const target=String(data.vk_user_id||"").trim();
    if(String(env.VK_ADMIN_IDS||"").split(",").map(x=>x.trim()).includes(target)) return fail("Configured recovery admins cannot be removed from the dashboard.",409);
    if(target===uid)return fail("You cannot remove your own admin access while using this dashboard.",409);
    const count=await env.DB.prepare("SELECT COUNT(*) n FROM app_admins").first();
    const configured=String(env.VK_ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean).length;
    if(count.n+configured<=1)return fail("Cannot remove the last admin account.",409);
    await env.DB.prepare("DELETE FROM app_admins WHERE vk_user_id=?").bind(target).run();
    await log("ADMIN_REMOVED","admin",target);
    return json({ok:true,message:"EventHub admin access removed."});
  }
  return fail("Unknown admin action: "+action,404);
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "vk-eventhub-cloudflare" });
  if (path === "/api/role" && method === "POST") return roleApi(request, env);
  if (path === "/api/admin" && method === "POST") return adminApi(request, env);
  if (path === "/api/event_details" && method === "POST") return eventDetailsApi(request, env);
  if (path === "/api/register" && method === "POST") return registerApi(request, env);
  if (path === "/api/my_pass" && method === "POST") return myPassApi(request, env);
  if (path === "/api/guest" && method === "POST") return guestLookupApi(request, env);
  if (path === "/api/action" && method === "POST") return actionApi(request, env);
  if (path === "/api/checkpoints" && method === "POST") return checkpointsApi(request, env);
  if (path === "/api/checkpoint_scan" && method === "POST") return checkpointScanApi(request, env);

  if (path === "/api/bootstrap" && method === "GET") {
    const uid = await requireUser(request, env);
    const event = await activeEvent(env);
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?").bind(event.id, uid).first();
    const scanRows = guest ? await env.DB.prepare("SELECT stage,scanned_at FROM scans WHERE guest_id=?").bind(guest.id).all() : { results: [] };
    const volunteer = await env.DB.prepare("SELECT 1 AS ok FROM volunteers WHERE vk_user_id=? AND active=1").bind(uid).first();
    const safeEvent = { ...event, food_enabled: asBool(event.food_enabled) };
    return json({
      user: { vk_user_id: uid, is_admin: await hasAdmin(uid, env), is_volunteer: (await hasAdmin(uid, env)) || !!volunteer },
      event: safeEvent, food_collection_enabled: safeEvent.food_enabled,
      registration: asGuest(guest),
      scans: Object.fromEntries((scanRows.results || []).map(x => [x.stage, x.scanned_at]))
    });
  }

  if (path === "/api/register" && method === "POST") {
    const uid = await requireUser(request, env);
    const data = await body(request);
    const required = ["full_name", "phone", "residence", "hostel", "room"];
    for (const field of required) {
      if (typeof data[field] !== "string" || data[field].trim().length < (field === "full_name" || field === "residence" ? 2 : 1)) return fail("Please provide a valid " + field.replace("_", " ") + ".");
      if (data[field].length > 160) return fail(field + " is too long.");
    }
    const event = await activeEvent(env);
    const foodEnabled = asBool(event.food_enabled);
    if (foodEnabled && !["Vegetarian", "Non-vegetarian"].includes(data.food_preference)) return fail("Choose a valid food preference.");
    if (!foodEnabled && data.food_preference) return fail("Food preference is not collected for this event.");
    const existing = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?").bind(event.id, uid).first();
    if (existing) return json({ registration: existing, message: "You are already registered." });
    const registeredAt = now();
    const insert = await env.DB.prepare("INSERT INTO guests(event_id,vk_user_id,full_name,phone,residence,hostel,room,food_preference,status,registered_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(event.id, uid, data.full_name.trim(), data.phone.trim(), data.residence.trim(), data.hostel.trim(), data.room.trim(), foodEnabled ? data.food_preference : null, "pending", registeredAt).run();
    const guestId = insert.meta.last_row_id;
    const payload = { guest_id: guestId, vk_user_id: uid, full_name: data.full_name.trim(), phone: data.phone.trim(), residence: data.residence.trim(), hostel: data.hostel.trim(), room: data.room.trim(), food_preference: foodEnabled ? data.food_preference : null, status: "pending" };
    await outbox(env, event.id, guestId, "registered", payload);
    await audit(env, uid, "registration_submitted", "guest", guestId);
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE id=?").bind(guestId).first();
    return json({ registration: guest, message: "Registration submitted for admin approval." }, 201);
  }

  if (path === "/api/my-pass" && method === "GET") {
    const uid = await requireUser(request, env);
    const event = await activeEvent(env);
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?").bind(event.id, uid).first();
    if (!guest) return fail("No registration found.", 404);
    if (guest.status !== "approved" || guest.revoked_at) return fail("Your pass is not currently active.", 403);
    const design = await env.DB.prepare("SELECT design_json FROM pass_design WHERE event_id=?").bind(event.id).first();
    const scans = await env.DB.prepare("SELECT stage,scanned_at FROM scans WHERE guest_id=?").bind(guest.id).all();
    return json({ guest, event, design: design ? JSON.parse(design.design_json) : {}, scans: Object.fromEntries(scans.results.map(x => [x.stage, x.scanned_at])) });
  }

  if (path === "/api/admin/guests" && method === "GET") {
    await requireAdmin(request, env);
    const event = await activeEvent(env);
    const status = url.searchParams.get("status");
    const result = ["pending", "approved", "rejected", "revoked"].includes(status)
      ? await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND status=? ORDER BY registered_at DESC").bind(event.id, status).all()
      : await env.DB.prepare("SELECT * FROM guests WHERE event_id=? ORDER BY registered_at DESC").bind(event.id).all();
    return json({ guests: result.results });
  }

  const decisionMatch = path.match(/^\/api\/admin\/guests\/(\d+)\/(approve|reject|revoke)$/);
  if (decisionMatch && method === "POST") {
    const uid = await requireAdmin(request, env);
    const guestId = Number(decisionMatch[1]), decision = decisionMatch[2];
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE id=?").bind(guestId).first();
    if (!guest) return fail("Guest not found.", 404);
    let updated;
    if (decision === "approve") {
      const code = guest.pass_code || ("EH-" + crypto.randomUUID().slice(0, 8).toUpperCase());
      const token = guest.qr_token || Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare("UPDATE guests SET status='approved',pass_code=?,qr_token=?,approved_at=?,revoked_at=NULL WHERE id=?")
        .bind(code, token, now(), guestId).run();
    } else if (decision === "reject") {
      await env.DB.prepare("UPDATE guests SET status='rejected' WHERE id=?").bind(guestId).run();
    } else {
      await env.DB.prepare("UPDATE guests SET status='revoked',revoked_at=? WHERE id=?").bind(now(), guestId).run();
    }
    updated = await env.DB.prepare("SELECT * FROM guests WHERE id=?").bind(guestId).first();
    await audit(env, uid, "guest_" + decision, "guest", guestId);
    await outbox(env, guest.event_id, guestId, decision, updated);
    return json({ guest: updated });
  }

  if (path === "/api/admin/volunteers" && method === "POST") {
    const uid = await requireAdmin(request, env), data = await body(request);
    if (!data.vk_user_id || String(data.vk_user_id).length > 40) return fail("Enter a valid VK user ID.");
    await env.DB.prepare("INSERT INTO volunteers(vk_user_id,display_name,added_by,active,added_at) VALUES(?,?,?,1,?) ON CONFLICT(vk_user_id) DO UPDATE SET display_name=excluded.display_name,active=1")
      .bind(String(data.vk_user_id), String(data.display_name || "").slice(0, 120), uid, now()).run();
    await audit(env, uid, "volunteer_added", "volunteer", data.vk_user_id);
    return json({ ok: true });
  }
  if (path === "/api/admin/volunteers" && method === "GET") {
    await requireAdmin(request, env);
    const result = await env.DB.prepare("SELECT * FROM volunteers ORDER BY added_at DESC").all();
    return json({ volunteers: result.results });
  }
  const volunteerMatch = path.match(/^\/api\/admin\/volunteers\/([^/]+)$/);
  if (volunteerMatch && method === "DELETE") {
    const uid = await requireAdmin(request, env), volunteerId = decodeURIComponent(volunteerMatch[1]);
    await env.DB.prepare("UPDATE volunteers SET active=0 WHERE vk_user_id=?").bind(volunteerId).run();
    await audit(env, uid, "volunteer_removed", "volunteer", volunteerId);
    return json({ ok: true });
  }

  if (path === "/api/scan" && method === "POST") {
    const uid = await requireStaff(request, env), data = await body(request);
    const stage = String(data.stage || "").toLowerCase();
    if (!STAGES.has(stage) || typeof data.qr_token !== "string" || !data.qr_token) return fail("Invalid checkpoint or QR token.");
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE qr_token=?").bind(data.qr_token).first();
    if (!guest) return fail("Invalid QR pass.", 404);
    if (guest.status !== "approved" || guest.revoked_at) return fail("Pass is not active.", 403);
    try {
      await env.DB.prepare("INSERT INTO scans(guest_id,stage,scanned_by,scanned_at) VALUES(?,?,?,?)").bind(guest.id, stage, uid, now()).run();
    } catch (e) {
      if (String(e.message).toLowerCase().includes("unique")) return fail(stage.replace("_", " ") + " already recorded.", 409);
      throw e;
    }
    await audit(env, uid, "checkpoint_scan", "guest", guest.id, { stage });
    await outbox(env, guest.event_id, guest.id, "scan", { guest_id: guest.id, stage, scanned_by: uid });
    return json({ ok: true, stage, guest: { full_name: guest.full_name, hostel: guest.hostel, room: guest.room, food_preference: guest.food_preference } });
  }

  if (path === "/api/admin/stats" && method === "GET") {
    await requireAdmin(request, env);
    const event = await activeEvent(env);
    const [total, approved, pending, stages, outboxCount] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id=?").bind(event.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id=? AND status='approved'").bind(event.id).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id=? AND status='pending'").bind(event.id).first(),
      env.DB.prepare("SELECT s.stage,COUNT(*) AS n FROM scans s JOIN guests g ON g.id=s.guest_id WHERE g.event_id=? GROUP BY s.stage").bind(event.id).all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM sheets_outbox WHERE event_id=? AND synced_at IS NULL").bind(event.id).first()
    ]);
    return json({ total: total.n, approved: approved.n, pending: pending.n, checkpoints: Object.fromEntries(stages.results.map(x => [x.stage, x.n])), sheets_pending: outboxCount.n });
  }

  if (path === "/api/admin/export.csv" && method === "GET") {
    await requireAdmin(request, env);
    const event = await activeEvent(env);
    const result = await env.DB.prepare("SELECT id,full_name,phone,residence,hostel,room,food_preference,status,pass_code,registered_at FROM guests WHERE event_id=? ORDER BY registered_at").bind(event.id).all();
    const fields = ["ID","Full name","Phone","Residence","Hostel","Room","Food preference","Status","Pass code","Registered at"];
    const cell = value => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const rows = result.results.map(g => [g.id,g.full_name,g.phone,g.residence,g.hostel,g.room,g.food_preference,g.status,g.pass_code,g.registered_at].map(cell).join(","));
    return new Response([fields.map(cell).join(","), ...rows].join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="event-guests.csv"', "cache-control": "no-store" } });
  }

  if (path === "/api/admin/design" && method === "GET") {
    await requireAdmin(request, env);
    const event = await activeEvent(env);
    const row = await env.DB.prepare("SELECT design_json FROM pass_design WHERE event_id=?").bind(event.id).first();
    return json({ design: row ? JSON.parse(row.design_json) : { title: event.name, subtitle: "", show_food: asBool(event.food_enabled), show_residence: true, show_hostel: true, show_room: true, qr_size: 240, background: "#21113d", accent: "#f8d68a" } });
  }
  if (path === "/api/admin/design" && method === "PUT") {
    const uid = await requireAdmin(request, env), data = await body(request);
    if (!data.design || typeof data.design !== "object" || Array.isArray(data.design)) return fail("Invalid design settings.");
    const event = await activeEvent(env);
    await env.DB.prepare("INSERT INTO pass_design(event_id,design_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET design_json=excluded.design_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(event.id, JSON.stringify(data.design), uid, now()).run();
    await audit(env, uid, "pass_design_updated", "event", event.id);
    return json({ ok: true, message: "Pass design saved. Existing QR tokens and checkpoint history were preserved." });
  }

  return fail("API route not found.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env); }
      catch (e) { return fail(e.message || "Internal server error.", e.status || 500); }
    }
    return env.ASSETS.fetch(request);
  }
};
