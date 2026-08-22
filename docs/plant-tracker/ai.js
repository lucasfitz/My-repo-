/* Sprout AI — plant health assessment and care reasoning via the Anthropic API.
   The user supplies their own API key (stored on-device only, never synced).
   Raw HTTP is used because this is a no-build static app: the official SDK
   requires a bundler; the API supports direct browser access via CORS. */
"use strict";

const AI_MODEL = "claude-opus-5";
const AI_API_URL = "https://api.anthropic.com/v1/messages";
// Ceiling for a non-streaming request: past this the call risks the API's own
// timeout for a single response, which is a worse failure than a short answer.
const MAX_OUTPUT_TOKENS = 16000;

function aiConfigured() {
  return !!(state.settings.ai && state.settings.ai.key);
}

// ---------------------------------------------------------------------------
// Core API call: structured output, refusal handling, server-side fallbacks
// ---------------------------------------------------------------------------
async function askClaude({ system, messages, schema, maxTokens = 8000, effort = "high", _retried = false }) {
  const res = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": state.settings.ai.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      fallbacks: "default",
      system,
      messages,
      output_config: { effort, format: { type: "json_schema", schema } },
    }),
  });
  if (!res.ok) {
    let msg = "API error " + res.status;
    try {
      const err = await res.json();
      if (err.error && err.error.message) msg = err.error.message;
    } catch { /* non-JSON error body */ }
    if (res.status === 401) msg = "Invalid API key — check it in Settings.";
    if (res.status === 429) msg = "Rate limited — try again in a minute.";
    // Surface the raw failure for anyone debugging from a phone's console;
    // the thrown message is written for the person, not the developer.
    console.warn("Sprout AI request failed:", res.status, msg);
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("The AI declined this request. Try a different photo.");
  }
  // This model thinks by default, and max_tokens caps thinking and answer
  // together — so a tight budget spends the whole allowance on reasoning and
  // truncates the JSON rather than erroring. Vision work on a detailed schema
  // is exactly where that bites, so buy more room and think less hard, once,
  // instead of handing back a dead end.
  if (data.stop_reason === "max_tokens") {
    if (_retried || maxTokens >= MAX_OUTPUT_TOKENS) {
      throw new Error("The answer got cut off, even with a longer budget. Try again with fewer photos.");
    }
    console.warn("Sprout AI: response truncated at", maxTokens, "tokens — retrying with more room");
    return askClaude({
      system, messages, schema,
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2),
      effort: effort === "high" ? "medium" : "low",
      _retried: true,
    });
  }
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("Empty response from the AI.");
  try {
    return JSON.parse(textBlock.text);
  } catch {
    throw new Error("The AI sent back something unreadable. Try again.");
  }
}

