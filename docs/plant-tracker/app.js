/* Sprout — plant care tracker. Vanilla JS + IndexedDB, no build step. */
"use strict";

// ---------------------------------------------------------------------------
// IndexedDB wrapper
// ---------------------------------------------------------------------------
const DB_NAME = "sprout-db";
const DB_VERSION = 5;
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
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      // Species learned on demand, keyed like the built-in guide entries.
      if (!db.objectStoreNames.contains("species")) db.createObjectStore("species", { keyPath: "key" });
      // Household preferences — one record, synced. See loadPrefs().
      if (!db.objectStoreNames.contains("prefs")) db.createObjectStore("prefs", { keyPath: "id" });
      // The fertilizer shelf: what's owned, what's needed, synced. (v5)
      if (!db.objectStoreNames.contains("ferts")) db.createObjectStore("ferts", { keyPath: "id" });
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

// Synced mutations: write locally, stamp updatedAt, queue for cloud push.
// (queuePush/queueDelete are no-ops until sync is configured — see sync.js.)
async function saveRecord(store, rec) {
  rec.updatedAt = new Date().toISOString();
  await dbPut(store, rec);
  await queuePush(store, rec.id);
  return rec;
}
async function removeRecord(store, id) {
  await dbDel(store, id);
  await queueDelete(store, id);
}

// ---------------------------------------------------------------------------
// Settings / household profiles
// ---------------------------------------------------------------------------
// waterDays: Sunday and Wednesday by default — twice a week, so nothing waits
// more than four days, and no watering lands on a weekday morning.
const state = { settings: { users: ["Lucas", "Kelly"], activeUser: "Lucas", lastNotified: "", waterDays: [0, 3], rooms: ["Living room", "Kitchen", "Bedroom", "Bathroom", "Office", "Porch"] } };

/* Settings are split in two, because they aren't all the same kind of thing.

   Device settings — the Anthropic key, the Supabase credentials, which of you
   is using this phone — belong to the phone and must never go on the wire.
   Household preferences — watering days, rooms, who lives here — are shared
   decisions, and a shared garden where the two of you see different due dates
   isn't shared at all.

   So the household half lives in its own record that syncs like a plant does,
   last-write-wins on updatedAt. `state.settings` stays the single runtime
   view: device settings load first, the household record is layered on top. */
const HOUSEHOLD_KEYS = ["waterDays", "rooms", "users"];
const PREFS_ID = "household";
// The shipped values, captured before any stored settings are layered on, so
// "has this device got an opinion of its own?" can be answered later.
const DEFAULT_PREFS = JSON.parse(JSON.stringify(
  Object.fromEntries(HOUSEHOLD_KEYS.map(k => [k, state.settings[k]]))));

async function loadSettings() {
  const row = await dbGet("settings", "main");
  if (row) state.settings = Object.assign(state.settings, row.value);
  await loadPrefs();
  await migrateSettings();
}

// Layer the shared record over the device's own copy.
async function loadPrefs() {
  const prefs = await dbGet("prefs", PREFS_ID);
  if (!prefs) return;
  for (const k of HOUSEHOLD_KEYS) {
    if (prefs[k] !== undefined) state.settings[k] = prefs[k];
  }
}

/* Publish the household half. Called wherever one of those choices changes;
   `saveSettings` also calls it, so nothing has to remember to. */
