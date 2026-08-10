/* Sprout cloud sync — real-time shared data via a user-provided Supabase project.
   Local-first: IndexedDB stays the source of truth on each device; changes are
   queued in an outbox and pushed, remote changes arrive via realtime + pulls.
   Conflict resolution: last-write-wins on each record's updatedAt. */
"use strict";

const SYNC = {
  client: null,
  channel: null,
  status: "off",      // off | connecting | online | error
  statusMsg: "",
  flushing: false,
  pullTimer: null,
};

const SYNC_STORES = ["plants", "logs", "tasks", "photos"];
const PHOTO_BUCKET = "plant-photos";

const SYNC_SETUP_SQL = `-- Sprout sync setup: paste into Supabase > SQL Editor > Run (once)
create table if not exists records (
  id text primary key,
  household text not null,
  store text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists records_household_updated
  on records (household, updated_at);
alter table records enable row level security;
create policy "sprout anon access" on records
  for all to anon using (true) with check (true);
alter publication supabase_realtime add table records;

insert into storage.buckets (id, name) values ('plant-photos', 'plant-photos')
  on conflict (id) do nothing;
create policy "sprout photos select" on storage.objects
  for select to anon using (bucket_id = 'plant-photos');
create policy "sprout photos insert" on storage.objects
  for insert to anon with check (bucket_id = 'plant-photos');
create policy "sprout photos update" on storage.objects
  for update to anon using (bucket_id = 'plant-photos');
create policy "sprout photos delete" on storage.objects
  for delete to anon using (bucket_id = 'plant-photos');`;

function syncConfigured() {
  const s = state.settings.sync;
  return !!(s && s.url && s.key && s.household);
}

// ---------------------------------------------------------------------------
// Pairing: one phone sets Supabase up, the rest join by opening a link.
// The link carries url + key + household in its hash, so nothing is typed and
// nothing is sent to a server — the hash never leaves the device it opens on.
// ---------------------------------------------------------------------------
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(pad + "=".repeat((4 - pad.length % 4) % 4))));
}

function pairingLink() {
  const s = state.settings.sync;
  const payload = b64urlEncode(JSON.stringify({ u: s.url, k: s.key, h: s.household }));
  return location.origin + location.pathname + "#/pair/" + payload;
}

// Called by the router when a pairing link is opened.
async function acceptPairing(payload) {
  const { u, k, h } = JSON.parse(b64urlDecode(payload));
  if (!u || !k || !h) throw new Error("This pairing link looks incomplete.");
  state.settings.sync = { url: u, key: k, household: h, lastPullAt: "" };
  await saveSettings();
  const ok = await syncConnect(true);
  if (!ok) {
    state.settings.sync = null;
    await saveSettings();
    throw new Error(SYNC.statusMsg || "Couldn't reach the shared database.");
  }
}

function syncStatusText() {
  switch (SYNC.status) {
    case "online": return "🟢 Connected — changes sync live";
    case "connecting": return "🟡 Connecting…";
    case "error": return "🔴 Sync problem: " + SYNC.statusMsg;
    default: return "⚪ Sync is off";
  }
}

function syncSetStatus(status, msg = "") {
  SYNC.status = status;
  SYNC.statusMsg = msg;
  const el = document.getElementById("syncStatus");
  if (el) el.textContent = syncStatusText();
}

// ---------------------------------------------------------------------------
// Outbox: every local mutation is queued here, then flushed to Supabase.
// ---------------------------------------------------------------------------
async function queuePush(store, recordId) {
  if (!syncConfigured()) return;
  await dbPut("outbox", { id: store + ":" + recordId, store, recordId, op: "put", at: new Date().toISOString() });
  scheduleFlush();
}

async function queueDelete(store, recordId) {
  if (!syncConfigured()) return;
  await dbPut("outbox", { id: store + ":" + recordId, store, recordId, op: "delete", at: new Date().toISOString() });
  scheduleFlush();
}

let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { syncFlushOutbox().catch(() => {}); }, 300);
}

async function syncFlushOutbox() {
  if (!SYNC.client || SYNC.flushing) return;
  SYNC.flushing = true;
  try {
    const items = (await dbAll("outbox")).sort((a, b) => a.at.localeCompare(b.at));
    for (const it of items) {
      if (it.op === "put") {
        const rec = await dbGet(it.store, it.recordId);
        if (rec) await syncPushRecord(it.store, rec);
      } else {
        await syncPushDelete(it.store, it.recordId);
      }
      await dbDel("outbox", it.id);
    }
    if (SYNC.status === "error") syncSetStatus("online");
  } catch (e) {
    syncSetStatus("error", e.message || "push failed");
  } finally {
    SYNC.flushing = false;
  }
}

function cloudId(store, recId) {
  return state.settings.sync.household + ":" + store + ":" + recId;
}

