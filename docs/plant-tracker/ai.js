/* Sprout AI — plant health assessment and care reasoning via the Anthropic API.
   The user supplies their own API key (stored on-device only, never synced).
   Raw HTTP is used because this is a no-build static app: the official SDK
   requires a bundler; the API supports direct browser access via CORS. */
"use strict";

const AI_MODEL = "claude-opus-5";
const AI_API_URL = "https://api.anthropic.com/v1/messages";

function aiConfigured() {
  return !!(state.settings.ai && state.settings.ai.key);
}

// ---------------------------------------------------------------------------
// Core API call: structured output, refusal handling, server-side fallbacks
// ---------------------------------------------------------------------------
async function askClaude({ system, messages, schema }) {
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
      max_tokens: 8000,
      fallbacks: "default",
      system,
      messages,
      output_config: { format: { type: "json_schema", schema } },
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
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("The AI declined this request. Try a different photo.");
  }
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("Empty response from the AI.");
  return JSON.parse(textBlock.text);
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
          kind: { type: "string", enum: ["water", "fertilize", "repot", "prune", "move", "treat", "inspect", "other"] },
          when: { type: "string", enum: ["today", "this week", "ongoing"] },
          water_every_days: {
            type: "integer",
            description: "New watering interval in days if the routine itself should change; 0 to leave the schedule alone"
          },
          fert_every_days: {
            type: "integer",
            description: "New fertilizing interval in days if the routine itself should change; 0 to leave the schedule alone"
          }
        },
        required: ["title", "detail", "kind", "when", "water_every_days", "fert_every_days"],
        additionalProperties: false
      },
      description: "Concrete steps, most important first. Every issue above needs a step here that fixes it. " +
        "Set an interval field only when the standing schedule is wrong — a one-off soak is an action, not a schedule change."
    }
  },
  required: ["health_score", "status", "trend", "summary", "observations", "issues", "actions"],
  additionalProperties: false
};

async function aiAssessPlant(plantId) {
  const plant = await dbGet("plants", plantId);
  const g = guideEntry(plant.speciesKey);
  const photos = (await dbAllByIndex("photos", "plantId", plantId))
    .filter(p => p.blob)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3); // newest first; oldest of the three gives the comparison baseline
  if (!photos.length) throw new Error("Add at least one photo first — the AI reads the plant's health from its photos.");
  const logs = await dbAllByIndex("logs", "plantId", plantId);
  const env = await describeEnvironment(plant);

  const content = [];
  // Oldest → newest so "the last photo is current state" reads naturally
  for (const ph of [...photos].reverse()) {
    content.push({ type: "text", text: `Photo taken ${ph.createdAt.slice(0, 10)}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: await blobToApiImage(ph.blob) },
    });
  }
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
  });

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
  return plant.health;
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
        type: "array",
        minItems: 1,
        maxItems: MAX_CANDIDATES,
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
  });
  result.candidates = (result.candidates || []).slice(0, MAX_CANDIDATES);
  return result;
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
  move: "↔️", treat: "🧴", inspect: "🔍", other: "•",
};

// A step's identity has to survive a re-render so an added step still reads as
// added — derived from the plant and the moment of the assessment, not random.
function actionTaskId(plantId, at, i) {
  return `ai_${plantId}_${Date.parse(at).toString(36)}_${i}`;
}

function renderAssessment(a, { plantId = "", addedIds = [] } = {}) {
  const trendIcon = { improving: "↗", stable: "→", declining: "↘", unknown: "" }[a.trend] || "";
  const actions = a.actions || [];
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
            <span class="act-when">${esc(act.when)}</span>
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
        <b>${esc(a.status[0].toUpperCase() + a.status.slice(1))}</b>
        ${a.trend !== "unknown" ? `<span class="ai-trend">${trendIcon} ${esc(a.trend)}</span>` : ""}
        ${a.at ? `<span class="ai-when">${fmtDate(a.at.slice(0, 10))}</span>` : ""}
      </div>
      <p class="ai-summary">${esc(a.summary)}</p>
      ${(a.observations || []).length ? `<div class="ai-section"><b>Observed</b>${a.observations.map(o => `<div class="ai-item">· ${esc(o)}</div>`).join("")}</div>` : ""}
      ${(a.issues || []).length ? `<div class="ai-section"><b>Issues</b>${a.issues.map(i =>
        `<div class="ai-item ai-issue-${i.severity}">· <b>${esc(i.issue)}</b> — ${esc(i.action)}</div>`).join("")}</div>` : ""}
      ${steps ? `
        <div class="ai-section">
          <div class="act-head">
            <b>What to do</b>
            <button class="btn small secondary" type="button" id="addAllSteps">Add all to checklist</button>
          </div>
          ${steps}
        </div>` : ""}
    </div>`;
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
