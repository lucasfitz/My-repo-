/* Sprout — plant care tracker. Vanilla JS + IndexedDB, no build step. */
"use strict";

// ---------------------------------------------------------------------------
// IndexedDB wrapper
// ---------------------------------------------------------------------------
const DB_NAME = "sprout-db";
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("plants")) db.createObjectStore("plants", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) {
        const s = db.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("plantId", "plantId");
      }
      if (!db.objectStoreNames.contains("logs")) {
        const s = db.createObjectStore("logs", { keyPath: "id" });
        s.createIndex("plantId", "plantId");
      }
      if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

const dbPut = (store, val) => tx(store, "readwrite", s => s.put(val));
const dbDel = (store, key) => tx(store, "readwrite", s => s.delete(key));
const dbGet = (store, key) => tx(store, "readonly", s => s.get(key));
const dbAll = (store) => tx(store, "readonly", s => s.getAll());
const dbAllByIndex = (store, index, key) =>
  tx(store, "readonly", s => s.index(index).getAll(key));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Settings / household profiles
// ---------------------------------------------------------------------------
const state = { settings: { users: ["Lucas", "Partner"], activeUser: "Lucas", lastNotified: "" } };

async function loadSettings() {
  const row = await dbGet("settings", "main");
  if (row) state.settings = Object.assign(state.settings, row.value);
}
async function saveSettings() {
  await dbPut("settings", { key: "main", value: state.settings });
  renderProfileChip();
}
function renderProfileChip() {
  document.getElementById("profileBtn").textContent = "👤 " + state.settings.activeUser;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
const DAY = 86400000;
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + "T12:00:00"), b = new Date(toStr + "T12:00:00");
  return Math.round((b - a) / DAY);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function dueLabel(dueStr) {
  const n = daysBetween(todayStr(), dueStr);
  if (n < -1) return `${-n} days overdue`;
  if (n === -1) return "1 day overdue";
  if (n === 0) return "due today";
  if (n === 1) return "due tomorrow";
  return `due in ${n} days`;
}

// Due date for an action on a plant. Falls back to createdAt if never done.
function nextDue(plant, kind) {
  const every = kind === "water" ? plant.waterEvery : plant.fertEvery;
  if (!every) return null; // schedule disabled
  const last = kind === "water" ? plant.lastWatered : plant.lastFertilized;
  const base = last || plant.createdAt.slice(0, 10);
  return addDays(base, every);
}