// ---------------------------------------------------------------------------
// Building context: photos (downscaled for token cost) + plant state
// ---------------------------------------------------------------------------
function blobToApiImage(blob, maxDim = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataURL = canvas.toDataURL("image/jpeg", 0.8);
      // Free the pixels before the base64 string is handed back: an assessment
      // does this three times over, and the string itself is the only part
      // still needed.
      releaseCanvas(canvas);
      img.src = "";
      resolve(dataURL.slice(dataURL.indexOf(",") + 1)); // strip data: prefix → base64
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

function describeCareHistory(logs, limit = 15) {
  const verbs = { water: "watered", fertilize: "fertilized", repot: "repotted", prune: "pruned", note: "note", ai: "AI health check" };
  return logs
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(l => `${l.at.slice(0, 10)}: ${verbs[l.type] || l.type}${l.note ? " — " + l.note : ""}${typeof l.score === "number" ? ` (health ${l.score}/10)` : ""}`)
    .join("\n");
}

async function describeEnvironment(plant) {
  const parts = [`Season: ${currentSeason()}.`];
  if (plant && isOutdoorPlant(plant)) {
    parts.push("The plant lives outdoors.");
    if (weatherConfigured()) {
      const wx = await getWeather();
      const today = wx ? wxDay(wx, 0) : null;
      if (today) {
        const deg = weatherUnit() === "fahrenheit" ? "°F" : "°C";
        parts.push(`Today's weather: high ${Math.round(today.tmax)}${deg}, low ${Math.round(today.tmin)}${deg}, ${today.rain.toFixed(1)} mm rain.`);
      }
    }
  } else {
    parts.push("The plant lives indoors.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Per-plant health assessment (vision + care state)
// ---------------------------------------------------------------------------
const HEALTH_SCHEMA = {
  type: "object",
  properties: {
    health_score: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      description: "Overall health, 1 (dying) to 10 (thriving)" },
    status: { type: "string", enum: ["thriving", "healthy", "fair", "struggling", "critical"] },
    trend: { type: "string", enum: ["improving", "stable", "declining", "unknown"],
      description: "Change over time, judged from photo dates and prior assessments; unknown if only one data point" },
    summary: { type: "string", description: "Two or three sentences a home gardener can act on" },
    observations: { type: "array", items: { type: "string" },
      description: "Specific things visible in the photos: leaf color, new growth, soil state, pests" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          action: { type: "string", description: "The concrete fix" }
        },
        required: ["issue", "severity", "action"],
        additionalProperties: false
      }
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "One instruction, phrased so it can be done without thinking further — " +
              "'Move it 3 ft back from the south window', not 'consider light levels'"
          },
          detail: { type: "string", description: "One line on why this, tied to what you saw" },
          kind: { type: "string", enum: ["water", "fertilize", "repot", "prune", "move", "rotate", "treat", "inspect", "other"] },
          due_in_days: {
            type: "integer",
            description: "Days until this step becomes ready: 0 = ready now. Ready steps are shown alongside the " +
              "plant's next due watering or fertilizing — the owner reads them standing at the plant, can in hand — " +
              "so phrase steps to be done during that visit, and schedule forward only when waiting genuinely " +
              "matters (a follow-up check, a treatment interval)."
          },
          repeat_every_days: {
            type: "integer",
            description: "0 for a one-off. For a standing chore — rotate a quarter turn, wipe the leaves, refill " +
              "the pebble tray — the days between repeats; it will resurface on that rhythm, each time as a single day's task."
          },
          water_every_days: {
            type: "integer",
            description: "New watering interval in days if the routine itself should change; 0 to leave the schedule alone"
          },
          fert_every_days: {
            type: "integer",
            description: "New fertilizing interval in days if the routine itself should change; 0 to leave the schedule alone"
          }
        },
        required: ["title", "detail", "kind", "due_in_days", "repeat_every_days", "water_every_days", "fert_every_days"],
        additionalProperties: false
      },
      description: "Concrete steps, most important first. Every issue above needs a step here that fixes it. " +
        "These land on the owner's checklist automatically, each on its scheduled day, so only include steps worth " +
        "doing — and never a duplicate of routine care the schedule already covers. " +
        "Set an interval field only when the standing schedule is wrong — a one-off soak is an action, not a schedule change."
    }
  },
  required: ["health_score", "status", "trend", "summary", "observations", "issues", "actions"],
  additionalProperties: false
};

