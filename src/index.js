// The Cloudflare Worker. It keeps two Smartsheet sheets, one row per record:
//   "Lagerbestand – Inventory"   the stock, sent from your phone (one row per material)
//   "Anforderungen – Requests"   material requests from teams (one row per requested material)
// The Smartsheet API token stays secret here and never goes to a phone.
//
// Secrets (Cloudflare → site-inventory → Settings → Variables and Secrets):
//   SMARTSHEET_TOKEN  your Smartsheet API token
//   APP_PIN           your PIN; only with it can stock be changed and requests approved
//   TEAM_PIN          the code you give to the teams so they can send requests

// Smartsheet has separate servers for US accounts (app.smartsheet.com) and EU accounts
// (app.smartsheet.eu). A token only works on its own server, so the Worker tries both.
const APIS = ["https://api.smartsheet.com/2.0", "https://api.smartsheet.eu/2.0"];
let api = null; // the server that last accepted the token

// Each sheet: its name and columns. "key" is the field name used in the code.
// The last column links a row to the app; do not edit it in Smartsheet.
const INVENTORY = {
  name: "Lagerbestand – Inventory",
  columns: [
    { key: "no", title: "Art.-Nr. / Item no.", type: "TEXT_NUMBER", primary: true },
    { key: "ugg", title: "UGG-Code", type: "TEXT_NUMBER" },
    { key: "name", title: "Bezeichnung / Name", type: "TEXT_NUMBER" },
    { key: "category", title: "Kategorie / Category", type: "TEXT_NUMBER" },
    { key: "stock", title: "Bestand / Stock", type: "TEXT_NUMBER" },
    { key: "unit", title: "Einheit / Unit", type: "TEXT_NUMBER" },
    { key: "min", title: "Mindestbestand / Min. stock", type: "TEXT_NUMBER" },
    { key: "low", title: "Unter Minimum / Below min.", type: "CHECKBOX" },
    { key: "updated", title: "Letzte Änderung / Last change", type: "TEXT_NUMBER" },
    { key: "last", title: "Letzte Bewegung / Last move", type: "TEXT_NUMBER" },
    { key: "note", title: "Notiz / Note", type: "TEXT_NUMBER" },
    { key: "id", title: "App-ID (nicht ändern / do not edit)", type: "TEXT_NUMBER" },
  ],
};

const REQUESTS = {
  name: "Anforderungen – Requests",
  columns: [
    { key: "request", title: "Anforderung / Request", type: "TEXT_NUMBER", primary: true },
    { key: "date", title: "Datum / Date", type: "TEXT_NUMBER" },
    { key: "team", title: "Team", type: "TEXT_NUMBER" },
    { key: "person", title: "Besteller / Requested by", type: "TEXT_NUMBER" },
    { key: "no", title: "Art.-Nr. / Item no.", type: "TEXT_NUMBER" },
    { key: "name", title: "Material", type: "TEXT_NUMBER" },
    { key: "qty", title: "Menge / Qty", type: "TEXT_NUMBER" },
    { key: "unit", title: "Einheit / Unit", type: "TEXT_NUMBER" },
    { key: "note", title: "Notiz / Note", type: "TEXT_NUMBER" },
    { key: "status", title: "Status", type: "TEXT_NUMBER" },
    { key: "approved", title: "Genehmigte Menge / Approved qty", type: "TEXT_NUMBER" },
    { key: "decided", title: "Entschieden / Decided", type: "TEXT_NUMBER" },
    { key: "reason", title: "Grund / Reason", type: "TEXT_NUMBER" },
    { key: "id", title: "Zeilen-ID (nicht ändern / do not edit)", type: "TEXT_NUMBER" },
  ],
};

