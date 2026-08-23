/* Sprout weather — live conditions & season-aware care for outdoor plants.
   Uses Open-Meteo (free, no API key). Location is set once in Settings and
   stored on-device; the forecast is cached for an hour and kept for offline. */
"use strict";

const OUTDOOR_RE = /porch|balcon|patio|garden|outdoor|outside|deck|yard|terrace|greenhouse/i;

function isOutdoorPlant(p) {
  if (p.outdoor === true) return true;
  if (p.outdoor === false) return false;
  return !!(p.location && OUTDOOR_RE.test(p.location));
}

// Outdoor watering stretches in winter and tightens in summer.
function seasonFactor() {
  const s = currentSeason();
  return s === "winter" ? 1.5 : s === "summer" ? 0.8 : 1;
}

function weatherConfigured() {
  const w = state.settings.weather;
  return !!(w && typeof w.lat === "number" && typeof w.lon === "number");
}

function weatherUnit() {
  const w = state.settings.weather;
  if (w && w.unit) return w.unit;
  return /^en-US/i.test(navigator.language || "") ? "fahrenheit" : "celsius";
}

const wxThresholds = () => weatherUnit() === "fahrenheit"
  ? { hot: 90, frost: 36 }
  : { hot: 32, frost: 2 };

const WX_RAIN_MM = 4;        // today's rain that likely covers a watering
const WX_RAIN_AHEAD_MM = 8;  // rain over next 2 days worth mentioning

function wxEmoji(code) {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌧️";
  if (code <= 86) return "🌨️";
  return "⛈️";
}

// --------------------------------------------------------------------------
// Fetch + cache
// --------------------------------------------------------------------------
let _wx = null; // { fetchedAt, data }

async function getWeather(force = false) {
  if (!weatherConfigured()) return null;
  const now = Date.now();
  if (!_wx) {
    const row = await dbGet("settings", "weatherCache");
    if (row) _wx = row.value;
  }
  const fresh = _wx && (now - _wx.fetchedAt) < 60 * 60 * 1000 && _wx.unit === weatherUnit();
  if (fresh && !force) return _wx.data;
  if (!navigator.onLine && _wx) return _wx.data;

  const w = state.settings.weather;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${w.lat}&longitude=${w.lon}` +
    "&current=temperature_2m,precipitation,weather_code" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code" +
    "&timezone=auto&forecast_days=7" +
    (weatherUnit() === "fahrenheit" ? "&temperature_unit=fahrenheit" : "");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather http " + res.status);
    const data = await res.json();
    _wx = { fetchedAt: now, unit: weatherUnit(), data };
    await dbPut("settings", { key: "weatherCache", value: _wx });
    return data;
  } catch {
    return _wx ? _wx.data : null; // offline / blocked: fall back to last known
  }
}

async function geocodeCity(name) {
  const url = "https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=" + encodeURIComponent(name);
  const res = await fetch(url);
  if (!res.ok) throw new Error("geocoding failed");
  const data = await res.json();
  return (data.results || []).map(r => ({
    lat: r.latitude, lon: r.longitude,
    label: [r.name, r.admin1, r.country_code].filter(Boolean).join(", ")
  }));
}

// --------------------------------------------------------------------------
// Deriving advice from the forecast
// --------------------------------------------------------------------------
function wxDay(wx, i) {
  const d = wx && wx.daily;
  if (!d || !d.time || d.time.length <= i) return null;
  return {
    date: d.time[i],
    tmax: d.temperature_2m_max[i],
    tmin: d.temperature_2m_min[i],
    rain: d.precipitation_sum[i] || 0,
    rainProb: (d.precipitation_probability_max || [])[i],
    code: (d.weather_code || [])[i]
  };
}

// Flags used to tag today's outdoor watering tasks.
function todayWeatherFlags(wx) {
  const t = wxThresholds();
  const today = wxDay(wx, 0);
  if (!today) return {};
  const next2 = [wxDay(wx, 1), wxDay(wx, 2)].filter(Boolean);
  return {
    rainToday: today.rain >= WX_RAIN_MM,
    hotToday: today.tmax >= t.hot,
    rainAhead: next2.reduce((s, d) => s + d.rain, 0) >= WX_RAIN_AHEAD_MM,
    frostSoon: [today, ...next2].some(d => d.tmin <= t.frost)
  };
}

// Human advisories for the Today-tab weather card.
function weatherAdvisories(wx) {
  const flags = todayWeatherFlags(wx);
  const t = wxThresholds();
  const deg = weatherUnit() === "fahrenheit" ? "°F" : "°C";
  const today = wxDay(wx, 0);
  const out = [];
  if (!today) return out;
  if (flags.frostSoon) {
    const coldest = Math.min(...[0, 1, 2].map(i => wxDay(wx, i)).filter(Boolean).map(d => d.tmin));
    out.push({ icon: "🥶", text: `Frost risk — lows near ${Math.round(coldest)}${deg} in the next few days. Bring tender porch plants inside or cover them overnight.` });
  }
  if (flags.hotToday) {
    out.push({ icon: "🔥", text: `Hot today (${Math.round(today.tmax)}${deg}) — porch pots dry out fast. Check soil even if not on the schedule, and water in the morning or evening.` });
  }
  if (flags.rainToday) {
    out.push({ icon: "🌧️", text: `${today.rain.toFixed(1)} mm of rain today — uncovered porch plants may not need watering. Check the soil before you skip, covered pots still need you.` });
  } else if (flags.rainAhead) {
    out.push({ icon: "🌦️", text: "Decent rain expected in the next couple of days — thirsty-but-not-desperate porch plants can wait for it." });
  }
  // No seasonal line here: the seasonal adjustment acts on the schedule by
  // itself, and each outdoor plant's page shows its own adjusted interval —
  // a standing banner restating policy was furniture, not advice.
  return out;
}

// Small per-day summary for the This-week rows, e.g. "91° 🌧️".
function weekWeatherLabel(wx, i) {
  const d = wxDay(wx, i);
  if (!d) return "";
  const rain = d.rain >= 1 ? " 🌧️" : "";
  return `${Math.round(d.tmax)}°${rain || " " + wxEmoji(d.code)}`;
}