// ---------------------------------------------------------------------------
// Task computation (the Today checklist)
// ---------------------------------------------------------------------------
function computeCareTasks(plants) {
  const tasks = [];
  for (const p of plants) {
    if (p.archived) continue;
    for (const kind of ["water", "fertilize"]) {
      const due = nextDue(p, kind);
      if (!due) continue;
      tasks.push({ plant: p, kind, due, delta: daysBetween(todayStr(), due) });
    }
  }
  tasks.sort((a, b) => a.delta - b.delta || a.plant.name.localeCompare(b.plant.name));
  return tasks;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function logAction(plantId, type, note = "") {
  const plant = await dbGet("plants", plantId);
  if (!plant) return;
  const now = new Date().toISOString();
  if (type === "water") plant.lastWatered = todayStr();
  if (type === "fertilize") plant.lastFertilized = todayStr();
  await dbPut("plants", plant);
  await dbPut("logs", { id: uid(), plantId, type, at: now, by: state.settings.activeUser, note });
  const verbs = { water: "Watered", fertilize: "Fertilized", repot: "Repotted", prune: "Pruned", note: "Noted" };
  toast(`${verbs[type] || type} ${plant.name} 🌿`);
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function resizeImage(file, maxDim = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("encode failed")), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

async function addPhoto(plantId, file) {
  const blob = await resizeImage(file);
  await dbPut("photos", { id: uid(), plantId, blob, createdAt: new Date().toISOString() });
}

async function latestPhotoURL(plantId) {
  const photos = await dbAllByIndex("photos", "plantId", plantId);
  if (!photos.length) return null;
  photos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return URL.createObjectURL(photos[0].blob);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const $view = () => document.getElementById("view");
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
function guideEntry(key) {
  return PLANT_GUIDE.find(g => g.key === key) || PLANT_GUIDE.find(g => g.key === "other");
}
function plantEmoji(p) { return guideEntry(p.speciesKey).emoji; }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// ----- Today -----
async function viewToday() {
  const plants = await dbAll("plants");
  const care = computeCareTasks(plants);
  const overdue = care.filter(t => t.delta < 0);
  const dueToday = care.filter(t => t.delta === 0);
  const upcoming = care.filter(t => t.delta > 0 && t.delta <= 7);
  const custom = (await dbAll("tasks")).sort((a, b) => a.done - b.done || b.createdAt.localeCompare(a.createdAt));
  const season = currentSeason();

  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  let html = `
    <h1>${greeting}, ${esc(state.settings.activeUser)} 👋</h1>
    <p class="subtitle">${dateLine}</p>
    <div class="stat-row">
      <div class="stat"><div class="num">${plants.filter(p => !p.archived).length}</div><div class="lbl">Plants</div></div>
      <div class="stat"><div class="num" style="${overdue.length ? 'color:var(--red)' : ''}">${overdue.length}</div><div class="lbl">Overdue</div></div>
      <div class="stat"><div class="num">${dueToday.length}</div><div class="lbl">Due today</div></div>
    </div>
    <div class="tip-card">${SEASONAL_TIPS[season]}</div>`;

  const renderCareTask = async (t, cls) => {
    const photo = await latestPhotoURL(t.plant.id);
    const icon = t.kind === "water" ? "💧" : "🌾";
    const verb = t.kind === "water" ? "Water" : "Fertilize";
    return `
      <div class="task ${cls}" data-plant="${t.plant.id}" data-kind="${t.kind}">
        <button class="task-check" data-action="complete" aria-label="Mark done">✓</button>
        ${photo ? `<img class="task-thumb" src="${photo}" alt="">` : `<div class="task-thumb" style="display:grid;place-items:center">${plantEmoji(t.plant)}</div>`}
        <div class="task-body">
          <div class="task-title">${icon} ${verb} ${esc(t.plant.name)}</div>
          <div class="task-sub">${esc(t.plant.location || "")}${t.plant.location ? " · " : ""}${dueLabel(t.due)}</div>
        </div>
        <a class="btn small secondary" href="#/plant/${t.plant.id}">View</a>
      </div>`;
  };

  const section = async (title, list, cls) => {
    if (!list.length) return "";
    const items = await Promise.all(list.map(t => renderCareTask(t, cls)));
    return `<h2>${title}</h2>${items.join("")}`;
  };

  html += await section("🔴 Overdue", overdue, "overdue");
  html += await section("Due today", dueToday, "due-today");
  html += await section("Coming up this week", upcoming, "");

  if (!care.length && !plants.length) {
    html += `<div class="empty"><div class="big">🪴</div><p>No plants yet!<br>Tap <b>Add</b> below to plant your first one.</p></div>`;
  } else if (!overdue.length && !dueToday.length) {
    html += `<div class="empty"><div class="big">🎉</div><p>All caught up — the jungle is happy.</p></div>`;
  }

  html += `
    <div class="section-head"><h2>📝 Household checklist</h2></div>
    ${custom.map(t => `
      <div class="task" data-task="${t.id}">
        <button class="task-check ${t.done ? "done" : ""}" data-action="toggle-task">✓</button>
        <div class="task-body"><div class="task-title" style="${t.done ? "text-decoration:line-through;opacity:.55" : ""}">${esc(t.title)}</div>
        <div class="task-sub">added by ${esc(t.by || "?")}</div></div>
        <button class="btn small danger" data-action="del-task">✕</button>
      </div>`).join("")}
    <form id="addTaskForm" class="inline-form" style="margin-top:10px">
      <input type="text" id="newTaskTitle" placeholder="Add a task… (buy potting soil)" maxlength="120">
      <button class="btn" type="submit">Add</button>
    </form>`;

  $view().innerHTML = html;

  $view().querySelectorAll("[data-action=complete]").forEach(btn => {
    btn.addEventListener("click", async e => {
      const row = e.target.closest(".task");
      await logAction(row.dataset.plant, row.dataset.kind);
      render();
    });
  });
  $view().querySelectorAll("[data-action=toggle-task]").forEach(btn => {
    btn.addEventListener("click", async e => {
      const id = e.target.closest(".task").dataset.task;
      const t = await dbGet("tasks", id);
      t.done = !t.done;
      await dbPut("tasks", t);
      render();
    });
  });
  $view().querySelectorAll("[data-action=del-task]").forEach(btn => {
    btn.addEventListener("click", async e => {
      await dbDel("tasks", e.target.closest(".task").dataset.task);
      render();
    });
  });
  document.getElementById("addTaskForm").addEventListener("submit", async e => {
    e.preventDefault();
    const title = document.getElementById("newTaskTitle").value.trim();
    if (!title) return;
    await dbPut("tasks", { id: uid(), title, done: false, by: state.settings.activeUser, createdAt: new Date().toISOString() });
    render();
  });
}

// ----- Plants list -----
async function viewPlants() {
  const plants = (await dbAll("plants")).filter(p => !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));

  let html = `<h1>Our plants</h1><p class="subtitle">${plants.length} plant${plants.length === 1 ? "" : "s"} in the family</p>
    <div class="search-bar"><input type="text" id="plantSearch" placeholder="Search plants…"></div>`;

  if (!plants.length) {
    html += `<div class="empty"><div class="big">🪴</div><p>Nothing here yet.<br>Tap <b>Add</b> to start your collection.</p></div>`;
    $view().innerHTML = html;
    return;
  }

  const cards = await Promise.all(plants.map(async p => {
    const photo = await latestPhotoURL(p.id);
    const wDue = nextDue(p, "water");
    const wDelta = wDue ? daysBetween(todayStr(), wDue) : null;
    let chip = `<span class="badge ok">✓ happy</span>`;
    if (wDelta !== null && wDelta < 0) chip = `<span class="badge overdue">💧 ${-wDelta}d overdue</span>`;
    else if (wDelta === 0) chip = `<span class="badge water">💧 water today</span>`;
    else if (wDelta !== null) chip = `<span class="badge ok">💧 in ${wDelta}d</span>`;
    return `
      <a class="plant-card" href="#/plant/${p.id}" data-name="${esc(p.name.toLowerCase())} ${esc((p.species || "").toLowerCase())}">
        ${photo ? `<img src="${photo}" alt="${esc(p.name)}">` : `<div class="no-photo">${plantEmoji(p)}</div>`}
        <div class="plant-card-body">
          <div class="plant-card-name">${esc(p.name)}</div>
          <div class="plant-card-sub">${esc(p.species || "")}${p.location ? " · " + esc(p.location) : ""}</div>
          ${chip}
        </div>
      </a>`;
  }));

  html += `<div class="plant-grid" id="plantGrid">${cards.join("")}</div>`;
  $view().innerHTML = html;

  document.getElementById("plantSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#plantGrid .plant-card").forEach(c => {
      c.style.display = !q || c.dataset.name.includes(q) ? "" : "none";
    });
  });
}