async function syncPushRecord(store, rec) {
  const s = state.settings.sync;
  let data = rec;
  if (store === "photos") {
    const { blob, ...meta } = rec;
    data = meta;
    if (blob) {
      const path = s.household + "/" + rec.id + ".jpg";
      const up = await SYNC.client.storage.from(PHOTO_BUCKET)
        .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (up.error) throw new Error("photo upload: " + up.error.message);
    }
  }
  const { error } = await SYNC.client.from("records").upsert({
    id: cloudId(store, rec.id),
    household: s.household,
    store,
    data,
    deleted: false,
    updated_at: rec.updatedAt || new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function syncPushDelete(store, recId) {
  const s = state.settings.sync;
  if (store === "photos") {
    await SYNC.client.storage.from(PHOTO_BUCKET)
      .remove([s.household + "/" + recId + ".jpg"]).catch(() => {});
  }
  const { error } = await SYNC.client.from("records").upsert({
    id: cloudId(store, recId),
    household: s.household,
    store,
    data: { id: recId },
    deleted: true,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Applying remote rows to the local database
// ---------------------------------------------------------------------------
let remoteRenderTimer = null;
function scheduleRemoteRender() {
  clearTimeout(remoteRenderTimer);
  remoteRenderTimer = setTimeout(() => {
    const h = location.hash;
    if (h.startsWith("#/add") || h.startsWith("#/edit")) return; // don't clobber forms
    render();
  }, 400);
}

async function applyRemoteRow(row) {
  if (!row || !SYNC_STORES.includes(row.store)) return;
  const recId = row.data && row.data.id;
  if (!recId) return;

  if (row.deleted) {
    const existing = await dbGet(row.store, recId);
    if (existing) {
      await dbDel(row.store, recId);
      scheduleRemoteRender();
    }
    return;
  }

  const local = await dbGet(row.store, recId);
  const incomingAt = row.data.updatedAt || row.updated_at || "";
  if (local && (local.updatedAt || "") >= incomingAt) return; // ours is same or newer

  const rec = Object.assign({}, row.data);
  if (row.store === "photos") {
    if (local && local.blob) rec.blob = local.blob;
    else {
      const s = state.settings.sync;
      const dl = await SYNC.client.storage.from(PHOTO_BUCKET)
        .download(s.household + "/" + recId + ".jpg");
      if (!dl.error && dl.data) rec.blob = dl.data;
    }
  }
  await dbPut(row.store, rec);
  scheduleRemoteRender();
}

// ---------------------------------------------------------------------------
// Pull (incremental, paged) + realtime subscription
// ---------------------------------------------------------------------------
async function syncPull() {
  if (!SYNC.client) return;
  const s = state.settings.sync;
  try {
    let since = s.lastPullAt || "";
    for (;;) {
      let q = SYNC.client.from("records").select("*")
        .eq("household", s.household)
        .order("updated_at", { ascending: true })
        .limit(500);
      if (since) q = q.gt("updated_at", since);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      for (const row of data) await applyRemoteRow(row);
      since = data[data.length - 1].updated_at;
      s.lastPullAt = since;
      await saveSettings();
      if (data.length < 500) break;
    }
    if (SYNC.status === "error") syncSetStatus("online");
  } catch (e) {
    syncSetStatus("error", e.message || "pull failed");
  }
}

function syncSubscribe() {
  const s = state.settings.sync;
  if (SYNC.channel) { SYNC.client.removeChannel(SYNC.channel); SYNC.channel = null; }
  try {
    SYNC.channel = SYNC.client.channel("sprout-" + s.household)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "records", filter: "household=eq." + s.household },
        payload => { applyRemoteRow(payload.new).catch(() => {}); })
      .subscribe(status => {
        if (status === "SUBSCRIBED") syncSetStatus("online");
        // On channel errors we stay usable: outbox + periodic pull still sync.
      });
  } catch { /* realtime unavailable; periodic pull covers us */ }
}

// Give every not-yet-synced local record a timestamp and queue it for upload.
async function syncSeedLocal() {
  for (const store of SYNC_STORES) {
    for (const rec of await dbAll(store)) {
      if (!rec.updatedAt) {
        rec.updatedAt = rec.createdAt || new Date().toISOString();
        await dbPut(store, rec);
      }
      await dbPut("outbox", { id: store + ":" + rec.id, store, recordId: rec.id, op: "put", at: rec.updatedAt });
    }
  }
}

async function syncConnect(seed = false) {
  if (!syncConfigured()) return false;
  if (!window.supabase) { syncSetStatus("error", "sync library didn't load (offline?)"); return false; }
  syncSetStatus("connecting");
  try {
    const s = state.settings.sync;
    SYNC.client = window.supabase.createClient(s.url, s.key, { auth: { persistSession: false } });
    const probe = await SYNC.client.from("records").select("id").limit(1);
    if (probe.error) throw new Error(probe.error.message);
    syncSetStatus("online");
    if (seed) await syncSeedLocal();
    await syncFlushOutbox();
    await syncPull();
    syncSubscribe();
    clearInterval(SYNC.pullTimer);
    SYNC.pullTimer = setInterval(() => {
      syncFlushOutbox().catch(() => {});
      syncPull().catch(() => {});
    }, 60 * 1000);
    return true;
  } catch (e) {
    syncSetStatus("error", e.message || "could not connect");
    return false;
  }
}

async function syncDisconnect() {
  if (SYNC.channel && SYNC.client) SYNC.client.removeChannel(SYNC.channel);
  clearInterval(SYNC.pullTimer);
  SYNC.channel = null;
  SYNC.client = null;
  state.settings.sync = null;
  await saveSettings();
  syncSetStatus("off");
}