const OPEN = "Offen / Open";
const APPROVED = "Genehmigt / Approved";
const DENIED = "Abgelehnt / Denied";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request); // the app files from /public

    try {
      // Your phone (needs APP_PIN)
      if (route === "POST /api/sync") {
        checkPin(request, env, "manager");
        return Response.json({ ok: true, ...(await syncInventory(env, (await request.json()).rows)) });
      }
      if (route === "GET /api/requests/open") {
        checkPin(request, env, "manager");
        return Response.json({ requests: await listRequests(env, { openOnly: true }) });
      }
      if (route === "POST /api/requests/decide") {
        checkPin(request, env, "manager");
        return Response.json({ ok: true, ...(await decideRequest(env, await request.json())) });
      }

      // The teams' request page (needs TEAM_PIN, or your APP_PIN)
      if (route === "GET /api/materials") {
        checkPin(request, env, "team");
        return Response.json({ materials: await listMaterials(env) });
      }
      if (route === "POST /api/requests") {
        checkPin(request, env, "team");
        return Response.json({ ok: true, ...(await createRequest(env, await request.json())) });
      }
      if (route === "GET /api/requests") {
        checkPin(request, env, "team");
        const team = (url.searchParams.get("team") || "").trim();
        return Response.json({ requests: (await listRequests(env, { team })).slice(0, 20) });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (e) {
      return Response.json({ error: e.message }, { status: e.status || 502 });
    }
  },
};

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

// ---------- PIN check ----------

// "manager" needs APP_PIN. "team" accepts TEAM_PIN or APP_PIN.
function checkPin(request, env, who) {
  if (!token(env) || !env.APP_PIN || (who === "team" && !env.TEAM_PIN)) {
    fail(503, "In Cloudflare noch nicht eingerichtet. / Not set up in Cloudflare yet.");
  }
  const appPin = request.headers.get("X-App-Pin") || "";
  if (appPin && sameText(appPin, env.APP_PIN)) return;
  if (who === "team" && sameText(request.headers.get("X-Team-Pin") || "", env.TEAM_PIN)) return;
  fail(401, who === "team" ? "Team-Code falsch / Wrong team code" : "PIN falsch / Wrong PIN");
}

// Compares two texts without leaking (by timing) how many characters matched.
function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------- Smartsheet ----------

// The token as pasted in Cloudflare, without spaces, quotes or "Bearer " around it.
function token(env) {
  return String(env.SMARTSHEET_TOKEN || "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

async function smartsheet(env, method, path, body) {
  // The server that worked last time first, then the other one.
  // A refused token (401) means nothing was done, so trying the other server is safe.
  for (const base of api ? [api, ...APIS.filter((b) => b !== api)] : APIS) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token(env)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) continue;
    if (!res.ok) fail(502, `Smartsheet: ${data.message || res.statusText} (${res.status})`);
    api = base;
    return data;
  }
  fail(
    502,
    "Smartsheet: Token ungültig – in Smartsheet einen neuen API-Token erstellen und in Cloudflare als SMARTSHEET_TOKEN eintragen. " +
      "/ Token invalid – create a new API token in Smartsheet and save it in Cloudflare as SMARTSHEET_TOKEN. (401)",
  );
}

// Finds a sheet by its name, or creates it the first time.
const sheetIds = {};
async function sheetId(env, def) {
  if (sheetIds[def.name]) return sheetIds[def.name];
  const list = await smartsheet(env, "GET", "/sheets?includeAll=true");
  const found = (list.data || []).find((s) => s.name === def.name);
  if (found) {
    sheetIds[def.name] = found.id;
  } else {
    const created = await smartsheet(env, "POST", "/sheets", {
      name: def.name,
      columns: def.columns.map((c) => ({ title: c.title, type: c.type, ...(c.primary ? { primary: true } : {}) })),
    });
    sheetIds[def.name] = created.result.id;
  }
  return sheetIds[def.name];
}

// Reads a sheet. Returns { id, permalink, colId: {key: columnId}, rows: [{ rowId, v: {key: value} }] }.
// Adds any column that is missing (new in an app update, or deleted by mistake) at its usual place.
async function openSheet(env, def) {
  const id = await sheetId(env, def);
  let sheet;
  try {
    sheet = await smartsheet(env, "GET", `/sheets/${id}`);
  } catch (e) {
    delete sheetIds[def.name]; // the sheet may have been deleted; look it up again next time
    throw e;
  }
  const byTitle = Object.fromEntries(sheet.columns.map((c) => [c.title, c.id]));
  let count = sheet.columns.length;
  for (const [pos, c] of def.columns.entries()) {
    if (byTitle[c.title]) continue;
    const added = await smartsheet(env, "POST", `/sheets/${id}/columns`, [
      { title: c.title, type: c.type, index: Math.min(pos, count) },
    ]);
    byTitle[c.title] = [].concat(added.result)[0].id;
    count++;
  }
  const colId = Object.fromEntries(def.columns.map((c) => [c.key, byTitle[c.title]]));
  const keyOf = Object.fromEntries(def.columns.map((c) => [byTitle[c.title], c.key]));
  const rows = (sheet.rows || []).map((row) => {
    const v = {};
    for (const cell of row.cells || []) if (keyOf[cell.columnId]) v[keyOf[cell.columnId]] = cell.value;
    return { rowId: row.id, v };
  });
  return { id, permalink: sheet.permalink || "", colId, rows };
}