// ----- Add / Edit plant -----
async function viewAddEdit(editId = null) {
  const editing = editId ? await dbGet("plants", editId) : null;
  const speciesOpts = PLANT_GUIDE.map(g =>
    `<option value="${g.key}" ${editing && editing.speciesKey === g.key ? "selected" : ""}>${g.emoji} ${g.name}</option>`).join("");

  $view().innerHTML = `
    <h1>${editing ? "Edit " + esc(editing.name) : "Add a plant"}</h1>
    <p class="subtitle">${editing ? "Update details or schedules." : "Pick a species and we'll suggest a care schedule."}</p>
    <form id="plantForm" class="card">
      <div class="field">
        <label for="pName">Nickname *</label>
        <input type="text" id="pName" required maxlength="60" placeholder="e.g. Fernie Sanders" value="${esc(editing?.name || "")}">
      </div>
      <div class="field">
        <label for="pSpecies">Species</label>
        <select id="pSpecies">${speciesOpts}</select>
        <div class="hint" id="speciesHint"></div>
      </div>
      <div class="field">
        <label for="pCustomSpecies">Species name (optional, free text)</label>
        <input type="text" id="pCustomSpecies" maxlength="80" placeholder="e.g. Variegated monstera" value="${esc(editing?.species || "")}">
      </div>
      <div class="field">
        <label for="pLocation">Location in the house</label>
        <input type="text" id="pLocation" maxlength="60" placeholder="e.g. Living room window" value="${esc(editing?.location || "")}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pWater">Water every (days)</label>
          <input type="number" id="pWater" min="0" max="365" value="${editing ? editing.waterEvery : 7}">
          <div class="hint">0 = no reminders</div>
        </div>
        <div class="field">
          <label for="pFert">Fertilize every (days)</label>
          <input type="number" id="pFert" min="0" max="365" value="${editing ? editing.fertEvery : 30}">
          <div class="hint">0 = no reminders</div>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pLastWater">Last watered</label>
          <input type="date" id="pLastWater" value="${editing?.lastWatered || todayStr()}">
        </div>
        <div class="field">
          <label for="pLastFert">Last fertilized</label>
          <input type="date" id="pLastFert" value="${editing?.lastFertilized || ""}">
        </div>
      </div>
      <div class="field">
        <label for="pNotes">Notes</label>
        <textarea id="pNotes" maxlength="1000" placeholder="Quirks, where it came from, repotting history…">${esc(editing?.notes || "")}</textarea>
      </div>
      ${editing ? "" : `
      <div class="field">
        <label for="pPhoto">Photo</label>
        <input type="file" id="pPhoto" accept="image/*">
      </div>`}
      <button class="btn block" type="submit">${editing ? "Save changes" : "🌱 Add plant"}</button>
      ${editing ? `<button class="btn block secondary" type="button" id="cancelEdit" style="margin-top:8px">Cancel</button>` : ""}
    </form>`;

  const speciesSel = document.getElementById("pSpecies");
  const hint = document.getElementById("speciesHint");
  const applySpecies = (setDefaults) => {
    const g = guideEntry(speciesSel.value);
    hint.textContent = g.latin ? `${g.latin} — suggested: water every ${g.waterDays}d, fertilize every ${g.fertDays}d` : "";
    if (setDefaults) {
      document.getElementById("pWater").value = g.waterDays;
      document.getElementById("pFert").value = g.fertDays;
    }
  };
  applySpecies(false);
  speciesSel.addEventListener("change", () => applySpecies(!editing));

  document.getElementById("plantForm").addEventListener("submit", async e => {
    e.preventDefault();
    const plant = editing || { id: uid(), createdAt: new Date().toISOString(), archived: false };
    plant.name = document.getElementById("pName").value.trim();
    plant.speciesKey = speciesSel.value;
    plant.species = document.getElementById("pCustomSpecies").value.trim() || guideEntry(speciesSel.value).name;
    plant.location = document.getElementById("pLocation").value.trim();
    plant.waterEvery = parseInt(document.getElementById("pWater").value, 10) || 0;
    plant.fertEvery = parseInt(document.getElementById("pFert").value, 10) || 0;
    plant.lastWatered = document.getElementById("pLastWater").value || null;
    plant.lastFertilized = document.getElementById("pLastFert").value || null;
    plant.notes = document.getElementById("pNotes").value.trim();
    await dbPut("plants", plant);
    if (!editing) {
      const file = document.getElementById("pPhoto").files[0];
      if (file) await addPhoto(plant.id, file);
      await dbPut("logs", { id: uid(), plantId: plant.id, type: "note", at: new Date().toISOString(), by: state.settings.activeUser, note: "Added to the family 🎉" });
    }
    toast(editing ? "Saved ✓" : `Welcome home, ${plant.name}! 🌱`);
    location.hash = "#/plant/" + plant.id;
  });
  const cancel = document.getElementById("cancelEdit");
  if (cancel) cancel.addEventListener("click", () => { location.hash = "#/plant/" + editId; });
}

