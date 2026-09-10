/* Sprout cloud sync — real-time shared data via a user-provided Supabase project.
   Local-first: IndexedDB stays the source of truth on each device; changes are
   queued in an outbox and pushed, remote changes arrive via realtime + pulls.
   Conflict resolution: last-write-wins on each record's updatedAt.
   Two clocks matter and they are different things: a record's updatedAt (when
   it was edited, decides conflicts) and a row's updated_at (when it reached
   the cloud, decides what a pull has yet to see). */
"use strict";

const SYNC = {
  client: null,
  channel: null,
  status: "off",      // off | connecting | online | stuck | error
  statusMsg: "",
  stuck: 0,           // outbox items the cloud keeps refusing
  live: false,        // realtime channel joined: changes arrive as they happen
  joins: 0,           // how many times the channel has (re)joined
  flushing: false,
  pulling: false,
  pullTimer: null,
  lastPullAt: 0,      // Date.now() of the last completed pull
};

// How often to look for changes when the realtime channel is carrying them
// (a backstop) versus when it isn't (the only way anything arrives).
const PULL_EVERY_LIVE = 60 * 1000;
const PULL_EVERY_POLLING = 15 * 1000;
// Re-read this much history on every incremental pull. Two phones stamp rows
// from their own clocks, so a row can land with a time just before a cursor
// the other phone already passed. Last-write-wins makes re-applying a row
// harmless, so overlap costs nothing but a few bytes.
const PULL_OVERLAP = 10 * 60 * 1000;

// "species" rides along: a species learned on one phone should not have to be
// learned again on the other. Settings stay out — they hold the API key.
// "prefs" carries the household's shared choices — watering days, rooms, who
// lives here. "settings" stays out: it holds the API key and the credentials
// for this connection, which belong to the device and nowhere else.
// "ferts" is the household's fertilizer shelf — owned and needed alike belong
// to both of you, same as the plants they feed.
const SYNC_STORES = ["plants", "logs", "tasks", "photos", "species", "prefs", "ferts"];
const PHOTO_BUCKET = "plant-photos";

// Paste into Supabase > SQL Editor > Run. Safe to run more than once.
//
// The editor runs this as ONE transaction, so any statement that errors rolls
// back everything before it. Realtime and storage both touch objects this role
// may not own (permissions vary by project), so they are isolated in DO blocks
// that swallow failures — a project without them still syncs, just without live
// push or photo sharing. The records table must never be the casualty.
const SYNC_SETUP_SQL = `-- Sprout sync setup — safe to re-run.
create table if not exists public.records (
  id text primary key,
  household text not null,
  store text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists records_household_updated
  on public.records (household, updated_at);
alter table public.records enable row level security;

drop policy if exists "sprout anon access" on public.records;
create policy "sprout anon access" on public.records
  for all to anon using (true) with check (true);

grant usage on schema public to anon;
grant all on public.records to anon;

-- Live push (optional): skipped if this role cannot alter the publication.
do $$
begin
  alter publication supabase_realtime add table public.records;
exception when others then
  raise notice 'Realtime not enabled (%). Sync still works, it polls instead.', sqlerrm;
end $$;

-- Photo sharing (optional): skipped if storage is not reachable from here.
do $$
begin
  insert into storage.buckets (id, name) values ('plant-photos', 'plant-photos')
    on conflict (id) do nothing;
exception when others then
  raise notice 'Could not create the photo bucket (%).', sqlerrm;
end $$;

do $$
begin
  drop policy if exists "sprout photos all" on storage.objects;
  create policy "sprout photos all" on storage.objects
    for all to anon
    using (bucket_id = 'plant-photos')
    with check (bucket_id = 'plant-photos');
exception when others then
  raise notice 'Could not add the photo policy (%).', sqlerrm;
end $$;

select 'Sprout is ready - go back to the app and tap Connect.' as status;`;

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