async function savePrefs() {
  const existing = await dbGet("prefs", PREFS_ID);

  /* A device still on the factory defaults has nothing to say, and saying it
     is actively harmful: joining a garden runs saveSettings to store the
     connection, which would create a defaults record stamped now — newer than
     the established phone's real one, so last-write-wins hands the household
     a set of defaults and the joining phone never sees the real choices.
     Silence until this device actually has an opinion. */
  if (!existing && HOUSEHOLD_KEYS.every(k => sameValue(state.settings[k], DEFAULT_PREFS[k]))) return;

  const rec = existing || { id: PREFS_ID };
  let changed = false;
  for (const k of HOUSEHOLD_KEYS) {
    if (!sameValue(rec[k], state.settings[k])) { rec[k] = state.settings[k]; changed = true; }
  }
  // Only write when something actually differs: saveRecord stamps updatedAt and
  // queues a push, so writing unconditionally would have the two phones
  // ping-ponging an unchanged record every time either of them saved anything.
  if (changed) await saveRecord("prefs", rec);
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* A household record arriving from the other phone. The sync layer has already
   decided it's newer, so adopt it and redraw — a watering day changed on
   Kelly's phone should move the due dates here without a reload. */
async function adoptRemotePrefs(rec) {
  let changed = false;
  for (const k of HOUSEHOLD_KEYS) {
    if (rec[k] !== undefined && JSON.stringify(state.settings[k]) !== JSON.stringify(rec[k])) {
      state.settings[k] = rec[k];
      changed = true;
    }
  }
  // Mirror into the device record so the value survives a restart offline.
  if (changed) await dbPut("settings", { key: "main", value: state.settings });
  return changed;
}

/* Saved settings shadow the defaults, so changing a default alone never
   reaches a device that has already stored the old value. Renames need a
   migration, and they need to be idempotent — this runs on every load. */
async function migrateSettings() {
  let changed = false;
  const RENAMES = { Partner: "Kelly" };
  for (const [from, to] of Object.entries(RENAMES)) {
    const i = (state.settings.users || []).indexOf(from);
    // Skip if the new name is already there, so a manual rename isn't undone.
    if (i !== -1 && !state.settings.users.includes(to)) {
      state.settings.users[i] = to;
      if (state.settings.activeUser === from) state.settings.activeUser = to;
      changed = true;
    }
  }
  if (changed) {
    await saveSettings();
    await renameInHistory(RENAMES);
  }
  await migrateFeedingSchedules();

  // One-time: bring plants that were on sub-rhythm schedules onto the twice-
  // weekly rhythm. Flagged so it never fights a later manual edit — changing
  // watering days afterwards re-applies it from Settings, on request.
  if (!state.settings.waterRhythmApplied) {
    const moved = await applyWaterRhythm();
    state.settings.waterRhythmApplied = true;
    await saveSettings();
    if (moved.length) console.info("Sprout: moved onto the watering rhythm —", moved);
  }
}

/* A plant copies its schedule out of the guide when it's added, so correcting
   the guide leaves every plant already in the app on the old number.

   Only schedules still sitting on the old guide default get moved — if the
   value has been changed since, by hand or by a health check, it's a decision
   and stays put. Keyed by the old value so this is safe to run every launch.
   Once these species have aged out of everyone's app this can go. */
const FEEDING_CORRECTIONS = {
  // Mediterranean herbs: lean soil is what keeps the oils strong.
  rosemary: [30, 60], sage: [30, 60], thyme: [30, 60],
  oregano: [30, 60], marjoram: [30, 60], tarragon: [30, 60],
  salvia: [30, 60], lavender: [45, 0],
  // Legumes fix their own nitrogen; feeding buys leaves instead of pods.
  peas: [30, 0], "green-beans": [30, 0],
  // A root crop fed on nitrogen forks and goes hairy.
  carrot: [30, 0],
  // Poor soil is what makes it flower.
  "moss-rose": [30, 60],
  // Hungry growers that were on a generic monthly default.
  ginger: [30, 21], turmeric: [30, 21], amaryllis: [30, 21], bonsai: [30, 14],
};

async function migrateFeedingSchedules() {
  const plants = await dbAll("plants");
  for (const p of plants) {
    const fix = FEEDING_CORRECTIONS[p.speciesKey];
    if (!fix || p.fertEvery !== fix[0]) continue;
    p.fertEvery = fix[1];
    await saveRecord("plants", p);
  }
}

// History carries the name it was written with; leaving it behind would mean
// "watered by Partner" under a person called Kelly.
async function renameInHistory(renames) {
  for (const store of ["logs", "tasks"]) {
    for (const rec of await dbAll(store)) {
      const to = renames[rec.by];
      if (!to) continue;
      rec.by = to;
      await saveRecord(store, rec);
    }
  }
}
async function saveSettings() {
  await dbPut("settings", { key: "main", value: state.settings });
  // Anything household-level in that save goes out to the other phone too.
  await savePrefs();
  renderProfileChip();
}
function renderProfileChip() {
  document.getElementById("profileBtn").textContent = state.settings.activeUser;
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
// Compact by design — these sit in one-line rows that must not truncate.
function dueLabel(dueStr) {
  const n = daysBetween(todayStr(), dueStr);
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return "due today";
  if (n === 1) return "due tomorrow";
  return `due in ${n}d`;
}

// Due date for an action on a plant. Falls back to createdAt if never done.
// Outdoor plants' watering interval flexes with the season (weather.js).
/* Watering days.

   Left to itself, a collection of any size puts something on the list every
   single day, which nobody actually does. Instead watering collects onto
   chosen days of the week: on a watering day you do everything that would
   otherwise come due before the next one.

   Empty means no batching — every plant on its own natural day. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Where plants without a room land. Shared so the Today and Plants tabs agree,
// and so it sorts last in both.
const NO_ROOM = "No room set";

function waterDays() {
  const d = state.settings.waterDays;
  return Array.isArray(d) ? [...new Set(d.filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : [];
}

// The longest run between consecutive watering days — twice a week is a 3-day
// gap and a 4-day one, so 4 is what a plant has to survive.
function maxWaterGap(days) {
  if (!days.length) return Infinity;
  let max = 0;
  for (let i = 0; i < days.length; i++) {
    const next = days[(i + 1) % days.length];
    max = Math.max(max, i === days.length - 1 ? 7 - days[i] + next : next - days[i]);
  }
  return max;
}

/* Move a watering date onto the rhythm.

   Backwards by preference: a little early is harmless, whereas a plant left
   dry past its day is the failure the schedule exists to prevent. A plant
   that needs water more often than the rhythm's longest gap can't be served
   by it at all, so it keeps its own schedule.

   One exception to backwards: when the backward snap would land in the past,
   a plant that isn't even due yet would surface as "overdue" — a deck full
   of invented work on a day that isn't a watering day at all, which is the
   opposite of what a rhythm promises. A not-yet-due plant rolls forward to
   the next watering day instead; the floor rule (interval ≥ longest gap)
   is exactly what makes that bounded wait safe. Genuinely overdue stays
   overdue — that work is real. */
function snapToWaterDay(dateStr, every) {
  const days = waterDays();
  if (!days.length || every < maxWaterGap(days)) return dateStr;
  const d = new Date(dateStr + "T12:00:00");
  for (let i = 0; i < 7; i++) {
    if (days.includes(d.getDay())) break;
    d.setDate(d.getDate() - 1);
  }
  const snapped = d.toISOString().slice(0, 10);
  if (snapped >= todayStr() || dateStr < todayStr()) return snapped;
  const f = new Date(dateStr + "T12:00:00");
  for (let i = 0; i < 7; i++) {
    if (days.includes(f.getDay())) break;
    f.setDate(f.getDate() + 1);
  }
  return f.toISOString().slice(0, 10);
}

/* Raise anything that wants water more often than the rhythm can give it.

   Snapping alone can't help a plant on a 2-day schedule: it needs attention
   between watering days, so it stays off the rhythm and keeps putting itself
   on the list mid-week. Moving it up to the rhythm's longest gap is what
   actually makes twice a week the whole story.

   The comparison uses the interval as it is actually lived: outdoor plants
   run tighter in summer (seasonFactor), so a pot raised to the bare floor in
   August would be shrunk right back below it at render time and fall off the
   rhythm the moment the button was pressed — which read, correctly, as "this
   button does nothing". The raw interval is raised until the seasonal
   effective interval clears the floor.

   Only ever raises — a cactus on 90 days is left alone. */
async function applyWaterRhythm() {
  const floor = maxWaterGap(waterDays());
  if (!Number.isFinite(floor)) return [];
  const changed = [];
  for (const p of await dbAll("plants")) {
    if (p.archived || !p.waterEvery) continue;
    const factor = isOutdoorPlant(p) ? seasonFactor() : 1;
    const lived = e => Math.max(1, Math.round(e * factor));
    if (lived(p.waterEvery) >= floor) continue;
    let raw = Math.max(p.waterEvery + 1, Math.ceil(floor / factor));
    while (lived(raw) < floor) raw++;
    changed.push({ name: p.name, from: p.waterEvery, to: raw });
    p.waterEvery = raw;
    await saveRecord("plants", p);
  }
  return changed;
}

function isWateringDay(dateStr = todayStr()) {
  const days = waterDays();
  return !days.length || days.includes(new Date(dateStr + "T12:00:00").getDay());
}

function nextDue(plant, kind) {
  let every = kind === "water" ? plant.waterEvery : plant.fertEvery;
  if (!every) return null; // schedule disabled
  if (kind === "water" && isOutdoorPlant(plant)) {
    every = Math.max(1, Math.round(every * seasonFactor()));
  }
  const last = kind === "water" ? plant.lastWatered : plant.lastFertilized;
  const base = last || plant.createdAt.slice(0, 10);
  // Fertilizing happens standing at the plant with the can — it belongs on
  // watering days too, or the calendar keeps sprouting lone mid-week chips
  // that the rhythm was supposed to have cleared away.
  let due = snapToWaterDay(addDays(base, every), every);
  /* "Checked — soil still wet" holds the whole visit without faking one:
     lastWatered stays honest and the due date waits out the snooze instead.
     It holds BOTH kinds — feeding happens through the watering can, so a
     fertilizing that's due can't happen while the watering is on hold.
     Forward-snapped onto the rhythm, never backward — a hold that lands the
     plant back on today's list would be no hold at all. An expired snooze is
     simply outrun by the natural due date. */
  if (plant.waterSnooze && plant.waterSnooze > due) {
    due = snapForwardToWaterDay(plant.waterSnooze, every);
  }
  return due;
}

function snapForwardToWaterDay(dateStr, every) {
  const days = waterDays();
  if (!days.length || every < maxWaterGap(days)) return dateStr;
  const d = new Date(dateStr + "T12:00:00");
  for (let i = 0; i < 7; i++) {
    if (days.includes(d.getDay())) break;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/* The soil got checked and it's still wet. Log the check (it's real care,
   and the AI reads it — a plant repeatedly still-wet on its due day is how
   an interval learns it's too short) and hold the watering for two days. */
async function skipWatering(plantId, date = todayStr()) {
  const plant = await dbGet("plants", plantId);
  if (!plant) return null;
  plant.waterSnooze = addDays(date, 2);
  await saveRecord("plants", plant);
  await saveRecord("logs", {
    id: uid(), plantId, type: "check", at: date === todayStr()
      ? new Date().toISOString() : new Date(date + "T12:00:00").toISOString(),
    by: state.settings.activeUser, note: "soil still wet, held off watering",
  });
  return nextDue(plant, "water");
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
/* `date` lets care be logged on the day it actually happened, not the day it
   got written down — "I watered everything Tuesday" on Thursday. A backdated
   watering never moves lastWatered backwards: the newest real watering is
   what the schedule runs on. */
async function logAction(plantId, type, note = "", { date = todayStr(), quiet = false } = {}) {
  const plant = await dbGet("plants", plantId);
  if (!plant) return;
  const at = date === todayStr()
    ? new Date().toISOString()
    : new Date(date + "T12:00:00").toISOString();
  if (type === "water" && (!plant.lastWatered || date > plant.lastWatered)) plant.lastWatered = date;
  if (type === "water") delete plant.waterSnooze; // a real watering ends any hold
  if (type === "fertilize" && (!plant.lastFertilized || date > plant.lastFertilized)) plant.lastFertilized = date;
  await saveRecord("plants", plant);
  await saveRecord("logs", { id: uid(), plantId, type, at, by: state.settings.activeUser, note });
  const verbs = { water: "Watered", fertilize: "Fertilized", repot: "Repotted", prune: "Pruned", note: "Noted" };
  if (!quiet) toast(`${verbs[type] || type} ${plant.name}`);
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
/* An object URL pins its blob in memory until it is revoked; dropping the
   <img> that used it is not enough. The plant screens mint one per photo on
   every render, and swiping between plants re-renders constantly, so browsing
   the collection leaked a full-size photo per card. These are handed out for
   the current view and released when it is replaced. */
let viewURLs = [];
function viewURL(blob) {
  const url = URL.createObjectURL(blob);
  viewURLs.push(url);
  return url;
}
function releaseViewURLs() {
  viewURLs.forEach(u => URL.revokeObjectURL(u));
  viewURLs = [];
}

/* Sizing a canvas to 0 is what actually frees its pixel buffer — dropping the
   reference leaves it allocated until the collector runs, which on a phone
   mid-upload is too late to matter. */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

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
      canvas.toBlob(b => {
        // A phone photo decodes to ~50MB of pixels, and a bulk upload does this
        // once per file. Dropping the backing store and the decoded image the
        // moment we have the JPEG keeps the peak to one photo at a time rather
        // than however many the collector hasn't got round to yet.
        releaseCanvas(canvas);
        img.src = "";
        b ? resolve(b) : reject(new Error("encode failed"));
      }, "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

/* The one place a photo the user supplied gets stored. Every entry point goes
   through here — the add form, the photo journal — so a new photo always
   triggers a health check and the next entry point added can't forget to.

   `assess: false` is for callers saving several photos in one go: they fire a
   single check once everything is saved, since an assessment reads the newest
   few photos anyway and one call per file would be pure waste. The backup
   restore writes photo records directly and deliberately doesn't come through
   here — re-importing a collection shouldn't fire a check per plant.

   `resize: false` is for a blob that's already been through resizeImage(). */
/* `batch` ties photos picked in one go into one journal entry — five angles
   of the same plant on the same afternoon are one visit, not five. */
async function addPhoto(plantId, file, { assess = true, resize = true, batch = null } = {}) {
  const blob = resize ? await resizeImage(file) : file;
  const rec = { id: uid(), plantId, blob, createdAt: new Date().toISOString() };
  if (batch) rec.batch = batch;
  await saveRecord("photos", rec);
  if (assess) autoAssess(plantId);
}

async function latestPhotoURL(plantId) {
  const photos = (await dbAllByIndex("photos", "plantId", plantId)).filter(p => p.blob);
  if (!photos.length) return null;
  photos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return viewURL(photos[0].blob);
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

/* A tap you can feel. Android has navigator.vibrate; iPhone Safari has no
   vibration API at all, but toggling a real switch control plays the OS's
   switch haptic (iOS 17.4+) — one fixed tick, which is the entire vocabulary
   available there. Browsers with neither toggle an invisible checkbox and
   feel nothing, which is the right fallback: silence, not breakage. */
/* Overlay discipline. Every sheet in the app — the card sheet, the plant
   chat, the log-activity sheet, the photo viewer — closes the same four
   ways: its ✕, its backdrop, the Escape key, and the phone's back gesture.
   The back gesture is the one that needs machinery: opening an overlay
   pushes a history entry, so "back" pops the overlay instead of leaving the
   screen. One overlay is ever open at a time. The page behind is
   scroll-locked while one is up. */
let activeOverlay = null;

function overlayOpened(el, doClose) {
  activeOverlay = { el, doClose };
  document.body.classList.add("overlay-open");
  history.pushState({ sproutOverlay: true }, "");
}

/* Called from an overlay's own close path. Pops the entry the open pushed —
   unless history itself is what closed us, in which case it's already gone. */
function overlayClosed(el, { viaHistory = false } = {}) {
  if (!activeOverlay || activeOverlay.el !== el) return;
  activeOverlay = null;
  document.body.classList.remove("overlay-open");
  if (!viaHistory && history.state && history.state.sproutOverlay) history.back();
}

window.addEventListener("popstate", () => {
  if (!activeOverlay) return;
  const o = activeOverlay;
  activeOverlay = null;
  document.body.classList.remove("overlay-open");
  o.doClose();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && activeOverlay) activeOverlay.doClose();
});

let hapticSwitch = null;
function buzz(pattern = 10) {
  try {
    if (navigator.vibrate && navigator.vibrate(pattern)) return;
  } catch { /* blocked by permissions policy — fall through */ }
  if (!hapticSwitch) {
    const holder = document.createElement("label");
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:fixed;top:-40px;left:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    holder.innerHTML = `<input type="checkbox" switch tabindex="-1">`;
    document.body.appendChild(holder);
    hapticSwitch = holder.querySelector("input");
  }
  hapticSwitch.click();
}
/* The built-in guide plus everything learned on demand.

   PLANT_GUIDE ships with the app; LEARNED comes from the database and syncs
   between phones, so a species looked up on one is present on the other. The
   built-in entry wins on a key collision — it was curated, and a plant already
   referencing that key expects it. */
let LEARNED = [];

function allSpecies() {
  if (!LEARNED.length) return PLANT_GUIDE;
  const known = new Set(PLANT_GUIDE.map(g => g.key));
  return PLANT_GUIDE.concat(LEARNED.filter(g => !known.has(g.key)));
}

async function loadLearnedSpecies() {
  try { LEARNED = (await dbAll("species")).filter(g => g && g.key && g.name); }
  catch { LEARNED = []; }
}

// A key has to be stable and unique: plants store it, so a collision would
// silently repoint one plant's care at another species.
function speciesKeyFor(entry) {
  const base = (entry.latin || entry.name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "species";
  const taken = new Set(allSpecies().map(g => g.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${uid()}`;
}

async function saveLearnedSpecies(entry) {
  const rec = { ...entry, key: entry.key || speciesKeyFor(entry), learnedAt: new Date().toISOString() };
  await saveRecord("species", rec);
  LEARNED = LEARNED.filter(g => g.key !== rec.key).concat(rec);
  return rec;
}

function guideEntry(key) {
  const all = allSpecies();
  return all.find(g => g.key === key) || all.find(g => g.key === "other");
}
function plantEmoji(p) { return guideEntry(p.speciesKey).emoji; }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// ----- Today -----
/* Where the collection stands right now: the average of every plant that has
   been checked. Plants without a score aren't counted as zero — they're
   unknown, and reported separately so the average can't quietly be an average
   of two plants out of twenty. */
function gardenHealth(plants) {
  const scored = plants.filter(p => !p.archived && p.health && typeof p.health.score === "number");
  const live = plants.filter(p => !p.archived);
  if (!scored.length) return { scored: 0, total: live.length, avg: null };
  const avg = scored.reduce((s, p) => s + p.health.score, 0) / scored.length;
  const band = avg >= 8 ? "Thriving" : avg >= 6.5 ? "Healthy" : avg >= 5 ? "Fair" : "Needs attention";
  return { scored: scored.length, total: live.length, avg, band, ailing: scored.filter(p => p.health.score <= 5).length };
}

/* Average health per day, from the health checks actually recorded.

   Every check writes a log with a score, so the history is already there. A
   day's value is the mean of the checks made that day — not of every plant,
   since most plants aren't checked on most days, and carrying forward stale
   scores would draw a confident line through data that doesn't exist. */
function healthSeries(logs, days = 90) {
  const cutoff = addDays(todayStr(), -days);
  const byDay = new Map();
  for (const l of logs) {
    if (l.type !== "ai" || typeof l.score !== "number") continue;
    const day = l.at.slice(0, 10);
    if (day < cutoff) continue;
    const at = byDay.get(day) || [];
    at.push(l.score);
    byDay.set(day, at);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, scores]) => ({ date, avg: scores.reduce((s, n) => s + n, 0) / scores.length }));
}

/* A sparkline, drawn only when there is something to draw.

   Two points is the minimum that can honestly be called a trend; below that
   the caller shows the score alone. Fixed 0-10 domain rather than fitting to
   the data, so a wobble between 7.1 and 7.4 looks like the flat line it is
   instead of a dramatic climb. */
function healthSparkline(series) {
  if (series.length < 2) return "";
  const w = 240, h = 44, pad = 3;
  const x = i => pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = v => pad + (1 - v / 10) * (h - pad * 2);
  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d.avg).toFixed(1)}`);
  const last = series[series.length - 1];
  return `
    <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="spark-fill" points="${pad},${h - pad} ${pts.join(" ")} ${w - pad},${h - pad}"></polygon>
      <polyline class="spark-line" points="${pts.join(" ")}"></polyline>
      <circle class="spark-dot" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="2.8"></circle>
    </svg>`;
}

async function viewToday() {
  const plants = await dbAll("plants");
  const hasOutdoor = plants.some(p => !p.archived && isOutdoorPlant(p));
  const wx = hasOutdoor ? await getWeather() : null;
  const wxFlags = wx ? todayWeatherFlags(wx) : {};
  const care = computeCareTasks(plants);
  const overdue = care.filter(t => t.delta < 0);
  const dueToday = care.filter(t => t.delta === 0);
  // Assessments from before steps landed automatically come through once here.
  for (const p of plants) if (p.health && !p.health.tasked) await materializeHealthTasks(p);
  const custom = (await dbAll("tasks")).sort((a, b) => a.done - b.done || b.createdAt.localeCompare(a.createdAt));

  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // Weather sits in the corner of the greeting rather than in a card of its
  // own: on most days it's a glance, and the advisories below carry anything
  // that actually needs acting on.
  const cur = wx ? (wx.current || {}) : null;
  const wxCorner = hasOutdoor && wx && typeof cur.temperature_2m === "number"
    ? `<a class="wx-chip" href="#/settings" title="${esc(state.settings.weather.label || "your spot")}">
         <span class="wx-chip-icon">${wxEmoji(cur.weather_code)}</span>${Math.round(cur.temperature_2m)}°
       </a>`
    : "";

  const gh = gardenHealth(plants);
  const allLogs = await dbAll("logs");
  const series = healthSeries(allLogs);
  const spark = healthSparkline(series);

  let html = `
    <div class="today-head">
      <div>
        <h1 class="greeting">${greeting}, <b>${esc(state.settings.activeUser)}</b></h1>
        <p class="subtitle">${dateLine}</p>
      </div>
      ${wxCorner}
    </div>`;

  /* Porch weather sits BELOW the deck now, with the rest of the status. The
     cards are what this screen is for — nothing renders between the greeting
     and the first card. Actionable warnings (frost, heat, rain) still earn
     their space down there; anything already covered by the row tags and the
     week view stays out entirely. */
  let wxBlock = "";
  if (hasOutdoor) {
    if (!weatherConfigured()) {
      wxBlock = `<div class="card flat wx-card">
        <b>Porch weather</b>
        <p class="subtitle" style="margin:6px 0 10px">Set your location once and your porch plants get live rain, heat, and frost advice.</p>
        <a class="btn small secondary" href="#/settings">Set location in Settings</a>
      </div>`;
    } else if (wx) {
      // Only advisories earn space, and only when there is one — "nothing
      // dramatic in the forecast" was a card's worth of furniture saying nothing.
      const advisories = weatherAdvisories(wx);
      if (advisories.length) {
        wxBlock = `<div class="card flat wx-card">
          ${advisories.map(a => `<div class="wx-advice">${a.icon} ${esc(a.text)}</div>`).join("")}
        </div>`;
      }
    } else {
      wxBlock = `<div class="card flat wx-card"><b>Porch weather</b><p class="subtitle" style="margin:6px 0 0">Couldn't reach the weather service — using your normal schedule for now.</p></div>`;
    }
  }

  /* One agenda: room by room, plant by plant.

     Care tasks, the household checklist and the plants needing a look used to
     be three lists in three places, so knowing what to do meant reading all of
     them and holding the overlap in your head. They are the same question —
     what needs doing — and they are answered together here, in the order you
     would physically walk it.

     Ordering carries the urgency the old headings used to: rooms worst-first,
     plants worst-first inside a room, and within a plant the overdue watering
     above the note someone left.

     Everything dealt is doable today and clears with a tap — that is the
     deck's contract. The goal of the screen is an empty deck by evening, so
     nothing undated, unfinishable, or scheduled for another day gets a card:
     a task due Thursday appears Thursday, a rotation resurfaces on its
     rhythm, and the old "Needs a look" row (a link, not an action) is gone —
     a struggling plant's card now carries the actual steps, because every
     assessment materializes them onto the checklist itself.

     Recommendations ride cards; they never summon one. A card exists because
     the plant needs care today or a person put something on the list — the
     AI's steps then come along for the visit, which is where they belong:
     "check the leaf joints for mealybugs" is a thing you do standing at the
     plant with the can in your hand, not a reason to walk over on a day it
     needs nothing. A step whose day has come simply waits, dealt with the
     plant's next care visit. (If a plant has no care schedule at all, its
     steps do summon — otherwise they'd wait forever.) */
  const AGENDA_ORDER = { care: 0, task: 1 };

  const buildAgenda = () => {
    const rows = [];
    const summoned = new Set();
    for (const t of care) {
      if (t.delta > 0) continue;
      let wxTag = "";
      if (t.kind === "water" && isOutdoorPlant(t.plant)) {
        if (wxFlags.rainToday) wxTag = ` · <span class="wx-tag">rain may cover this</span>`;
        else if (wxFlags.hotToday) wxTag = ` · <span class="wx-tag hot">hot — don't skip</span>`;
      }
      summoned.add(t.plant.id);
      rows.push({ kind: "care", t, wxTag, plant: t.plant, urgency: AGENDA_ORDER.care + Math.min(0, t.delta) });
    }
    const byId = new Map(plants.filter(p => !p.archived).map(p => [p.id, p]));
    const open = custom.filter(t => !t.done && !(t.due && t.due > todayStr()));
    for (const task of open) {
      if (task.by !== "Sprout AI") summoned.add(task.plantId);
    }
    for (const task of open) {
      /* "Anything else" is for chores that were never about a plant. A task
         whose plant is archived waits with the plant; one whose plant is gone
         is an orphan (the boot sweep resolves those) — neither is dealt. */
      if (task.plantId && !byId.has(task.plantId)) continue;
      const plant = byId.get(task.plantId) || null;
      if (task.by === "Sprout AI" && plant && !summoned.has(plant.id) &&
          (nextDue(plant, "water") || nextDue(plant, "fertilize"))) continue;
      rows.push({ kind: "task", task, plant, urgency: AGENDA_ORDER.task });
    }
    return rows;
  };

  /* Group into room → plant. A checklist item with no plant attached ("buy
     potting soil") belongs to the household rather than to a room, so it
     collects at the end instead of being filed under someone's guess. */
  const LOOSE = "\u0000loose";

  /* The stack: every remaining card, visibly queued.

     One-card-at-a-time hid the shape of the day — you couldn't see how much
     was left or what was coming. The stack shows the whole queue, worst room
     first, one compact card per plant: photo, name, health, and its jobs as
     pills. Swiping works per card — left sends it to the bottom of the queue,
     right opens the camera for a fresh photo (which runs a health check) —
     and tapping opens the full detail sheet where the long-form advice
     lives. The room chips filter the queue, because you work one room at a
     time and the rest is noise while you're in it. */
  const buildStack = () => {
    const rows = buildAgenda();
    const byPlant = new Map();
    for (const r of rows) {
      const key = r.plant ? r.plant.id : LOOSE;
      if (!byPlant.has(key)) {
        byPlant.set(key, {
          plant: r.plant,
          room: r.plant ? ((r.plant.location || "").trim() || NO_ROOM) : LOOSE,
          rows: [],
        });
      }
      byPlant.get(key).rows.push(r);
    }
    const cards = [...byPlant.values()];
    /* "Water until it runs freely, then empty the saucer" is not a second
       job next to Water — it's how to do the watering. A health step whose
       kind is water or fertilize folds into that care row as a hint when the
       row is on the card; completing the row completes the hint. Without a
       matching row it stands alone, as before. */
    for (const c of cards) {
      const careOf = kind => c.rows.find(r => r.kind === "care" && r.t.kind === kind);
      c.rows = c.rows.filter(r => {
        if (r.kind !== "task" || !isHealthStep(r.task)) return true;
        const host = (r.task.kind === "water" || r.task.kind === "fertilize") ? careOf(r.task.kind) : null;
        if (!host) return true;
        (host.hints = host.hints || []).push(r.task);
        return false;
      });
      c.rows.sort((a, b) => a.urgency - b.urgency);
      c.urgency = Math.min(...c.rows.map(r => r.urgency));
    }
    // Same order the list used: worst room first, worst plant inside it, and
    // the unattached checklist last.
    const roomWorst = new Map();
    for (const c of cards) {
      const cur = roomWorst.get(c.room);
      if (cur === undefined || c.urgency < cur) roomWorst.set(c.room, c.urgency);
    }
    const rank = room => room === LOOSE ? 2 : room === NO_ROOM ? 1 : 0;
    cards.sort((a, b) =>
      rank(a.room) - rank(b.room) ||
      roomWorst.get(a.room) - roomWorst.get(b.room) ||
      a.room.localeCompare(b.room) ||
      a.urgency - b.urgency ||
      (a.plant ? a.plant.name : "").localeCompare(b.plant ? b.plant.name : ""));

    /* Finishing a plant must not march you into another room while you are
       still standing in this one. Ordering rooms by their worst plant is right
       for the first deal and wrong from then on: watering the worst plant in
       the room drops that room's rank and the deck jumps you elsewhere with
       its neighbour still unwatered. So the room you're working stays at the
       front until it's clear. Stable sort, so everything else holds. */
    if (todayLastRoom && cards.some(c => c.room === todayLastRoom)) {
      cards.sort((a, b) => (a.room === todayLastRoom ? 0 : 1) - (b.room === todayLastRoom ? 0 : 1));
    }
    // Skipped cards sink to the bottom, in the order they were skipped.
    if (todayLater.length) {
      const laterRank = c => { const i = todayLater.indexOf(cardKey(c)); return i === -1 ? -1 : i; };
      cards.sort((a, b) => laterRank(a) - laterRank(b));
    }
    return cards;
  };

  const cardKey = c => c.plant ? c.plant.id : "loose";

  const roomLabel = room => room === LOOSE ? "Anything else" : room;

  // A pill is the compressed form of a job: verb for care, clipped title for
  // a note. The full sentence lives one tap away in the sheet — a card you
  // can read at arm's length beats a card that says everything.
  const pillFor = r => {
    if (r.kind === "care") {
      const verb = r.t.kind === "water" ? "Water" : "Fertilize";
      return `<button class="job ${r.t.kind}${r.t.delta < 0 ? " late" : ""}" data-plant="${r.t.plant.id}" data-kind="${r.t.kind}">
        ${r.t.kind === "water" ? "💧" : "🌾"} ${verb}${r.t.delta < 0 ? ` · ${-r.t.delta}d late` : ""}</button>`;
    }
    const icon = r.task.by === "Sprout AI" ? (ACTION_ICONS[r.task.kind] || "✦") : "📝";
    return `<button class="job chore${r.task.repeatDays ? " repeat" : ""}" data-task="${r.task.id}">
      ${icon} <span class="job-clip">${esc(r.task.title)}</span>${r.task.repeatDays ? " ↻" : ""}</button>`;
  };

  const stack = buildStack();
  // Rooms offered are the ones with work in them — a chip for a room that
  // needs nothing is a dead end.
  const rooms = [];
  for (const c of stack) if (!rooms.includes(c.room)) rooms.push(c.room);
  if (todayRoom && !rooms.includes(todayRoom)) todayRoom = "";
  const visible = todayRoom ? stack.filter(c => c.room === todayRoom) : stack;

  /* Progress is what makes "clear the deck" a game you can win: everything
     completed today over everything the day asked for. Distinct plant+kind
     for care (watering twice is not two chores), tasks by their updatedAt. */
  const careDoneToday = new Set(allLogs
    .filter(l => (l.type === "water" || l.type === "fertilize") && l.at.slice(0, 10) === todayStr())
    .map(l => l.plantId + "/" + l.type)).size;
  const tasksDoneToday = custom.filter(t => t.done && (t.updatedAt || "").slice(0, 10) === todayStr()).length;
  const doneCount = careDoneToday + tasksDoneToday;
  const openCount = stack.reduce((n, c) => n + c.rows.length, 0);
  const dayTotal = doneCount + openCount;

  const cardStack = async () => {
    if (!stack.length) return "";
    const parts = [];
    for (const card of visible) {
      const late = card.rows.filter(r => r.kind === "care" && r.t.delta < 0);
      const worst = late.length ? Math.min(...late.map(r => r.t.delta)) : null;
      const photo = card.plant ? await latestPhotoURL(card.plant.id) : null;
      const lastW = card.plant && card.plant.lastWatered
        ? `Watered ${daysBetween(card.plant.lastWatered, todayStr()) === 0 ? "today" : daysBetween(card.plant.lastWatered, todayStr()) + "d ago"}`
        : "";
      parts.push(`
      <div class="deck-card" data-card="${esc(cardKey(card))}">
        <span class="deck-stamp is-photo" aria-hidden="true">📷 Photo</span>
        <span class="deck-stamp is-later" aria-hidden="true">Skip</span>
        <div class="deck-photo">
          ${photo ? `<img src="${photo}" alt="" draggable="false">`
                  : `<div class="deck-photo-none">${card.plant ? plantEmoji(card.plant) : "📋"}</div>`}
          ${card.plant ? `<span class="deck-room-badge">${esc(roomLabel(card.room))}</span>` : ""}
          ${worst !== null ? `<span class="deck-flag">${-worst}d overdue</span>` : ""}
          ${card.plant ? `<button class="deck-cam" data-cam="${card.plant.id}" aria-label="Take a photo">📷</button>` : ""}
        </div>
        <div class="deck-body">
          <div class="deck-head">
            <div class="deck-title">
              <h2 class="deck-name">${card.plant ? esc(card.plant.name) : "Anything else"}</h2>
              <p class="deck-sub">${card.plant
                ? esc(card.plant.species || guideEntry(card.plant.speciesKey).name)
                : "Not tied to a plant"}</p>
            </div>
            <div class="deck-meta">
              ${card.plant && card.plant.health ? healthChip(card.plant.health) : ""}
              ${lastW ? `<span class="deck-lastw">${lastW}</span>` : ""}
            </div>
          </div>
          <div class="deck-pills">${card.rows.map(pillFor).join("")}</div>
        </div>
      </div>`);
    }

    return `
      <div class="deck-bar">
        <div class="room-chips">
          ${rooms.length > 1 ? `<button class="room-chip${todayRoom ? "" : " active"}" data-room="">All · ${stack.length}</button>` : ""}
          ${rooms.map(r => `<button class="room-chip${todayRoom === r ? " active" : ""}${rooms.length === 1 ? " active" : ""}" data-room="${esc(r)}">${
            esc(roomLabel(r))} · ${stack.filter(c => c.room === r).length}</button>`).join("")}
        </div>
      </div>
      <div class="deck-progress">
        <div class="deck-progress-bar"><i style="width:${dayTotal ? Math.round(doneCount / dayTotal * 100) : 0}%"></i></div>
        <span class="deck-count">${visible.length} left</span>
      </div>

      <div class="deck" id="deck">${parts.join("")}</div>
      <input type="file" id="deckCam" accept="image/*" capture="environment" hidden>
      <p class="deck-hint">Tap a pill to do it · tap the card for the full story · swipe right for a photo, left to skip</p>`;
  };

  html += await cardStack();
  html += wxBlock;

  /* Status, not action — so it sits under the card rather than above it.
     The point of this screen is the plant in front of you; how the collection
     is doing overall is what you read once that's dealt with, and a summary
     above the deck pushes the card itself below the fold. */
  if (gh.total) {
    html += `
      <div class="card flat garden-card">
        <div class="garden-main">
          <div class="garden-figure">
            <div class="garden-score">${gh.avg === null ? "—" : gh.avg.toFixed(1)}</div>
            <div class="garden-band">${gh.avg === null ? "Not checked yet" : esc(gh.band)}</div>
          </div>
          ${spark || ""}
        </div>
        <div class="garden-stats">
          <span><b>${gh.total}</b> plant${gh.total === 1 ? "" : "s"}</span>
          <span class="${overdue.length ? "is-overdue" : ""}"><b>${overdue.length}</b> overdue</span>
          <span><b>${dueToday.length}</b> due today</span>
          ${gh.avg === null
            ? `<span class="garden-muted">no health checks yet</span>`
            : gh.scored < gh.total
              ? `<span class="garden-muted">${gh.scored} of ${gh.total} checked</span>`
              : ""}
        </div>
      </div>`;
  }



  // Week-at-a-glance: which plants need water/fertilizer on each of the next 7 days
  if (plants.some(p => !p.archived)) {
    const weekRows = [];
    for (let i = 0; i < 7; i++) {
      const list = i === 0 ? care.filter(t => t.delta <= 0) : care.filter(t => t.delta === i);
      const d = new Date(); d.setDate(d.getDate() + i);
      const ds = addDays(todayStr(), i);
      const label = i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
      // Scheduled checklist items too — a task that left today's deck for
      // Thursday should be findable on Thursday, not just gone. Only the
      // human ones: AI steps ride the plant's care visits, and those days
      // are already on this chart as the watering chips.
      const dayTasks = custom.filter(t => !t.done && t.by !== "Sprout AI" && t.due &&
        (i === 0 ? t.due <= ds : t.due === ds));
      const chips = list.map(t =>
        `<span class="badge ${t.delta < 0 ? "overdue" : t.kind === "water" ? "water" : "fertilize"}">${esc(t.plant.name)}</span>`)
        .concat(dayTasks.map(t =>
          `<span class="badge chore">${esc(t.plantName || t.title)}</span>`)).join("");
      const wxLabel = wx ? weekWeatherLabel(wx, i) : "";
      weekRows.push(`<div class="week-row${i === 0 ? " today" : ""}"><div class="week-day">${label}</div><div class="week-chips">${chips || '<span class="week-none">—</span>'}</div>${wxLabel ? `<div class="week-wx">${wxLabel}</div>` : ""}</div>`);
    }
    html += `<h2>This week</h2><div class="card flat">${weekRows.join("")}</div>`;
  }

  if (!plants.some(p => !p.archived)) {
    html += `<div class="empty"><div class="big">🪴</div><p>No plants yet.<br>Tap <b>Add</b> to plant your first one.</p></div>`;
  } else if (!buildAgenda().length) {
    html += `<div class="empty"><div class="big">✓</div><p>All clear for today.<br>Nothing to do until tomorrow's cards.</p></div>`;
  }

  const doneTasks = custom.filter(t => t.done);
  html += `
    <form id="addTaskForm" class="inline-form" style="margin-top:22px">
      <input type="text" id="newTaskTitle" placeholder="Add a task… (buy potting soil)" maxlength="120">
      <button class="btn" type="submit">Add</button>
    </form>
    ${doneTasks.length ? `
      <details class="ai-fold" style="margin-top:14px">
        <summary class="ai-fold-head">
          <span class="ai-fold-title">Done</span>
          <span class="ai-fold-count">${doneTasks.length}</span>
          <span class="ai-fold-chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg></span>
        </summary>
        <div class="ai-fold-body">
          ${doneTasks.map(t => `
            <div class="ag-row is-done" data-task="${t.id}">
              <button class="task-check done" data-action="toggle-task" aria-label="Mark not done">✓</button>
              <div class="ag-main"><div class="ag-title">${esc(t.title)}</div></div>
              <button class="ag-del" data-action="del-task" aria-label="Remove">✕</button>
            </div>`).join("")}
        </div>
      </details>` : ""}`;

  $view().innerHTML = html;

  /* The deck. Everything re-renders after a record changes; a card with
     nothing left on it simply isn't in the next deal, and render() keeps the
     scroll position, so the list just gets shorter under your thumb. */
  const staleSheet = document.getElementById("cardSheet");
  if (staleSheet) { overlayClosed(staleSheet); staleSheet.remove(); } // a sync mid-sheet would leave it stale

  $view().querySelectorAll(".room-chip").forEach(ch => ch.addEventListener("click", () => {
    todayRoom = ch.dataset.room;
    render();
  }));

  const byKey = new Map(stack.map(c => [cardKey(c), c]));
  let lastDrag = 0;

  // One row at a time, awaited: two writes to the same plant in flight at
  // once would have the second overwrite the first's lastWatered.
  const finishTask = async id => {
    const t = await dbGet("tasks", id);
    if (!t) return;
    // A standing chore clears for today and books itself back in — done
    // would end it, and the ✕ in the sheet is how it stops for good.
    if (t.repeatDays > 0) {
      t.due = addDays(todayStr(), t.repeatDays);
      toast(`Done — back on ${fmtDate(t.due)}`);
    } else t.done = true;
    await saveRecord("tasks", t);
  };
  const doRow = async (card, r) => {
    todayLastRoom = card.room;
    if (r.kind === "care") {
      await logAction(r.t.plant.id, r.t.kind);
      for (const h of r.hints || []) await finishTask(h.id);
    } else await finishTask(r.task.id);
  };

  const rowForEl = (card, el) => card.rows.find(r => r.kind === "care"
    ? el.dataset.kind && r.t.plant.id === el.dataset.plant && r.t.kind === el.dataset.kind
    : el.dataset.task && r.task.id === el.dataset.task);

  // Pills complete their job in place — the fast path for "water it, move on".
  $view().querySelectorAll(".job").forEach(el => el.addEventListener("click", async e => {
    e.stopPropagation();
    const card = byKey.get(el.closest(".deck-card").dataset.card);
    const row = card && rowForEl(card, el);
    if (!row) return;
    buzz(8);
    await doRow(card, row);
    render();
  }));

  /* The camera on the card: a fresh photo is the day's best gift to the
     health history, and it triggers a check on its own. One shared input —
     `capture` sends iPhones straight to the camera. */
  const deckCam = document.getElementById("deckCam");
  let camPlant = null;
  $view().querySelectorAll(".deck-cam[data-cam]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    camPlant = b.dataset.cam;
    deckCam.click();
  }));
  if (deckCam) deckCam.addEventListener("change", async () => {
    const f = deckCam.files && deckCam.files[0];
    if (!f || !camPlant) return;
    await addPhoto(camPlant, f);
    toast(aiConfigured() ? "Photo saved — health check running" : "Photo saved");
    render();
  });

  /* The sheet: the card's full story. Pills compress; this is where the long
     step reads in whole sentences with its reasoning, where a standing chore
     can be stopped, and where the species' own care notes sit. */
  const openSheet = async (card) => {
    const prior = document.getElementById("cardSheet");
    if (prior) { overlayClosed(prior); prior.remove(); }
    const g = card.plant ? guideEntry(card.plant.speciesKey) : null;
    const photo = card.plant ? await latestPhotoURL(card.plant.id) : null;
    // Which bottle to reach for, right where the job is.
    const fert = card.plant && card.plant.fertId ? await dbGet("ferts", card.plant.fertId) : null;
    const rowsHtml = card.rows.map((r, i) => {
      if (r.kind === "care") {
        const verb = r.t.kind === "water" ? "Water" : "Fertilize";
        const fertTag = r.t.kind === "fertilize" && fert ? ` · ${esc(fert.name)}` : "";
        const hints = (r.hints || []).map(h =>
          `<span class="deck-act-sub deck-hint-line">↳ ${esc(h.title)}</span>`).join("");
        const btnHtml = `<button class="deck-act" data-row="${i}" data-kind="${r.t.kind}"><span class="deck-act-lay">
          <span class="deck-act-icon">${r.t.kind === "water" ? "💧" : "🌾"}</span>
          <span class="deck-act-main"><b>${verb}</b><span class="deck-act-sub${r.t.delta < 0 ? " is-late" : ""}">${dueLabel(r.t.due)}${fertTag}${r.wxTag || ""}</span>${hints}</span>
          <span class="deck-tick">✓</span>
        </span></button>`;
        // Feel the soil first: if it's still wet, say so — the watering
        // clears for today without a fake log, and asks again in two days.
        return r.t.kind === "water"
          ? `<div class="deck-act-wrap">${btnHtml}<button class="deck-wet" data-wet="${i}" aria-label="Still wet — hold off watering"><span>💦</span><span>wet</span></button></div>`
          : btnHtml;
      }
      const btn = `<button class="deck-act" data-row="${i}"><span class="deck-act-lay">
        <span class="deck-act-icon">${r.task.by === "Sprout AI" ? (ACTION_ICONS[r.task.kind] || "✦") : "📝"}</span>
        <span class="deck-act-main"><b>${esc(r.task.title)}</b>${
          r.task.detail ? `<span class="deck-act-sub">${esc(r.task.detail)}</span>` : ""}${
          r.task.repeatDays ? `<span class="deck-act-sub is-repeat">↻ every ${r.task.repeatDays}d — clears for today</span>` : ""}</span>
        <span class="deck-tick">✓</span>
      </span></button>`;
      return r.task.repeatDays
        ? `<div class="deck-act-wrap">${btn}<button class="deck-drop" data-drop="${r.task.id}" aria-label="Stop repeating this">✕</button></div>`
        : btn;
    }).join("");

    const el = document.createElement("div");
    el.id = "cardSheet";
    el.className = "sheet-back";
    el.innerHTML = `
      <div class="sheet" role="dialog" aria-label="${card.plant ? esc(card.plant.name) : "Checklist"}">
        <div class="sheet-grip"></div>
        <div class="sheet-head">
          ${photo ? `<img class="sheet-thumb" src="${photo}" alt="">`
                  : `<div class="sheet-thumb" style="display:grid;place-items:center">${card.plant ? plantEmoji(card.plant) : "📋"}</div>`}
          <div class="sheet-title">
            <b>${card.plant ? esc(card.plant.name) : "Anything else"}</b>
            <span>${card.plant
              ? esc([card.plant.species || (g && g.name), roomLabel(card.room)].filter(Boolean).join(" · "))
              : "Not tied to a plant"}</span>
          </div>
          <button class="sheet-close" aria-label="Close">✕</button>
        </div>
        <div class="sheet-body">
          ${rowsHtml}
          ${card.plant && card.plant.health && card.plant.health.summary
            ? `<div class="sheet-tip">${healthChip(card.plant.health)} ${esc(card.plant.health.summary)}</div>` : ""}
          ${g && g.tips && g.key !== "other" ? `<div class="sheet-tip"><b>Tip</b> — ${esc(g.tips)}</div>` : ""}
        </div>
        <div class="sheet-foot">
          <button class="btn block" id="sheetAll">Did all ${card.rows.length > 1 ? card.rows.length : ""}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));

    const done = new Set();
    const closeAnd = () => { el.remove(); overlayClosed(el); render(); };
    overlayOpened(el, closeAnd);
    el.addEventListener("click", e => { if (e.target === el) closeAnd(); });
    el.querySelector(".sheet-close").addEventListener("click", closeAnd);
    el.querySelectorAll(".deck-act[data-row]").forEach(btn => btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.row);
      if (done.has(i)) return;
      done.add(i);
      buzz(8);
      await doRow(card, card.rows[i]);
      btn.classList.add("is-done-row");
      btn.disabled = true;
      if (done.size === card.rows.length) closeAnd();
    }));
    el.querySelectorAll(".deck-wet[data-wet]").forEach(btn => btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.wet);
      if (done.has(i)) return;
      buzz(8);
      const nextAsk = await skipWatering(card.plant.id);
      toast(`Still wet — will ask again ${fmtDate(nextAsk)}`);
      /* The hold covers the visit, and feeding happens through the can — so
         the card's Fertilize row is off the table too, not just Water. Mark
         every care row handled; "Did all" then skips them both. */
      card.rows.forEach((r, j) => {
        if (r.kind !== "care") return;
        done.add(j);
        const rowBtn = el.querySelector(`.deck-act[data-row="${j}"]`);
        if (rowBtn) { rowBtn.classList.add("is-done-row"); rowBtn.disabled = true; }
      });
      btn.disabled = true;
      if (done.size === card.rows.length) closeAnd();
    }));
    el.querySelectorAll(".deck-drop[data-drop]").forEach(btn => btn.addEventListener("click", async () => {
      await removeRecord("tasks", btn.dataset.drop);
      toast("Okay — it won't come back");
      closeAnd();
    }));
    el.querySelector("#sheetAll").addEventListener("click", async () => {
      buzz([12, 40, 12]);
      for (let i = 0; i < card.rows.length; i++) if (!done.has(i)) await doRow(card, card.rows[i]);
      closeAnd();
    });
  };

  $view().querySelectorAll(".deck-card").forEach(cardEl => {
    cardEl.addEventListener("click", () => {
      if (Date.now() - lastDrag < 400) return; // the click that trails a swipe
      const card = byKey.get(cardEl.dataset.card);
      if (card) openSheet(card);
    });
  });

  /* Swipes, per card, the reference design's way: drag right and the card
     asks for a photo (which runs a health check); drag left and it sinks to
     the bottom of the queue to come back around. Completion lives on the
     pills and in the sheet — a gesture this easy to fire shouldn't be the
     thing that writes records.

     touch-action: pan-y leaves vertical scrolling native; the gesture is
     only claimed once it is clearly horizontal. */
  const deck = document.getElementById("deck");
  if (deck) {
    const COMMIT = Math.min(120, Math.round(deck.clientWidth * 0.34)) || 100;
    let cardEl = null, stamps = null, sx = 0, sy = 0, dx = 0, mode = null, armed = false;

    const follow = x => {
      if (!cardEl) return;
      cardEl.style.transform = x ? `translateX(${x}px) rotate(${(x / 26).toFixed(2)}deg)` : "";
      const p = Math.min(1, Math.abs(x) / COMMIT);
      stamps.photo.style.opacity = x > 0 && cardEl.querySelector(".deck-cam") ? p : 0;
      stamps.later.style.opacity = x < 0 ? p : 0;
    };
    const settle = () => {
      if (!cardEl) return;
      cardEl.style.transition = "transform .3s cubic-bezier(.2,.9,.3,1.18)";
      follow(0);
    };

    deck.addEventListener("touchstart", e => {
      cardEl = e.target.closest(".deck-card");
      if (!cardEl || e.touches.length !== 1) { mode = "scroll"; return; }
      stamps = {
        photo: cardEl.querySelector(".deck-stamp.is-photo"),
        later: cardEl.querySelector(".deck-stamp.is-later"),
      };
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      dx = 0; mode = null; armed = false;
      cardEl.style.transition = "none";
    }, { passive: true });

    deck.addEventListener("touchmove", e => {
      if (mode === "scroll" || !cardEl) return;
      const t = e.touches[0];
      dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (mode === null) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { mode = "scroll"; return; }
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) mode = "drag";
        else return;
      }
      follow(dx);
      // One tick at the threshold — and it un-arms if the finger retreats.
      if (!armed && Math.abs(dx) >= COMMIT) { armed = true; buzz(8); }
      else if (armed && Math.abs(dx) < COMMIT) armed = false;
    }, { passive: true });

    deck.addEventListener("touchcancel", () => { if (mode === "drag") settle(); mode = null; }, { passive: true });

    deck.addEventListener("touchend", async () => {
      if (mode !== "drag" || !cardEl) { mode = null; return; }
      mode = null;
      lastDrag = Date.now();
      if (Math.abs(dx) < COMMIT) { settle(); return; }
      const card = byKey.get(cardEl.dataset.card);
      if (dx > 0) {
        // Photo: the card springs back and the camera opens.
        settle();
        buzz(8);
        if (card && card.plant) { camPlant = card.plant.id; deckCam.click(); }
        return;
      }
      // Skip: off to the left, then to the bottom of the queue.
      cardEl.style.transition = "transform .28s ease-in, opacity .28s ease-in";
      cardEl.style.transform = "translateX(-120%) rotate(-8deg)";
      cardEl.style.opacity = "0";
      buzz(8);
      await new Promise(r => setTimeout(r, 240));
      if (card) {
        const k = cardKey(card);
        todayLater = todayLater.filter(x => x !== k);
        todayLater.push(k);
      }
      render();
    }, { passive: true });
  }

  $view().querySelectorAll("[data-action=toggle-task]").forEach(btn => {
    btn.addEventListener("click", async e => {
      const id = e.target.closest("[data-task]").dataset.task;
      const t = await dbGet("tasks", id);
      t.done = !t.done;
      await saveRecord("tasks", t);
      render();
    });
  });
  $view().querySelectorAll("[data-action=del-task]").forEach(btn => {
    btn.addEventListener("click", async e => {
      await removeRecord("tasks", e.target.closest("[data-task]").dataset.task);
      render();
    });
  });
  document.getElementById("addTaskForm").addEventListener("submit", async e => {
    e.preventDefault();
    const title = document.getElementById("newTaskTitle").value.trim();
    if (!title) return;
    await saveRecord("tasks", { id: uid(), title, done: false, by: state.settings.activeUser, createdAt: new Date().toISOString() });
    render();
  });
}

// What's in the pot, in words: "Monstera x3", "Monstera + Pothos".
function potSummary(p) {
  const parts = [];
  const n = p.quantity || 1;
  parts.push(esc(p.species || guideEntry(p.speciesKey).name) + (n > 1 ? ` \u00d7${n}` : ""));
  (p.alsoContains || []).forEach(a => parts.push(esc(a.name)));
  return parts.join(" + ");
}

/* Look a species up, keep it, and hand it to whoever asked.

   The row it was launched from becomes the progress indicator: the lookup
   takes a few seconds and the list is the only thing the owner is looking at.
   A failure leaves the search open so the query can be reworded — the typed
   text is still a perfectly good custom species name if they'd rather move on. */
async function learnAndPick(query, row, pick) {
  if (!query) return;
  row.classList.add("busy");
  row.innerHTML = `<span class="ac-ask-icon">✦</span><span>Looking up "${esc(query)}"…</span>`;
  try {
    const entry = await saveLearnedSpecies(await aiLearnSpecies(query));
    toast(`Added ${entry.name} to the guide`);
    pick(entry);
  } catch (err) {
    row.classList.remove("busy");
    row.innerHTML = `<span class="ac-ask-icon">·</span><span>${esc(err.message)}</span>`;
  }
}

/* Searching for what's actually written on the label.

   Nursery tags and receipts read "Leucadendron Winter Red 5g" — genus,
   cultivar, pot size. Matching contiguous substrings finds nothing for that,
   even with Leucadendron sitting in the guide, because no entry contains the
   whole string. Typing the label you were given is the most natural thing to
   do and it was the one thing guaranteed to fail.

   So: drop the sizing noise, then fall back from the whole phrase to its best
   single word. */
const SIZE_NOISE = /^(x{0,2}lg|lrg|sm|md|large|small|medium|gal|gallon|qt|quart|pot|pots|#\d+|\d+(\.\d+)?(g|gal|qt|l|d|cm|in|")?)$/;

/* Words that are on half the labels in a plant shop and so narrow nothing.
   Without this, "Weird alien plant" matches every entry with "Plant" in its
   name — a page of noise where the honest answer is "not in the guide, shall
   I look it up?". They still work inside a phrase: "Snake Plant" matches as a
   whole string before any of this applies. */
const GENERIC_WORDS = new Set([
  "plant", "plants", "tree", "trees", "flower", "flowers", "seedling",
  "indoor", "outdoor", "house", "houseplant", "live", "fresh", "assorted",
  "mix", "mixed", "variety", "hanging", "basket", "potted", "starter",
]);

function searchTokens(q, { keepGeneric = false } = {}) {
  return q.toLowerCase().split(/[^a-z0-9"']+/)
    .filter(t => t && !SIZE_NOISE.test(t) && (keepGeneric || !GENERIC_WORDS.has(t)));
}

/* The label with the sizing stripped but the words and capitals left alone —
   "Leucadendron Winter Red", not "leucadendron winter red 5g". This is what
   gets shown and what a lookup is asked about, so it should read like the tag
   the plant came with. */
function cleanLabel(raw) {
  return raw.trim().split(/\s+/)
    .filter(w => !SIZE_NOISE.test(w.toLowerCase().replace(/[^a-z0-9#"]/g, "")))
    .join(" ");
}

// With a few hundred species, filtering alone puts "Mini Monstera" above
// "Monstera". Rank by how well the match starts, not just whether it matches.
function rankPhrase(g, q) {
  const name = g.name.toLowerCase(), latin = g.latin.toLowerCase();
  if (!q) return 99;
  if (name === q || latin === q) return 0;
  if (name.startsWith(q)) return 1;
  if (latin.startsWith(q)) return 2;
  // A match at a word boundary beats one buried mid-word.
  if (new RegExp("\\b" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(name)) return 3;
  if (name.includes(q)) return 4;
  if (latin.includes(q)) return 5;
  return 99;
}

function rankSpecies(g, raw) {
  const tokens = searchTokens(raw);
  if (!tokens.length) return 99;
  const phrase = rankPhrase(g, tokens.join(" "));
  if (phrase < 99) return phrase;

  /* No whole-phrase match, so try the words on their own. Short words are
     skipped: matching "red" in "Leucadendron Winter Red" would put Red Maple
     ahead of the plant actually in the pot.

     Matching more of the words beats matching one of them better. "Echinopsis
     San Pedro" hits the Echinopsis genus on one word and San Pedro Cactus on
     two, and the specific plant is the right answer. Scored from 20 up so any
     genuine phrase match still sorts first — this is a broader guess. */
  let best = 99, matched = 0;
  for (const t of tokens) {
    if (t.length < 4) continue;
    const r = rankPhrase(g, t);
    if (r === 99) continue;
    matched++;
    best = Math.min(best, r);
  }
  return matched ? 20 + best - 5 * (matched - 1) : 99;
}

/* Species rows show a photograph of the plant, not a stand-in glyph. The
   image arrives after the row does, so each row renders a slot and gets
   filled as lookups land. Requests are aborted when the query moves on, and
   results are cached per-device, so typing doesn't re-fetch what it just saw. */
let speciesThumbAbort = null;
function speciesRowsHTML(hits) {
  return hits.map(g => `
    <div class="ac-item" data-key="${g.key}">
      <span class="ac-thumb" data-thumb-key="${g.key}"></span>
      <span class="ac-text"><span class="ac-name">${esc(g.name)}</span>
      <span class="ac-latin">${esc(g.latin)}</span></span>
    </div>`).join("");
}

function fillSpeciesThumbs(container, hits) {
  if (speciesThumbAbort) speciesThumbAbort.abort();
  speciesThumbAbort = new AbortController();
  const signal = speciesThumbAbort.signal;
  hits.forEach(async g => {
    try {
      const url = await speciesThumb(g.latin, g.name, signal);
      if (signal.aborted) return;
      const slot = container.querySelector(`[data-thumb-key="${g.key}"]`);
      if (slot && url) {
        // Decode before inserting, so a photo that fails to load leaves the
        // neutral slot instead of a broken-image icon. Deliberately not
        // loading="lazy": that defers until the element is in the viewport,
        // and this one is off-document until it has loaded — which would
        // mean it never loads at all.
        const img = new Image();
        img.alt = "";
        img.onload = () => {
          if (!slot.isConnected) return;
          slot.innerHTML = "";
          slot.appendChild(img);
          slot.classList.add("has-img");
        };
        img.src = url;
      }
    } catch { /* aborted or offline — the slot stays neutral */ }
  });
}

// ----- Plants list -----
async function viewPlants() {
  const plants = (await dbAll("plants")).filter(p => !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const groupBy = state.settings.plantsGroupBy || "name";

  let html = `<h1>Our plants</h1><p class="subtitle">${plants.length} plant${plants.length === 1 ? "" : "s"} in the family</p>
    <div class="search-bar"><input type="text" id="plantSearch" placeholder="Search plants…"></div>
    <div class="pill-row" id="groupBy">
      <button class="pill ${groupBy === "name" ? "active" : ""}" data-group="name">All</button>
      <button class="pill ${groupBy === "room" ? "active" : ""}" data-group="room">By room</button>
      <button class="pill ${groupBy === "due" ? "active" : ""}" data-group="due">Needs water</button>
      <button class="pill ${groupBy === "health" ? "active" : ""}" data-group="health">By health</button>
    </div>`;

  if (!plants.length) {
    html += `<div class="empty"><div class="big">🪴</div><p>Nothing here yet.<br>Tap <b>Add</b> to start your collection.</p></div>`;
    $view().innerHTML = html;
    return;
  }

  const cards = await Promise.all(plants.map(async p => {
    const photo = await latestPhotoURL(p.id);
    const wDue = nextDue(p, "water");
    const wDelta = wDue ? daysBetween(todayStr(), wDue) : null;
    let chip = `<span class="badge ok">happy</span>`;
    if (wDelta !== null && wDelta < 0) chip = `<span class="badge overdue">${-wDelta}d overdue</span>`;
    else if (wDelta === 0) chip = `<span class="badge water">water today</span>`;
    else if (wDelta !== null) chip = `<span class="badge">water in ${wDelta}d</span>`;
    return `
      <a class="plant-card" href="#/plant/${p.id}" data-name="${esc(p.name.toLowerCase())} ${esc((p.species || "").toLowerCase())}">
        ${photo ? `<img src="${photo}" alt="${esc(p.name)}">` : `<div class="no-photo">${plantEmoji(p)}</div>`}
        <div class="plant-card-body">
          <div class="plant-card-name">${esc(p.name)}</div>
          <div class="plant-card-sub">${potSummary(p)}${p.location ? " · " + esc(p.location) : ""}</div>
          <div class="plant-card-chips">${chip}${healthChip(p.health)}</div>
        </div>
      </a>`;
  }));

  if (groupBy === "room") {
    // Ungrouped plants go last under their own heading rather than vanishing.
    const byRoom = {};
    plants.forEach((p, i) => {
      const room = (p.location || "").trim() || NO_ROOM;
      (byRoom[room] = byRoom[room] || []).push(cards[i]);
    });
    const rooms = Object.keys(byRoom).sort((a, b) =>
      a === NO_ROOM ? 1 : b === NO_ROOM ? -1 : a.localeCompare(b));
    html += rooms.map(room => `
      <div class="plant-group" data-room="${esc(room.toLowerCase())}">
        <div class="group-head"><h2>${esc(room)}</h2><span class="group-count">${byRoom[room].length}</span></div>
        <div class="plant-grid">${byRoom[room].join("")}</div>
      </div>`).join("");
  } else if (groupBy === "due") {
    const order = plants.map((p, i) => {
      const due = nextDue(p, "water");
      return { card: cards[i], delta: due ? daysBetween(todayStr(), due) : Infinity };
    }).sort((a, b) => a.delta - b.delta);
    html += `<div class="plant-grid" id="plantGrid">${order.map(o => o.card).join("")}</div>`;
  } else if (groupBy === "health") {
    // Worst first — the point of this order is to surface what needs help.
    // Plants never checked have no score to rank on and sit at the end under
    // their own heading, rather than being scored 0 and jumping the queue.
    const scored = [], unchecked = [];
    plants.forEach((p, i) => {
      const score = p.health && typeof p.health.score === "number" ? p.health.score : null;
      (score === null ? unchecked : scored).push({ card: cards[i], score, name: p.name });
    });
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    if (scored.length) {
      html += `<div class="plant-group">
        <div class="group-head"><h2>Needs the most help</h2><span class="group-count">${scored.length}</span></div>
        <div class="plant-grid">${scored.map(o => o.card).join("")}</div>
      </div>`;
    } else {
      html += `<div class="card flat"><b>No health checks yet</b>
        <p class="subtitle" style="margin:6px 0 0">Open a plant and run a health check, or add a photo — one runs automatically.</p></div>`;
    }
    if (unchecked.length) {
      html += `<div class="plant-group">
        <div class="group-head"><h2>Not checked yet</h2><span class="group-count">${unchecked.length}</span></div>
        <div class="plant-grid">${unchecked.map(o => o.card).join("")}</div>
      </div>`;
    }
  } else {
    html += `<div class="plant-grid" id="plantGrid">${cards.join("")}</div>`;
  }
  $view().innerHTML = html;

  document.getElementById("groupBy").addEventListener("click", async e => {
    const btn = e.target.closest("[data-group]");
    if (!btn) return;
    state.settings.plantsGroupBy = btn.dataset.group;
    await saveSettings();
    render();
  });

  document.getElementById("plantSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    $view().querySelectorAll(".plant-card").forEach(c => {
      c.style.display = !q || c.dataset.name.includes(q) ? "" : "none";
    });
    // Hide a room heading once everything under it is filtered out.
    $view().querySelectorAll(".plant-group").forEach(g => {
      const anyVisible = [...g.querySelectorAll(".plant-card")].some(c => c.style.display !== "none");
      g.style.display = anyVisible ? "" : "none";
    });
  });
}

// ----- Add / Edit plant -----
// A bottom drawer. Opens over whatever you were doing, dismisses by tapping
// away or pressing Esc — `onDismiss` fires only for those, not for close().
function openSheet({ title, sub = "", onDismiss = null }) {
  document.querySelectorAll(".sheet-wrap").forEach(old => old.remove());
  const el = document.createElement("div");
  el.className = "sheet-wrap";
  el.innerHTML = `
    <div class="sheet-scrim"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="sheet-head">
        <h2 id="sheetTitle"></h2>
        <p class="sheet-sub"></p>
      </div>
      <div class="sheet-subject" hidden></div>
      <div class="sheet-body"></div>
      <div class="sheet-foot"></div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => el.classList.add("in"));

  let closed = false;
  // Run after the exit animation, not before it — releasing an object URL
  // while the sheet is still sliding out blanks the image on the way down.
  const cleanups = [];
  const finish = dismissed => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    el.classList.remove("in");
    document.body.classList.remove("sheet-open");
    setTimeout(() => {
      el.remove();
      cleanups.forEach(fn => { try { fn(); } catch { /* nothing to salvage */ } });
    }, 260);
    if (dismissed && onDismiss) onDismiss();
  };
  const onKey = e => { if (e.key === "Escape") finish(true); };
  document.addEventListener("keydown", onKey);
  el.querySelector(".sheet-scrim").addEventListener("click", () => finish(true));

  const api = {
    el,
    body: el.querySelector(".sheet-body"),
    foot: el.querySelector(".sheet-foot"),
    // Sits between the heading and the scrolling body, so whatever the drawer
    // is *about* stays on screen while you scroll the options.
    subject: el.querySelector(".sheet-subject"),
    onCleanup: fn => cleanups.push(fn),
    setHead(t, s) {
      el.querySelector("#sheetTitle").textContent = t;
      const p = el.querySelector(".sheet-sub");
      p.textContent = s || "";
      p.hidden = !s;
    },
    close: () => finish(false),
  };
  api.setHead(title, sub);
  return api;
}

const CONF_LABEL = { high: "Likely", medium: "Maybe", low: "Long shot" };
const CONF_CLASS = { high: "ok", medium: "fertilize", low: "" };

/* Pin the photo being identified to the top of a drawer.

   Going through a batch, every photo is a different plant — being asked
   "which one is it?" with no sight of the plant in question is guesswork.
   It shows from the moment the drawer opens, before the answer comes back,
   and stays put while the candidate list scrolls underneath.

   Tapping switches between a cropped strip and the whole frame uncropped:
   the crop is the right size to sit above the options, but the detail that
   settles an identification is often at the edge of the shot. */
function showSubjectPhoto(sheet, blob) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  sheet.onCleanup(() => URL.revokeObjectURL(url));
  sheet.subject.hidden = false;
  sheet.subject.innerHTML = `
    <button type="button" class="subject-shot" id="subjectShot" aria-label="Show the whole photo">
      <img src="${url}" alt="The photo being identified">
      <span class="subject-tag">Your photo</span>
    </button>`;
  const btn = sheet.subject.querySelector("#subjectShot");
  btn.addEventListener("click", () => {
    const full = btn.classList.toggle("full");
    btn.setAttribute("aria-label", full ? "Crop the photo back" : "Show the whole photo");
  });
}

// ----- Add / edit -----
// Adding runs in two steps: photograph the plant and confirm what it is, then
// fill in the details. Editing goes straight to the form.
async function viewAddEdit(editId = null) {
  const editing = editId ? await dbGet("plants", editId) : null;
  let photo = null;      // resized blob, saved with the plant on submit
  let queue = [];        // photos still waiting their turn
  let batchTotal = 0;    // 0 when this isn't a batch
  let batchDone = 0;

  // Shown on every screen of the flow so you always know where you are in the pile.
  const batchLabel = () => batchTotal > 1 ? `Plant ${batchDone + 1} of ${batchTotal}` : "";

  if (!editing) { renderCapture(); return; }
  await renderForm();

  // --- Step 1: the photo ---
  function renderCapture() {
    $view().innerHTML = `
      <h1>Add a plant</h1>
      <p class="subtitle">${aiConfigured()
        ? "Start with a photo. Sprout will work out what it is — you confirm."
        : "Start with a photo, then pick the species yourself."}</p>
      <label class="photo-drop" id="photoDrop">
        <input type="file" id="pPhoto" accept="image/*" multiple hidden>
        <div class="photo-drop-inner" id="photoDropInner">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="photo-drop-icon">
            <rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.4"/><path d="M8.5 6l1.4-2.2h4.2L15.5 6"/>
          </svg>
          <span class="photo-drop-title">Take a photo</span>
          <span class="photo-drop-sub">Or pick several from your library at once</span>
        </div>
      </label>
      <button class="btn block secondary" id="skipPhoto" style="margin-top:14px">Add without a photo</button>`;
    document.getElementById("pPhoto").addEventListener("change", onPhotoPicked);
    document.getElementById("skipPhoto").addEventListener("click", () => renderForm());
  }

  async function onPhotoPicked(e) {
    const files = [...e.target.files];
    if (!files.length) return;
    const inner = document.getElementById("photoDropInner");
    if (inner && files.length > 1) {
      document.getElementById("photoDrop").classList.add("has-photo");
      inner.innerHTML = `<div class="photo-drop-inner"><span class="photo-drop-title">Preparing ${files.length} photos…</span></div>`;
    }
    // Resize up front so the queue holds ready-to-save blobs, not File handles
    // that a phone may drop while the flow is in progress.
    const blobs = [];
    for (const f of files) {
      try { blobs.push(await resizeImage(f)); } catch { /* skip anything unreadable */ }
    }
    if (!blobs.length) { toast("Couldn't read those images — try others"); return; }
    if (blobs.length < files.length) toast(`Skipped ${files.length - blobs.length} unreadable photo(s)`);

    photo = blobs[0];
    queue = blobs.slice(1);
    batchTotal = blobs.length;
    batchDone = 0;
    if (inner && batchTotal === 1) {
      document.getElementById("photoDrop").classList.add("has-photo");
      inner.innerHTML = `<img src="${URL.createObjectURL(photo)}" alt="">`;
    }
    if (!aiConfigured()) { await renderForm(); return; }
    await identify();
  }

  /* After a save, move to the next photo instead of leaving the flow. Returns
     false when the pile is empty and the caller should navigate away. */
  async function advanceBatch() {
    if (!queue.length) return false;
    photo = queue.shift();
    batchDone++;
    if (aiConfigured()) await identify();
    else await renderForm();
    return true;
  }

  // Drop the current photo without saving anything for it.
  async function skipPhoto() {
    if (!queue.length) { location.hash = "#/plants"; return; }
    batchTotal--;
    photo = queue.shift();
    if (aiConfigured()) await identify();
    else await renderForm();
  }

  // --- Step 2: the shortlist, in a drawer ---
  // `apply` receives what the owner settled on. From step 1 that builds the
  // form; from inside the form it updates the fields in place, so re-running
  // identification never costs you what you already typed.
  async function identify(apply = seed => renderForm(seed)) {
    const sheet = openSheet({
      title: "Identifying…",
      sub: [batchLabel(), "Reading leaf shape, habit, and setting."].filter(Boolean).join(" · "),
      onDismiss: () => apply({}),
    });
    showSubjectPhoto(sheet, photo);
    sheet.body.innerHTML = `<div class="cand-row"><div class="cand skeleton"></div></div>`.repeat(3);

    let id;
    try {
      id = await aiIdentifySpecies(photo);
    } catch (err) {
      sheet.close();
      toast("Couldn't identify it — " + err.message);
      apply({});
      return;
    }

    if (!id.is_plant || !id.candidates.length) {
      sheet.setHead("That doesn't look like a plant", [batchLabel(), id.note].filter(Boolean).join(" · "));
      sheet.body.innerHTML = "";
      sheet.foot.innerHTML = `<button class="btn block" id="candManual">Add it anyway</button>`;
      document.getElementById("candManual").addEventListener("click", () => {
        sheet.close();
        apply({ outdoor: id.looks_outdoor });
      });
      return;
    }
    renderCandidates(sheet, id, apply);
  }

  function renderCandidates(sheet, id, apply) {
    const cands = id.candidates;
    const many = cands.length > 1;
    const count = ["", "one", "two", "three", "four", "five"][cands.length] || cands.length;
    sheet.setHead(
      many ? "Which one is it?" : "Is this your plant?",
      [batchLabel(), many
        ? `It could be ${count} things — closest first. Tap one to compare against example photos.`
        : (id.note || "Tap it to compare against example photos.")].filter(Boolean).join(" · ")
    );

    sheet.body.innerHTML = cands.map((c, i) => `
      <div class="cand-row">
        <button type="button" class="cand" data-i="${i}" aria-pressed="false">
          <span class="cand-thumb" data-thumb="${i}"></span>
          <span class="cand-main">
            <span class="cand-name">${esc(c.common_name)}</span>
            ${c.latin_name ? `<span class="cand-latin">${esc(c.latin_name)}</span>` : ""}
            ${c.why ? `<span class="cand-why">${esc(c.why)}</span>` : ""}
          </span>
          <span class="badge ${CONF_CLASS[c.confidence] || ""} cand-conf">${CONF_LABEL[c.confidence] || ""}</span>
        </button>
        <div class="cand-examples" data-ex="${i}" hidden></div>
      </div>`).join("");

    sheet.foot.innerHTML = `
      <button class="btn block" id="candUse">Use this</button>
      <button class="btn block secondary" id="candNone" style="margin-top:8px">None of these — I'll search</button>
      ${batchTotal > 1 ? `<button class="btn block secondary" id="candSkip" style="margin-top:8px">Skip this photo</button>` : ""}`;

    const rows = [...sheet.body.querySelectorAll(".cand")];
    const useBtn = document.getElementById("candUse");
    let picked = 0;

    const select = i => {
      picked = i;
      rows.forEach((r, n) => {
        r.classList.toggle("picked", n === i);
        r.setAttribute("aria-pressed", String(n === i));
        sheet.body.querySelector(`[data-ex="${n}"]`).hidden = n !== i;
      });
      useBtn.textContent = `Use ${cands[i].common_name}`;
      loadExamples(i);
    };

    // One lookup per candidate, cached: its first image becomes the row's
    // thumbnail, the rest fill the example strip when that row is selected.
    const examples = {};
    async function loadExamples(i) {
      const c = cands[i];
      const box = sheet.body.querySelector(`[data-ex="${i}"]`);
      if (examples[i] === undefined) {
        box.innerHTML = `<div class="cand-ex-label">Loading example photos…</div>`;
        try {
          examples[i] = await speciesExamples(c.latin_name, c.common_name, 3);
        } catch {
          examples[i] = [];
        }
        if (!sheet.el.isConnected) return;
        const thumb = sheet.body.querySelector(`[data-thumb="${i}"]`);
        if (examples[i].length && thumb) {
          thumb.classList.add("has-img");
          thumb.innerHTML = `<img src="${esc(examples[i][0])}" alt="" loading="lazy">`;
        }
      }
      box.innerHTML = examples[i].length
        ? `<div class="cand-ex-label">Example photos of ${esc(c.latin_name || c.common_name)}</div>
           <div class="cand-ex-strip">${examples[i]
             .map(u => `<img src="${esc(u)}" alt="Example ${esc(c.common_name)}" loading="lazy">`).join("")}</div>`
        : `<div class="cand-ex-label">No photos found for this one — check the botanical name against the guide.</div>`;
    }

    rows.forEach((r, i) => r.addEventListener("click", () => select(i)));
    select(0);
    // Preload the thumbnails of the rest so the list fills in as you read it.
    cands.forEach((_, i) => { if (i !== picked) loadExamples(i).catch(() => {}); });

    useBtn.addEventListener("click", () => {
      const c = cands[picked];
      sheet.close();
      apply({ key: c.species_key, name: c.common_name, outdoor: id.looks_outdoor });
    });
    document.getElementById("candNone").addEventListener("click", () => {
      sheet.close();
      apply({ outdoor: id.looks_outdoor });
    });
    const skipBtn = document.getElementById("candSkip");
    if (skipBtn) skipBtn.addEventListener("click", () => { sheet.close(); skipPhoto(); });
  }

  // --- Step 3: the details ---
  async function renderForm(seed = {}) {
  const roomSet = new Set(state.settings.rooms || []);
  (await dbAll("plants")).forEach(p => { if (p.location) roomSet.add(p.location); });
  if (editing && editing.location) roomSet.add(editing.location);
  const rooms = [...roomSet].sort((a, b) => a.localeCompare(b));

  const seedGuide = seed.key ? guideEntry(seed.key) : null;
  const speciesValue = editing ? (editing.species || guideEntry(editing.speciesKey).name) : (seed.name || "");
  const speciesKeyValue = editing ? editing.speciesKey : (seed.key || "other");
  const waterValue = editing ? editing.waterEvery : (seedGuide ? seedGuide.waterDays : 7);
  const fertValue = editing ? editing.fertEvery : (seedGuide ? seedGuide.fertDays : 30);

  $view().innerHTML = `
    <h1>${editing ? "Edit " + esc(editing.name) : "Confirm the details"}</h1>
    ${batchLabel() ? `<div class="batch-bar"><span>${batchLabel()}</span><div class="batch-track"><i style="width:${Math.round(batchDone / batchTotal * 100)}%"></i></div></div>` : ""}
    <p class="subtitle">${editing
      ? "Update details or schedules."
      : seed.name
        ? `Set up as ${esc(seed.name)}, with care from the guide. Change anything that's off.`
        : "Give it a name and pick a species — the care schedule follows from there."}</p>
    <form id="plantForm" class="card">
      ${editing || !photo ? "" : `
      <div class="form-photo">
        <img src="${URL.createObjectURL(photo)}" alt="Photo of the plant being added">
        <div class="form-photo-actions">
          <span class="form-photo-label">Your photo</span>
          <span class="form-photo-links">
            <button type="button" class="link-btn" id="changePhoto">Change</button>
            ${aiConfigured() ? `<button type="button" class="link-btn" id="reIdentify">Identify again</button>` : ""}
          </span>
        </div>
        <input type="file" id="pPhoto" accept="image/*" hidden>
      </div>`}
      <div class="field">
        <label for="pName">Nickname *</label>
        <input type="text" id="pName" required maxlength="60"
          placeholder="${seed.name ? `e.g. ${esc(seed.name)}` : "e.g. Fernie Sanders"}" value="${esc(editing?.name || "")}">
      </div>
      <div class="field">
        <label for="pSpeciesSearch">Species</label>
        <div class="autocomplete">
          <input type="text" id="pSpeciesSearch" maxlength="80" autocomplete="off" autocapitalize="off"
            placeholder="Search ${allSpecies().length - 1}+ species…"
            value="${esc(speciesValue)}">
          <div class="ac-list" id="speciesResults" hidden></div>
        </div>
        <input type="hidden" id="pSpeciesKey" value="${esc(speciesKeyValue)}">
        <div class="hint" id="speciesHint"></div>
      </div>
      <div class="field">
        <label for="pQuantity">How many in this pot?</label>
        <input type="number" id="pQuantity" min="1" max="99" value="${editing?.quantity || 1}">
        <div class="hint">Several cuttings of the same plant sharing one pot count as one entry.</div>
      </div>
      <div class="field">
        <label for="pAlsoSearch">Anything else in the same pot?</label>
        <div class="autocomplete">
          <input type="text" id="pAlsoSearch" maxlength="80" autocomplete="off" autocapitalize="off" placeholder="Add another species…">
          <div class="ac-list" id="alsoResults" hidden></div>
        </div>
        <div class="pill-row" id="alsoChips" style="margin:10px 0 0"></div>
        <div class="hint" id="alsoHint"></div>
      </div>
      <div class="field">
        <label for="pRoom">Room</label>
        <select id="pRoom">
          <option value="">— no room —</option>
          ${rooms.map(r => `<option value="${esc(r)}" ${editing && editing.location === r ? "selected" : ""}>${esc(r)}</option>`).join("")}
          <option value="__new__">➕ Add a new room…</option>
        </select>
        <input type="text" id="pRoomNew" maxlength="40" placeholder="New room name (e.g. Sunroom)" style="margin-top:8px" hidden>
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="pOutdoor" ${editing ? (isOutdoorPlant(editing) ? "checked" : "") : (seed.outdoor ? "checked" : "")} style="width:18px;height:18px">
          Lives outdoors (porch, balcony, garden)
        </label>
        <div class="hint">Outdoor plants get season- and weather-aware care: watering flexes with the season, and live weather flags rain, heat, and frost.</div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pWater">Water every (days)</label>
          <input type="number" id="pWater" min="0" max="365" value="${waterValue}">
          <div class="hint">0 = no reminders</div>
        </div>
        <div class="field">
          <label for="pFert">Fertilize every (days)</label>
          <input type="number" id="pFert" min="0" max="365" value="${fertValue}">
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
      <button class="btn block" type="submit">${editing ? "Save changes" : (queue.length ? "Add and go to the next photo" : "Add plant")}</button>
      ${editing ? `<button class="btn block secondary" type="button" id="cancelEdit" style="margin-top:8px">Cancel</button>` : ""}
      ${!editing && batchTotal > 1 ? `<button class="btn block secondary" type="button" id="skipPhotoBtn" style="margin-top:8px">Skip this photo</button>` : ""}
    </form>`;

  const sInput = document.getElementById("pSpeciesSearch");
  const sKey = document.getElementById("pSpeciesKey");
  const sList = document.getElementById("speciesResults");
  const hint = document.getElementById("speciesHint");
  let confirmedName = sInput.value; // species text currently bound to sKey

  const showHint = () => {
    const g = guideEntry(sKey.value);
    hint.textContent = g.latin
      ? `${g.latin} — ${g.light}. Water every ~${g.waterDays}d, fertilize ${g.fertDays ? "every ~" + g.fertDays + "d" : "never"}`
      : "";
  };
  if (editing || seed.key) showHint();

  const pickSpecies = (g) => {
    sKey.value = g.key;
    sInput.value = g.name;
    confirmedName = g.name;
    document.getElementById("pWater").value = g.waterDays;
    document.getElementById("pFert").value = g.fertDays;
    sList.hidden = true;
    showHint();
  };

  // Same, but keeping the name the identification used — "Swiss Cheese Plant"
  // rather than whatever the guide happens to call that key.
  const applySpeciesKey = (key, displayName) => {
    const g = guideEntry(key);
    sKey.value = key;
    sInput.value = displayName || g.name;
    confirmedName = sInput.value;
    document.getElementById("pWater").value = g.waterDays;
    document.getElementById("pFert").value = g.fertDays;
    showHint();
  };

  sInput.addEventListener("input", () => {
    const q = sInput.value.trim().toLowerCase();
    if (!q) { sList.hidden = true; hint.textContent = ""; return; }
    const hits = allSpecies()
      .filter(g => g.key !== "other")
      .map(g => ({ g, rank: rankSpecies(g, q) }))
      .filter(x => x.rank < 99)
      .sort((a, b) => a.rank - b.rank || a.g.name.localeCompare(b.g.name))
      .slice(0, 8)
      .map(x => x.g);
    /* Nothing in the guide is only a dead end if we leave it there — offer to
       go and find out. Offered alongside weak matches too: typing a cultivar
       that only matched its genus is exactly when the exact plant is worth
       looking up.

       The lookup uses the cleaned name — "Leucadendron Winter Red", not
       "Leucadendron Winter Red 5g". The pot size isn't part of the plant. */
    const cleaned = cleanLabel(sInput.value);
    const askRow = aiConfigured() && cleaned
      ? `<button type="button" class="ac-item ac-ask" data-ask="${esc(cleaned)}">
           <span class="ac-ask-icon">✦</span>
           <span><b>Look up "${esc(cleaned)}"</b><br>
           <span class="ac-ask-sub">Ask Claude for its care, and keep it in the guide</span></span>
         </button>`
      : "";
    sList.innerHTML = hits.length
      ? speciesRowsHTML(hits) + (hits.every(h => rankSpecies(h, q) > 2) ? askRow : "")
      : (askRow || `<div class="ac-item ac-none">No match — it'll be saved as a custom species with default care</div>`);
    sList.hidden = false;
    if (hits.length) fillSpeciesThumbs(sList, hits);
  });
  sList.addEventListener("mousedown", async e => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    if (item.dataset.key) { e.preventDefault(); pickSpecies(guideEntry(item.dataset.key)); return; }
    if (item.dataset.ask !== undefined) {
      e.preventDefault();
      await learnAndPick(item.dataset.ask, item, pickSpecies);
    }
  });
  sInput.addEventListener("blur", () => setTimeout(() => { sList.hidden = true; }, 200));

  // --- Everything else sharing the pot ---
  const alsoInput = document.getElementById("pAlsoSearch");
  const alsoList = document.getElementById("alsoResults");
  const alsoChips = document.getElementById("alsoChips");
  const alsoHint = document.getElementById("alsoHint");
  let alsoContains = (editing?.alsoContains || []).slice();

  const renderAlso = () => {
    alsoChips.innerHTML = alsoContains.map((a, i) =>
      `<button type="button" class="pill active" data-drop="${i}">${esc(guideEntry(a.key).emoji)} ${esc(a.name)} ✕</button>`).join("");
    if (!alsoContains.length) { alsoHint.textContent = ""; return; }
    // Everything in one pot gets watered together, so the schedule has to suit
    // whichever occupant dries out first.
    const all = [sKey.value, ...alsoContains.map(a => a.key)].map(guideEntry).filter(g => g.waterDays);
    const thirstiest = all.reduce((m, g) => (g.waterDays < m.waterDays ? g : m), all[0]);
    alsoHint.textContent = `Sharing a pot means sharing a watering can — the schedule below follows ${thirstiest.name}, the thirstiest of them.`;
  };

  const applyPotSchedule = () => {
    if (!alsoContains.length) return;
    const all = [sKey.value, ...alsoContains.map(a => a.key)].map(guideEntry).filter(g => g.waterDays);
    if (!all.length) return;
    document.getElementById("pWater").value = Math.min(...all.map(g => g.waterDays));
  };

  alsoInput.addEventListener("input", () => {
    const q = alsoInput.value.trim().toLowerCase();
    if (!q) { alsoList.hidden = true; return; }
    const taken = new Set([sKey.value, ...alsoContains.map(a => a.key)]);
    const hits = allSpecies()
      .filter(g => g.key !== "other" && !taken.has(g.key))
      .map(g => ({ g, rank: rankSpecies(g, q) }))
      .filter(x => x.rank < 99)
      .sort((a, b) => a.rank - b.rank || a.g.name.localeCompare(b.g.name))
      .slice(0, 8)
      .map(x => x.g);
    alsoList.innerHTML = hits.length
      ? speciesRowsHTML(hits)
      : `<div class="ac-item ac-none">No match</div>`;
    alsoList.hidden = false;
    if (hits.length) fillSpeciesThumbs(alsoList, hits);
  });
  alsoList.addEventListener("mousedown", e => {
    const item = e.target.closest(".ac-item");
    if (!item || !item.dataset.key) return;
    e.preventDefault();
    const g = guideEntry(item.dataset.key);
    alsoContains.push({ key: g.key, name: g.name });
    alsoInput.value = "";
    alsoList.hidden = true;
    renderAlso();
    applyPotSchedule();
  });
  alsoInput.addEventListener("blur", () => setTimeout(() => { alsoList.hidden = true; }, 200));
  alsoChips.addEventListener("click", e => {
    const btn = e.target.closest("[data-drop]");
    if (!btn) return;
    alsoContains.splice(Number(btn.dataset.drop), 1);
    renderAlso();
    applyPotSchedule();
  });
  renderAlso();

  const roomSel = document.getElementById("pRoom");
  const roomNew = document.getElementById("pRoomNew");
  const outdoorCb = document.getElementById("pOutdoor");

  // The photo carried over from step 1 — swap it, or run the shortlist again.
  // Both update the form in place rather than rebuilding it.
  const applyHere = seed => {
    if (seed.key) applySpeciesKey(seed.key, seed.name);
    if (seed.outdoor) outdoorCb.checked = true;
  };
  const changeBtn = document.getElementById("changePhoto");
  const againBtn = document.getElementById("reIdentify");
  const photoInput = document.getElementById("pPhoto");
  if (changeBtn) changeBtn.addEventListener("click", () => photoInput.click());
  if (againBtn) againBtn.addEventListener("click", () => identify(applyHere));
  if (photoInput) photoInput.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      photo = await resizeImage(file);
    } catch {
      toast("Couldn't read that image — try another");
      return;
    }
    const img = document.querySelector(".form-photo img");
    if (img) img.src = URL.createObjectURL(photo);
    if (aiConfigured()) identify(applyHere);
  });

  roomSel.addEventListener("change", () => {
    roomNew.hidden = roomSel.value !== "__new__";
    if (!roomNew.hidden) roomNew.focus();
    if (roomSel.value !== "__new__" && OUTDOOR_RE.test(roomSel.value)) outdoorCb.checked = true;
  });
  roomNew.addEventListener("input", () => {
    if (OUTDOOR_RE.test(roomNew.value)) outdoorCb.checked = true;
  });

  document.getElementById("plantForm").addEventListener("submit", async e => {
    e.preventDefault();
    const plant = editing || { id: uid(), createdAt: new Date().toISOString(), archived: false };
    plant.name = document.getElementById("pName").value.trim();
    const typed = sInput.value.trim();
    const exact = allSpecies().find(g => g.name.toLowerCase() === typed.toLowerCase());
    if (typed && typed === confirmedName.trim()) { /* keep sKey as-is */ }
    else if (exact) sKey.value = exact.key;
    else sKey.value = "other";
    plant.speciesKey = sKey.value;
    plant.species = typed || guideEntry(sKey.value).name;
    plant.quantity = Math.max(1, parseInt(document.getElementById("pQuantity").value, 10) || 1);
    plant.alsoContains = alsoContains;
    const newRoom = roomSel.value === "__new__" ? roomNew.value.trim() : "";
    plant.location = newRoom || (roomSel.value === "__new__" ? "" : roomSel.value);
    if (plant.location && !(state.settings.rooms || []).includes(plant.location)) {
      state.settings.rooms = [...(state.settings.rooms || []), plant.location];
      await saveSettings();
    }
    plant.outdoor = outdoorCb.checked;
    plant.waterEvery = parseInt(document.getElementById("pWater").value, 10) || 0;
    plant.fertEvery = parseInt(document.getElementById("pFert").value, 10) || 0;
    plant.lastWatered = document.getElementById("pLastWater").value || null;
    plant.lastFertilized = document.getElementById("pLastFert").value || null;
    plant.notes = document.getElementById("pNotes").value.trim();
    await saveRecord("plants", plant);
    if (!editing) {
      // The photo that identified it can also grade it — one check per new
      // plant, in the background, so a bulk add still moves at photo speed.
      // Already resized when it was picked.
      if (photo) await addPhoto(plant.id, photo, { resize: false });
      await saveRecord("logs", { id: uid(), plantId: plant.id, type: "note", at: new Date().toISOString(), by: state.settings.activeUser, note: "Added to the collection" });
    }
    if (!editing && queue.length) {
      toast(`Added ${plant.name} — ${batchDone + 1} of ${batchTotal}`);
      await advanceBatch();
      return;
    }
    toast(editing ? "Saved" : (batchTotal > 1 ? `Added ${plant.name} — all ${batchTotal} done` : `Added ${plant.name}`));
    location.hash = "#/plant/" + plant.id;
  });
  const cancel = document.getElementById("cancelEdit");
  if (cancel) cancel.addEventListener("click", () => { location.hash = "#/plant/" + editId; });
  const skipBtn2 = document.getElementById("skipPhotoBtn");
  if (skipBtn2) skipBtn2.addEventListener("click", () => skipPhoto());
  }
}

