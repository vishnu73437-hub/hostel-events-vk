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

async function authenticate(request, env) {
  const raw = request.headers.get("X-VK-Launch-Params");
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
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.VK_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedParams)));
  const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (!safeEqual(expected, sign)) throw new Error("VK launch signature verification failed.");
  const ts = Number(params.get("vk_ts"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 3600) throw new Error("VK launch parameters expired. Reopen the app.");
  return uid;
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
  const event = await env.DB.prepare("SELECT * FROM events WHERE active=1 ORDER BY id LIMIT 1").first();
  if (!event) throw Object.assign(new Error("No active event configured."), { status: 404 });
  return event;
}
async function audit(env, actor, action, type, target, details = {}) {
  await env.DB.prepare("INSERT INTO audit_log(actor,action,target_type,target_id,details_json,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, type, String(target), JSON.stringify(details), now()).run();
}
async function outbox(env, eventId, guestId, action, payload) {
  await env.DB.prepare("INSERT INTO sheets_outbox(event_id,guest_id,action,payload_json,created_at) VALUES(?,?,?,?,?)")
    .bind(eventId, guestId, action, JSON.stringify(payload), now()).run();
}
async function body(request) {
  try { return await request.json(); } catch { throw Object.assign(new Error("Invalid JSON body."), { status: 400 }); }
}
const asGuest = row => row ? { ...row } : null;

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "vk-eventhub-cloudflare" });

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