async function aiAssessPlant(plantId) {
  const plant = await dbGet("plants", plantId);
  const g = guideEntry(plant.speciesKey);
  const all = await dbAllByIndex("photos", "plantId", plantId);
  const photos = all
    .filter(p => p.blob)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3); // newest first; oldest of the three gives the comparison baseline
  if (!photos.length) {
    // A photo record with no blob means the image itself never came down from
    // storage — a different problem from having taken no photos, and telling
    // someone to "add a photo" when the gallery is full is just confusing.
    throw new Error(all.length
      ? "This plant's photos haven't finished syncing to this device yet. Try again in a moment."
      : "Add at least one photo first — the AI reads the plant's health from its photos.");
  }
  const logs = await dbAllByIndex("logs", "plantId", plantId);
  const env = await describeEnvironment(plant);

  const content = [];
  // Oldest → newest so "the last photo is current state" reads naturally
  let decoded = 0;
  for (const ph of [...photos].reverse()) {
    let data;
    // One unreadable photo (an odd format, a truncated download) shouldn't
    // sink the whole check when the others are fine.
    try { data = await blobToApiImage(ph.blob); }
    catch { continue; }
    content.push({ type: "text", text: `Photo taken ${ph.createdAt.slice(0, 10)}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    decoded++;
  }
  if (!decoded) throw new Error("Couldn't read this plant's photos. Try adding a new one.");
  content.push({
    type: "text",
    text: `Assess this plant's health. The most recent photo shows its current state; earlier photos are for judging the trend.

Plant: "${plant.name}" — ${plant.species || g.name}${g.latin ? ` (${g.latin})` : ""}
Location: ${plant.location || "unspecified"}. ${env}
Care schedule: water every ${plant.waterEvery || "—"} days, fertilize every ${plant.fertEvery || "—"} days.
Last watered: ${plant.lastWatered || "unknown"}. Last fertilized: ${plant.lastFertilized || "never"}.
Species guidance: ${g.light}. ${g.tips}
${plant.notes ? `Owner's notes: ${plant.notes}` : ""}
Recent care history:
${describeCareHistory(logs) || "(none recorded)"}`,
  });

  const result = await askClaude({
    system: "You are Sprout's plant doctor: an experienced horticulturist assessing houseplants and garden plants for home gardeners. Ground every observation in what is actually visible in the photos and the care records provided. Be specific and practical — name the likely cause and the concrete fix, not generic advice. If the photos are too unclear to judge something, say so rather than guessing.",
    messages: [{ role: "user", content }],
    schema: HEALTH_SCHEMA,
    // Reading three photos against a detailed schema is the most expensive
    // thing the app asks for: high effort spent the entire default budget on
    // reasoning and truncated the answer every time.
    effort: "medium",
    maxTokens: 12000,
  });

  // Nothing gets persisted until it's the shape the views expect. The schema
  // makes a malformed answer unlikely, but this check now runs unattended, and
  // a bad object saved to the plant would break its page on every later visit.
  if (typeof result.health_score !== "number" || typeof result.status !== "string") {
    throw new Error("The AI sent back an incomplete assessment. Try again.");
  }

  const at = new Date().toISOString();
  // Persist as a care-history entry so health tracks over time (and syncs)
  await saveRecord("logs", {
    id: uid(), plantId, type: "ai", at,
    by: "Sprout AI", note: result.summary,
    score: result.health_score, status: result.status,
  });
  // ...and on the plant itself, so its health and the steps it needs survive
  // leaving the screen, and show up on both phones.
  plant.health = {
    score: result.health_score, status: result.status, trend: result.trend,
    summary: result.summary, observations: result.observations,
    issues: result.issues, actions: result.actions, at,
  };
  await saveRecord("plants", plant);
  // The steps land on the checklist by themselves, each due on its day. A
  // recommendation nobody has to transcribe is the only kind that reliably
  // happens — the report on the plant page keeps the reasoning.
  await materializeHealthTasks(plant);
  return plant.health;
}

/* Every new photo is a fresh look at the plant, so it triggers a check on its
   own — the whole point of the health score is that it tracks the plant over
   time, and that only happens if it updates without being asked.

   Runs detached: adding a photo must never wait on the network, and a failed
   check is not worth interrupting anyone over — the manual button is still
   there. `ASSESSING` both de-duplicates overlapping runs (bulk adds fire one
   per plant) and lets the detail view show that one is already in flight. */
const ASSESSING = new Set();
const ASSESS_QUEUED = new Set();

function assessInFlight(plantId) { return ASSESSING.has(plantId); }

/* Release the lock and honour anything that arrived while we were busy.

   `rerender` is false for the manual button: its own handler re-renders on
   success and writes the failure into the results box, and re-rendering from
   here would detach that box before the message reached it. */
function releaseAssess(plantId, { rerender }) {
  ASSESSING.delete(plantId);
  if (rerender && typeof render === "function") render();
  if (ASSESS_QUEUED.delete(plantId)) autoAssess(plantId);
}

// The manual button goes through the same bookkeeping, so a re-render while a
// check is running (a sync landing, say) doesn't reset the button to idle.
async function assessNow(plantId) {
  ASSESSING.add(plantId);
  try { return await aiAssessPlant(plantId); }
  finally { releaseAssess(plantId, { rerender: false }); }
}

/* Waiting their turn. One assessment runs at a time, app-wide.

   These used to be independent per plant, so adding five photos in one go put
   five vision requests in flight at once — each decoding photos into canvases
   and holding them as base64 while it uploaded. That is enough memory pressure
   on a phone for the browser to kill the tab mid-upload, which is exactly what
   it did. Nobody is waiting on a background check, so a queue costs nothing. */
const ASSESS_WAIT = [];
let assessBusy = false;

function autoAssess(plantId) {
  if (!aiConfigured()) return;
  // A photo landing mid-check still deserves a look — remember it and run
  // again once this one lands, rather than dropping it on the floor.
  if (ASSESSING.has(plantId)) { ASSESS_QUEUED.add(plantId); return; }
  ASSESSING.add(plantId);
  ASSESS_WAIT.push(plantId);
  pumpAssessQueue();
}

async function pumpAssessQueue() {
  if (assessBusy) return;
  assessBusy = true;
  try {
    while (ASSESS_WAIT.length) {
      const plantId = ASSESS_WAIT.shift();
      try {
        const health = await aiAssessPlant(plantId);
        // Only speak up if the plant needs something; a clean bill of health
        // arriving unprompted is noise.
        if (health.score <= 5) toast(`Health check: ${health.status} — see the steps`);
      } catch (err) {
        console.warn("Sprout AI: automatic health check failed —", err.message);
      } finally {
        // Refresh whatever is on screen: the score belongs on the card and the
        // pill row, not only on the detail page that started the check.
        releaseAssess(plantId, { rerender: true });
      }
    }
  } finally {
    assessBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Species identification from a photo (the first step of adding a plant)
// ---------------------------------------------------------------------------
// The enum pins the answer to a species we actually hold care data for, so the
// result can drive the schedule directly. `common_name` stays free text so a
// species outside the guide is still named properly rather than forced.
const MAX_CANDIDATES = 5;

function identifySchema() {
  return {
    type: "object",
    properties: {
      is_plant: { type: "boolean", description: "false if the photo doesn't show a plant" },
      candidates: {
        // No minItems/maxItems here: structured outputs reject array
        // constraints, and raw HTTP has no SDK to quietly strip them — the
        // whole request 400s. The cap is stated in the description below and
        // enforced for real by the slice in aiIdentifySpecies().
        type: "array",
        items: {
          type: "object",
          properties: {
            common_name: { type: "string", description: "Common name, e.g. 'Swiss Cheese Plant'" },
            latin_name: { type: "string", description: "Botanical name, e.g. 'Monstera deliciosa'" },
            species_key: {
              type: "string",
              enum: PLANT_GUIDE.map(g => g.key),
              description: "Closest entry in the care guide; 'other' if none is a reasonable match"
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            why: { type: "string", description: "One short line: the visible detail that points here, or what would rule it out" }
          },
          required: ["common_name", "latin_name", "species_key", "confidence", "why"],
          additionalProperties: false
        },
        description:
          "Ranked, most likely first. Give exactly as many as it takes for the right answer to be in the list: " +
          "one when the photo is unambiguous, more when it genuinely could be several things. Never more than 5, " +
          "and never pad the list with species the photo already rules out."
      },
      looks_outdoor: { type: "boolean", description: "True if the setting looks like a porch, balcony, or garden" },
      note: { type: "string", description: "One short sentence on what the photo shows, or what's unclear about it" }
    },
    required: ["is_plant", "candidates", "looks_outdoor", "note"],
    additionalProperties: false
  };
}

async function aiIdentifySpecies(blob) {
  const result = await askClaude({
    system:
      "You identify houseplants and garden plants from photos for a plant-care app. Judge only from what is visible — " +
      "leaf shape, venation, margin, growth habit, stem, pot, and setting. Match to the provided species list whenever the " +
      "plant plausibly belongs to one of those entries, since the app has care data for them; use 'other' only when nothing fits.\n\n" +
      "You are producing a shortlist the owner will pick from, so calibrate its length to your actual certainty. A clear photo of " +
      "an unmistakable plant deserves one candidate — offering more is noise. A blurry seedling or a genus whose species look alike " +
      "deserves several, up to five. Rank them honestly and say, in one line each, what would tell them apart.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await blobToApiImage(blob) } },
        { type: "text", text: "What plant is this? Shortlist the species it could be and match each to the care guide." },
      ],
    }],
    schema: identifySchema(),
    effort: "low",
    maxTokens: 4000,
  });
  result.candidates = (result.candidates || []).slice(0, MAX_CANDIDATES);
  return result;
}

/* ---------------------------------------------------------------------------
   Learning a species the guide doesn't have

   A hand-written list is never finished — every gap costs the owner a dead end
   at exactly the moment they're trying to add a plant. Rather than grow the
   list forever, the app asks for the care profile of whatever was typed and
   keeps it. Learned species are stored like any other record and sync to the
   other phone, so each one is learned once for the household.

   No numeric bounds in the schema: structured outputs reject them, so the
   ranges live in the descriptions and are clamped on arrival.
   --------------------------------------------------------------------------- */
const SPECIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "name", "latin_name", "water_every_days", "fertilize_every_days", "light", "tips", "note"],
  properties: {
    found: { type: "boolean", description: "True if this is a real, identifiable plant you can give care advice for. False for gibberish or something that isn't a plant." },
    name: { type: "string", description: "Common name, title case. Fall back to the botanical name if there is no common one." },
    latin_name: { type: "string", description: "Botanical name. Genus alone is fine when the query names only a genus." },
    water_every_days: { type: "integer", description: "Typical days between waterings in the growing season, 1-30. Err on the dry side for anything succulent or Mediterranean." },
    fertilize_every_days: { type: "integer", description: "Typical days between feeds in the growing season, 0-120. Use 0 for plants that are harmed by feeding — carnivores, legumes, Proteaceae, and anything that wants lean soil." },
    light: { type: "string", description: "Short light requirement, phrased like 'Bright indirect light' or 'Full direct sun'." },
    tips: { type: "string", description: "Two or three sentences of care advice specific to this plant: the mistake people actually make with it, and how to tell it is unhappy. No generic filler." },
    note: { type: "string", description: "Empty if found. Otherwise a short line explaining why no advice could be given." },
  },
};

async function aiLearnSpecies(query) {
  const result = await askClaude({
    system:
      "You supply care data for a plant-care app whose built-in guide didn't have the plant the owner typed. " +
      "Give the care a knowledgeable grower would give, not a hedged average: intervals are a starting schedule the " +
      "owner will adjust, so commit to a number.\n\n" +
      "Be careful with plants that are harmed by ordinary care — Proteaceae and Australian natives are killed by " +
      "phosphorus, carnivorous plants by fertilizer and tap water, succulents by a weekly watering can. Where that " +
      "applies, say so in the tips rather than leaving it to be discovered.\n\n" +
      "If the query names a genus rather than a species, answer for the genus as commonly grown. If it isn't a plant " +
      "or you can't tell what was meant, set found to false rather than guessing.",
    messages: [{ role: "user", content: `Care profile for: ${query}` }],
    schema: SPECIES_SCHEMA,
    effort: "low",
    maxTokens: 3000,
  });
  if (!result.found) throw new Error(result.note || `No care data found for "${query}".`);

  // The model is asked for sane ranges but nothing enforces them on the wire.
  const clamp = (n, lo, hi, fallback) =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  return {
    name: (result.name || query).trim(),
    latin: (result.latin_name || "").trim(),
    emoji: "🪴",
    waterDays: clamp(result.water_every_days, 1, 60, 7),
    fertDays: clamp(result.fertilize_every_days, 0, 180, 30),
    light: (result.light || "Check the nursery tag").trim(),
    tips: (result.tips || "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Garden-wide advisor: reasons over every plant's state + care + weather
// ---------------------------------------------------------------------------
const GARDEN_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence on the garden's overall state today" },
    priorities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          plant: { type: "string", description: "Plant nickname exactly as given" },
          advice: { type: "string" },
          urgency: { type: "string", enum: ["today", "soon", "fyi"] }
        },
        required: ["plant", "advice", "urgency"],
        additionalProperties: false
      },
      description: "The plants that most need attention, most urgent first — omit plants that are fine"
    },
    tip: { type: "string", description: "One seasonal or situational tip for this household" }
  },
  required: ["headline", "priorities", "tip"],
  additionalProperties: false
};

async function aiGardenInsights() {
  const plants = (await dbAll("plants")).filter(p => !p.archived);
  if (!plants.length) throw new Error("Add some plants first.");
  const logs = await dbAll("logs");
  const lines = [];
  for (const p of plants) {
    const g = guideEntry(p.speciesKey);
    const wDue = nextDue(p, "water"), fDue = nextDue(p, "fertilize");
    const wDelta = wDue ? daysBetween(todayStr(), wDue) : null;
    const lastAi = logs.filter(l => l.plantId === p.id && l.type === "ai")
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    lines.push(
      `- "${p.name}" (${p.species || g.name}), ${p.location || "no room"}, ${isOutdoorPlant(p) ? "outdoor" : "indoor"}. ` +
      `Watering ${wDelta === null ? "off" : wDelta < 0 ? `${-wDelta}d overdue` : `due in ${wDelta}d`}; ` +
      `fertilizing ${fDue ? "due " + fDue : "off"}. Last watered ${p.lastWatered || "unknown"}.` +
      (lastAi ? ` Last AI check ${lastAi.at.slice(0, 10)}: ${lastAi.status || ""} ${typeof lastAi.score === "number" ? lastAi.score + "/10" : ""} — ${lastAi.note}` : "")
    );
  }
  const wxLine = await describeEnvironment(plants.find(p => isOutdoorPlant(p)) || null);

  return askClaude({
    system: "You are Sprout's garden advisor for a two-person household. Given the state of every plant, their care schedules, recent AI health checks, and the weather, reason about what deserves attention and in what order. Be concrete and brief — each piece of advice should be one actionable sentence. Don't restate the schedule the app already shows; add judgment: connect overdue care, season, weather, and health history.",
    messages: [{ role: "user", content: `Today is ${todayStr()}. ${wxLine}\n\nOur plants:\n${lines.join("\n")}` }],
    schema: GARDEN_SCHEMA,
  });
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function aiScoreBadge(score) {
  const cls = score >= 8 ? "ok" : score >= 5 ? "fertilize" : "overdue";
  return `<span class="badge ${cls}">${score}/10</span>`;
}

// The at-a-glance indicator: a dot whose colour is the health band, used on
// plant cards and anywhere a plant is named.
function healthChip(health, { withLabel = false } = {}) {
  if (!health || typeof health.score !== "number") return "";
  const band = health.score >= 8 ? "good" : health.score >= 5 ? "fair" : "poor";
  return `<span class="health-chip ${band}" title="Health ${health.score}/10 — ${esc(health.status)}">
    <span class="health-dot"></span>${health.score}/10${withLabel ? ` · ${esc(health.status)}` : ""}</span>`;
}

const ACTION_ICONS = {
  water: "💧", fertilize: "🌾", repot: "🪴", prune: "✂️",
  move: "↔️", rotate: "🔄", treat: "🧴", inspect: "🔍", other: "•",
};

// When a step happens, in words. New assessments carry numbers; ones stored
// before the schema learned to schedule only had a phrase, which still reads.
function actionWhenLabel(act) {
  if (act.repeat_every_days > 0) return `every ${act.repeat_every_days}d`;
  if (Number.isInteger(act.due_in_days)) {
    return act.due_in_days <= 0 ? "today"
      : act.due_in_days === 1 ? "tomorrow" : `in ${act.due_in_days}d`;
  }
  return act.when || "today";
}

// A step's identity has to survive a re-render so an added step still reads as
// added — derived from the plant and the moment of the assessment, not random.
function actionTaskId(plantId, at, i) {
  return `ai_${plantId}_${Date.parse(at).toString(36)}_${i}`;
}

function renderAssessment(a, { plantId = "", addedIds = [] } = {}) {
  if (!a || typeof a.score !== "number") return "";
  const status = a.status || "unknown";
  const trendIcon = { improving: "↗", stable: "→", declining: "↘", unknown: "" }[a.trend] || "";
  const actions = a.actions || [];
  const issues = a.issues || [];
  const observations = a.observations || [];
  const steps = actions.map((act, i) => {
    const taskId = actionTaskId(plantId, a.at || "", i);
    const added = addedIds.includes(taskId);
    const plan = act.water_every_days > 0 || act.fert_every_days > 0;
    const planLabel = [
      act.water_every_days > 0 ? `water every ${act.water_every_days}d` : "",
      act.fert_every_days > 0 ? `fertilize every ${act.fert_every_days}d` : "",
    ].filter(Boolean).join(", ");
    return `
      <div class="act" data-act="${i}">
        <span class="act-icon">${ACTION_ICONS[act.kind] || "•"}</span>
        <div class="act-main">
          <div class="act-title">${esc(act.title)}</div>
          ${act.detail ? `<div class="act-detail">${esc(act.detail)}</div>` : ""}
          <div class="act-meta">
            <span class="act-when">${esc(actionWhenLabel(act))}</span>
            ${plan ? `<span class="act-plan">changes the plan → ${esc(planLabel)}</span>` : ""}
          </div>
        </div>
        <div class="act-buttons">
          ${plan ? `<button class="btn small" type="button" data-apply="${i}">Apply</button>` : ""}
          <button class="btn small secondary" type="button" data-add="${i}" ${added ? "disabled" : ""}>${added ? "On the list ✓" : "Add step"}</button>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="ai-result">
      <div class="ai-head">
        ${aiScoreBadge(a.score)}
        <b>${esc(status[0].toUpperCase() + status.slice(1))}</b>
        ${a.trend !== "unknown" ? `<span class="ai-trend">${trendIcon} ${esc(a.trend)}</span>` : ""}
        ${a.at ? `<span class="ai-when">${fmtDate(a.at.slice(0, 10))}</span>` : ""}
      </div>
      <p class="ai-summary">${esc(a.summary)}</p>
      ${section("What to do", steps, {
        open: true,
        count: actions.length,
        extra: `<button class="btn small secondary" type="button" id="addAllSteps">Add all to checklist</button>`,
      })}
      ${section("Issues", issues.map(i =>
        `<div class="ai-item ai-issue-${esc(i.severity)}">· <b>${esc(i.issue)}</b> — ${esc(i.action)}</div>`).join(""),
        { count: issues.length })}
      ${section("Observed", observations.map(o => `<div class="ai-item">· ${esc(o)}</div>`).join(""),
        { count: observations.length })}
    </div>`;
}

/* One collapsible block of the health report.

   The report had grown to a wall of text under a photo — a score, a summary,
   observations, issues and steps all expanded at once, so the thing you can
   act on was somewhere in the middle of it. Each part now folds, with the
   count on the header so a collapsed section still tells you whether it is
   worth opening.

   Only "What to do" starts open — it is the part you act on. Issues and
   observations are why, not what, and both start shut: the count on the header
   is enough to decide whether to look.

   <details> rather than a click handler: it keeps the disclosure semantics,
   works before any JS runs, and survives the re-render after a step is added. */
function section(title, body, { open = false, count = 0, extra = "" } = {}) {
  if (!body) return "";
  return `
    <details class="ai-fold"${open ? " open" : ""}>
      <summary class="ai-fold-head">
        <span class="ai-fold-title">${esc(title)}</span>
        ${count ? `<span class="ai-fold-count">${count}</span>` : ""}
        <span class="ai-fold-chev" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>
        </span>
      </summary>
      <div class="ai-fold-body">${extra ? `<div class="act-head">${extra}</div>` : ""}${body}</div>
    </details>`;
}

function renderGardenInsights(g) {
  const urgencyBadge = { today: `<span class="badge overdue">today</span>`, soon: `<span class="badge fertilize">soon</span>`, fyi: `<span class="badge ok">fyi</span>` };
  return `
    <div class="ai-result">
      <p class="ai-summary">${esc(g.headline)}</p>
      ${g.priorities.map(p => `<div class="ai-item">${urgencyBadge[p.urgency] || ""} <b>${esc(p.plant)}</b> — ${esc(p.advice)}</div>`).join("")}
      ${g.tip ? `<p class="ai-tip">${esc(g.tip)}</p>` : ""}
    </div>`;
}

// ---------------------------------------------------------------------------
// Talking to the intelligence about one plant
// ---------------------------------------------------------------------------
/* The correction channel. Health checks and identification write to the
   record on their own — so when one of them gets something wrong, the owner
   needs somewhere to say so in plain words and have the record actually
   change. Every "set_" field is an edit the reply is allowed to make;
   sentinels ("" / -1 / "leave") mean hands off. The model edits only what
   the owner asked for or plainly implied — the reply says what changed, and
   the app writes it, so there is no "I've updated that" that didn't happen. */
function chatSchema() {
  return {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description: "Your answer to the owner, in one or two short conversational paragraphs. " +
          "If you're changing anything, say what and why; if you can't do something, say so plainly."
      },
      set_name: { type: "string", description: "Rename the plant; \"\" to leave the name alone" },
      set_room: { type: "string", description: "Move it to this room; \"\" to leave the room alone" },
      set_species_key: {
        type: "string",
        enum: ["", ...allSpecies().map(g => g.key)],
        description: "Correct the species to this care-guide entry; \"\" to leave it. Use 'other' only when nothing in the guide fits."
      },
      set_species_name: {
        type: "string",
        description: "Display name for the corrected species (e.g. 'Hoya carnosa'); \"\" unless set_species_key is set"
      },
      set_water_every_days: { type: "integer", description: "New watering interval in days; 0 turns the schedule off; -1 to leave it alone" },
      set_fert_every_days: { type: "integer", description: "New fertilizing interval in days; 0 turns it off; -1 to leave it alone" },
      set_last_watered: { type: "string", description: "Correct the last-watered date, YYYY-MM-DD; \"\" to leave it" },
      set_last_fertilized: { type: "string", description: "Correct the last-fertilized date, YYYY-MM-DD; \"\" to leave it" },
      set_outdoor: { type: "string", enum: ["leave", "outdoor", "indoor"], description: "Where the plant lives, if the owner corrected it" },
      set_notes: {
        type: "string",
        description: "Replace the owner's notes with this text — include anything from the existing notes worth keeping; \"\" to leave them"
      },
      clear_health: { type: "boolean", description: "True to discard the last health assessment because it was wrong or is now stale" },
      add_tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "One concrete instruction" },
            detail: { type: "string", description: "One line on why" },
            kind: { type: "string", enum: ["water", "fertilize", "repot", "prune", "move", "rotate", "treat", "inspect", "other"] },
            due_in_days: { type: "integer", description: "0 = ready now" },
            repeat_every_days: { type: "integer", description: "0 for a one-off; N for a standing chore" }
          },
          required: ["title", "detail", "kind", "due_in_days", "repeat_every_days"],
          additionalProperties: false
        },
        description: "New checklist steps, only if the owner asked for something to be done or reminded about"
      },
      complete_task_ids: {
        type: "array", items: { type: "string" },
        description: "Open task ids (from the list provided) the owner says are already done"
      },
      drop_task_ids: {
        type: "array", items: { type: "string" },
        description: "Open task ids the owner wants gone — wrong, unwanted, or no longer relevant"
      }
    },
    required: ["reply", "set_name", "set_room", "set_species_key", "set_species_name",
      "set_water_every_days", "set_fert_every_days", "set_last_watered", "set_last_fertilized",
      "set_outdoor", "set_notes", "clear_health", "add_tasks", "complete_task_ids", "drop_task_ids"],
    additionalProperties: false
  };
}

/* Context is rebuilt from the live record on every turn, so an edit applied
   two messages ago is simply true in the next one — the transcript carries
   the conversation, never the state. */
async function aiPlantChat(plantId, transcript) {
  const plant = await dbGet("plants", plantId);
  const g = guideEntry(plant.speciesKey);
  const logs = await dbAllByIndex("logs", "plantId", plantId);
  const openTasks = (await dbAll("tasks")).filter(t => t.plantId === plantId && !t.done);
  const env = await describeEnvironment(plant);

  const h = plant.health;
  const system = `You are Sprout's plant assistant, talking with the owner about one specific plant. You can edit the plant's record directly through the structured fields — that is the point of this chat: when an identification, schedule, or health check got something wrong, the owner tells you here and you fix it. Edit only what the owner asks for or plainly implies; when you're unsure what they mean, ask instead of guessing. Keep replies short and warm, like a knowledgeable friend texting back.

Today: ${todayStr()}.
The plant's record:
- Name: "${plant.name}"${plant.location ? `, in "${plant.location}"` : ", no room set"}
- Species: ${plant.species || g.name} (guide entry: ${g.key}${g.latin ? `, ${g.latin}` : ""})
- Watering: every ${plant.waterEvery || "—"} days, last ${plant.lastWatered || "unknown"}. Fertilizing: every ${plant.fertEvery || "—"} days, last ${plant.lastFertilized || "never"}.
- ${env}
- Owner's notes: ${plant.notes || "(none)"}
- Last health check: ${h ? `${h.at.slice(0, 10)} — ${h.score}/10 ${h.status}: ${h.summary}` : "(none)"}
- Open checklist steps for this plant:
${openTasks.map(t => `  · [id ${t.id}] ${t.title}${t.repeatDays ? ` (repeats every ${t.repeatDays}d)` : ""}${t.due ? ` (for ${t.due})` : ""}`).join("\n") || "  (none)"}
- Recent care history:
${describeCareHistory(logs) || "  (none recorded)"}
- Guide entry says: ${g.light}. ${g.tips}`;

  return askClaude({
    system,
    messages: transcript.map(m => ({ role: m.role, content: m.text })),
    schema: chatSchema(),
    effort: "low",
    maxTokens: 6000,
  });
}