/* When a recommended step is due, as a date. New assessments say it in days;
   ones stored before the schema learned to schedule only had a phrase. */
function actionSchedule(action) {
  const dueIn = Number.isInteger(action.due_in_days) ? Math.max(0, action.due_in_days)
    : action.when === "this week" ? 2 : 0;
  const repeat = Number.isInteger(action.repeat_every_days) ? Math.max(0, action.repeat_every_days) : 0;
  return { due: addDays(todayStr(), dueIn), repeatDays: repeat };
}

async function addStepAsTask(plant, action, taskId, { source = "health" } = {}) {
  await saveRecord("tasks", {
    id: taskId,
    source,
    title: action.title,
    // The step's reasoning was being dropped on the floor. A step reads as an
    // instruction; the detail is why, and it's what you want when the
    // instruction alone isn't obvious a week later.
    detail: action.detail || "",
    done: false,
    by: "Sprout AI",
    kind: action.kind || "",
    plantId: plant.id,
    plantName: plant.name,
    ...actionSchedule(action),
    createdAt: new Date().toISOString(),
  });
}

/* Recommendations arrive on their own.

   A health check's steps used to wait behind an "Add step" tap on the plant
   page — advice that was easy to never see again. Now every assessment's
   steps land on the checklist themselves, each due on its scheduled day, and
   the deck deals them when that day comes.

   `tasked` on the health object makes this once-per-assessment: without it, a
   completed or deleted step would be resurrected on the next render. The flag
   rides the plant record through sync, and the deterministic task ids mean
   two phones materializing the same assessment write the same rows rather
   than duplicates. Assessments older than a week (from before this existed,
   or a phone that was off) are flagged without creating anything — week-old
   advice flooding today's deck helps nobody. */
