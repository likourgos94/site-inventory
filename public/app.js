// Site Inventory: the material in the warehouse (Lager) and how much is left.
// Everything is stored on the phone (IndexedDB), so it works without signal.
// No history is kept: each material remembers only its current stock and its last change.

// ---------- Fixed texts (German / English) ----------

const ACTIONS = {
  in: { title: "Wareneingang / Arrival", sign: +1, textLabel: "Lieferschein / Delivery note (optional)" },
  issue: { title: "Ausgabe an Team / Issue to team", sign: -1, textLabel: "Adresse / Bereich – Address / area (optional)" },
  transfer: { title: "Umlagerung / Transfer", sign: 0, textLabel: "Von / Nach – From / To (optional)" },
  set: { title: "Bestand setzen / Set amount", sign: 0, textLabel: "Notiz / Note (optional)" },
};

// Short text for "last change", e.g. "Ausgabe / Issue −50 m · Team Müller"
const LAST_NAMES = {
  new: "Neu angelegt / Created",
  in: "Wareneingang / Arrival",
  issue: "Ausgabe / Issue",
  "transfer-in": "Umlagerung rein / Transfer in",
  "transfer-out": "Umlagerung raus / Transfer out",
  set: "Bestand gesetzt / Amount set",
};

// ---------- Storage on the phone (IndexedDB) ----------

