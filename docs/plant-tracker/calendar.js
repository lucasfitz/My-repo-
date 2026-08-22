/* Google Calendar sync — puts the next month of plant care on a real calendar,
   so it shows up next to everything else you're already looking at.

   Two ways in, because the good one has setup cost:
     · Download .ics — works right now, no accounts, but it's a snapshot.
     · Connect Google — a live calendar that re-syncs as schedules change.

   The OAuth token lives in memory only and expires in an hour; nothing but the
   client ID and the calendar's own ID is ever written to disk, and neither is
   secret. Sprout writes to a calendar it creates itself, never to your main
   one, so disconnecting is a clean delete.

   One event per day rather than one per plant: a calendar with "Water Monty",
   "Water Spike", "Fertilize Fern" stacked on the same morning is noise. */
"use strict";

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const CAL_HORIZON_DAYS = 30;
const CAL_NAME = "Sprout — Plant care";

let calToken = null;      // { token, expiresAt } — memory only, never persisted
let calTokenClient = null;

function calSettings() {
  return state.settings.calendar || {};
}
function calConfigured() {
  return !!calSettings().clientId;
}
function calConnected() {
  return !!(calSettings().clientId && calSettings().calendarId);
}

// ---------------------------------------------------------------------------
// Projecting the care schedule forward
// ---------------------------------------------------------------------------
/* nextDue() answers "when next", which is all the Today screen needs. A
   calendar needs the whole run, so repeat the interval out to the horizon. */
function projectCare(plants, days = CAL_HORIZON_DAYS) {
  const byDate = {};
  const today = todayStr();
  const limit = addDays(today, days);
  for (const p of plants) {
    if (p.archived) continue;
    for (const kind of ["water", "fertilize"]) {
      let every = kind === "water" ? p.waterEvery : p.fertEvery;
      if (!every) continue;
      if (kind === "water" && isOutdoorPlant(p)) {
        every = Math.max(1, Math.round(every * seasonFactor()));
      }
      let date = nextDue(p, kind);
      if (!date) continue;
      // An overdue plant belongs on today's entry, not on a date in the past.
      if (date < today) date = today;
      while (date <= limit) {
        (byDate[date] = byDate[date] || []).push({ name: p.name, kind });
        // Each repeat re-snaps to the rhythm — adding the raw interval alone
        // holds the rhythm for one event and then drifts back off it. The
        // guard keeps a backward snap from ever re-landing on the same day.
        const next = addDays(date, every);
        const snapped = snapToWaterDay(next, every);
        date = snapped > date ? snapped : next;
      }
    }
  }
  return byDate;
}

function calEventSummary(items) {
  const water = items.filter(i => i.kind === "water").map(i => i.name);
  const fert = items.filter(i => i.kind === "fertilize").map(i => i.name);
  const parts = [];
  if (water.length) parts.push(`Water ${listWords(water)}`);
  if (fert.length) parts.push(`Fertilize ${listWords(fert)}`);
  return "🌱 " + parts.join(" · ");
}

function listWords(names) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function calEventDescription(items) {
  return items
    .map(i => `${i.kind === "water" ? "💧 Water" : "🌾 Fertilize"} ${i.name}`)
    .join("\n") + "\n\nFrom Sprout.";
}