/* A health step's task id is ai_<plant>_<assessment time>_<index>, so the
   assessment a step came from is readable off the id — which is what lets a
   newer assessment retire an older one's leftovers. Chat-added steps use
   plain uids and are never touched here: those were asked for. */
function isHealthStep(task) {
  return task.source === "health" || /^ai_/.test(task.id || "");
}
function healthStepPrefix(plantId, at) {
  return `ai_${plantId}_${Date.parse(at).toString(36)}_`;
}

/* The latest assessment owns the plant's steps.

   Every health check (and there is one per photo) used to ADD its steps
   while the previous check's still-open steps stayed — so a plant checked
   three times carried three near-identical "wipe the leaves", two rotations
   on different rhythms, and a card nobody could clear. A new assessment now
   replaces the old one's open steps: it was written seeing them (the prompt
   lists them), told to restate anything still needed and drop the rest.
   Done steps stay done — they're history. Human tasks and chat requests are
   untouched. Duplicate titles within one assessment collapse, and no
   assessment puts more than five steps on a card. */
async function materializeHealthTasks(plant) {
  const h = plant.health;
  if (!h || !Array.isArray(h.actions) || h.tasked) return;
  h.tasked = true;
  const fresh = h.at && Date.now() - Date.parse(h.at) < 7 * DAY;
  if (fresh) {
    const keep = healthStepPrefix(plant.id, h.at);
    for (const t of await dbAll("tasks")) {
      if (t.plantId !== plant.id || t.done || !isHealthStep(t)) continue;
      if (!t.id.startsWith(keep)) await removeRecord("tasks", t.id);
    }
    const seen = new Set();
    let placed = 0;
    for (let i = 0; i < h.actions.length && placed < 5; i++) {
      const a = h.actions[i];
      const key = (a.title || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const id = actionTaskId(plant.id, h.at, i);
      if (!(await dbGet("tasks", id))) await addStepAsTask(plant, a, id, { source: "health" });
      placed++;
    }
  }
  await saveRecord("plants", plant);
}

/* Apply what the chat decided, and say what happened in words.

   Everything is validated here rather than trusted: intervals clamp to sane
   ranges, dates must be real dates, species keys must exist in the guide.
   The returned strings drive the chips under the reply and the history log —
   the record of an AI edit belongs in the plant's history, same as an
   assessment. */
async function applyChatChanges(plantId, res) {
  const plant = await dbGet("plants", plantId);
  if (!plant) return [];
  const changes = [];
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && s <= todayStr();

  if (res.set_name && res.set_name.trim() && res.set_name.trim() !== plant.name) {
    changes.push(`name "${plant.name}" → "${res.set_name.trim()}"`);
    plant.name = res.set_name.trim();
  }
  if (res.set_room && res.set_room.trim() && res.set_room.trim() !== (plant.location || "")) {
    changes.push(`room → ${res.set_room.trim()}`);
    plant.location = res.set_room.trim();
  }
  if (res.set_species_key && res.set_species_key !== plant.speciesKey) {
    const g = guideEntry(res.set_species_key);
    if (g) {
      const label = (res.set_species_name || "").trim() || g.name;
      changes.push(`species → ${label}`);
      plant.speciesKey = res.set_species_key;
      plant.species = label;
    }
  }
  const setEvery = (field, v, label) => {
    if (!Number.isInteger(v) || v < 0 || v > 365 || v === plant[field]) return;
    changes.push(`${label} every ${plant[field] || "—"}d → ${v ? v + "d" : "off"}`);
    plant[field] = v;
  };
  setEvery("waterEvery", res.set_water_every_days, "water");
  setEvery("fertEvery", res.set_fert_every_days, "fertilize");
  if (res.set_last_watered && isDate(res.set_last_watered) && res.set_last_watered !== plant.lastWatered) {
    changes.push(`last watered → ${fmtDate(res.set_last_watered)}`);
    plant.lastWatered = res.set_last_watered;
  }
  if (res.set_last_fertilized && isDate(res.set_last_fertilized) && res.set_last_fertilized !== plant.lastFertilized) {
    changes.push(`last fertilized → ${fmtDate(res.set_last_fertilized)}`);
    plant.lastFertilized = res.set_last_fertilized;
  }
  if (res.set_outdoor === "outdoor" && !isOutdoorPlant(plant)) { plant.outdoor = true; changes.push("lives outdoors now"); }
  if (res.set_outdoor === "indoor" && isOutdoorPlant(plant)) { plant.outdoor = false; changes.push("lives indoors now"); }
  if (res.set_notes && res.set_notes.trim() && res.set_notes.trim() !== (plant.notes || "")) {
    plant.notes = res.set_notes.trim();
    changes.push("notes updated");
  }
  if (res.clear_health && plant.health) {
    delete plant.health;
    changes.push("health assessment cleared");
  }
  if (changes.length) await saveRecord("plants", plant);

  for (const a of res.add_tasks || []) {
    if (!a.title || !a.title.trim()) continue;
    await saveRecord("tasks", {
      id: uid(), title: a.title.trim(), detail: a.detail || "", done: false,
      by: "Sprout AI", source: "chat", kind: a.kind || "", plantId: plant.id, plantName: plant.name,
      ...actionSchedule(a), createdAt: new Date().toISOString(),
    });
    changes.push(`added: ${a.title.trim()}`);
  }
  for (const tid of res.complete_task_ids || []) {
    const t = await dbGet("tasks", tid);
    if (!t || t.plantId !== plant.id || t.done) continue;
    if (t.repeatDays > 0) t.due = addDays(todayStr(), t.repeatDays);
    else t.done = true;
    await saveRecord("tasks", t);
    changes.push(`done: ${t.title}`);
  }
  for (const tid of res.drop_task_ids || []) {
    const t = await dbGet("tasks", tid);
    if (!t || t.plantId !== plant.id) continue;
    await removeRecord("tasks", tid);
    changes.push(`removed: ${t.title}`);
  }

  if (changes.length) {
    await saveRecord("logs", {
      id: uid(), plantId: plant.id, type: "note", at: new Date().toISOString(),
      by: "Sprout AI", note: `Updated from chat — ${changes.join("; ")}`,
    });
  }
  return changes;
}

async function applyStepToPlan(plant, action) {
  const changes = [];
  if (action.water_every_days > 0 && action.water_every_days !== plant.waterEvery) {
    changes.push(`water every ${plant.waterEvery || "—"}d → ${action.water_every_days}d`);
    plant.waterEvery = action.water_every_days;
  }
  if (action.fert_every_days > 0 && action.fert_every_days !== plant.fertEvery) {
    changes.push(`fertilize every ${plant.fertEvery || "—"}d → ${action.fert_every_days}d`);
    plant.fertEvery = action.fert_every_days;
  }
  if (!changes.length) return null;
  await saveRecord("plants", plant);
  await saveRecord("logs", {
    id: uid(), plantId: plant.id, type: "note", at: new Date().toISOString(),
    by: state.settings.activeUser,
    note: `Care plan updated from a health check — ${changes.join("; ")}`,
  });
  return changes.join("; ");
}

/* Logging care, in one place. Four separate buttons said less than they
   cost: this sheet asks the two questions that matter — what happened, and
   when. Several activities can be picked at once (watering and feeding
   usually happen together), and the date can be any past day, because care
   gets logged when you sit down, not when you do it. A backdated watering
   never moves the schedule backwards; logAction guards that. */
function openLogSheet(plantId, plantName) {
  const priorLog = document.getElementById("logSheet");
  if (priorLog) { overlayClosed(priorLog); priorLog.remove(); }
  const KINDS = [
    { k: "water", icon: "💧", label: "Watered" },
    { k: "fertilize", icon: "🌾", label: "Fertilized" },
    { k: "prune", icon: "✂️", label: "Pruned" },
    { k: "repot", icon: "🪴", label: "Repotted" },
    { k: "check", icon: "💦", label: "Still wet" },
    { k: "note", icon: "📝", label: "Note" },
  ];
  const el = document.createElement("div");
  el.id = "logSheet";
  el.className = "chat-back";
  el.innerHTML = `
    <div class="log-sheet" role="dialog" aria-label="Log activity for ${esc(plantName)}">
      <div class="chat-head">
        <div class="chat-title"><b>Log activity</b><span>${esc(plantName)} — what happened, and when?</span></div>
        <button class="chat-close" id="logClose" aria-label="Close">✕</button>
      </div>
      <div class="log-body">
        <div class="log-kinds">
          ${KINDS.map(x => `<button type="button" class="log-kind" data-kind="${x.k}">${x.icon} ${x.label}</button>`).join("")}
        </div>
        <div class="log-when">
          <button type="button" class="log-day active" data-ago="0">Today</button>
          <button type="button" class="log-day" data-ago="1">Yesterday</button>
          <input type="date" id="logDate" max="${todayStr()}" aria-label="On another day">
        </div>
        <input type="text" id="logNote" placeholder="Add a note… (optional)" maxlength="200">
        <button class="btn block" id="logSave" disabled>Pick an activity</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  const close = () => { el.remove(); overlayClosed(el); };
  overlayOpened(el, close);
  el.addEventListener("click", e => { if (e.target === el) close(); });
  el.querySelector("#logClose").addEventListener("click", close);

  const save = el.querySelector("#logSave");
  const dateInput = el.querySelector("#logDate");
  const picked = () => [...el.querySelectorAll(".log-kind.active")].map(b => b.dataset.kind);
  const chosenDate = () => {
    const chip = el.querySelector(".log-day.active");
    if (chip) return addDays(todayStr(), -Number(chip.dataset.ago));
    return dateInput.value;
  };
  const refresh = () => {
    const kinds = picked();
    const dateOk = !!(el.querySelector(".log-day.active") || (dateInput.value && dateInput.value <= todayStr()));
    const noteOk = !kinds.includes("note") || el.querySelector("#logNote").value.trim();
    save.disabled = !kinds.length || !dateOk || !noteOk;
    save.textContent = !kinds.length ? "Pick an activity"
      : !dateOk ? "Pick a day"
      : !noteOk ? "Write the note"
      : `Log ${kinds.length > 1 ? kinds.length + " activities" : "it"}${chosenDate() === todayStr() ? "" : " · " + fmtDate(chosenDate())}`;
  };

  el.querySelectorAll(".log-kind").forEach(b => b.addEventListener("click", () => {
    b.classList.toggle("active");
    buzz(8);
    refresh();
  }));
  el.querySelectorAll(".log-day").forEach(b => b.addEventListener("click", () => {
    el.querySelectorAll(".log-day").forEach(x => x.classList.toggle("active", x === b));
    dateInput.value = "";
    refresh();
  }));
  dateInput.addEventListener("change", () => {
    if (dateInput.value) el.querySelectorAll(".log-day").forEach(x => x.classList.remove("active"));
    refresh();
  });
  el.querySelector("#logNote").addEventListener("input", refresh);

  save.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true;
    const date = chosenDate();
    const note = el.querySelector("#logNote").value.trim();
    const kinds = picked();
    for (const k of kinds) {
      // "Still wet" is its own path: it holds the schedule instead of writing
      // a watering that didn't happen.
      if (k === "check") await skipWatering(plantId, date);
      else await logAction(plantId, k, note, { date, quiet: true });
    }
    const labels = { water: "watered", fertilize: "fertilized", prune: "pruned", repot: "repotted", note: "noted", check: "still wet — held off" };
    toast(`Logged: ${kinds.map(k => labels[k]).join(", ")}${date === todayStr() ? "" : " · " + fmtDate(date)}`);
    buzz([12, 40, 12]);
    close();
    render();
  });
}

/* The chat panel. Lives outside #view so the page behind can re-render as
   edits land — which it does after every applied change, so closing the
   panel never reveals a stale page. Transcript is per-visit: the record
   keeps the changes (and the history keeps a line per edit); the
   conversation itself isn't something to sync or store. */
function openPlantChat(plantId, plantName) {
  const priorChat = document.getElementById("plantChat");
  if (priorChat) { overlayClosed(priorChat); priorChat.remove(); }
  const transcript = [];
  const el = document.createElement("div");
  el.id = "plantChat";
  el.className = "chat-back";
  el.innerHTML = `
    <div class="chat" role="dialog" aria-label="Chat about ${esc(plantName)}">
      <div class="chat-head">
        <div class="chat-title"><b>${esc(plantName)}</b><span>Ask anything — it can fix the record too</span></div>
        <button class="chat-close" id="chatClose" aria-label="Close">✕</button>
      </div>
      <div class="chat-log" id="chatLog">
        <div class="msg ai">What's going on with ${esc(plantName)}? If something in here is wrong — species, schedule, a health check that missed — tell me and I'll fix it.</div>
      </div>
      <form class="chat-input" id="chatForm">
        <input type="text" id="chatText" placeholder="e.g. This is actually a hoya…" autocomplete="off" maxlength="600">
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  const log = el.querySelector("#chatLog");
  const input = el.querySelector("#chatText");
  const form = el.querySelector("#chatForm");
  const close = () => { el.remove(); overlayClosed(el); };
  overlayOpened(el, close);
  el.addEventListener("click", e => { if (e.target === el) close(); });
  el.querySelector("#chatClose").addEventListener("click", close);

  const bubble = (cls, html) => {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || form.dataset.busy) return;
    form.dataset.busy = "1";
    input.value = "";
    transcript.push({ role: "user", text });
    bubble("user", esc(text));
    const wait = bubble("ai thinking", "Thinking…");
    try {
      const res = await aiPlantChat(plantId, transcript);
      transcript.push({ role: "assistant", text: res.reply });
      const applied = await applyChatChanges(plantId, res);
      wait.remove();
      bubble("ai", esc(res.reply) + (applied.length
        ? `<div class="msg-changes">${applied.map(c => `<span class="msg-change">✓ ${esc(c)}</span>`).join("")}</div>`
        : ""));
      if (applied.length) { buzz(8); render(); }
    } catch (err) {
      wait.remove();
      bubble("ai", `⚠️ ${esc(err.message)}`);
      transcript.pop(); // the turn never happened; let them send it again
    } finally {
      delete form.dataset.busy;
      input.focus();
    }
  });
  input.focus();
}