// ----- Plant detail -----
async function viewPlant(id) {
  const p = await dbGet("plants", id);
  if (!p) { location.hash = "#/plants"; return; }
  const g = guideEntry(p.speciesKey);
  const photos = (await dbAllByIndex("photos", "plantId", id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const logs = (await dbAllByIndex("logs", "plantId", id)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  const heroURL = photos.length ? URL.createObjectURL(photos[0].blob) : null;

  const wDue = nextDue(p, "water"), fDue = nextDue(p, "fertilize");
  const badge = (due, cls, icon, label) => {
    if (!due) return `<span class="badge ok">${icon} off</span>`;
    const d = daysBetween(todayStr(), due);
    if (d < 0) return `<span class="badge overdue">${icon} ${label} ${-d}d overdue</span>`;
    if (d === 0) return `<span class="badge ${cls}">${icon} ${label} today</span>`;
    return `<span class="badge ${cls}">${icon} ${label} ${fmtDate(due)}</span>`;
  };

  const logIcons = { water: "💧", fertilize: "🌾", repot: "🪴", prune: "✂️", note: "📝" };

  $view().innerHTML = `
    <div class="hero">${heroURL ? `<img src="${heroURL}" alt="${esc(p.name)}">` : `<div class="no-photo">${g.emoji}</div>`}</div>
    <h1>${esc(p.name)}</h1>
    <p class="subtitle">${esc(p.species || g.name)}${p.location ? " · 📍 " + esc(p.location) : ""}</p>
    <div class="pill-row">
      ${badge(wDue, "water", "💧", "water")}
      ${badge(fDue, "fertilize", "🌾", "fertilize")}
    </div>
    <div class="action-row">
      <button class="btn" id="btnWater">💧 Water now</button>
      <button class="btn secondary" id="btnFert">🌾 Fertilize</button>
    </div>
    <div class="action-row">
      <button class="btn small secondary" id="btnRepot">🪴 Repotted</button>
      <button class="btn small secondary" id="btnPrune">✂️ Pruned</button>
      <button class="btn small secondary" id="btnEdit">✏️ Edit</button>
    </div>

    <div class="tip-card"><b>${g.emoji} Care tips — ${esc(g.name)}</b><br>
      ☀️ ${esc(g.light)}<br>💡 ${esc(g.tips)}</div>

    ${p.notes ? `<div class="card flat"><b>Notes</b><br>${esc(p.notes).replace(/\n/g, "<br>")}</div>` : ""}

    <div class="section-head"><h2>📷 Photo journal</h2>
      <label class="btn small secondary" style="cursor:pointer">＋ Photo<input type="file" id="photoInput" accept="image/*" hidden></label>
    </div>
    ${photos.length ? `<div class="gallery" id="gallery">
      ${photos.map(ph => `<img src="${URL.createObjectURL(ph.blob)}" data-photo="${ph.id}" alt="" title="${fmtDateTime(ph.createdAt)}">`).join("")}
    </div>` : `<p class="subtitle">No photos yet — take a growth pic!</p>`}

    <h2>📜 History</h2>
    <div class="card flat">
      ${logs.length ? logs.map(l => `
        <div class="history-item">
          <span class="history-icon">${logIcons[l.type] || "•"}</span>
          <div><div>${l.type === "note" ? esc(l.note) : (l.type[0].toUpperCase() + l.type.slice(1) + "d") + (l.note ? " — " + esc(l.note) : "")}</div>
          <div class="history-meta">${fmtDateTime(l.at)} · by ${esc(l.by)}</div></div>
        </div>`).join("") : `<p class="subtitle" style="margin:0">No history yet.</p>`}
    </div>

    <div style="margin-top:18px; display:flex; gap:10px">
      <button class="btn small danger block" id="btnDelete">🗑 Remove plant</button>
    </div>`;

  const act = async (type) => { await logAction(id, type); render(); };
  document.getElementById("btnWater").addEventListener("click", () => act("water"));
  document.getElementById("btnFert").addEventListener("click", () => act("fertilize"));
  document.getElementById("btnRepot").addEventListener("click", () => act("repot"));
  document.getElementById("btnPrune").addEventListener("click", () => act("prune"));
  document.getElementById("btnEdit").addEventListener("click", () => { location.hash = "#/edit/" + id; });
  document.getElementById("btnDelete").addEventListener("click", async () => {
    if (!confirm(`Remove ${p.name} and all its photos/history? This can't be undone.`)) return;
    for (const ph of photos) await dbDel("photos", ph.id);
    const allLogs = await dbAllByIndex("logs", "plantId", id);
    for (const l of allLogs) await dbDel("logs", l.id);
    await dbDel("plants", id);
    toast(`${p.name} removed 🥀`);
    location.hash = "#/plants";
  });
  document.getElementById("photoInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await addPhoto(id, file);
      toast("Photo saved 📷");
      render();
    } catch { toast("Couldn't read that image"); }
  });
  const gallery = document.getElementById("gallery");
  if (gallery) gallery.addEventListener("click", e => {
    if (e.target.tagName === "IMG") openPhotoViewer(e.target.dataset.photo, id);
  });
}

async function openPhotoViewer(photoId, plantId) {
  const ph = await dbGet("photos", photoId);
  if (!ph) return;
  const div = document.createElement("div");
  div.className = "photo-viewer";
  div.innerHTML = `
    <div class="pv-bar">
      <button class="btn small danger" id="pvDelete">Delete</button>
      <button class="btn small secondary" id="pvClose">Close ✕</button>
    </div>
    <img src="${URL.createObjectURL(ph.blob)}" alt="">`;
  document.body.appendChild(div);
  div.addEventListener("click", e => { if (e.target === div) div.remove(); });
  div.querySelector("#pvClose").addEventListener("click", () => div.remove());
  div.querySelector("#pvDelete").addEventListener("click", async () => {
    if (!confirm("Delete this photo?")) return;
    await dbDel("photos", photoId);
    div.remove();
    render();
  });
}

// ----- Guide -----
async function viewGuide() {
  const season = currentSeason();
  $view().innerHTML = `
    <h1>Care guide</h1>
    <p class="subtitle">Suggested schedules & tips for common houseplants.</p>
    <div class="tip-card">${SEASONAL_TIPS[season]}</div>
    <div class="search-bar"><input type="text" id="guideSearch" placeholder="Search species…"></div>
    ${PLANT_GUIDE.filter(g => g.key !== "other").map(g => `
      <div class="card guide-item" data-name="${g.name.toLowerCase()} ${g.latin.toLowerCase()}">
        <div class="guide-name">${g.emoji} ${g.name}</div>
        <div class="guide-latin">${g.latin}</div>
        <div class="guide-detail" hidden>
          <div><b>💧 Water:</b> every ~${g.waterDays} days</div>
          <div><b>🌾 Fertilize:</b> every ~${g.fertDays} days (spring–summer)</div>
          <div><b>☀️ Light:</b> ${g.light}</div>
          <div><b>💡 Tip:</b> ${g.tips}</div>
        </div>
      </div>`).join("")}`;

  $view().querySelectorAll(".guide-item").forEach(item => {
    item.addEventListener("click", () => {
      const d = item.querySelector(".guide-detail");
      d.hidden = !d.hidden;
    });
  });
  document.getElementById("guideSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    $view().querySelectorAll(".guide-item").forEach(c => {
      c.style.display = !q || c.dataset.name.includes(q) ? "" : "none";
    });
  });
}

