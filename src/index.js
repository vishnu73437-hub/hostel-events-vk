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
async function requireUser(request, env) {
  try { return await authenticate(request, env); }
  catch (e) { throw Object.assign(new Error(e.message), { status: 401 }); }
}
async function requireAdmin(request, env) {
  const uid = await requireUser(request, env);
  if (!isAdmin(uid, env)) throw Object.assign(new Error("Administrator access required."), { status: 403 });
  return uid;
}
async function requireStaff(request, env) {
  const uid = await requireUser(request, env);
  if (isAdmin(uid, env)) return uid;
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
async function audit(env, actor, action, type, target, details = {}) {
  await env.DB.prepare("INSERT INTO audit_log(event_id,actor,actor_vk_user_id,action,target_type,target_id,details_json,created_at) VALUES((SELECT id FROM events WHERE active=1 ORDER BY id DESC LIMIT 1),?,?,?,?,?,?,?)")
    .bind(actor, actor, action, type, String(target), JSON.stringify(details), now()).run();
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
  if (isAdmin(uid, env)) return "admin";
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
  const admin = isAdmin(uid, env);
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
  if (!event || (event.status !== "active" && !isAdmin(uid, env))) return fail("This event page is unavailable or archived.", 404);
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

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "vk-eventhub-cloudflare" });
  if (path === "/api/role" && method === "POST") return roleApi(request, env);
  if (path === "/api/event_details" && method === "POST") return eventDetailsApi(request, env);
  if (path === "/api/register" && method === "POST") return registerApi(request, env);
  if (path === "/api/my_pass" && method === "POST") return myPassApi(request, env);

  if (path === "/api/bootstrap" && method === "GET") {
    const uid = await requireUser(request, env);
    const event = await activeEvent(env);
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE event_id=? AND vk_user_id=?").bind(event.id, uid).first();
    const scanRows = guest ? await env.DB.prepare("SELECT stage,scanned_at FROM scans WHERE guest_id=?").bind(guest.id).all() : { results: [] };
    const volunteer = await env.DB.prepare("SELECT 1 AS ok FROM volunteers WHERE vk_user_id=? AND active=1").bind(uid).first();
    const safeEvent = { ...event, food_enabled: asBool(event.food_enabled) };
    return json({
      user: { vk_user_id: uid, is_admin: isAdmin(uid, env), is_volunteer: isAdmin(uid, env) || !!volunteer },
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
