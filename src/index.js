// The Cloudflare Worker. It receives the material list from the phone and writes it
// to the Smartsheet sheet "Lagerbestand – Inventory" (one row per material).
// The Smartsheet API token stays secret here and never goes to the phone.
//
// Two secrets are needed (Cloudflare → site-inventory → Settings → Variables and Secrets):
//   SMARTSHEET_TOKEN  your Smartsheet API token
//   APP_PIN           the PIN you type in the app settings; without it nobody can change the sheet

const API = "https://api.smartsheet.com/2.0";
const SHEET_NAME = "Lagerbestand – Inventory";

// The sheet's columns. "key" is the field the phone sends for each material.
// The last column links a row to the material on the phone; do not edit it in Smartsheet.
const COLUMNS = [
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
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      const denied = checkPin(request, env);
      if (denied) return denied;
      try {
        const body = await request.json();
        const result = await syncSheet(env, body.rows);
        return Response.json({ ok: true, ...result });
      } catch (e) {
        return Response.json({ error: e.message }, { status: e.status || 502 });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Anything else: the app files from /public.
    return env.ASSETS.fetch(request);
  },
};

// ---------- PIN check ----------

function checkPin(request, env) {
  if (!env.SMARTSHEET_TOKEN || !env.APP_PIN) {
    return Response.json(
      { error: "Smartsheet ist in Cloudflare noch nicht eingerichtet. / Smartsheet is not set up in Cloudflare yet." },
      { status: 503 },
    );
  }
  if (!sameText(request.headers.get("X-App-Pin") || "", env.APP_PIN)) {
    return Response.json({ error: "PIN falsch / Wrong PIN" }, { status: 401 });
  }
  return null;
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

async function smartsheet(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${env.SMARTSHEET_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Smartsheet: ${data.message || res.statusText} (${res.status})`);
    err.status = 502;
    throw err;
  }
  return data;
}

// Finds the sheet by its name, or creates it the first time.
let cachedSheetId = null;
async function sheetId(env) {
  if (cachedSheetId) return cachedSheetId;
  const list = await smartsheet(env, "GET", "/sheets?includeAll=true");
  const found = (list.data || []).find((s) => s.name === SHEET_NAME);
  if (found) {
    cachedSheetId = found.id;
  } else {
    const created = await smartsheet(env, "POST", "/sheets", {
      name: SHEET_NAME,
      columns: COLUMNS.map((c) => ({ title: c.title, type: c.type, ...(c.primary ? { primary: true } : {}) })),
    });
    cachedSheetId = created.result.id;
  }
  return cachedSheetId;
}

// Text Smartsheet would show for a value, to see whether a cell really changed.
const same = (a, b, type) =>
  type === "CHECKBOX" ? Boolean(a) === Boolean(b) : String(a ?? "") === String(b ?? "");

// Makes the sheet match the phone: updates changed rows, adds new ones,
// and removes rows of materials deleted on the phone. Rows someone typed
// into Smartsheet by hand (no App-ID) are left alone.
async function syncSheet(env, rows) {
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== "string" || !r.id)) {
    const err = new Error("Ungültige Daten / Invalid data");
    err.status = 400;
    throw err;
  }

  const id = await sheetId(env);
  let sheet;
  try {
    sheet = await smartsheet(env, "GET", `/sheets/${id}`);
  } catch (e) {
    cachedSheetId = null; // the sheet may have been deleted; look it up again next time
    throw e;
  }

  // Column ids by title; add any column that is missing (new in an app update, or deleted by mistake),
  // one at a time at its usual place.
  const colId = Object.fromEntries(sheet.columns.map((c) => [c.title, c.id]));
  let count = sheet.columns.length;
  for (const [pos, c] of COLUMNS.entries()) {
    if (colId[c.title]) continue;
    const added = await smartsheet(env, "POST", `/sheets/${id}/columns`, [
      { title: c.title, type: c.type, index: Math.min(pos, count) },
    ]);
    colId[c.title] = [].concat(added.result)[0].id;
    count++;
  }

  // What is in the sheet now, by App-ID
  const idCol = colId[COLUMNS.at(-1).title];
  const existing = new Map();
  for (const row of sheet.rows || []) {
    const values = Object.fromEntries((row.cells || []).map((c) => [c.columnId, c.value]));
    const appId = values[idCol];
    if (appId) existing.set(String(appId), { rowId: row.id, values });
  }

  const toAdd = [];
  const toUpdate = [];
  for (const r of rows) {
    const old = existing.get(r.id);
    const cells = COLUMNS.map((c) => ({ columnId: colId[c.title], value: cellValue(r[c.key], c.type) }));
    if (!old) {
      toAdd.push({ toBottom: true, cells: cells.filter((c) => c.value !== "") });
    } else {
      const changed = cells.filter((cell, i) => !same(old.values[cell.columnId], cell.value, COLUMNS[i].type));
      if (changed.length) toUpdate.push({ id: old.rowId, cells: changed });
    }
  }

  // Safety: an empty list from the phone (e.g. a new phone) never empties the sheet.
  const phoneIds = new Set(rows.map((r) => r.id));
  const toDelete = rows.length === 0 ? [] : [...existing].filter(([appId]) => !phoneIds.has(appId)).map(([, e]) => e.rowId);

  for (const part of chunks(toUpdate, 200)) await smartsheet(env, "PUT", `/sheets/${id}/rows`, part);
  for (const part of chunks(toAdd, 200)) await smartsheet(env, "POST", `/sheets/${id}/rows`, part);
  for (const part of chunks(toDelete, 100)) {
    await smartsheet(env, "DELETE", `/sheets/${id}/rows?ids=${part.join(",")}&ignoreRowsNotFound=true`);
  }

  return {
    added: toAdd.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    sheetUrl: sheet.permalink || "",
  };
}

// Numbers stay numbers, everything else becomes text; empty clears the cell.
function cellValue(v, type) {
  if (type === "CHECKBOX") return Boolean(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return v === null || v === undefined ? "" : String(v).slice(0, 4000);
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