const db = {
  _open: null,
  open() {
    if (!this._open) {
      this._open = new Promise((resolve, reject) => {
        const req = indexedDB.open("site-inventory", 1);
        req.onupgradeneeded = () => {
          const conn = req.result;
          // One entry per material: { id, no, name, category, unit, stock, min, note, updatedAt, last }
          conn.createObjectStore("materials", { keyPath: "id" });
          conn.createObjectStore("settings");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this._open;
  },
  async run(store, mode, action) {
    const conn = await this.open();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(store, mode);
      const req = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  allMaterials: () => db.run("materials", "readonly", (s) => s.getAll()),
  putMaterial: (m) => db.run("materials", "readwrite", (s) => s.put(m)),
  deleteMaterial: (id) => db.run("materials", "readwrite", (s) => s.delete(id)),
  getSettings: () => db.run("settings", "readonly", (s) => s.get("main")),
  putSettings: (v) => db.run("settings", "readwrite", (s) => s.put(v, "main")),
};

function defaultSettings() {
  return {
    warehouse: "Lager Lahnau (LAHLU01)",
    teams: [],
    categories: [
      "Kabel / Cable",
      "Rohr / Duct",
      "Verbinder / Connector",
      "Hauseinführung / House entry",
      "HÜP / APL",
      "Verteiler / Cabinet",
      "Schacht / Manhole",
      "Muffe / Closure",
      "Patchkabel / Patch cord",
      "Endgerät / CPE",
      "Kennzeichnung / Marking",
      "Werkzeug / Tool",
      "Sonstiges / Other",
    ],
    units: ["Stk.", "m", "Rolle", "Karton", "kg"],
    pin: "", // the APP_PIN set in Cloudflare; lets this phone write to Smartsheet
  };
}

// ---------- Small helpers ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ISO time -> "10.10.2026 14:05"
function fmtDateTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 1250.5 -> "1.250,5" (German style)
const fmtQty = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { maximumFractionDigits: 3 }) : "–");

// What you typed -> number. Accepts "12", "12,5", "12.5", "1.250" and "1.250,5".
// Returns null for an empty field and NaN for something that is not a number.
function parseQty(text) {
  let s = String(text || "").trim().replace(/\s/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // "1.250" = one thousand two hundred fifty
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

// Avoids 0.1 + 0.2 = 0.30000000000000004
const round = (n) => Math.round(n * 1000) / 1000;

const isLow = (m) => m.min !== null && m.min !== undefined && m.stock < m.min;

function lastText(m) {
  if (!m.last) return "";
  const l = m.last;
  let s = LAST_NAMES[l.kind] || "";
  if (l.kind === "set") s += ` ${fmtQty(l.before)} → ${fmtQty(l.after)} ${m.unit}`;
  else if (l.kind !== "new") s += ` ${l.qty > 0 ? "+" : "−"}${fmtQty(Math.abs(l.qty))} ${m.unit}`;
  if (l.team) s += ` · ${l.team}`;
  if (l.text) s += ` · ${l.text}`;
  return s;
}

let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

// Next free item number, e.g. MAT-0013
function nextNo() {
  let max = 0;
  for (const m of materials) {
    const match = /^MAT-(\d+)$/.exec(m.no || "");
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `MAT-${String(max + 1).padStart(4, "0")}`;
}

// ---------- App state ----------

let settings = defaultSettings();
let materials = []; // all materials, kept in memory and saved to the phone on every change
let current = null; // the material that is open
let action = null; // "in" | "issue" | "transfer" | "set" while the move form is open
let transferDir = "in";
let view = "list";

// ---------- Views ----------

function show(next) {
  view = next;
  for (const v of ["list", "item", "edit", "settings", "requests"]) $(`#view-${v}`).hidden = v !== next;
  $("#btn-back").hidden = next === "list";
  $("#btn-settings").hidden = next !== "list";
  $("#title").textContent =
    next === "item" ? "Material" :
    next === "edit" ? (current ? "Angaben / Details" : "Neues Material / New material") :
    next === "settings" ? "Einstellungen / Settings" :
    next === "requests" ? "Anforderungen / Requests" :
    settings.warehouse || "Lager / Warehouse";
  window.scrollTo(0, 0);
}

function sortMaterials(list) {
  const order = (cat) => {
    const i = settings.categories.indexOf(cat);
    return i === -1 ? 999 : i;
  };
  return list.sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name, "de"));
}

// ---------- 1) Material list ----------

function renderCategoryFilter() {
  const sel = $("#filter-cat");
  const chosen = sel.value;
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, "Alle / All"));
  const cats = [...settings.categories];
  for (const m of materials) if (m.category && !cats.includes(m.category)) cats.push(m.category);
  for (const c of cats) sel.append(el("option", { value: c }, c));
  sel.value = cats.includes(chosen) ? chosen : "";
}

function renderList() {
  const query = $("#search").value.trim().toLowerCase();
  const cat = $("#filter-cat").value;
  const lowOnly = $("#filter-low").checked;

  const shown = sortMaterials(
    materials.filter(
      (m) =>
        (!cat || m.category === cat) &&
        (!lowOnly || isLow(m)) &&
        (!query || `${m.no} ${m.ugg || ""} ${m.name} ${m.category} ${m.note || ""}`.toLowerCase().includes(query)),
    ),
  );

  const box = $("#material-list");
  box.innerHTML = "";
  let group = null;
  for (const m of shown) {
    if (m.category !== group) {
      group = m.category;
      box.append(el("div", { class: "group-title" }, group || "–"));
    }
    const btn = el("button", { class: `mat${isLow(m) ? " low" : ""}`, type: "button" });
    const left = el("div");
    left.append(el("div", { class: "name" }, m.name));
    left.append(el("div", { class: "meta" }, m.no + (m.ugg ? ` · ${m.ugg}` : "") + (isLow(m) ? ` · unter Minimum / below min. (${fmtQty(m.min)})` : "")));
    const qty = el("div", { class: "qty" }, fmtQty(m.stock) + " ");
    qty.append(el("small", {}, m.unit));
    btn.append(left, qty);
    btn.onclick = () => openItem(m.id);
    box.append(btn);
  }

  const low = materials.filter(isLow).length;
  $("#summary").textContent =
    materials.length === 0 ? "" :
    `${materials.length} Materialien / materials` +
    (low ? ` · ${low} unter Minimum / below minimum` : "") +
    (shown.length !== materials.length ? ` · ${shown.length} angezeigt / shown` : "");
  $("#empty-hint").hidden = materials.length > 0;
}

// ---------- 2) One material ----------

function openItem(id) {
  current = materials.find((m) => m.id === id);
  closeMove();
  renderItem();
  show("item");
}

function renderItem() {
  const m = current;
  $("#i-no").textContent = m.no + (m.ugg ? ` · UGG ${m.ugg}` : "");
  $("#i-cat").textContent = m.category || "–";
  $("#i-name").textContent = m.name;
  const stock = $("#i-stock");
  stock.textContent = fmtQty(m.stock) + " ";
  stock.append(el("small", {}, m.unit));
  stock.classList.toggle("low", isLow(m));
  $("#i-min").textContent =
    m.min === null || m.min === undefined ? "" :
    `Mindestbestand / Min. stock: ${fmtQty(m.min)} ${m.unit}` + (isLow(m) ? " – nachbestellen! / reorder!" : "");
  $("#i-last").textContent = m.last ? `Letzte Änderung / Last change: ${fmtDateTime(m.updatedAt)} · ${lastText(m)}` : "";
  $("#i-note").textContent = m.note ? `Notiz / Note: ${m.note}` : "";
}

function openMove(kind) {
  action = kind;
  transferDir = "in";
  const a = ACTIONS[kind];
  for (const b of $$(".act")) b.classList.toggle("selected", b.dataset.act === kind);
  $("#m-title").textContent = a.title;
  $("#m-dir-row").hidden = kind !== "transfer";
  $("#m-team-row").hidden = kind !== "issue";
  $("#m-qty-label").textContent = kind === "set" ? "Gezählter Bestand / Counted amount" : "Menge / Quantity";
  $("#m-text-label").textContent = a.textLabel;
  $("#m-unit").textContent = current.unit;
  $("#m-qty").value = kind === "set" ? String(current.stock).replace(".", ",") : "";
  $("#m-team").value = "";
  $("#m-text").value = "";
  $("#m-error").hidden = true;
  renderDir();
  updatePreview();
  $("#move").hidden = false;
  $("#m-qty").focus();
  $("#move").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeMove() {
  action = null;
  $("#move").hidden = true;
  for (const b of $$(".act")) b.classList.remove("selected");
}

function renderDir() {
  for (const b of $$("#m-dir-row button")) b.classList.toggle("on", b.dataset.dir === transferDir);
}

// Works out the new stock from the form. Returns { qty, after } or { error }.
function computeMove() {
  const qty = parseQty($("#m-qty").value);
  if (qty === null) return { error: "" };
  if (Number.isNaN(qty)) return { error: "Bitte eine Zahl eingeben. / Please enter a number." };
  const before = current.stock;
  if (action === "set") return { qty: round(qty - before), after: round(qty) };
  if (qty === 0) return { error: "Menge muss größer als 0 sein. / Quantity must be more than 0." };
  const sign = action === "transfer" ? (transferDir === "in" ? 1 : -1) : ACTIONS[action].sign;
  const after = round(before + sign * qty);
  if (after < 0) {
    return { error: `Nicht genug auf Lager (nur ${fmtQty(before)} ${current.unit}). / Not enough in stock.` };
  }
  return { qty: sign * qty, after };
}

function updatePreview() {
  const r = computeMove();
  const p = $("#m-preview");
  p.textContent = "";
  if (r.after !== undefined) {
    p.append(`Neuer Bestand / New stock: ${fmtQty(current.stock)} → `);
    p.append(el("b", {}, `${fmtQty(r.after)} ${current.unit}`));
  }
  $("#m-error").hidden = !r.error;
  $("#m-error").textContent = r.error || "";
}

async function saveMove() {
  const r = computeMove();
  if (r.after === undefined) {
    $("#m-error").textContent = r.error || "Bitte Menge eingeben. / Please enter a quantity.";
    $("#m-error").hidden = false;
    return;
  }
  const team = $("#m-team").value.trim();
  if (action === "issue" && !team) {
    $("#m-error").textContent = "Bitte Team eingeben. / Please enter the team.";
    $("#m-error").hidden = false;
    return;
  }

  const kind = action === "transfer" ? `transfer-${transferDir}` : action;
  current.last = {
    kind,
    qty: r.qty,
    before: current.stock,
    after: r.after,
    team: action === "issue" ? team : "",
    text: $("#m-text").value.trim(),
  };
  current.stock = r.after;
  current.updatedAt = new Date().toISOString();
  await db.putMaterial(current);
  scheduleSync();

  if (team && !settings.teams.includes(team)) {
    settings.teams.push(team);
    await saveSettings();
  }

  toast(`Gespeichert / Saved: ${fmtQty(current.stock)} ${current.unit}`);
  closeMove();
  renderItem();
  renderList();
}

// ---------- 3) New material / edit details ----------

function fillSelect(sel, values, chosen) {
  sel.innerHTML = "";
  const all = [...values];
  if (chosen && !all.includes(chosen)) all.push(chosen);
  for (const v of all) sel.append(el("option", { value: v }, v));
  sel.value = chosen || all[0] || "";
}

function openEdit(isNew) {
  if (isNew) current = null;
  const m = current;
  $("#e-no").value = m ? m.no : nextNo();
  $("#e-ugg").value = m ? m.ugg || "" : "";
  $("#e-name").value = m ? m.name : "";
  $("#e-suggest").hidden = true;
  fillSelect($("#e-cat"), settings.categories, m && m.category);
  fillSelect($("#e-unit"), settings.units, m && m.unit);
  // Stock is only typed here for a new material; afterwards use the four actions.
  $("#e-stock-row").hidden = !!m;
  $("#e-stock").value = "";
  $("#e-min").value = m && m.min !== null && m.min !== undefined ? String(m.min).replace(".", ",") : "";
  $("#e-note").value = m ? m.note || "" : "";
  $("#e-error").hidden = true;
  $("#e-delete").hidden = !m;
  show("edit");
  if (!m) $("#e-name").focus();
}

async function saveEdit() {
  const err = (text) => {
    $("#e-error").textContent = text;
    $("#e-error").hidden = false;
  };
  const name = $("#e-name").value.trim();
  const no = $("#e-no").value.trim();
  if (!name) return err("Bitte eine Bezeichnung eingeben. / Please enter a name.");
  if (!no) return err("Bitte eine Art.-Nr. eingeben. / Please enter an item no.");
  if (materials.some((x) => x.no.toLowerCase() === no.toLowerCase() && (!current || x.id !== current.id))) {
    return err(`Art.-Nr. ${no} gibt es schon. / Item no. ${no} already exists.`);
  }
  const min = parseQty($("#e-min").value);
  if (Number.isNaN(min)) return err("Mindestbestand: bitte eine Zahl. / Min. stock: please enter a number.");

  if (current) {
    Object.assign(current, {
      no, name, min,
      ugg: $("#e-ugg").value.trim(),
      category: $("#e-cat").value,
      unit: $("#e-unit").value,
      note: $("#e-note").value.trim(),
    });
    await db.putMaterial(current);
    scheduleSync();
    renderItem();
    renderList();
    show("item");
    return;
  }

  const stock = parseQty($("#e-stock").value);
  if (Number.isNaN(stock)) return err("Bestand: bitte eine Zahl. / Stock: please enter a number.");
  const now = new Date().toISOString();
  const m = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    no, name, min,
    ugg: $("#e-ugg").value.trim(),
    category: $("#e-cat").value,
    unit: $("#e-unit").value,
    stock: stock || 0,
    note: $("#e-note").value.trim(),
    createdAt: now,
    updatedAt: now,
    last: { kind: "new", qty: stock || 0, before: 0, after: stock || 0, team: "", text: "" },
  };
  materials.push(m);
  await db.putMaterial(m);
  scheduleSync();
  renderCategoryFilter();
  renderList();
  toast(`${m.name} angelegt / created`);
  openItem(m.id);
}

// While typing the name of a NEW material: matching catalog items (all typed words must match).
function renderSuggestions() {
  const box = $("#e-suggest");
  const words = $("#e-name").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  box.innerHTML = "";
  if (current || !words.length || words.join("").length < 2) {
    box.hidden = true;
    return;
  }
  const hits = CATALOG.filter((c) => {
    const text = `${c.no} ${c.ugg} ${c.name}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }).slice(0, 8);
  for (const c of hits) {
    const have = materials.find((m) => m.no === c.no);
    const btn = el("button", { type: "button" });
    btn.append(el("div", {}, c.name));
    const meta = el("div", { class: "meta" }, `Netceed ${c.no}` + (c.ugg ? ` · UGG ${c.ugg}` : "") + ` · ${c.category} · `);
    if (have) meta.append(el("span", { class: "have" }, "schon angelegt – öffnen / already added – open"));
    else meta.append(c.unit);
    btn.append(meta);
    btn.onclick = () => (have ? openItem(have.id) : pickCatalog(c));
    box.append(btn);
  }
  box.hidden = hits.length === 0;
}

function pickCatalog(c) {
  $("#e-name").value = c.name;
  $("#e-no").value = c.no;
  $("#e-ugg").value = c.ugg;
  fillSelect($("#e-cat"), settings.categories, c.category);
  fillSelect($("#e-unit"), settings.units, c.unit);
  $("#e-suggest").hidden = true;
  $("#e-stock").focus();
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm(`„${current.name}“ wirklich löschen? / Really delete “${current.name}”?`)) return;
  await db.deleteMaterial(current.id);
  materials = materials.filter((m) => m.id !== current.id);
  current = null;
  scheduleSync();
  renderCategoryFilter();
  renderList();
  show("list");
}

// ---------- 4) Settings ----------

// Once per phone: add the categories used by the catalog (before "Sonstiges / Other").
function addCatalogCategories() {
  for (const c of CATALOG.map((x) => x.category)) {
    if (settings.categories.includes(c)) continue;
    const other = settings.categories.indexOf("Sonstiges / Other");
    settings.categories.splice(other === -1 ? settings.categories.length : other, 0, c);
  }
  settings.catalogCategories = true;
  db.putSettings(settings);
}

const lines = (text) => [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];

function renderSettings() {
  $("#s-warehouse").value = settings.warehouse;
  $("#s-teams").value = settings.teams.join("\n");
  $("#s-categories").value = settings.categories.join("\n");
  $("#s-units").value = settings.units.join("\n");
  $("#s-pin").value = settings.pin || "";
  $("#s-request-link").textContent = requestLink();
  renderSyncStatus();
}

function renderTeams() {
  const list = $("#team-names");
  list.innerHTML = "";
  for (const t of settings.teams) list.append(el("option", { value: t }));
}

async function saveSettings() {
  await db.putSettings(settings);
  renderTeams();
}

function readSettingsForm() {
  settings.warehouse = $("#s-warehouse").value.trim();
  settings.teams = lines($("#s-teams").value);
  const cats = lines($("#s-categories").value);
  settings.categories = cats.length ? cats : defaultSettings().categories;
  const units = lines($("#s-units").value);
  settings.units = units.length ? units : defaultSettings().units;
  settings.pin = $("#s-pin").value.trim();
}

// ---------- Excel export ----------

// One material as the columns of the Excel file and of the Smartsheet sheet.
function materialRow(m) {
  return {
    id: m.id,
    no: m.no,
    ugg: m.ugg || "",
    name: m.name,
    category: m.category,
    stock: m.stock,
    unit: m.unit,
    min: m.min ?? "",
    low: isLow(m),
    updated: fmtDateTime(m.updatedAt),
    last: lastText(m),
    note: m.note || "",
  };
}

async function exportExcel() {
  const today = localDate(new Date());
  const blob = makeXlsx({
    sheetName: "Lagerbestand",
    columns: [
      { title: "Art.-Nr. / Item no.", width: 14 },
      { title: "UGG-Code", width: 16 },
      { title: "Bezeichnung / Name", width: 50 },
      { title: "Kategorie / Category", width: 22 },
      { title: "Bestand / Stock", width: 14 },
      { title: "Einheit / Unit", width: 10 },
      { title: "Mindestbestand / Min. stock", width: 14 },
      { title: "Unter Minimum / Below min.", width: 14 },
      { title: "Letzte Änderung / Last change", width: 18 },
      { title: "Letzte Bewegung / Last move", width: 44 },
      { title: "Notiz / Note", width: 24 },
    ],
    rows: sortMaterials([...materials])
      .map(materialRow)
      .map((r) => [r.no, r.ugg, r.name, r.category, r.stock, r.unit, r.min, r.low ? "JA / YES" : "", r.updated, r.last, r.note]),
  });
  await shareFile(blob, `Lagerbestand-${today}.xlsx`);
}

// ---------- Smartsheet ----------
// After every change the whole list is sent to the Worker, which updates the sheet.
// Without signal it waits and sends as soon as the phone is online again.

let syncTimer = null;
let syncing = false;
let changes = 0; // counts changes, so one made while sending is not marked as sent

function scheduleSync() {
  changes++;
  sync.dirty = true;
  saveSyncState();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

async function syncNow() {
  clearTimeout(syncTimer);
  if (syncing) return scheduleSync(); // try again when the running one is done
  if (!settings.pin) {
    sync.error = "PIN fehlt – in ⚙︎ eintragen / PIN missing – enter it in ⚙︎";
    return renderSyncStatus();
  }
  if (!navigator.onLine) {
    sync.error = "";
    return renderSyncStatus();
  }
  syncing = true;
  const sending = changes;
  renderSyncStatus();
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Pin": settings.pin },
      body: JSON.stringify({ rows: materials.map(materialRow) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fehler / Error ${res.status}`);
    sync.dirty = changes !== sending;
    sync.error = "";
    sync.lastOk = new Date().toISOString();
    if (data.sheetUrl) sync.sheetUrl = data.sheetUrl;
  } catch (e) {
    sync.error = e.message === "Failed to fetch" || e.message === "Load failed" ? "" : e.message;
  } finally {
    syncing = false;
    saveSyncState();
    renderSyncStatus();
  }
}

// { dirty, lastOk, error, sheetUrl } – kept on the phone so "not sent yet" survives closing the app
let sync = { dirty: false, lastOk: "", error: "", sheetUrl: "" };
const saveSyncState = () => db.run("settings", "readwrite", (s) => s.put(sync, "sync"));

function renderSyncStatus() {
  const text =
    syncing ? "Smartsheet: wird gesendet … / sending …" :
    sync.error ? (sync.error.startsWith("Smartsheet") ? sync.error : `Smartsheet: ${sync.error}`) :
    sync.dirty ? "Smartsheet: noch nicht gesendet (kein Netz?) / not sent yet (no signal?)" :
    sync.lastOk ? `Smartsheet: aktuell / up to date (${fmtDateTime(sync.lastOk)})` :
    "Smartsheet: noch nie gesendet / never sent";
  for (const node of $$(".sync-status")) {
    node.textContent = text;
    node.classList.toggle("bad", !!sync.error);
  }
  const link = $("#s-sheet-link");
  link.hidden = !sync.sheetUrl;
  if (sync.sheetUrl) link.href = sync.sheetUrl;
}

// ---------- Team requests ----------
// Teams send requests from /request.html. They wait in Smartsheet until you approve or deny here.
// Approving takes the approved amounts out of stock as "Issue to team".

let openRequests = [];

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-App-Pin": settings.pin || "" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Fehler / Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadRequests() {
  const status = $("#req-status");
  if (!settings.pin) {
    status.textContent = "PIN fehlt – in ⚙︎ eintragen / PIN missing – enter it in ⚙︎";
    return;
  }
  if (!navigator.onLine) {
    status.textContent = "Kein Netz – Anforderungen brauchen Internet. / No signal – requests need internet.";
    return;
  }
  status.textContent = "Wird geladen … / Loading …";
  try {
    openRequests = (await api("GET", "/api/requests/open")).requests;
    status.textContent = openRequests.length ? "" : "Keine offenen Anforderungen. / No open requests.";
  } catch (e) {
    status.textContent = e.message;
  }
  const badge = $("#req-badge");
  badge.textContent = openRequests.length;
  badge.hidden = openRequests.length === 0;
  renderRequests();
}

function materialByNo(no) {
  return materials.find((m) => String(m.no) === String(no));
}

function renderRequests() {
  const box = $("#req-list");
  box.innerHTML = "";
  for (const r of openRequests) {
    const card = el("section", { class: "card" });
    const head = el("div", { class: "row-between" });
    head.append(el("h2", {}, r.team), el("span", { class: "status open" }, "Offen / Open"));
    card.append(head);
    card.append(el("p", { class: "hint" }, `${r.request} · ${r.date}` + (r.person ? ` · ${r.person}` : "")));
    if (r.note) card.append(el("p", {}, r.note));

    const inputs = [];
    for (const l of r.lines) {
      const m = materialByNo(l.no);
      const line = el("div", { class: "req-line" });
      line.append(el("div", { class: "name" }, l.name));
      line.append(el("div", { class: "hint" },
        `Angefordert / Requested: ${fmtQty(l.qty)} ${l.unit} · ` +
        (m ? `Lager / Stock: ${fmtQty(m.stock)} ${m.unit}` : "nicht im Lager / not in stock list")));
      const label = el("label", {}, "Genehmigen / Approve");
      const row = el("div", { class: "qty-row" });
      const input = el("input", { type: "text", inputmode: "decimal", autocomplete: "off" });
      input.value = String(m ? Math.min(l.qty, m.stock) : 0).replace(".", ",");
      row.append(input, el("span", { class: "unit" }, l.unit));
      label.append(row);
      line.append(label);
      card.append(line);
      inputs.push({ line: l, material: m, input });
    }

    const error = el("p", { class: "error", hidden: "" });
    const actions = el("div", { class: "req-actions" });
    const approve = el("button", { class: "primary", type: "button" }, "✓ Genehmigen / Approve");
    const deny = el("button", { class: "danger", type: "button" }, "✕ Ablehnen / Deny");
    approve.onclick = () => approveRequest(r, inputs, error, [approve, deny]);
    deny.onclick = () => denyRequest(r, [approve, deny]);
    actions.append(approve, deny);
    card.append(error, actions);
    box.append(card);
  }
}

async function approveRequest(r, inputs, error, buttons) {
  // Check every amount before anything is changed
  const lines = [];
  for (const { line, material, input } of inputs) {
    const qty = parseQty(input.value) ?? 0;
    let problem = "";
    if (Number.isNaN(qty)) problem = "bitte eine Zahl / please enter a number";
    else if (qty > 0 && !material) problem = "nicht im Lager – 0 eintragen / not in stock list – enter 0";
    else if (material && qty > material.stock) problem = `nur ${fmtQty(material.stock)} ${material.unit} auf Lager / only that much in stock`;
    if (problem) {
      error.textContent = `${line.name}: ${problem}`;
      error.hidden = false;
      return;
    }
    lines.push({ line, material, qty });
  }
  error.hidden = true;
  buttons.forEach((b) => (b.disabled = true));
  try {
    // First mark the request as approved in Smartsheet, then take the stock out on the phone,
    // so a request can never be taken out of stock twice.
    await api("POST", "/api/requests/decide", {
      request: r.request,
      decision: "approve",
      lines: lines.map((x) => ({ lineId: x.line.lineId, qty: x.qty })),
    });
    const now = new Date().toISOString();
    for (const { material, qty } of lines) {
      if (!material || qty <= 0) continue;
      const after = round(material.stock - qty);
      material.last = { kind: "issue", qty: -qty, before: material.stock, after, team: r.team, text: `Anforderung ${r.request}` };
      material.stock = after;
      material.updatedAt = now;
      await db.putMaterial(material);
    }
    if (!settings.teams.includes(r.team)) {
      settings.teams.push(r.team);
      await saveSettings();
    }
    scheduleSync();
    renderList();
    toast(`Genehmigt / Approved: ${r.team}`);
  } catch (e) {
    toast(e.message);
  }
  await loadRequests();
}

async function denyRequest(r, buttons) {
  const reason = prompt("Grund (optional) / Reason (optional)");
  if (reason === null) return; // cancelled
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api("POST", "/api/requests/decide", { request: r.request, decision: "deny", reason });
    toast(`Abgelehnt / Denied: ${r.team}`);
  } catch (e) {
    toast(e.message);
  }
  await loadRequests();
}