function wireSteps(box, plant) {
  if (!box || !plant.health || !plant.health.actions) return;
  const actions = plant.health.actions;
  const at = plant.health.at;

  box.querySelectorAll("[data-add]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.add);
      await addStepAsTask(plant, actions[i], actionTaskId(plant.id, at, i));
      btn.disabled = true;
      btn.textContent = "On the list ✓";
      toast("Added to the checklist");
    });
  });

  box.querySelectorAll("[data-apply]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const changed = await applyStepToPlan(plant, actions[Number(btn.dataset.apply)]);
      toast(changed ? "Care plan updated" : "Already set that way");
      if (changed) render();
    });
  });

  const all = box.querySelector("#addAllSteps");
  if (all) all.addEventListener("click", async () => {
    let n = 0;
    for (let i = 0; i < actions.length; i++) {
      const btn = box.querySelector(`[data-add="${i}"]`);
      if (!btn || btn.disabled) continue;
      await addStepAsTask(plant, actions[i], actionTaskId(plant.id, at, i));
      btn.disabled = true;
      btn.textContent = "On the list ✓";
      n++;
    }
    toast(n ? `Added ${n} step${n > 1 ? "s" : ""} to the checklist` : "Already on the list");
  });
}

// ----- Plant detail -----
async function viewPlant(id) {
  const p = await dbGet("plants", id);
  if (!p) { location.hash = "#/plants"; return; }
  const g = guideEntry(p.speciesKey);

  /* Swiping moves through the collection in the order the Plants tab lists it
     by default — alphabetical — so "3 of 12" means something when you arrive
     from that list. Wraps at both ends: on a phone, hitting an invisible wall
     mid-swipe reads as the gesture having failed. */
  const siblings = (await dbAll("plants")).filter(x => !x.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const at = siblings.findIndex(x => x.id === id);
  const go = step => {
    if (siblings.length < 2 || at === -1) return;
    location.hash = "#/plant/" + siblings[(at + step + siblings.length) % siblings.length].id;
  };
  plantNavGo = go;

  const nav = document.getElementById("plantNav");
  nav.hidden = siblings.length < 2;
  document.getElementById("plantPos").textContent = `${at + 1} of ${siblings.length}`;
  // Assignment rather than addEventListener: these elements outlive the view,
  // so adding would stack a new handler on every plant you swipe to.
  document.getElementById("prevPlant").onclick = () => go(-1);
  document.getElementById("nextPlant").onclick = () => go(1);
  document.getElementById("backBtn").onclick = () => { location.hash = backHash; };
  document.getElementById("editBtn").onclick = () => { location.hash = "#/edit/" + id; };

  const view = $view();
  let sx = 0, sy = 0, tracking = false;
  view.ontouchstart = e => {
    tracking = e.touches.length === 1;
    if (!tracking) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  };
  view.ontouchend = e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    // Must be a decisive sideways move: anything closer to vertical is the
    // page being scrolled, and this screen is long enough to scroll a lot.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(dx < 0 ? 1 : -1);
  };

  const photos = (await dbAllByIndex("photos", "plantId", id)).filter(ph => ph.blob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const logs = (await dbAllByIndex("logs", "plantId", id)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  const addedIds = (await dbAll("tasks")).map(t => t.id);
  const heroURL = photos.length ? viewURL(photos[0].blob) : null;

  const wDue = nextDue(p, "water"), fDue = nextDue(p, "fertilize");
  const badge = (due, cls, icon, label) => {
    if (!due) return `<span class="badge">${label} off</span>`;
    const d = daysBetween(todayStr(), due);
    if (d < 0) return `<span class="badge overdue">${label} ${-d}d overdue</span>`;
    if (d === 0) return `<span class="badge ${cls}">${label} today</span>`;
    return `<span class="badge ${cls}">${label} ${fmtDate(due)}</span>`;
  };

  const logIcons = { water: "💧", fertilize: "🌾", repot: "🪴", prune: "✂️", note: "📝", ai: "✨", check: "💦" };
  const logVerbs = { water: "Watered", fertilize: "Fertilized", repot: "Repotted", prune: "Pruned", check: "Checked" };
  const logLine = (l) => {
    if (l.type === "ai") return `Health check${typeof l.score === "number" ? ` ${l.score}/10` : ""} — ${esc(l.note)}`;
    if (l.type === "note") return esc(l.note);
    return (logVerbs[l.type] || l.type) + (l.note ? " — " + esc(l.note) : "");
  };

  $view().innerHTML = `
    <div class="hero">
      ${heroURL ? `<img src="${heroURL}" alt="${esc(p.name)}">` : `<div class="no-photo">${g.emoji}</div>`}
      <button class="hero-action" id="btnPhotoHero" title="Add photos of ${esc(p.name)}" aria-label="Add photos of ${esc(p.name)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 18.5a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h3.2l1.9-2.5h5.8L16.8 7H20a2 2 0 012 2z"/><circle cx="12" cy="13.5" r="3.8"/></svg>
      </button>
    </div>
    <h1>${esc(p.name)}</h1>
    <p class="subtitle">${potSummary(p)}${p.location ? " · " + esc(p.location) : ""}</p>
    <div class="pill-row">
      ${badge(wDue, "water", "💧", "water")}
      ${badge(fDue, "fertilize", "🌾", "fertilize")}
      ${isOutdoorPlant(p) ? `<span class="badge ok">outdoor</span>` : ""}
      ${healthChip(p.health)}
    </div>
    ${isOutdoorPlant(p) && p.waterEvery && seasonFactor() !== 1 ? `
      <p class="subtitle" style="margin-top:-6px">${currentSeason() === "winter" ? "❄️" : "☀️"} ${currentSeason()} adjusts outdoor watering: every ${p.waterEvery}d → ~${Math.max(1, Math.round(p.waterEvery * seasonFactor()))}d</p>` : ""}
    ${await (async () => {
      const f = p.fertId ? await dbGet("ferts", p.fertId) : null;
      return f ? `<p class="subtitle" style="margin-top:-6px">🌾 Fed with <b>${esc(f.name)}</b>${
        f.owned === false ? ` <span style="color:var(--warn)">(on the shopping list)</span>` : ""}${
        f.dilution ? ` — ${esc(f.dilution)}` : ""}</p>` : "";
    })()}
    <div class="action-row">
      <button class="btn block" id="btnLogActivity">＋ Log activity</button>
    </div>

    ${(p.alsoContains || []).length ? `
      <div class="card flat">
        <b>Sharing this pot</b>
        <p class="subtitle" style="margin:4px 0 10px">One watering can between them — the schedule follows whichever dries out first.</p>
        ${[{ key: p.speciesKey, name: p.species || g.name }, ...p.alsoContains].map(a => {
          const e = guideEntry(a.key);
          return `<div class="pot-mate">
            <span class="pot-mate-emoji">${e.emoji}</span>
            <div><div class="pot-mate-name">${esc(a.name)}</div>
            <div class="pot-mate-need">${esc(e.light)} · water every ~${e.waterDays}d</div></div>
          </div>`;
        }).join("")}
      </div>` : ""}

    <div class="tip-card"><b>Care tips — ${esc(g.name)}</b><br>
      ${esc(g.light)}<br>${esc(g.tips)}</div>

    <div class="card flat" id="aiCard">
      <div class="section-head" style="margin:0">
        <h2 style="margin:0">Health</h2>
        ${healthChip(p.health, { withLabel: true })}
      </div>
      <p class="subtitle" style="margin:6px 0 10px">${aiConfigured()
        ? p.health
          ? `Last checked ${fmtDate(p.health.at.slice(0, 10))} from the photos, care history, and conditions.`
          : "Claude reads the photos, care history, and conditions to assess health and turn what it finds into steps."
        : "Add your Anthropic API key in Settings to enable AI health checks."}</p>
      ${aiConfigured()
        ? `<div class="action-row" style="margin:0 0 4px">
             <button class="btn secondary" id="btnAiCheck"${assessInFlight(p.id) ? " disabled" : ""}>${
               assessInFlight(p.id) ? "Looking at your plant…" : p.health ? "Check again" : "Check health"}</button>
             <button class="btn secondary" id="btnPlantChat">💬 Ask about it</button>
           </div>
           <div id="aiResult">${p.health ? renderAssessment(p.health, { plantId: p.id, addedIds }) : ""}</div>`
        : `<a class="btn small secondary" href="#/settings">Set up in Settings</a>`}
    </div>

    ${p.notes ? `<div class="card flat"><b>Notes</b><br>${esc(p.notes).replace(/\n/g, "<br>")}</div>` : ""}

    <div class="section-head"><h2>Photo journal</h2>
      <label class="btn small secondary" style="cursor:pointer">Add photos<input type="file" id="photoInput" accept="image/*" multiple hidden></label>
    </div>
    ${photos.length ? `<div id="gallery">
      ${(() => {
        /* One entry per visit: photos picked together share a batch id and
           read as a single dated entry. Photos from before batches existed
           each stand alone. */
        const entries = [];
        const byBatch = new Map();
        for (const ph of photos) {
          const key = ph.batch || ph.id;
          if (!byBatch.has(key)) { const en = { at: ph.createdAt, shots: [] }; byBatch.set(key, en); entries.push(en); }
          byBatch.get(key).shots.push(ph);
        }
        return entries.map(en => `
          <div class="journal-entry">
            <div class="journal-date">${fmtDateTime(en.at)}${en.shots.length > 1 ? ` · ${en.shots.length} photos` : ""}</div>
            <div class="gallery">${en.shots.map(ph =>
              `<img src="${viewURL(ph.blob)}" data-photo="${ph.id}" alt="" title="${fmtDateTime(ph.createdAt)}">`).join("")}</div>
          </div>`).join("");
      })()}
    </div>` : `<p class="subtitle">No photos yet — take a growth pic!</p>`}

    <h2>History</h2>
    <div class="card flat">
      ${logs.length ? logs.map(l => `
        <div class="history-item">
          <span class="history-icon">${logIcons[l.type] || "•"}</span>
          <div><div>${logLine(l)}</div>
          <div class="history-meta">${fmtDateTime(l.at)} · by ${esc(l.by)}</div></div>
        </div>`).join("") : `<p class="subtitle" style="margin:0">No history yet.</p>`}
    </div>

    <div style="margin-top:18px; display:flex; gap:10px">
      <button class="btn small danger block" id="btnDelete">Remove plant</button>
    </div>`;

  const btnAi = document.getElementById("btnAiCheck");
  if (btnAi) {
    const box = document.getElementById("aiResult");
    wireSteps(box, p);
    btnAi.addEventListener("click", async () => {
      btnAi.disabled = true;
      btnAi.textContent = "Looking at your plant…";
      box.innerHTML = "";
      try {
        await assessNow(id);
        render();  // the score belongs on the pill row and the grid too, not just here
      } catch (err) {
        box.innerHTML = `<p class="subtitle" style="margin-top:10px">⚠️ ${esc(err.message)}</p>`;
        btnAi.textContent = "Check health";
      } finally {
        btnAi.disabled = false;
      }
    });
  }

  const btnChat = document.getElementById("btnPlantChat");
  if (btnChat) btnChat.addEventListener("click", () => openPlantChat(id, p.name));

  document.getElementById("btnLogActivity").addEventListener("click", () => openLogSheet(id, p.name));
  // The hero button opens the journal's picker — same input, so photos taken
  // here batch into one entry exactly like the button below.
  document.getElementById("btnPhotoHero").addEventListener("click", () =>
    document.getElementById("photoInput").click());
  document.getElementById("btnDelete").addEventListener("click", async () => {
    if (!confirm(`Remove ${p.name} and all its photos/history? This can't be undone.`)) return;
    for (const ph of photos) await removeRecord("photos", ph.id);
    const allLogs = await dbAllByIndex("logs", "plantId", id);
    for (const l of allLogs) await removeRecord("logs", l.id);
    // Its steps go with it — an orphaned step used to fall through to the
    // "Anything else" card and haunt Today with advice for a plant that's gone.
    for (const t of await dbAll("tasks")) if (t.plantId === id) await removeRecord("tasks", t.id);
    await removeRecord("plants", id);
    toast(`${p.name} removed`);
    location.hash = "#/plants";
  });
  document.getElementById("photoInput").addEventListener("change", async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    // Save them all under one batch, then run one check — the pick is one
    // visit to the plant, so it becomes one journal entry and one question.
    const batch = files.length > 1 ? uid() : null;
    let saved = 0;
    for (const file of files) {
      try { await addPhoto(id, file, { assess: false, batch }); saved++; } catch { /* skip unreadable */ }
    }
    if (!saved) { toast("Couldn't read that image"); return; }
    const label = saved > 1 ? `Journal entry added — ${saved} photos` : "Photo saved";
    toast(aiConfigured() ? `${label} — checking health…` : label);
    if (saved < files.length) toast(`Skipped ${files.length - saved} unreadable photo(s)`);
    autoAssess(id);
    render();
  });
  const gallery = document.getElementById("gallery");
  if (gallery) gallery.addEventListener("click", e => {
    if (e.target.tagName === "IMG") openPhotoViewer(e.target.dataset.photo, id);
  });
}

async function openPhotoViewer(photoId, plantId) {
  const ph = await dbGet("photos", photoId);
  if (!ph) return;
  const url = URL.createObjectURL(ph.blob);
  const div = document.createElement("div");
  div.className = "photo-viewer";
  div.innerHTML = `
    <div class="pv-bar">
      <button class="btn small danger" id="pvDelete">Delete</button>
      <button class="btn small secondary" id="pvClose">Close ✕</button>
    </div>
    <img src="${url}" alt="">`;
  document.body.appendChild(div);
  // This one lives outside #view, so it isn't covered by the per-view release.
  const close = () => { div.remove(); URL.revokeObjectURL(url); overlayClosed(div); };
  overlayOpened(div, close);
  div.addEventListener("click", e => { if (e.target === div) close(); });
  div.querySelector("#pvClose").addEventListener("click", close);
  div.querySelector("#pvDelete").addEventListener("click", async () => {
    if (!confirm("Delete this photo?")) return;
    await removeRecord("photos", photoId);
    close();
    render();
  });
}

// ----- Guide -----
/* Every species the collection actually contains — the plant's own species,
   plus anything else sharing its pot. Maps a guide key to the plants it
   covers, so the guide can say "this is your Monty and your Vera". */
async function ownedSpecies() {
  const plants = (await dbAll("plants")).filter(p => !p.archived);
  const owned = new Map();
  const add = (key, plant) => {
    if (!key) return;
    if (!owned.has(key)) owned.set(key, { g: guideEntry(key), plants: [] });
    const entry = owned.get(key);
    if (!entry.plants.some(p => p.id === plant.id)) entry.plants.push(plant);
  };
  plants.forEach(p => {
    add(p.speciesKey || "other", p);
    (p.alsoContains || []).forEach(a => add(a.key, p));
  });
  return owned;
}

// A guide entry is advice; the plant's own schedule is what the app actually
// runs on. Where the two disagree — because a health check rewrote the plan,
// or someone edited it — the guide should show what's really set.
function scheduleNote(plants, guide, field, guideDays) {
  const set = [...new Set(plants.map(p => p[field]).filter(n => typeof n === "number" && n > 0))];
  if (!set.length || (set.length === 1 && set[0] === guideDays)) return "";
  return ` <span class="guide-yours">yours: every ${set.sort((a, b) => a - b).join(" / ")}d</span>`;
}

async function viewGuide() {
  const season = currentSeason();
  const owned = await ownedSpecies();
  const allPlants = (await dbAll("plants")).filter(p => !p.archived);
  const ferts = (await dbAll("ferts")).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const ownedFerts = ferts.filter(f => f.owned !== false);
  const neededFerts = ferts.filter(f => f.owned === false);

  /* The fertilizer shelf. Each card is a product — what it is, how it's
     used, and which plants it feeds (tap a plant to unassign, pick from the
     dropdown to assign). "Ran out" moves it to the shopping list without
     losing anything; "Bought it" brings it back. */
  const fertCard = f => {
    const feeds = allPlants.filter(p => p.fertId === f.id);
    const rest = allPlants.filter(p => p.fertId !== f.id);
    const meta = [f.npk ? "NPK " + f.npk : "", f.form || ""].filter(Boolean).join(" · ");
    return `
    <div class="card fert-item" data-fert="${f.id}">
      <div class="fert-head">
        <div class="fert-title">
          <b>${esc(f.name)}</b>${f.brand ? `<span class="fert-brand"> · ${esc(f.brand)}</span>` : ""}
          ${meta ? `<div class="fert-meta">${esc(meta)}</div>` : ""}
        </div>
        <button class="fert-del" data-del aria-label="Remove ${esc(f.name)}">✕</button>
      </div>
      ${f.dilution ? `<p class="fert-line">${esc(f.dilution)}</p>` : ""}
      ${f.summary ? `<p class="fert-line sub">${esc(f.summary)}</p>` : ""}
      ${f.caution ? `<p class="fert-line caution">⚠️ ${esc(f.caution)}</p>` : ""}
      <div class="fert-feeds">
        ${feeds.map(p => `<button class="job chore" data-unassign="${p.id}" title="Stop feeding ${esc(p.name)} with this">${esc(p.name)} ✕</button>`).join("")}
        ${rest.length ? `<select class="fert-assign" data-assign aria-label="Feed another plant with this">
          <option value="">+ feeds…</option>
          ${rest.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
        </select>` : ""}
      </div>
      <button class="btn small secondary" data-toggle>${f.owned === false ? "Bought it ✓" : "Ran out — put on the list"}</button>
    </div>`;
  };
  // "Other" is a placeholder for a species we have no care data on — real
  // advice for it doesn't exist, so it stays out of the personalised list.
  const mine = [...owned.values()]
    .filter(o => o.g.key !== "other" && o.g.latin)
    .sort((a, b) => a.g.name.localeCompare(b.g.name));
  const unknown = owned.get("other");

  const card = (g, plants) => `
    <div class="card guide-item" data-name="${g.name.toLowerCase()} ${g.latin.toLowerCase()}">
      <div class="guide-head">
        <div class="guide-thumb" data-latin="${esc(g.latin)}" data-common="${esc(g.name)}"></div>
        <div>
          <div class="guide-name">${esc(g.name)}</div>
          <div class="guide-latin">${esc(g.latin)}</div>
          ${plants ? `<div class="guide-mine">${plants.map(p => esc(p.name)).join(", ")}</div>` : ""}
        </div>
      </div>
      <div class="guide-detail" hidden>
        <div><b>💧 Water:</b> every ~${g.waterDays} days${plants ? scheduleNote(plants, g, "waterEvery", g.waterDays) : ""}</div>
        <div><b>🌾 Fertilize:</b> ${g.fertDays
          ? `every ~${g.fertDays} days (spring–summer)${plants ? scheduleNote(plants, g, "fertEvery", g.fertDays) : ""}`
          : "not needed — this one does better unfed"}</div>
        <div><b>☀️ Light:</b> ${esc(g.light)}</div>
        <div><b>💡 Tip:</b> ${esc(g.tips)}</div>
      </div>
    </div>`;

  $view().innerHTML = `
    <h1>Care guide</h1>
    <p class="subtitle">${mine.length
      ? `Care for the ${mine.length} species in your collection${season ? `, and what they need in ${season}` : ""}.`
      : `Suggested schedules & tips for ${allSpecies().length - 1} common houseplants.`}</p>
    <div class="tip-card">${SEASONAL_TIPS[season]}</div>

    ${aiConfigured() && owned.size ? `
    <div class="card flat">
      <div class="section-head" style="margin:0">
        <h2 style="margin:0">Sprout AI advisor</h2>
        <button class="btn small secondary" id="btnGardenAi">Advise me</button>
      </div>
      <p class="subtitle" style="margin:6px 0 0">Reads every plant's state, care history and the weather, and says what the collection needs. It lives here because it's reading, not doing — Today only deals what can be done and cleared.</p>
      <div id="gardenAiResult"></div>
    </div>` : ""}

    <div class="section-head"><h2>Fertilizers</h2></div>
    <div class="card flat">
      <form id="fertForm" class="inline-form">
        <input type="text" id="fertText" placeholder="Paste a product link or type its name…" maxlength="300">
        <button class="btn" type="submit">Add</button>
      </form>
      <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
        <label class="btn small secondary" style="cursor:pointer">📷 Snap the label<input type="file" id="fertPhoto" accept="image/*" capture="environment" hidden></label>
        <span class="hint" id="fertStatus">${aiConfigured()
          ? "It identifies the product and matches it to your plants."
          : "Without an API key, what you type is saved as-is."}</span>
      </div>
    </div>
    <div id="fertList">
      ${ownedFerts.length ? `<div class="section-head" style="margin-top:14px"><h2 style="margin:0;font-size:16px">On the shelf · ${ownedFerts.length}</h2></div>
        ${ownedFerts.map(fertCard).join("")}` : ""}
      ${neededFerts.length ? `<div class="section-head" style="margin-top:14px"><h2 style="margin:0;font-size:16px">To buy · ${neededFerts.length}</h2></div>
        ${neededFerts.map(fertCard).join("")}` : ""}
      ${!ferts.length ? `<p class="subtitle" style="margin:4px 0 0">Nothing on the shelf yet — add what you've got and each plant learns what it's fed with.</p>` : ""}
    </div>

    ${mine.length ? `
      <div class="section-head"><h2>Your plants</h2></div>
      ${mine.map(o => card(o.g, o.plants)).join("")}
      ${unknown ? `<div class="card flat"><b>Not yet identified</b>
        <p class="subtitle" style="margin:6px 0 0">${unknown.plants.map(p => esc(p.name)).join(", ")} — set a species on ${
          unknown.plants.length > 1 ? "these" : "this one"} and its care lands here.</p></div>` : ""}
    ` : `<div class="card flat"><b>Nothing here yet</b>
      <p class="subtitle" style="margin:6px 0 0">Add a plant and its care notes show up at the top of this page.</p></div>`}

    <div class="section-head"><h2>All species</h2></div>
    <div class="search-bar"><input type="text" id="guideSearch" placeholder="Search ${allSpecies().length - 1} species…"></div>
    <div id="guideAll" hidden></div>
    <button class="btn block secondary" id="guideBrowse">Browse all ${allSpecies().length - 1} species</button>`;

  /* Submitting a fertilizer: link, name, or label photo. With a key the
     product identifies itself and lands pre-assigned to the plants it suits;
     without one the text is kept verbatim — a shelf you can still curate by
     hand. Every write goes through saveRecord, so the shelf syncs. */
  const fertStatus = document.getElementById("fertStatus");
  const addFert = async ({ text = "", imageBlob = null }) => {
    fertStatus.textContent = "Identifying…";
    try {
      let rec;
      let suits = [];
      if (aiConfigured()) {
        const r = await aiIdentifyFert({ text, imageBlob });
        rec = { id: uid(), name: r.name, brand: r.brand, npk: r.npk, form: r.form,
          dilution: r.dilution, summary: r.summary, caution: r.caution,
          owned: true, createdAt: new Date().toISOString() };
        suits = r.suits_plant_ids || [];
      } else {
        if (!text.trim()) throw new Error("Type a name, or add your API key for photos.");
        rec = { id: uid(), name: text.trim(), brand: "", npk: "", form: "", dilution: "",
          summary: "", caution: "", owned: true, createdAt: new Date().toISOString() };
      }
      await saveRecord("ferts", rec);
      let assigned = 0;
      for (const pid of suits) {
        const p = await dbGet("plants", pid);
        if (p && !p.archived) { p.fertId = rec.id; await saveRecord("plants", p); assigned++; }
      }
      toast(`Added ${rec.name}${assigned ? ` — feeds ${assigned} plant${assigned === 1 ? "" : "s"}` : ""}`);
      buzz(8);
      render();
    } catch (err) {
      fertStatus.textContent = `⚠️ ${err.message}`;
    }
  };
  document.getElementById("fertForm").addEventListener("submit", e => {
    e.preventDefault();
    const text = document.getElementById("fertText").value.trim();
    if (text) addFert({ text });
  });
  document.getElementById("fertPhoto").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!aiConfigured()) { fertStatus.textContent = "⚠️ Reading a label needs the API key — set it in Settings."; return; }
    addFert({ imageBlob: f });
  });

  document.getElementById("fertList").addEventListener("click", async e => {
    const card = e.target.closest("[data-fert]");
    if (!card) return;
    const f = await dbGet("ferts", card.dataset.fert);
    if (!f) return;
    if (e.target.closest("[data-del]")) {
      if (!confirm(`Remove ${f.name} from the shelf?`)) return;
      // Its plants shouldn't point at a ghost.
      for (const p of await dbAll("plants")) {
        if (p.fertId === f.id) { delete p.fertId; await saveRecord("plants", p); }
      }
      await removeRecord("ferts", f.id);
      render();
    } else if (e.target.closest("[data-toggle]")) {
      f.owned = f.owned === false;
      await saveRecord("ferts", f);
      toast(f.owned ? `${f.name} back on the shelf` : `${f.name} on the shopping list`);
      render();
    } else if (e.target.closest("[data-unassign]")) {
      const p = await dbGet("plants", e.target.closest("[data-unassign]").dataset.unassign);
      if (p) { delete p.fertId; await saveRecord("plants", p); render(); }
    }
  });
  document.getElementById("fertList").addEventListener("change", async e => {
    const sel = e.target.closest("[data-assign]");
    if (!sel || !sel.value) return;
    const p = await dbGet("plants", sel.value);
    if (p) { p.fertId = sel.closest("[data-fert]").dataset.fert; await saveRecord("plants", p); render(); }
  });

  const btnGardenAi = document.getElementById("btnGardenAi");
  if (btnGardenAi) btnGardenAi.addEventListener("click", async () => {
    const box = document.getElementById("gardenAiResult");
    btnGardenAi.disabled = true;
    btnGardenAi.textContent = "Thinking…";
    try {
      box.innerHTML = renderGardenInsights(await aiGardenInsights());
    } catch (err) {
      box.innerHTML = `<p class="subtitle" style="margin-top:10px">⚠️ ${esc(err.message)}</p>`;
    } finally {
      btnGardenAi.disabled = false;
      btnGardenAi.textContent = "Advise me";
    }
  });

  const all = document.getElementById("guideAll");
  const browse = document.getElementById("guideBrowse");
  const search = document.getElementById("guideSearch");
  let built = false;

  // A few hundred cards is a lot to hand the browser for a page most people
  // open to check one plant — so the full list is built only when asked for.
  const buildAll = () => {
    if (built) return;
    all.innerHTML = allSpecies().filter(g => g.key !== "other").map(g => card(g, null)).join("");
    built = true;
    wireCards(all);
  };

  const wireCards = (root) => {
    root.querySelectorAll(".guide-item").forEach(item => {
      if (item.dataset.wired) return;
      item.dataset.wired = "1";
      item.addEventListener("click", () => {
        const d = item.querySelector(".guide-detail");
        d.hidden = !d.hidden;
        if (!d.hidden) fillGuideThumb(item);
      });
    });
  };
  wireCards($view());

  browse.addEventListener("click", () => {
    buildAll();
    all.hidden = false;
    browse.hidden = true;
  });

  search.addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    if (q) { buildAll(); all.hidden = false; browse.hidden = true; }
    $view().querySelectorAll(".guide-item").forEach(c => {
      c.style.display = !q || c.dataset.name.includes(q) ? "" : "none";
    });
  });

  // Your own species get their photo straight away — there are only a handful.
  // The full list stays unfetched until a card is opened.
  $view().querySelectorAll(".guide-item").forEach(item => {
    if (item.parentElement === $view()) fillGuideThumb(item);
  });
}

