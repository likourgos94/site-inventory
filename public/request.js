// Request page for the teams: choose materials and amounts, send the request,
// and see whether it was approved. Needs internet; the team code is kept on this phone.

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmtQty = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { maximumFractionDigits: 3 }) : "–");

// What you typed -> number. Accepts "12", "12,5", "12.5", "1.250" and "1.250,5".
function parseQty(text) {
  let s = String(text || "").trim().replace(/\s/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------- Team code, team and name (saved on this phone) ----------

let cfg = { code: "", team: "", person: "" };
try {
  cfg = { ...cfg, ...JSON.parse(localStorage.getItem("request-cfg") || "{}") };
} catch {}
function saveCfg() {
  try {
    localStorage.setItem("request-cfg", JSON.stringify(cfg));
  } catch {}
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Team-Pin": cfg.code },
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

// ---------- State ----------

let materials = []; // [{ no, name, category, unit, stock }]
const cart = new Map(); // no -> qty
let openNo = null; // material whose amount field is open

// ---------- Screens ----------

function showSetup(message) {
  $("#setup").hidden = false;
  $("#main").hidden = true;
  $("#c-code").value = cfg.code;
  $("#c-team").value = cfg.team;
  $("#c-person").value = cfg.person;
  $("#c-error").textContent = message || "";
  $("#c-error").hidden = !message;
}

async function showMain() {
  $("#setup").hidden = true;
  $("#main").hidden = false;
  $("#who").textContent = cfg.team + (cfg.person ? ` · ${cfg.person}` : "");
  renderCart();
  await Promise.all([loadMaterials(), loadMine()]);
}

async function saveSetup() {
  cfg.code = $("#c-code").value.trim();
  cfg.team = $("#c-team").value.trim();
  cfg.person = $("#c-person").value.trim();
  if (!cfg.code || !cfg.team) return showSetup("Bitte Team-Code und Team eingeben. / Please enter team code and team.");
  try {
    materials = (await api("GET", "/api/materials")).materials; // also checks the code
  } catch (e) {
    return showSetup(e.message);
  }
  saveCfg();
  showMain();
}

// ---------- Materials ----------

async function loadMaterials() {
  $("#m-status").textContent = "Wird geladen … / Loading …";
  try {
    materials = (await api("GET", "/api/materials")).materials;
    $("#m-status").textContent = materials.length ? "" : "Noch kein Material im Lager. / No materials yet.";
  } catch (e) {
    if (e.status === 401) return showSetup(e.message);
    $("#m-status").textContent = navigator.onLine ? e.message : "Kein Netz / No signal";
  }
  renderMaterials();
}

function renderMaterials() {
  const query = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const box = $("#materials");
  box.innerHTML = "";
  for (const m of materials) {
    const text = `${m.no} ${m.ugg} ${m.name} ${m.category}`.toLowerCase();
    if (!query.every((w) => text.includes(w))) continue;
    const btn = el("button", { class: `mat${m.stock <= 0 ? " low" : ""}`, type: "button" });
    const left = el("div");
    left.append(el("div", { class: "name" }, m.name));
    left.append(el("div", { class: "meta" }, `${m.no} · ${m.category}`));
    const qty = el("div", { class: "qty" }, fmtQty(m.stock) + " ");
    qty.append(el("small", {}, m.unit));
    btn.append(left, qty);
    btn.onclick = () => {
      openNo = openNo === m.no ? null : m.no;
      renderMaterials();
    };
    box.append(btn);
    if (openNo === m.no) box.append(amountForm(m));
  }
}

// Amount field under a material, with "Add"
function amountForm(m) {
  const form = el("div", { class: "card" });
  const label = el("label", {}, "Menge / Quantity");
  const row = el("div", { class: "qty-row" });
  const input = el("input", { type: "text", inputmode: "decimal", autocomplete: "off" });
  if (cart.has(m.no)) input.value = String(cart.get(m.no)).replace(".", ",");
  row.append(input, el("span", { class: "unit" }, m.unit));
  label.append(row);
  const hint = el("p", { class: "hint" });
  const add = el("button", { class: "primary", type: "button" }, "Hinzufügen / Add");
  const check = () => {
    const q = parseQty(input.value);
    hint.textContent = q > m.stock ? `Mehr als auf Lager (${fmtQty(m.stock)} ${m.unit}). / More than in stock.` : "";
  };
  input.addEventListener("input", check);
  add.onclick = () => {
    const q = parseQty(input.value);
    if (!q || Number.isNaN(q) || q <= 0) {
      hint.textContent = "Bitte eine Menge eingeben. / Please enter a quantity.";
      return;
    }
    cart.set(m.no, q);
    openNo = null;
    renderCart();
    renderMaterials();
    toast(`${fmtQty(q)} ${m.unit} ${m.name}`);
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && add.click());
  form.append(label, hint, add);
  setTimeout(() => input.focus(), 0);
  return form;
}

// ---------- The request being put together ----------

function renderCart() {
  const box = $("#cart");
  box.innerHTML = "";
  for (const [no, qty] of cart) {
    const m = materials.find((x) => x.no === no) || { name: no, unit: "" };
    const row = el("div", { class: "row-between req-line" });
    row.append(el("div", {}, `${fmtQty(qty)} ${m.unit} · ${m.name}`));
    const remove = el("button", { class: "remove", type: "button" }, "Entfernen / Remove");
    remove.onclick = () => {
      cart.delete(no);
      renderCart();
    };
    row.append(remove);
    box.append(row);
  }
  $("#cart-empty").hidden = cart.size > 0;
  $("#r-send").disabled = cart.size === 0;
}

async function sendRequest() {
  const error = $("#r-error");
  error.hidden = true;
  const button = $("#r-send");
  button.disabled = true;
  try {
    const { request } = await api("POST", "/api/requests", {
      team: cfg.team,
      person: cfg.person,
      note: $("#r-note").value,
      lines: [...cart].map(([no, qty]) => ({ no, qty })),
    });
    cart.clear();
    $("#r-note").value = "";
    renderCart();
    toast(`Gesendet / Sent: ${request}`);
    await loadMine();
  } catch (e) {
    error.textContent = navigator.onLine ? e.message : "Kein Netz – bitte später senden. / No signal – please send later.";
    error.hidden = false;
  }
  button.disabled = cart.size === 0;
}

// ---------- Earlier requests of this team ----------

const STATUS_CLASS = { "Offen / Open": "open", "Genehmigt / Approved": "approved", "Abgelehnt / Denied": "denied" };

async function loadMine() {
  const box = $("#mine");
  try {
    const { requests } = await api("GET", `/api/requests?team=${encodeURIComponent(cfg.team)}`);
    box.innerHTML = "";
    if (!requests.length) box.append(el("p", { class: "hint" }, "Noch keine. / None yet."));
    for (const r of requests) {
      const item = el("div", { class: "req-line" });
      const head = el("div", { class: "row-between" });
      head.append(el("strong", {}, `${r.request} · ${r.date}`), el("span", { class: `status ${STATUS_CLASS[r.status] || ""}` }, r.status));
      item.append(head);
      for (const l of r.lines) {
        const approved = r.status === "Genehmigt / Approved" && l.approved !== null && l.approved !== l.qty
          ? ` (genehmigt / approved: ${fmtQty(l.approved)})` : "";
        item.append(el("div", { class: "hint" }, `${fmtQty(l.qty)} ${l.unit} · ${l.name}${approved}`));
      }
      if (r.reason) item.append(el("div", { class: "hint" }, `Grund / Reason: ${r.reason}`));
      box.append(item);
    }
  } catch (e) {
    if (e.status === 401) return showSetup(e.message);
    box.textContent = navigator.onLine ? e.message : "Kein Netz / No signal";
  }
}

// ---------- Start ----------

$("#c-save").onclick = saveSetup;
$("#change").onclick = () => showSetup();
$("#search").addEventListener("input", renderMaterials);
$("#r-send").onclick = sendRequest;
$("#mine-refresh").onclick = loadMine;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("#main").hidden) {
    loadMaterials();
    loadMine();
  }
});

if (cfg.code && cfg.team) showMain();
else showSetup();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