// Google accepts a caller-supplied id of a-v and 0-9, 5–1024 chars. Deriving it
// from the date makes every sync idempotent — no stored mapping to drift.
function calEventId(date) {
  return "sprout" + date.replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// .ics — the no-setup path
// ---------------------------------------------------------------------------
function icsEscape(text) {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildICS(byDate) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sprout//Plant care//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsEscape(CAL_NAME)}`,
  ];
  for (const date of Object.keys(byDate).sort()) {
    const items = byDate[date];
    const compact = date.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${calEventId(date)}@sprout`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact}`,
      `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, "")}`,
      `SUMMARY:${icsEscape(calEventSummary(items))}`,
      `DESCRIPTION:${icsEscape(calEventDescription(items))}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 wants CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}

async function downloadCareICS() {
  const byDate = projectCare(await dbAll("plants"));
  if (!Object.keys(byDate).length) throw new Error("Nothing scheduled in the next month yet.");
  const blob = new Blob([buildICS(byDate)], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sprout-plant-care.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return Object.keys(byDate).length;
}

// ---------------------------------------------------------------------------
// Google OAuth (Identity Services token flow)
// ---------------------------------------------------------------------------
function loadGIS() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Couldn't reach Google.")));
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't reach Google — check your connection."));
    document.head.appendChild(s);
  });
}

/* `interactive: false` tries for a token without showing a popup, which works
   while the Google session is still warm. The first connect must be
   interactive — a popup that isn't tied to a tap gets blocked. */
async function calAuth({ interactive = true } = {}) {
  if (calToken && Date.now() < calToken.expiresAt - 60000) return calToken.token;
  if (!calConfigured()) throw new Error("Add your Google client ID in Settings first.");
  await loadGIS();

  return new Promise((resolve, reject) => {
    if (!calTokenClient) {
      calTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: calSettings().clientId,
        scope: CAL_SCOPE,
        callback: () => {},  // replaced per request below
      });
    }
    calTokenClient.callback = res => {
      if (res.error) {
        reject(new Error(res.error === "access_denied"
          ? "Google access was declined."
          : "Google sign-in failed: " + res.error));
        return;
      }
      calToken = {
        token: res.access_token,
        expiresAt: Date.now() + (Number(res.expires_in) || 3600) * 1000,
      };
      resolve(calToken.token);
    };
    try {
      calTokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
    } catch (err) {
      reject(new Error("Google sign-in failed: " + err.message));
    }
  });
}

/* `silent` is for the background sync: it may use a token Google hands over
   without a popup, and must give up rather than interrupt with one. */
async function calFetch(path, { method = "GET", body = null, retryOn = [], silent = false } = {}) {
  const token = silent
    ? await calAuth({ interactive: false })
    : await calAuth({ interactive: false }).catch(() => calAuth());
  const res = await fetch(CAL_API + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    calToken = null;  // token died early; one retry with a fresh one
    const fresh = await calAuth({ interactive: !silent });
    const again = await fetch(CAL_API + path, {
      method,
      headers: { authorization: "Bearer " + fresh, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!again.ok && !retryOn.includes(again.status)) throw await calError(again);
    return again.status === 204 ? null : again.json().catch(() => null);
  }
  if (!res.ok && !retryOn.includes(res.status)) throw await calError(res);
  if (!res.ok) return { _status: res.status };
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function calError(res) {
  let msg = `Google Calendar error ${res.status}`;
  try {
    const body = await res.json();
    if (body.error && body.error.message) msg = body.error.message;
  } catch { /* non-JSON error body */ }
  if (res.status === 403 && /has not been used|disabled/i.test(msg)) {
    msg = "The Calendar API isn't enabled on that Google Cloud project yet.";
  }
  return new Error(msg);
}

// ---------------------------------------------------------------------------
// Connect / sync / disconnect
// ---------------------------------------------------------------------------
async function calConnect() {
  await calAuth();  // interactive: this runs from a tap
  let calendarId = calSettings().calendarId;
  if (calendarId) {
    // Make sure it still exists — someone may have deleted it in Google.
    const found = await calFetch(`/calendars/${encodeURIComponent(calendarId)}`, { retryOn: [404, 410] });
    if (found && found._status) calendarId = null;
  }
  if (!calendarId) {
    const made = await calFetch("/calendars", {
      method: "POST",
      body: { summary: CAL_NAME, description: "Watering and fertilizing from Sprout." },
    });
    calendarId = made.id;
  }
  state.settings.calendar = Object.assign({}, calSettings(), { calendarId });
  await saveSettings();
  return calendarId;
}

/* Reconciles the horizon in one pass: every day that needs care gets an event,
   every day that no longer does has its event removed. Deterministic ids mean
   this converges no matter how many times it runs or from which phone. */
async function calSync({ silent = false } = {}) {
  if (!calConnected()) throw new Error("Connect Google Calendar first.");
  const calendarId = encodeURIComponent(calSettings().calendarId);
  const byDate = projectCare(await dbAll("plants"));
  let written = 0, cleared = 0;

  for (let i = 0; i <= CAL_HORIZON_DAYS; i++) {
    const date = addDays(todayStr(), i);
    const items = byDate[date];
    const eventId = calEventId(date);
    if (items && items.length) {
      const event = {
        id: eventId,
        summary: calEventSummary(items),
        description: calEventDescription(items),
        start: { date },
        end: { date: addDays(date, 1) },
        transparency: "transparent",  // plant care shouldn't mark you busy
        source: { title: "Sprout", url: location.origin + location.pathname },
      };
      // Insert with our own id; 409 means it's already there, so update it.
      const made = await calFetch(`/calendars/${calendarId}/events`, { method: "POST", body: event, retryOn: [409], silent });
      if (made && made._status === 409) {
        await calFetch(`/calendars/${calendarId}/events/${eventId}`, { method: "PUT", body: event, silent });
      }
      written++;
    } else {
      const gone = await calFetch(`/calendars/${calendarId}/events/${eventId}`, { method: "DELETE", retryOn: [404, 410], silent });
      if (!gone || !gone._status) cleared++;
    }
  }

  state.settings.calendar = Object.assign({}, calSettings(), { lastSync: new Date().toISOString() });
  await saveSettings();
  return { written, cleared };
}

async function calDisconnect({ removeCalendar = false } = {}) {
  if (removeCalendar && calConnected()) {
    try {
      await calFetch(`/calendars/${encodeURIComponent(calSettings().calendarId)}`, { method: "DELETE", retryOn: [404, 410] });
    } catch { /* it's already gone, or access is revoked — either way, stop */ }
  }
  calToken = null;
  calTokenClient = null;
  state.settings.calendar = null;
  await saveSettings();
}

/* Schedules move every time someone waters something, so a calendar that only
   updates when you remember to tap Sync is a calendar that lies. Once a day on
   open, quietly, and only if Google will hand over a token without a popup. */
async function maybeAutoSyncCalendar() {
  if (!calConnected()) return;
  const last = calSettings().lastSync;
  if (last && Date.now() - Date.parse(last) < 12 * 60 * 60 * 1000) return;
  try {
    await calSync({ silent: true });
  } catch {
    /* No usable token, offline, or access revoked — the Settings screen still
       has a Sync now button, and that one is allowed to ask. */
  }
}