async function fillGuideThumb(item) {
  const slot = item.querySelector(".guide-thumb");
  if (!slot || slot.dataset.done) return;
  slot.dataset.done = "1";
  try {
    const url = await speciesThumb(slot.dataset.latin, slot.dataset.common);
    if (!url) return;
    const img = new Image();
    img.alt = "";
    // Same reasoning as the species rows: decode first so a failed load leaves
    // the neutral slot rather than a broken-image icon.
    img.onload = () => { slot.innerHTML = ""; slot.appendChild(img); slot.classList.add("has-img"); };
    img.src = url;
  } catch { /* the slot just stays neutral */ }
}

// ----- Pairing (opened from a "Pair another phone" link) -----
async function viewPair(payload) {
  const already = syncConfigured();
  $view().innerHTML = `
    <h1>Join the garden</h1>
    <p class="subtitle">This link connects this phone to a shared Sprout garden. You'll both see the same plants, photos, and checklists — live.</p>
    ${already ? `<div class="card flat"><b>Heads up</b><p class="subtitle" style="margin:6px 0 0">This phone is already synced. Joining a different garden replaces what's here — export a backup first if you're unsure.</p></div>` : ""}
    <div class="card">
      <button class="btn block" id="pairAccept">${already ? "Switch to this garden" : "Join garden"}</button>
      <button class="btn block secondary" id="pairCancel" style="margin-top:8px">Not now</button>
      <div id="pairMsg"></div>
    </div>`;

  document.getElementById("pairCancel").addEventListener("click", () => { location.hash = "#/today"; });
  document.getElementById("pairAccept").addEventListener("click", async e => {
    const btn = e.target, msg = document.getElementById("pairMsg");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    msg.innerHTML = "";
    try {
      await acceptPairing(payload);
      toast("Connected — your gardens are now shared");
      location.hash = "#/today";
    } catch (err) {
      msg.innerHTML = `<p class="subtitle" style="margin-top:10px">⚠️ ${esc(err.message)}</p>`;
      btn.disabled = false;
      btn.textContent = already ? "Switch to this garden" : "Join garden";
    }
  });
}