// ----- Settings -----
async function viewSettings() {
  const notifState = ("Notification" in window) ? Notification.permission : "unsupported";
  $view().innerHTML = `
    <h1>Settings</h1>
    <p class="subtitle">Household, reminders & backups.</p>

    <div class="card">
      <h2 style="margin-top:0">👥 Household</h2>
      <p class="subtitle">Actions are logged under whoever is active — tap a name to switch (also in the top bar).</p>
      <div class="pill-row" id="userPills">
        ${state.settings.users.map(u => `<button class="pill ${u === state.settings.activeUser ? "active" : ""}" data-user="${esc(u)}">${esc(u)}</button>`).join("")}
      </div>
      <form id="renameForm" class="inline-form">
        <input type="text" id="renameInput" placeholder="Rename active member…" maxlength="30">
        <button class="btn secondary" type="submit">Rename</button>
      </form>
    </div>

    <div class="card">
      <h2 style="margin-top:0">🔔 Reminders</h2>
      <p class="subtitle">When the app is open (or installed to your home screen), Sprout checks for due plants and sends a daily notification.</p>
      <button class="btn block secondary" id="notifBtn">
        ${notifState === "granted" ? "✓ Notifications enabled" : notifState === "denied" ? "Notifications blocked in browser settings" : notifState === "unsupported" ? "Not supported on this browser" : "Enable notifications"}
      </button>
      <p class="hint" style="margin-top:8px;color:var(--ink-soft);font-size:.78rem">
        📲 Tip: on iPhone/Android, open this page in the browser and choose <b>Add to Home Screen</b> — Sprout works offline and feels like a native app.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">💾 Backup & sharing</h2>
      <p class="subtitle">Export everything (plants, history, photos) to a file. Share it with your partner's phone and import there to sync up.</p>
      <div class="action-row">
        <button class="btn secondary" id="exportBtn">⬇️ Export backup</button>
        <label class="btn secondary" style="cursor:pointer">⬆️ Import<input type="file" id="importInput" accept=".json,application/json" hidden></label>
      </div>
      <p class="hint" style="color:var(--ink-soft);font-size:.78rem">Import merges by ID — newer entries win, nothing is duplicated.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">ℹ️ About</h2>
      <p class="subtitle" style="margin:0">Sprout 🌱 — a little plant-care tracker for two. All data lives on this device (nothing is uploaded anywhere).</p>
    </div>`;

  document.querySelectorAll("#userPills .pill").forEach(pill => {
    pill.addEventListener("click", async () => {
      state.settings.activeUser = pill.dataset.user;
      await saveSettings();
      render();
    });
  });
  document.getElementById("renameForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = document.getElementById("renameInput").value.trim();
    if (!name) return;
    const idx = state.settings.users.indexOf(state.settings.activeUser);
    state.settings.users[idx] = name;
    state.settings.activeUser = name;
    await saveSettings();
    render();
  });
  document.getElementById("notifBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    if (perm === "granted") { toast("Reminders on 🔔"); checkAndNotify(true); }
    render();
  });
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("importInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (file) await importBackup(file);
  });
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(dataURL) {
  return (await fetch(dataURL)).blob();
}