const requestLink = () => `${location.origin}/request.html`;

async function shareRequestLink() {
  const url = requestLink();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Material anfordern / Request material", url });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link kopiert / Link copied");
  } catch {
    toast(url);
  }
}

// Opens the iPhone share sheet (Mail, WhatsApp, Save to Files...).
async function shareFile(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === "AbortError") return; // user closed the share sheet
    }
  }
  // Fallback (e.g. on a computer): download the file.
  const a = el("a", { href: URL.createObjectURL(blob), download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- Start ----------

async function init() {
  const saved = await db.getSettings();
  settings = { ...defaultSettings(), ...(saved || {}) };
  if (!settings.catalogCategories) addCatalogCategories();
  materials = await db.allMaterials();
  sync = { ...sync, ...((await db.run("settings", "readonly", (s) => s.get("sync"))) || {}) };
  renderTeams();
  renderCategoryFilter();
  renderList();

  $("#search").addEventListener("input", renderList);
  $("#filter-cat").addEventListener("change", renderList);
  $("#filter-low").addEventListener("change", renderList);
  $("#btn-new").onclick = () => openEdit(true);
  $("#btn-export").onclick = exportExcel;

  for (const b of $$(".act")) b.onclick = () => (action === b.dataset.act ? closeMove() : openMove(b.dataset.act));
  for (const b of $$("#m-dir-row button")) {
    b.onclick = () => {
      transferDir = b.dataset.dir;
      renderDir();
      updatePreview();
    };
  }
  $("#m-qty").addEventListener("input", updatePreview);
  $("#m-qty").addEventListener("keydown", (e) => e.key === "Enter" && saveMove());
  $("#m-save").onclick = saveMove;
  $("#m-cancel").onclick = closeMove;
  $("#btn-edit").onclick = () => openEdit(false);

  $("#e-save").onclick = saveEdit;
  $("#e-name").addEventListener("input", renderSuggestions);
  $("#e-delete").onclick = deleteCurrent;

  $("#btn-settings").onclick = () => {
    renderSettings();
    show("settings");
  };
  for (const id of ["#s-warehouse", "#s-teams", "#s-categories", "#s-units", "#s-pin"]) {
    $(id).addEventListener("change", async () => {
      readSettingsForm();
      await saveSettings();
      renderCategoryFilter();
      if (id === "#s-pin") syncNow();
    });
  }
  $("#s-sync").onclick = syncNow;
  $("#s-share-link").onclick = shareRequestLink;
  $("#btn-requests").onclick = () => {
    renderRequests();
    show("requests");
    loadRequests();
  };
  $("#req-refresh").onclick = loadRequests;

  // Send to Smartsheet when the app opens, and when signal comes back.
  window.addEventListener("online", () => sync.dirty && syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (sync.dirty) syncNow();
    if (settings.pin) loadRequests(); // new team requests
  });
  renderSyncStatus();
  if (materials.length) syncNow();
  if (settings.pin) loadRequests();

  $("#btn-back").onclick = async () => {
    if (view === "settings") {
      readSettingsForm();
      await saveSettings();
      renderCategoryFilter();
      renderList();
      show("list");
    } else if (view === "edit" && current) {
      show("item");
    } else {
      current = null;
      closeMove();
      renderList();
      show("list");
    }
  };

  show("list");

  // Ask the phone to keep our data, and make the app work offline.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
}

init();
