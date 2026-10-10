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
      "HÜP / APL",
      "Muffe / Closure",
      "Verbinder / Connector",
      "Werkzeug / Tool",
      "Sonstiges / Other",
    ],
    units: ["Stk.", "m", "Rolle", "Karton", "kg"],
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
  for (const v of ["list", "item", "edit", "settings"]) $(`#view-${v}`).hidden = v !== next;
  $("#btn-back").hidden = next === "list";
  $("#btn-settings").hidden = next !== "list";
  $("#title").textContent =
    next === "item" ? "Material" :
    next === "edit" ? (current ? "Angaben / Details" : "Neues Material / New material") :
    next === "settings" ? "Einstellungen / Settings" :
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
        (!query || `${m.no} ${m.name} ${m.category} ${m.note || ""}`.toLowerCase().includes(query)),
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
    left.append(el("div", { class: "meta" }, m.no + (isLow(m) ? ` · unter Minimum / below min. (${fmtQty(m.min)})` : "")));
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
  $("#i-no").textContent = m.no;
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
  $("#e-name").value = m ? m.name : "";
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
      category: $("#e-cat").value,
      unit: $("#e-unit").value,
      note: $("#e-note").value.trim(),
    });
    await db.putMaterial(current);
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
  renderCategoryFilter();
  renderList();
  toast(`${m.name} angelegt / created`);
  openItem(m.id);
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm(`„${current.name}“ wirklich löschen? / Really delete “${current.name}”?`)) return;
  await db.deleteMaterial(current.id);
  materials = materials.filter((m) => m.id !== current.id);
  current = null;
  renderCategoryFilter();
  renderList();
  show("list");
}

// ---------- 4) Settings ----------

const lines = (text) => [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];

function renderSettings() {
  $("#s-warehouse").value = settings.warehouse;
  $("#s-teams").value = settings.teams.join("\n");
  $("#s-categories").value = settings.categories.join("\n");
  $("#s-units").value = settings.units.join("\n");
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
}

// ---------- Excel export ----------

async function exportExcel() {
  const list = sortMaterials([...materials]);
  const today = localDate(new Date());
  const blob = makeXlsx({
    sheetName: "Lagerbestand",
    columns: [
      { title: "Art.-Nr. / Item no.", width: 14 },
      { title: "Bezeichnung / Name", width: 36 },
      { title: "Kategorie / Category", width: 22 },
      { title: "Bestand / Stock", width: 14 },
      { title: "Einheit / Unit", width: 10 },
      { title: "Mindestbestand / Min. stock", width: 14 },
      { title: "Unter Minimum / Below min.", width: 14 },
      { title: "Letzte Änderung / Last change", width: 18 },
      { title: "Letzte Bewegung / Last move", width: 44 },
      { title: "Notiz / Note", width: 24 },
    ],
    rows: list.map((m) => [
      m.no,
      m.name,
      m.category,
      m.stock,
      m.unit,
      m.min ?? "",
      isLow(m) ? "JA / YES" : "",
      fmtDateTime(m.updatedAt),
      lastText(m),
      m.note || "",
    ]),
  });
  await shareFile(blob, `Lagerbestand-${today}.xlsx`);
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
  materials = await db.allMaterials();
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
  $("#e-delete").onclick = deleteCurrent;

  $("#btn-settings").onclick = () => {
    renderSettings();
    show("settings");
  };
  for (const id of ["#s-warehouse", "#s-teams", "#s-categories", "#s-units"]) {
    $(id).addEventListener("change", async () => {
      readSettingsForm();
      await saveSettings();
      renderCategoryFilter();
    });
  }

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