async function exportBackup() {
  toast("Preparing backup…");
  const [plants, photos, logs, tasks] = await Promise.all([
    dbAll("plants"), dbAll("photos"), dbAll("logs"), dbAll("tasks")
  ]);
  const photosOut = [];
  for (const ph of photos) {
    photosOut.push({ id: ph.id, plantId: ph.plantId, createdAt: ph.createdAt, dataURL: await blobToDataURL(ph.blob) });
  }
  const payload = { app: "sprout", version: 1, exportedAt: new Date().toISOString(), settings: state.settings, plants, logs, tasks, photos: photosOut };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sprout-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup downloaded ✓");
}

async function importBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== "sprout") throw new Error("not a Sprout backup");
    for (const p of payload.plants || []) {
      const existing = await dbGet("plants", p.id);
      if (!existing || (p.lastWatered || "") > (existing.lastWatered || "")) await dbPut("plants", p);
    }
    for (const l of payload.logs || []) await dbPut("logs", l);
    for (const t of payload.tasks || []) await dbPut("tasks", t);
    for (const ph of payload.photos || []) {
      const existing = await dbGet("photos", ph.id);
      if (!existing) {
        await dbPut("photos", { id: ph.id, plantId: ph.plantId, createdAt: ph.createdAt, blob: await dataURLToBlob(ph.dataURL) });
      }
    }
    toast("Backup imported ✓");
    render();
  } catch (err) {
    toast("Import failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Notifications (fire when app is open; once per day)
// ---------------------------------------------------------------------------
async function checkAndNotify(force = false) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!force && state.settings.lastNotified === todayStr()) return;
  const plants = await dbAll("plants");
  const due = computeCareTasks(plants).filter(t => t.delta <= 0);
  if (!due.length) return;
  const names = [...new Set(due.map(t => t.plant.name))].slice(0, 4).join(", ");
  const title = `🌱 ${due.length} plant task${due.length === 1 ? "" : "s"} due`;
  const body = `${names}${due.length > 4 ? "…" : ""} need${due.length === 1 ? "s" : ""} some love today.`;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
    else new Notification(title, { body, icon: "icons/icon-192.png" });
    state.settings.lastNotified = todayStr();
    await saveSettings();
  } catch { /* notification not available in this context */ }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = [
  { re: /^#\/today$/, fn: () => viewToday(), tab: "today" },
  { re: /^#\/plants$/, fn: () => viewPlants(), tab: "plants" },
  { re: /^#\/add$/, fn: () => viewAddEdit(), tab: "add" },
  { re: /^#\/edit\/(.+)$/, fn: m => viewAddEdit(m[1]), tab: "plants" },
  { re: /^#\/plant\/(.+)$/, fn: m => viewPlant(m[1]), tab: "plants" },
  { re: /^#\/guide$/, fn: () => viewGuide(), tab: "guide" },
  { re: /^#\/settings$/, fn: () => viewSettings(), tab: "settings" },
];

async function render() {
  const hash = location.hash || "#/today";
  const route = routes.find(r => r.re.test(hash)) || routes[0];
  const m = hash.match(route.re);
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === route.tab));
  try {
    await route.fn(m);
  } catch (err) {
    $view().innerHTML = `<div class="empty"><div class="big">🥀</div><p>Something went wrong.<br>${esc(err.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  await loadSettings();
  renderProfileChip();
  document.getElementById("profileBtn").addEventListener("click", async () => {
    const users = state.settings.users;
    const idx = users.indexOf(state.settings.activeUser);
    state.settings.activeUser = users[(idx + 1) % users.length];
    await saveSettings();
    toast(`Now caring as ${state.settings.activeUser} 👋`);
    render();
  });
  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/today";
  await render();
  checkAndNotify();
  setInterval(checkAndNotify, 60 * 60 * 1000); // hourly re-check while open

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