// ----- Settings -----
async function viewSettings() {
  const notifState = ("Notification" in window) ? Notification.permission : "unsupported";
  $view().innerHTML = `
    <h1>Settings</h1>
    <p class="subtitle">Household, reminders & backups.</p>

    <div class="card">
      <h2 style="margin-top:0">Household</h2>
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
      <h2 style="margin-top:0">Watering days</h2>
      <p class="subtitle">Watering collects onto the days you pick, so you're not doing a little every day. On a watering day you do everything that would come due before the next one.</p>
      <div class="pill-row" id="waterDayPills">
        ${DAY_NAMES.map((d, i) => `<button class="pill ${waterDays().includes(i) ? "active" : ""}" data-day="${i}">${d}</button>`).join("")}
      </div>
      <p class="subtitle" id="waterDayHint"></p>
      <button class="btn secondary" id="applyRhythm">Move every plant onto this rhythm</button>
      <p class="subtitle" id="rhythmResult" style="margin-bottom:0"></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Reminders</h2>
      <p class="subtitle">When the app is open (or installed to your home screen), Sprout checks for due plants and sends a daily notification.</p>
      <button class="btn block secondary" id="notifBtn">
        ${notifState === "granted" ? "✓ Notifications enabled" : notifState === "denied" ? "Notifications blocked in browser settings" : notifState === "unsupported" ? "Not supported on this browser" : "Enable notifications"}
      </button>
      <p class="hint" style="margin-top:8px;color:var(--ink-soft);font-size:.78rem">
        Tip: on iPhone/Android, open this page in the browser and choose <b>Add to Home Screen</b> — Sprout works offline and feels like a native app.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Sprout AI</h2>
      <p class="subtitle">Claude (Anthropic's AI) assesses plant health from your photos and reasons over your whole garden's care. Uses your own Anthropic API key — stored only on this device, calls billed to your Anthropic account (a few cents per check).</p>
      ${aiConfigured() ? `
        <p class="subtitle">✅ Connected · model: <b>Claude Opus</b></p>
        <button class="btn small danger" id="aiClearBtn">Remove API key</button>` : `
        <details style="margin-bottom:12px">
          <summary style="cursor:pointer;font-weight:600">How to get an API key (~2 min)</summary>
          <ol style="padding-left:18px;font-size:.85rem;margin-top:8px">
            <li>Go to <b>console.anthropic.com</b> and create an account.</li>
            <li>Add a small amount of credit under Billing (5 dollars goes a long way).</li>
            <li>Create an API key under <b>API keys</b> and paste it below.</li>
          </ol>
        </details>
        <form id="aiForm" class="inline-form">
          <input type="password" id="aiKeyInput" placeholder="sk-ant-…" autocomplete="off">
          <button class="btn" type="submit">Save</button>
        </form>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Weather &amp; location</h2>
      <p class="subtitle">Powers live rain, heat, and frost advice for outdoor plants (porch, balcony, garden). Your location is stored only on this device.</p>
      ${weatherConfigured() ? `
        <p class="subtitle">📍 <b>${esc(state.settings.weather.label || "Saved location")}</b></p>
        <div class="pill-row">
          <button class="pill ${weatherUnit() === "fahrenheit" ? "active" : ""}" data-unit="fahrenheit">°F</button>
          <button class="pill ${weatherUnit() === "celsius" ? "active" : ""}" data-unit="celsius">°C</button>
        </div>
        <button class="btn small danger" id="wxClearBtn">Remove location</button>` : `
        <button class="btn block secondary" id="wxGeoBtn" style="margin-bottom:10px">Use my current location</button>
        <form id="wxCityForm" class="inline-form">
          <input type="text" id="wxCityInput" placeholder="…or search a city" maxlength="60">
          <button class="btn secondary" type="submit">Search</button>
        </form>
        <div id="wxCityResults"></div>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Calendar</h2>
      <p class="subtitle">Put the next month of watering and fertilizing on a calendar — one entry a day, listing what needs doing.</p>

      <div class="cal-block">
        <b>Download once</b>
        <p class="subtitle" style="margin:4px 0 10px">A .ics file you can open in any calendar app. No accounts, but it's a snapshot — re-download after schedules change.</p>
        <button class="btn block secondary" id="icsBtn">Download .ics</button>
      </div>

      <div class="cal-block">
        <b>Or keep it in sync with Google</b>
        ${calConnected() ? `
          <p class="subtitle" style="margin:4px 0 10px">🟢 Connected. Sprout writes to its own <b>${esc(CAL_NAME)}</b> calendar — never your main one.${
            calSettings().lastSync ? ` Last synced ${fmtDateTime(calSettings().lastSync)}.` : ""}</p>
          <button class="btn block" id="calSyncBtn">Sync now</button>
          <button class="btn block secondary" id="calOffBtn" style="margin-top:8px">Disconnect</button>
          <div id="calMsg"></div>` : `
          <p class="subtitle" style="margin:4px 0 10px">Needs a Google OAuth client ID — a one-time setup in Google Cloud, free. <button type="button" class="link-btn" id="calHelpBtn">How</button></p>
          <div id="calHelp" hidden>
            <ol class="setup-steps">
              <li>Open <b>console.cloud.google.com</b> and make a project (any name).</li>
              <li>Under <b>APIs &amp; Services → Library</b>, enable <b>Google Calendar API</b>.</li>
              <li>Under <b>OAuth consent screen</b>, pick <b>External</b>, fill in the name and your email, and add both of your Google addresses under <b>Test users</b>. Leave it in Testing — it never needs review for just the two of you.</li>
              <li>Under <b>Credentials → Create credentials → OAuth client ID</b>, choose <b>Web application</b>, and add this exact origin under <b>Authorized JavaScript origins</b>:<br><code class="origin-code">${esc(location.origin)}</code></li>
              <li>Copy the client ID (ends in <b>.apps.googleusercontent.com</b>) and paste it below.</li>
            </ol>
          </div>
          <form id="calForm" class="inline-form">
            <input type="text" id="calClientId" placeholder="…apps.googleusercontent.com" autocomplete="off" value="${esc(calSettings().clientId || "")}">
            <button class="btn" type="submit">Connect</button>
          </form>
          <div id="calMsg"></div>`}
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Real-time sync</h2>
      <p class="subtitle" id="syncStatus">${syncStatusText()}</p>
      ${syncConfigured() ? `
        <p class="subtitle">You and everyone you've paired share one live database — waterings, photos, and checklists appear on the other phone within seconds.</p>
        <button class="btn block" id="pairBtn" style="margin-bottom:10px">Pair another phone</button>
        <div id="pairBox"></div>
        <div class="action-row">
          <button class="btn secondary" id="syncNowBtn">Sync now</button>
          <button class="btn danger" id="syncOffBtn">Disconnect</button>
        </div>` : `
        <div class="join-box">
          <b>Already have a garden on another device?</b>
          <p class="subtitle" style="margin:4px 0 10px">Paste the pairing link from that device — this is the only way to join an existing garden. Typing the database details below starts a <em>new, empty</em> one.</p>
          <form id="joinForm" class="inline-form">
            <input type="text" id="joinLink" placeholder="Paste pairing link" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button class="btn" type="submit">Join</button>
          </form>
          <div id="joinMsg"></div>
        </div>

        <p class="subtitle" style="margin-top:22px"><b>Setting up for the first time?</b> Only one of you does this. The other device joins with the pairing link.</p>
        <details style="margin-bottom:12px">
          <summary style="cursor:pointer;font-weight:600">Set up the shared database (~5 min, free, once)</summary>
          <ol style="padding-left:18px;font-size:.85rem;margin-top:8px;line-height:1.6">
            <li>Open <b>supabase.com</b>, sign up (free — no card needed), and click <b>New project</b>. Any name works; save the database password it asks for, you won't need it again.</li>
            <li>Wait ~2 min for it to finish setting up.</li>
            <li>In the left sidebar open <b>SQL Editor</b>, tap the button below to copy the script, paste it in, and press <b>Run</b>.</li>
            <li>In the left sidebar open <b>Settings → API</b>. Copy the <b>Project URL</b> and the <b>anon public</b> key into the two boxes below.</li>
            <li>Hit Connect — then use <b>Pair another phone</b> to bring your wife's phone in.</li>
          </ol>
          <button class="btn small secondary" id="copySqlBtn" type="button">Copy setup script</button>
        </details>
        <form id="syncForm">
          <div class="field"><label for="syncUrl">Project URL</label>
            <input type="text" id="syncUrl" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocorrect="off"></div>
          <div class="field"><label for="syncKey">anon public key</label>
            <input type="text" id="syncKey" placeholder="eyJ… or sb_publishable_…" autocapitalize="off" autocorrect="off"></div>
          <button class="btn block" type="submit">Create a new garden</button>
        </form>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Backup</h2>
      <p class="subtitle">Manual export/import of everything (plants, history, photos) — handy as an offline backup even with sync on.</p>
      <div class="action-row">
        <button class="btn secondary" id="exportBtn">Export backup</button>
        <label class="btn secondary" style="cursor:pointer">Import<input type="file" id="importInput" accept=".json,application/json" hidden></label>
      </div>
      <p class="hint" style="color:var(--ink-soft);font-size:.78rem">Import merges by ID — newer entries win, nothing is duplicated.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">About</h2>
      <p class="subtitle" style="margin:0">Sprout 🌱 — a little plant-care tracker for two. Data lives on this device; with real-time sync on, it's shared only through your own private Supabase project.</p>
      <p class="subtitle" style="margin:.75rem 0 .5rem">Running <b id="swVersion">checking…</b></p>
      <button class="btn" id="swUpdateBtn" type="button">Check for updates</button>
      <p class="hint" style="color:var(--ink-soft);font-size:.78rem;margin-bottom:0">If a version is waiting, this loads it and restarts the app.</p>
    </div>`;

  const swLabel = document.getElementById("swVersion");
  if (swLabel) {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.controller) swLabel.textContent = "from the network";
    else {
      const chan = new MessageChannel();
      chan.port1.onmessage = e => { if (e.data?.type === "version") swLabel.textContent = e.data.version; };
      sw.controller.postMessage("version", [chan.port2]);
      setTimeout(() => { if (swLabel.textContent === "checking…") swLabel.textContent = "an older version"; }, 1200);
    }
  }
  const swUpdateBtn = document.getElementById("swUpdateBtn");
  if (swUpdateBtn) swUpdateBtn.addEventListener("click", async () => {
    const sw = navigator.serviceWorker;
    if (!sw) return toast("No app cache to update");
    swUpdateBtn.disabled = true;
    try {
      const reg = await sw.getRegistration();
      if (!reg) return toast("Nothing cached yet");
      await reg.update();
      // A worker sitting in "waiting" is the new version held back because this
      // page is still using the old one. Tell it to take over — controllerchange
      // then reloads us into it.
      const pending = reg.waiting || reg.installing;
      if (pending) { pending.postMessage("skipWaiting"); toast("Updating…"); }
      else toast("Already up to date");
    } catch { toast("Couldn't check for updates"); }
    finally { swUpdateBtn.disabled = false; }
  });

  const aiForm = document.getElementById("aiForm");
  if (aiForm) aiForm.addEventListener("submit", async e => {
    e.preventDefault();
    const key = document.getElementById("aiKeyInput").value.trim();
    if (!key) return;
    state.settings.ai = { key };
    await saveSettings();
    toast("Sprout AI enabled");
    render();
  });
  const aiClearBtn = document.getElementById("aiClearBtn");
  if (aiClearBtn) aiClearBtn.addEventListener("click", async () => {
    state.settings.ai = null;
    await saveSettings();
    render();
  });

  // ----- Calendar -----
  const icsBtn = document.getElementById("icsBtn");
  if (icsBtn) icsBtn.addEventListener("click", async () => {
    try {
      const days = await downloadCareICS();
      toast(`Exported ${days} day${days > 1 ? "s" : ""} of care`);
    } catch (err) {
      toast(err.message);
    }
  });

  const calHelpBtn = document.getElementById("calHelpBtn");
  if (calHelpBtn) calHelpBtn.addEventListener("click", () => {
    const help = document.getElementById("calHelp");
    help.hidden = !help.hidden;
    calHelpBtn.textContent = help.hidden ? "How" : "Hide";
  });

  const calForm = document.getElementById("calForm");
  if (calForm) calForm.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = document.getElementById("calMsg");
    const clientId = document.getElementById("calClientId").value.trim();
    if (!clientId) return;
    msg.innerHTML = `<p class="subtitle">Opening Google…</p>`;
    state.settings.calendar = { clientId };
    await saveSettings();
    try {
      await calConnect();
      const { written } = await calSync();
      toast(`Calendar connected — ${written} day${written === 1 ? "" : "s"} added`);
      render();
    } catch (err) {
      state.settings.calendar = { clientId };  // keep the id so it isn't retyped
      await saveSettings();
      msg.innerHTML = `<p class="subtitle">⚠️ ${esc(err.message)}</p>`;
    }
  });

  const calSyncBtn = document.getElementById("calSyncBtn");
  if (calSyncBtn) calSyncBtn.addEventListener("click", async () => {
    const msg = document.getElementById("calMsg");
    calSyncBtn.disabled = true;
    calSyncBtn.textContent = "Syncing…";
    try {
      const { written } = await calSync();
      msg.innerHTML = `<p class="subtitle">✓ ${written} day${written === 1 ? "" : "s"} of care on your calendar.</p>`;
    } catch (err) {
      msg.innerHTML = `<p class="subtitle">⚠️ ${esc(err.message)}</p>`;
    } finally {
      calSyncBtn.disabled = false;
      calSyncBtn.textContent = "Sync now";
    }
  });

  const calOffBtn = document.getElementById("calOffBtn");
  if (calOffBtn) calOffBtn.addEventListener("click", async () => {
    const alsoDelete = confirm("Also delete the Sprout calendar from Google, with its entries?");
    try {
      await calDisconnect({ removeCalendar: alsoDelete });
      toast("Calendar disconnected");
    } catch (err) {
      toast(err.message);
    }
    render();
  });

  const wxGeoBtn = document.getElementById("wxGeoBtn");
  if (wxGeoBtn) {
    wxGeoBtn.addEventListener("click", () => {
      if (!navigator.geolocation) { toast("Geolocation not available — search a city instead"); return; }
      wxGeoBtn.textContent = "📍 Locating…";
      navigator.geolocation.getCurrentPosition(async pos => {
        state.settings.weather = {
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
          label: "My location", unit: weatherUnit()
        };
        await saveSettings();
        await getWeather(true);
        toast("Location saved");
        render();
      }, () => {
        wxGeoBtn.textContent = "📍 Use my current location";
        toast("Couldn't get location — search a city instead");
      }, { timeout: 10000 });
    });
    document.getElementById("wxCityForm").addEventListener("submit", async e => {
      e.preventDefault();
      const q = document.getElementById("wxCityInput").value.trim();
      if (!q) return;
      const box = document.getElementById("wxCityResults");
      box.innerHTML = `<p class="subtitle">Searching…</p>`;
      try {
        const hits = await geocodeCity(q);
        box.innerHTML = hits.length
          ? hits.map((h, i) => `<button class="btn small secondary" style="margin:4px 4px 0 0" data-city="${i}">📍 ${esc(h.label)}</button>`).join("")
          : `<p class="subtitle">No matches — try a bigger nearby city.</p>`;
        box.querySelectorAll("[data-city]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const h = hits[parseInt(btn.dataset.city, 10)];
            state.settings.weather = { lat: h.lat, lon: h.lon, label: h.label, unit: weatherUnit() };
            await saveSettings();
            await getWeather(true);
            toast("Location saved");
            render();
          });
        });
      } catch {
        box.innerHTML = `<p class="subtitle">Search failed — check your connection.</p>`;
      }
    });
  }
  const wxClearBtn = document.getElementById("wxClearBtn");
  if (wxClearBtn) {
    wxClearBtn.addEventListener("click", async () => {
      state.settings.weather = null;
      await saveSettings();
      render();
    });
    document.querySelectorAll("[data-unit]").forEach(pill => {
      pill.addEventListener("click", async () => {
        state.settings.weather.unit = pill.dataset.unit;
        await saveSettings();
        await getWeather(true);
        render();
      });
    });
  }

  const syncForm = document.getElementById("syncForm");
  if (syncForm) {
    document.getElementById("copySqlBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(SYNC_SETUP_SQL); toast("Setup script copied"); }
      catch { prompt("Copy this script:", SYNC_SETUP_SQL); }
    });
    syncForm.addEventListener("submit", async e => {
      e.preventDefault();
      const url = document.getElementById("syncUrl").value.trim().replace(/\/+$/, "");
      const key = document.getElementById("syncKey").value.trim();
      if (!url || !key) { toast("Paste both the URL and the key"); return; }
      // The household code is generated, not typed — the second phone gets it
      // from the pairing link, so there's nothing to keep in sync by hand.
      const household = "home-" + uid();
      state.settings.sync = { url, key, household, lastPullAt: "" };
      await saveSettings();
      const ok = await syncConnect(true);
      if (ok) toast("Connected — syncing");
      else { state.settings.sync = null; await saveSettings(); }
      render();
    });
  }
  const joinForm = document.getElementById("joinForm");
  if (joinForm) joinForm.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = document.getElementById("joinMsg");
    const raw = document.getElementById("joinLink").value.trim();
    if (!raw) return;
    // Accept the whole link, just the hash, or the bare payload — whatever
    // survived the trip through a messaging app.
    const payload = raw.split("#/pair/").pop().replace(/^#?\/?(pair\/)?/, "").trim();
    msg.innerHTML = `<p class="subtitle">Joining…</p>`;
    try {
      await acceptPairing(payload);
      toast("Joined — your plants are on the way");
      render();
    } catch (err) {
      msg.innerHTML = `<p class="subtitle">⚠️ ${esc(syncFriendlyError(err.message))}</p>`;
    }
  });

  const pairBtn = document.getElementById("pairBtn");
  if (pairBtn) pairBtn.addEventListener("click", async () => {
    const link = pairingLink();
    const box = document.getElementById("pairBox");
    // Native share sheet where available (AirDrop/Messages); copy link otherwise.
    if (navigator.share) {
      try {
        await navigator.share({ title: "Join our Sprout garden", text: "Tap to sync our plants:", url: link });
        toast("Sent — they just tap the link");
        return;
      } catch { /* dismissed; fall through to the copyable link */ }
    }
    box.innerHTML = `
      <p class="subtitle" style="margin-bottom:8px">Send this link to the other phone. Opening it connects them automatically — nothing to type.</p>
      <div class="inline-form"><input type="text" id="pairLink" value="${esc(link)}" readonly><button class="btn secondary" id="pairCopy">Copy</button></div>
      <p class="hint" style="color:var(--ink-soft);font-size:.78rem;margin-top:6px">Treat it like a house key — it grants access to your garden data.</p>`;
    document.getElementById("pairLink").addEventListener("focus", e => e.target.select());
    document.getElementById("pairCopy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link); toast("Link copied"); }
      catch { document.getElementById("pairLink").select(); toast("Press and hold to copy"); }
    });
  });

  const syncNowBtn = document.getElementById("syncNowBtn");
  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", async () => {
      toast("Syncing…");
      if (!SYNC.client) await syncConnect();
      // Tapped by hand, "Sync now" should leave nothing to doubt: re-read the
      // whole household rather than trust the cursor.
      else { await syncFlushOutbox(); await syncPull({ full: true }); }
      toast(SYNC.status === "online" ? "Up to date ✓" : "Sync problem — see status");
      render();
    });
    document.getElementById("syncOffBtn").addEventListener("click", async () => {
      if (!confirm("Turn off sync on this phone? Local data stays; the cloud copy is untouched.")) return;
      await syncDisconnect();
      render();
    });
  }

  document.querySelectorAll("#userPills .pill").forEach(pill => {
    pill.addEventListener("click", async () => {
      state.settings.activeUser = pill.dataset.user;
      await saveSettings();
      render();
    });
  });

  const dayHint = document.getElementById("waterDayHint");
  const showDayHint = () => {
    const days = waterDays();
    if (!days.length) {
      dayHint.textContent = "No watering days picked — every plant is listed on its own day.";
      return;
    }
    const gap = maxWaterGap(days);
    dayHint.textContent = `${days.map(d => DAY_NAMES[d]).join(", ")} — nothing waits more than ${gap} day${gap === 1 ? "" : "s"}. `
      + `Plants that need water more often than that (outdoor pots in summer, mostly) keep their own schedule.`;
  };
  showDayHint();
  document.getElementById("applyRhythm").addEventListener("click", async e => {
    const btn = e.target, out = document.getElementById("rhythmResult");
    btn.disabled = true;
    const moved = await applyWaterRhythm();
    btn.disabled = false;
    const dayList = waterDays().map(d => DAY_NAMES[d]).join(", ");
    out.textContent = moved.length
      ? `Moved ${moved.length} plant${moved.length === 1 ? "" : "s"} onto the rhythm: `
        + moved.map(m => `${m.name} (${m.from}d → ${m.to}d)`).join(", ")
        + `. The Today calendar now groups watering on ${dayList}.`
      : `Every plant already fits — watering now lands on ${dayList}.`;
    if (moved.length) toast(`${moved.length} plant${moved.length === 1 ? "" : "s"} moved onto the rhythm`);
  });
  document.querySelectorAll("#waterDayPills .pill").forEach(pill => {
    pill.addEventListener("click", async () => {
      const day = Number(pill.dataset.day);
      const days = waterDays();
      state.settings.waterDays = days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort();
      pill.classList.toggle("active");
      await saveSettings();
      showDayHint();
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
    if (perm === "granted") { toast("Reminders on"); checkAndNotify(true); }
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
    if (!ph.blob) continue;
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
      if (!existing || (p.lastWatered || "") > (existing.lastWatered || "")) await saveRecord("plants", p);
    }
    for (const l of payload.logs || []) await saveRecord("logs", l);
    for (const t of payload.tasks || []) await saveRecord("tasks", t);
    for (const ph of payload.photos || []) {
      const existing = await dbGet("photos", ph.id);
      if (!existing) {
        await saveRecord("photos", { id: ph.id, plantId: ph.plantId, createdAt: ph.createdAt, blob: await dataURLToBlob(ph.dataURL) });
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
  { re: /^#\/pair\/(.+)$/, fn: m => viewPair(m[1]), tab: "settings" },
];

/* Where the back button goes. Following browser history would sometimes leave
   the app, and swiping from plant to plant would turn "back" into an undo of
   the swipe — so remember the last screen that wasn't a plant or its edit form
   and return there. That's Today if you came from a task, the list if you came
   from the list. */
let backHash = "#/plants";
// Set while a plant is on screen, so the arrow keys have something to drive.
let plantNavGo = null;

/* The plant screen gets a detail-screen top bar: back on the left, Edit on the
   right, position in the collection between them. None of that belongs on any
   other screen, and the profile chip belongs to the app rather than to one
   plant — both at once is clutter on a screen that is mostly photograph. */
function setTopbarMode(onPlant) {
  document.querySelector(".brand").hidden = onPlant;
  document.getElementById("profileBtn").hidden = onPlant;
  document.getElementById("backBtn").hidden = !onPlant;
  document.getElementById("editBtn").hidden = !onPlant;
  document.getElementById("plantNav").hidden = !onPlant;
  // Claims horizontal gestures from the browser's back/forward navigation —
  // only here, so every other screen keeps the native behaviour.
  document.body.classList.toggle("swipe-nav", onPlant);
  if (!onPlant) {
    // Leaving the screen takes its gestures and key handling with it.
    plantNavGo = null;
    $view().ontouchstart = null;
    $view().ontouchend = null;
  }
}

/* Scrolling to the top belongs to navigation, not to redrawing.

   Everything on Today re-renders the whole view — ticking a task, watering a
   plant, a sync landing — and each one used to throw you back to the top. Ten
   items down the agenda, that makes the list unusable: you finish something
   and have to find your place again.

   So the jump only happens when the route actually changes. A redraw of the
   screen you're already on puts you back where you were. */
/* Where you are in the deck. Module-level because completing something
   re-renders the whole view, and the card you were on has to survive that. */
let todayRoom = "";
let todayLastRoom = null;
// Cards swiped "skip" this session sink to the bottom of the queue — the
// deck comes back around to them rather than dropping them.
let todayLater = [];

let renderedHash = null;

/* The tabs remember where you left them. Going into a plant from halfway
   down the collection and coming back used to land at the top — scroll back
   down, find your spot, every single time. Each tab screen now saves its
   offset on the way out and restores it on the way back, the way native
   tabs behave.

   Detail screens deliberately don't: a plant page, the add flow, an edit
   form all read from the top, and swiping plant-to-plant starts each one
   fresh. If the list shrank while you were away the browser clamps the
   restore to what's there. Session-only — a fresh open starts at the top. */
const SCROLL_MEMORY = new Map();
const remembersScroll = h => /^#\/(today|plants|guide|settings)$/.test(h);

async function render() {
  const hash = location.hash || "#/today";
  const sameScreen = hash === renderedHash;
  if (!sameScreen && renderedHash && remembersScroll(renderedHash)) {
    SCROLL_MEMORY.set(renderedHash, window.scrollY);
  }
  const keepAt = sameScreen ? window.scrollY
    : remembersScroll(hash) ? (SCROLL_MEMORY.get(hash) || 0) : 0;
  renderedHash = hash;
  const route = routes.find(r => r.re.test(hash)) || routes[0];
  const m = hash.match(route.re);
  const onPlant = /^#\/plant\//.test(hash);
  // The outgoing view's photos are about to be replaced — let go of them.
  releaseViewURLs();
  if (!onPlant && !/^#\/edit\//.test(hash)) backHash = hash;
  setTopbarMode(onPlant);
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === route.tab));
  try {
    await route.fn(m);
  } catch (err) {
    $view().innerHTML = `<div class="empty"><div class="big">·</div><p>Something went wrong.<br>${esc(err.message)}</p></div>`;
  }
  // After the content is in place: restoring first would be clamped against
  // the old height.
  window.scrollTo(0, keepAt);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  await loadSettings();
  /* Publish this device's household choices if it has any of its own and there
     is no shared record yet — the case of a phone that has been in use since
     before preferences synced. savePrefs stays silent on a device still on
     defaults, which is what stops a joining phone from overwriting the real
     settings with factory ones. */
  await savePrefs();
  await loadLearnedSpecies();
  renderProfileChip();

  // Arrow keys mirror the swipe, for anyone on a laptop. Registered once —
  // plantNavGo is null unless a plant is on screen.
  document.addEventListener("keydown", e => {
    if (!plantNavGo || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector(".sheet-wrap, .photo-viewer")) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); plantNavGo(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); plantNavGo(1); }
  });
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

  /* Heal text the model wrote before responses were cleaned: summaries with
     a literal "—" where an em-dash should be, tofu boxes from broken
     surrogates. Idempotent and quiet — only records that actually change are
     rewritten (and so re-synced), so after the first pass this scans and
     touches nothing. Runs after first paint; a heal repaints. */
  (async () => {
    let fixed = 0;
    for (const store of ["plants", "tasks", "logs", "species"]) {
      for (const rec of await dbAll(store)) {
        const before = JSON.stringify(rec);
        deepCleanText(rec);
        if (JSON.stringify(rec) !== before) { await saveRecord(store, rec); fixed++; }
      }
    }
    if (fixed) {
      console.log(`Sprout: cleaned model text on ${fixed} record(s)`);
      render();
    }
  })().catch(() => { /* cosmetic sweep — never worth failing the boot over */ });

  /* Prune the pile-up from before assessments superseded each other: for
     every plant, only the LATEST assessment's open health steps stay, and a
     title repeated within it collapses to one. Human tasks, chat requests
     and done steps are never touched. Only removes; runs quiet once the
     shelf is clean. */
  (async () => {
    const stamp = t => { const m = /^ai_[0-9a-z]+_([0-9a-z]+)_\d+$/.exec(t.id || ""); return m ? parseInt(m[1], 36) : Date.parse(t.createdAt || 0); };
    const byPlant = new Map();
    for (const t of await dbAll("tasks")) {
      if (t.done || !t.plantId || !isHealthStep(t)) continue;
      if (!byPlant.has(t.plantId)) byPlant.set(t.plantId, []);
      byPlant.get(t.plantId).push(t);
    }
    let pruned = 0;
    for (const list of byPlant.values()) {
      const latest = Math.max(...list.map(stamp));
      const seen = new Set();
      for (const t of list.sort((a, b) => stamp(b) - stamp(a))) {
        const key = (t.title || "").trim().toLowerCase();
        if (stamp(t) < latest || seen.has(key)) { await removeRecord("tasks", t.id); pruned++; }
        else seen.add(key);
      }
    }
    if (pruned) { console.log(`Sprout: retired ${pruned} superseded health step(s)`); render(); }
  })().catch(() => {});

  /* Orphans: tasks whose plant no longer exists (deleted before deletion
     took its tasks along). AI steps about a gone plant are meaningless and
     go; a person's task keeps its words and drops the dead link, so it shows
     honestly as a loose chore instead of hiding behind a plant that isn't
     there. Fertilizer assignments pointing at gone plants need nothing —
     they live on the plant record, which is the thing that's gone. */
  (async () => {
    const living = new Set((await dbAll("plants")).map(p => p.id));
    let fixed = 0;
    for (const t of await dbAll("tasks")) {
      if (!t.plantId || living.has(t.plantId)) continue;
      if (t.by === "Sprout AI") await removeRecord("tasks", t.id);
      else { t.plantId = ""; t.plantName = ""; await saveRecord("tasks", t); }
      fixed++;
    }
    if (fixed) { console.log(`Sprout: resolved ${fixed} orphaned task(s)`); render(); }
  })().catch(() => {});

  if (syncConfigured()) syncConnect().catch(() => {});
  maybeAutoSyncCalendar();

  /* Realtime carries changes while the app is open, and a 60s timer backstops
     it. Neither helps the moment you unlock your phone and look: the realtime
     socket may have been dropped in the background, and the timer can be 59
     seconds away. Pull on the way back in, so what you see is current. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!syncConfigured()) return;
    if (SYNC.client) { syncFlushOutbox().catch(() => {}); syncPull().catch(() => {}); }
    else syncConnect().catch(() => {});
  });

  window.addEventListener("online", () => {
    if (syncConfigured()) {
      if (SYNC.client) { syncFlushOutbox().catch(() => {}); syncPull().catch(() => {}); }
      else syncConnect().catch(() => {});
    }
  });

  /* Keeping the app up to date. Registering and walking away isn't enough: a
     new worker can install, activate and claim this page while the page goes
     on running the app.js it started with. On a home-screen PWA that page can
     live for days, so a merged change simply never appears. So: ask for an
     update whenever the app is opened or comes back to the foreground, and
     when a new worker actually takes over, reload once to pick it up. */
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // First install claims the page too — that one is already current.
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then(reg => {
      /* A worker that has finished installing waits for every page using the
         old one to go away — which, for an app you never really close, is
         never. skipWaiting() inside install isn't dependable once the page is
         controlled, so promote it from here: that reliably fires
         controllerchange, and the reload above lands us on the new build. */
      const promote = w => {
        if (!w || !navigator.serviceWorker.controller) return;
        if (w.state === "installed") w.postMessage("skipWaiting");
        else w.addEventListener("statechange", () => {
          if (w.state === "installed") w.postMessage("skipWaiting");
        });
      };
      promote(reg.waiting);
      reg.addEventListener("updatefound", () => promote(reg.installing));
      const check = () => reg.update().catch(() => {});
      check();
      document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
      window.addEventListener("online", check);
      setInterval(check, 60 * 60 * 1000);
      navigator.serviceWorker.addEventListener("message", e => {
        if (e.data && e.data.type === "version") state.swVersion = e.data.version;
      });
      navigator.serviceWorker.controller?.postMessage("version");
    }).catch(() => {});
  }
})();