// Supabase's raw errors are accurate but opaque to someone following a
// five-step setup. Translate the ones this setup can actually produce into
// the next action to take.
function syncFriendlyError(msg) {
  const m = String(msg || "");
  if (/schema cache|relation .*records.* does not exist|public\.records/i.test(m))
    return "the setup script hasn't run yet. In Supabase open SQL Editor, paste the script from the setup steps above, press Run, then tap Connect again.";
  if (/Invalid API key|JWT|apikey/i.test(m))
    return "that key wasn't accepted. Copy the anon public key from Supabase → Settings → API (not the service_role or database password).";
  if (/Failed to fetch|NetworkError|ENOTFOUND|ERR_NAME/i.test(m))
    return "couldn't reach that URL. Check the Project URL from Supabase → Settings → API, and that you're online.";
  if (/Bucket not found|bucket/i.test(m))
    return "the photo bucket doesn't exist yet. Re-run the setup script in Supabase → SQL Editor; it creates the bucket.";
  if (/permission denied|row-level security|violates/i.test(m))
    return "the database refused the write. Re-run the setup script — it grants the access Sprout needs.";
  return m;
}

function syncStatusText() {
  switch (SYNC.status) {
    case "online": return SYNC.live
      ? "🟢 Connected — changes sync live"
      : "🟢 Connected — live updates off, checking every 15s";
    case "connecting": return "🟡 Connecting…";
    case "stuck": return `🟠 Connected, but ${SYNC.stuck} change${SYNC.stuck === 1 ? "" : "s"} can't upload — ` + syncFriendlyError(SYNC.statusMsg);
    case "error": return "🔴 Not connected — " + syncFriendlyError(SYNC.statusMsg);
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
  let firstError = "", failed = 0;
  try {
    const items = (await dbAll("outbox")).sort((a, b) => a.at.localeCompare(b.at));
    for (const it of items) {
      try {
        if (it.op === "put") {
          const rec = await dbGet(it.store, it.recordId);
          if (rec) await syncPushRecord(it.store, rec);
        } else {
          await syncPushDelete(it.store, it.recordId);
        }
        await dbDel("outbox", it.id);
      } catch (e) {
        /* One stuck change must not hold up the rest. This loop used to stop
           at the first failure, so a photo the bucket refused sat at the head
           of the queue and every watering logged after it never left this
           phone. Leave the failed one queued for the next flush and carry on. */
        it.tries = (it.tries || 0) + 1;
        it.lastError = e.message || String(e);
        await dbPut("outbox", it);
        firstError = firstError || it.lastError;
        failed++;
      }
    }
    SYNC.stuck = failed;
    if (!firstError) { if (SYNC.status === "error" || SYNC.status === "stuck") syncSetStatus("online"); }
    // Can't reach the cloud at all: that's a connection problem. Reached it
    // and it refused something: the connection is fine, one change isn't.
    else if (/Failed to fetch|NetworkError|Load failed/i.test(firstError)) syncSetStatus("error", firstError);
    else syncSetStatus("stuck", firstError);
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
  /* updated_at is when the row REACHED the cloud, not when the record was
     edited — the record's own updatedAt (inside data) still decides which of
     two edits wins. The other phone pulls "everything since my last pull" by
     this column, so it has to be monotonic with arrival: a watering logged at
     9:00 and pushed at 11:00 (phone locked before the outbox flushed) used to
     land stamped 9:00, behind a cursor the other phone had long since passed,
     and never showed up there at all. */
  const { error } = await SYNC.client.from("records").upsert({
    id: cloudId(store, rec.id),
    household: s.household,
    store,
    data,
    deleted: false,
    updated_at: new Date().toISOString(),
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
  if (local && (local.updatedAt || "") >= incomingAt) {
    // Ours is the same or newer. A photo whose image never downloaded is
    // still worth another try, though: the other phone's upload may simply
    // have landed after we first saw the record.
    if (row.store === "photos" && !local.blob) {
      const blob = await downloadPhotoBlob(recId);
      if (blob) { local.blob = blob; await dbPut("photos", local); scheduleRemoteRender(); }
    }
    return;
  }

  const rec = Object.assign({}, row.data);
  if (row.store === "photos") {
    rec.blob = (local && local.blob) || await downloadPhotoBlob(recId) || undefined;
    if (!rec.blob) delete rec.blob;
  }
  await dbPut(row.store, rec);
  // Household preferences are the one synced store that also lives in memory:
  // writing the record isn't enough, the running app has to pick it up or the
  // watering days you changed on one phone won't move due dates on the other.
  if (row.store === "prefs" && rec.id === PREFS_ID) await adoptRemotePrefs(rec);
  scheduleRemoteRender();
}

async function downloadPhotoBlob(recId) {
  const s = state.settings.sync;
  try {
    const dl = await SYNC.client.storage.from(PHOTO_BUCKET)
      .download(s.household + "/" + recId + ".jpg");
    return (!dl.error && dl.data) ? dl.data : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Pull (incremental, paged) + realtime subscription
// ---------------------------------------------------------------------------
// A full pull re-reads the household from the start — used when connecting,
// so a phone that missed rows for any reason (the old cursor bug included)
// catches up once, and for "Sync now", which should mean it.
async function syncPull({ full = false } = {}) {
  if (!SYNC.client || SYNC.pulling) return;
  SYNC.pulling = true;
  const s = state.settings.sync;
  try {
    let since = "";
    if (!full && s.lastPullAt) {
      const t = Date.parse(s.lastPullAt);
      since = isNaN(t) ? s.lastPullAt : new Date(t - PULL_OVERLAP).toISOString();
    }
    let newest = s.lastPullAt || "";
    for (;;) {
      let q = SYNC.client.from("records").select("*")
        .eq("household", s.household)
        .order("updated_at", { ascending: true })
        .limit(500);
      if (since) q = q.gt("updated_at", since);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      for (const row of data) {
        // One row we can't apply must not stop the rest, or hold the cursor
        // back so every pull trips over it again.
        try { await applyRemoteRow(row); }
        catch (e) { console.warn("Sprout sync: could not apply", row.id, e); }
      }
      since = data[data.length - 1].updated_at;
      if (Date.parse(since) > (Date.parse(newest) || 0)) newest = since;
      if (data.length < 500) break;
    }
    if (newest !== (s.lastPullAt || "")) { s.lastPullAt = newest; await saveSettings(); }
    SYNC.lastPullAt = Date.now();
    if (SYNC.status === "error") syncSetStatus("online");
  } catch (e) {
    syncSetStatus("error", e.message || "pull failed");
  } finally {
    SYNC.pulling = false;
  }
}

function syncSubscribe() {
  const s = state.settings.sync;
  if (SYNC.channel) { try { SYNC.client.removeChannel(SYNC.channel); } catch { /* already gone */ } SYNC.channel = null; }
  SYNC.live = false;
  try {
    SYNC.channel = SYNC.client.channel("sprout-" + s.household)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "records", filter: "household=eq." + s.household },
        payload => { applyRemoteRow(payload.new).catch(() => {}); })
      .subscribe((status, err) => {
        /* The channel drops whenever the phone sleeps; the library rejoins it
           on its own. "Live" is only true while it's actually joined — the
           status line used to claim it from the moment the database answered,
           whether or not realtime was ever enabled on the project. */
        SYNC.live = status === "SUBSCRIBED";
        if (err) console.warn("Sprout sync: realtime " + status, err.message || err);
        // Rejoined after a gap: whatever changed while the socket was down
        // never came through it. Fetch it rather than wait for the timer.
        if (SYNC.live && SYNC.joins++ > 0) syncPull().catch(() => {});
        if (SYNC.status === "online") syncSetStatus("online"); // refresh the wording
      });
  } catch { SYNC.live = false; /* realtime unavailable; polling covers us */ }
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
    SYNC.joins = 0;
    await syncFlushOutbox();
    await syncPull({ full: true });
    syncSubscribe();
    clearInterval(SYNC.pullTimer);
    SYNC.pullTimer = setInterval(() => {
      syncFlushOutbox().catch(() => {});
      const every = SYNC.live ? PULL_EVERY_LIVE : PULL_EVERY_POLLING;
      if (Date.now() - SYNC.lastPullAt >= every - 500) syncPull().catch(() => {});
    }, PULL_EVERY_POLLING);
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
  SYNC.live = false;
  state.settings.sync = null;
  await saveSettings();
  syncSetStatus("off");
}