// Cells for a row: [{ columnId, value }] for the given keys.
const cellsOf = (def, s, data, keys) =>
  def.columns
    .filter((c) => keys.includes(c.key))
    .map((c) => ({ columnId: s.colId[c.key], value: cellValue(data[c.key], c.type) }));

// Numbers stay numbers, everything else becomes text; empty clears the cell.
function cellValue(v, type) {
  if (type === "CHECKBOX") return Boolean(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return v === null || v === undefined ? "" : String(v).slice(0, 4000);
}

// Text Smartsheet would show for a value, to see whether a cell really changed.
const same = (a, b, type) =>
  type === "CHECKBOX" ? Boolean(a) === Boolean(b) : String(a ?? "") === String(b ?? "");

const text = (v) => (v === null || v === undefined ? "" : String(v));

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Date and time in Germany, e.g. "10.10.2026 19:53"
const berlinTime = () =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date()).replace(",", "");

// ---------- Inventory sheet ----------

// Makes the sheet match the phone: updates changed rows, adds new ones,
// and removes rows of materials deleted on the phone. Rows someone typed
// into Smartsheet by hand (no App-ID) are left alone.
async function syncInventory(env, rows) {
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== "string" || !r.id)) {
    fail(400, "Ungültige Daten / Invalid data");
  }
  const s = await openSheet(env, INVENTORY);
  const keys = INVENTORY.columns.map((c) => c.key);
  const existing = new Map(s.rows.filter((r) => r.v.id).map((r) => [text(r.v.id), r]));

  const toAdd = [];
  const toUpdate = [];
  for (const r of rows) {
    const old = existing.get(r.id);
    const cells = cellsOf(INVENTORY, s, r, keys);
    if (!old) {
      toAdd.push({ toBottom: true, cells: cells.filter((c) => c.value !== "") });
    } else {
      const changed = cells.filter((cell, i) => !same(old.v[keys[i]], cell.value, INVENTORY.columns[i].type));
      if (changed.length) toUpdate.push({ id: old.rowId, cells: changed });
    }
  }

  // Safety: an empty list from the phone (e.g. a new phone) never empties the sheet.
  const phoneIds = new Set(rows.map((r) => r.id));
  const toDelete = rows.length === 0 ? [] : [...existing].filter(([appId]) => !phoneIds.has(appId)).map(([, e]) => e.rowId);

  for (const part of chunks(toUpdate, 200)) await smartsheet(env, "PUT", `/sheets/${s.id}/rows`, part);
  for (const part of chunks(toAdd, 200)) await smartsheet(env, "POST", `/sheets/${s.id}/rows`, part);
  for (const part of chunks(toDelete, 100)) {
    await smartsheet(env, "DELETE", `/sheets/${s.id}/rows?ids=${part.join(",")}&ignoreRowsNotFound=true`);
  }
  return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length, sheetUrl: s.permalink };
}

// The materials the teams can request, with current stock (as last sent by your phone).
async function listMaterials(env) {
  const s = await openSheet(env, INVENTORY);
  return s.rows
    .filter((r) => r.v.id && r.v.no && r.v.name)
    .map((r) => ({
      no: text(r.v.no),
      ugg: text(r.v.ugg),
      name: text(r.v.name),
      category: text(r.v.category),
      unit: text(r.v.unit),
      stock: Number(r.v.stock) || 0,
    }))
    .sort((a, b) => a.category.localeCompare(b.category, "de") || a.name.localeCompare(b.name, "de"));
}

// ---------- Requests sheet ----------

