/* Example photos for a species, so a suggestion can be compared against the
   real thing instead of taken on faith.

   Source is Wikipedia's REST API: free, no key, CORS-enabled, and the images
   are freely licensed. Results are cached per-device in localStorage — these
   are public URLs, so there is nothing here worth syncing between phones.
   Every failure path returns an empty list; callers fall back to the guide's
   emoji, which is what the app showed before any of this existed. */
"use strict";

const WIKI_API = "https://en.wikipedia.org/api/rest_v1/page";
const EXAMPLES_CACHE_KEY = "sprout.speciesExamples";
const EXAMPLES_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // a month; species don't change
const EXAMPLES_MISS_TTL_MS = 24 * 60 * 60 * 1000;  // retry a failed lookup sooner

// Files that are on a species page but aren't a photo of the plant.
const NOT_A_PHOTO = /\.svg$|\.ogv$|\.webm$|status_iucn|distribution|range_map|map_|_map|commons-logo|wiki(pedia|species)|icon/i;

function examplesCache() {
  try { return JSON.parse(localStorage.getItem(EXAMPLES_CACHE_KEY)) || {}; }
  catch { return {}; }
}

function examplesCachePut(key, urls) {
  try {
    const all = examplesCache();
    all[key] = { urls, at: Date.now() };
    // Keep the cache from growing without bound — 200 species is well past
    // anyone's collection, and the oldest entries are the least useful.
    const keys = Object.keys(all);
    if (keys.length > 200) {
      keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 200).forEach(k => delete all[k]);
    }
    localStorage.setItem(EXAMPLES_CACHE_KEY, JSON.stringify(all));
  } catch { /* private mode or full quota — the network path still works */ }
}

function examplesCacheGet(key) {
  const hit = examplesCache()[key];
  if (!hit) return null;
  const ttl = hit.urls.length ? EXAMPLES_TTL_MS : EXAMPLES_MISS_TTL_MS;
  return Date.now() - hit.at < ttl ? hit.urls : null;
}

async function wikiJSON(path, signal) {
  const res = await fetch(`${WIKI_API}/${path}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("wiki " + res.status);
  return res.json();
}

// A page's images, best-first. Lead image comes first in media-list order.
async function wikiImages(title, limit, signal) {
  const data = await wikiJSON(`media-list/${encodeURIComponent(title.replace(/ /g, "_"))}`, signal);
  return (data.items || [])
    .filter(it => it.type === "image" && it.srcset && it.srcset.length && !NOT_A_PHOTO.test(it.title || ""))
    .map(it => {
      const src = it.srcset[0].src;
      return src.startsWith("//") ? "https:" + src : src;
    })
    .slice(0, limit);
}

// The page's single lead image — a cheaper call, and the fallback when a
// species has a Wikipedia page but no usable media list.
async function wikiThumb(title, signal) {
  const data = await wikiJSON(`summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, signal);
  const url = (data.thumbnail && data.thumbnail.source) || "";
  return url ? [url] : [];
}

/* Up to `limit` example photos of a species. Tries the botanical name first —
   it redirects reliably and disambiguates common names that mean different
   plants in different places — then the common name. */
async function speciesExamples(latinName, commonName, limit = 3, signal = null) {
  const cacheKey = (latinName || commonName || "").trim().toLowerCase();
  if (!cacheKey) return [];
  const cached = examplesCacheGet(cacheKey);
  if (cached) return cached.slice(0, limit);

  const titles = [latinName, commonName].map(t => (t || "").trim()).filter(Boolean);
  let urls = [];
  for (const title of titles) {
    try {
      urls = await wikiImages(title, limit, signal);
      if (!urls.length) urls = await wikiThumb(title, signal);
      if (urls.length) break;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      /* try the next title, then give up quietly */
    }
  }
  examplesCachePut(cacheKey, urls);
  return urls;
}