// A team sends a request: { team, person, note, lines: [{ no, qty }] }
async function createRequest(env, body) {
  const team = text(body.team).trim().slice(0, 60);
  const person = text(body.person).trim().slice(0, 60);
  const note = text(body.note).trim().slice(0, 300);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!team) fail(400, "Bitte Team angeben. / Please enter the team.");
  if (!lines.length || lines.length > 50) fail(400, "Bitte Material auswählen. / Please choose materials.");

  const materials = new Map((await listMaterials(env)).map((m) => [m.no, m]));
  const rows = lines.map((l) => {
    const m = materials.get(text(l.no));
    const qty = Number(l.qty);
    if (!m) fail(400, `Unbekanntes Material / Unknown material: ${text(l.no)}`);
    if (!Number.isFinite(qty) || qty <= 0) fail(400, `Menge ungültig / Invalid quantity: ${m.name}`);
    return { no: m.no, name: m.name, unit: m.unit, qty };
  });

  // Request number, e.g. ANF-261010-K7Q2
  const d = berlinTime(); // "10.10.2026 19:53"
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  const request = `ANF-${d.slice(8, 10)}${d.slice(3, 5)}${d.slice(0, 2)}-${random}`;

  const s = await openSheet(env, REQUESTS);
  const keys = REQUESTS.columns.map((c) => c.key);
  const newRows = rows.map((r) => ({
    toBottom: true,
    cells: cellsOf(REQUESTS, s, { ...r, request, date: d, team, person, note, status: OPEN, id: crypto.randomUUID() }, keys)
      .filter((c) => c.value !== ""),
  }));
  await smartsheet(env, "POST", `/sheets/${s.id}/rows`, newRows);
  return { request };
}

// Requests grouped: [{ request, date, team, person, note, status, decided, reason, lines: [...] }], newest first.
async function listRequests(env, { openOnly = false, team = "" } = {}) {
  const s = await openSheet(env, REQUESTS);
  const groups = new Map();
  for (const { rowId, v } of s.rows) {
    const id = text(v.request);
    if (!id || !v.id) continue;
    if (team && text(v.team).trim().toLowerCase() !== team.toLowerCase()) continue;
    if (!groups.has(id)) {
      groups.set(id, {
        request: id, date: text(v.date), team: text(v.team), person: text(v.person), note: text(v.note),
        status: text(v.status) || OPEN, decided: text(v.decided), reason: text(v.reason), lines: [],
      });
    }
    groups.get(id).lines.push({
      rowId, lineId: text(v.id), no: text(v.no), name: text(v.name), unit: text(v.unit),
      qty: Number(v.qty) || 0, approved: v.approved === undefined || v.approved === "" ? null : Number(v.approved),
    });
  }
  const list = [...groups.values()].reverse();
  return openOnly ? list.filter((r) => r.status === OPEN) : list;
}

// You approve or deny: { request, decision: "approve" | "deny", lines: [{ lineId, qty }], reason }
async function decideRequest(env, body) {
  const all = await listRequests(env, {});
  const req = all.find((r) => r.request === text(body.request));
  if (!req) fail(404, "Anforderung nicht gefunden / Request not found");
  if (req.status !== OPEN) fail(409, `Schon entschieden: ${req.status} / Already decided`);
  const approve = body.decision === "approve";
  if (!approve && body.decision !== "deny") fail(400, "Ungültige Entscheidung / Invalid decision");

  const qtyOf = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [text(l.lineId), Number(l.qty)]));
  const decided = berlinTime();
  const s = await openSheet(env, REQUESTS);
  const updates = req.lines.map((l) => {
    const qty = approve ? (qtyOf.has(l.lineId) ? qtyOf.get(l.lineId) : l.qty) : 0;
    if (!Number.isFinite(qty) || qty < 0) fail(400, `Menge ungültig / Invalid quantity: ${l.name}`);
    return {
      id: l.rowId,
      cells: cellsOf(REQUESTS, s, {
        status: approve ? APPROVED : DENIED, approved: qty, decided, reason: text(body.reason).trim().slice(0, 300),
      }, ["status", "approved", "decided", "reason"]),
    };
  });
  for (const part of chunks(updates, 200)) await smartsheet(env, "PUT", `/sheets/${s.id}/rows`, part);
  return { status: approve ? APPROVED : DENIED };
}
