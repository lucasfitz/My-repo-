# 🌱 Sprout — Plant Care Tracker

A mobile-first web app for tracking your houseplants together — watering and
fertilizing schedules, photo journals, daily checklists, reminders, and a
built-in care guide. Built for two people (you and your wife) to share.

**Live app:** https://lucasfitz.github.io/My-repo-/plant-tracker/

No servers to run, no build step — it's a plain HTML/CSS/JS Progressive Web
App. All data is stored locally on each device (IndexedDB), including photos,
and stays in sync between your two phones in real time through a free
Supabase project that you own (optional, ~5 min one-time setup).

---

## What it does

| Feature | Where |
|---|---|
| Plant profiles (nickname, species, location, notes) | **Plants** tab |
| Watering & fertilizing schedules with due dates | Set per-plant; auto-suggested by species |
| Daily care checklist (overdue / due today / this week) | **Today** tab |
| One-tap "Water now" / "Fertilize" / "Repotted" / "Pruned" logging | Plant detail page |
| Photo journal per plant (stored on-device, auto-resized) | Plant detail page |
| Full care history — who did what, when | Plant detail page |
| Shared household checklist (e.g. "buy potting soil") | **Today** tab |
| Care guide: 20+ common houseplants with schedules & tips | **Guide** tab |
| Seasonal suggestions (winter rest, summer watering, etc.) | Today + Guide tabs |
| Two-person profiles — every action logs who did it | Top-right chip / **Settings** |
| **Real-time sync between both phones** (plants, photos, checklists) | **Settings** → Real-time sync |
| Daily reminder notifications | **Settings** → Enable notifications |
| Export/import backup (plants + history + photos in one file) | **Settings** |
| Works offline, installable to home screen (PWA) | Automatic |

## Getting started (both of you)

1. **Open the app** on your phone: https://lucasfitz.github.io/My-repo-/plant-tracker/
2. **Install it**: in Safari (iPhone) tap Share → *Add to Home Screen*; in
   Chrome (Android) tap ⋮ → *Add to Home screen*. It now opens full-screen
   and works offline.
3. **Set your names**: Settings → Household → tap a profile → rename
   ("Lucas" and your wife's name). The top-right chip switches who's
   logging care actions.
4. **Turn on sync** (once): follow the 4-step Supabase walkthrough below —
   after that both phones share one live database.
5. **Add your plants**: Add tab → pick the species (the schedule
   auto-fills with sensible defaults) → snap a photo.
6. **Enable reminders**: Settings → Enable notifications. Sprout sends one
   summary notification per day when plants are due.
7. **Each day**: open the Today tab, tap the ✓ next to each due task.
   Done.

## Real-time sync between your two phones

Sync runs through a **free Supabase project that you create and own** — the
app itself stays a static page with no keys in it. One-time setup:

1. One of you creates a free account at [supabase.com](https://supabase.com)
   and makes a **New project** (any name works).
2. In the project, open **SQL Editor**, paste the setup script (the app's
   **Settings → Real-time sync → Copy setup script** button has it), and
   press **Run**. This creates one `records` table and a `plant-photos`
   storage bucket.
3. In Supabase **Settings → API**, copy the **Project URL** and the
   **anon / publishable key**.
4. In Sprout on *each* phone: **Settings → Real-time sync**, paste the URL
   and key, enter the *same* household code, and hit **Connect**.

From then on, waterings, new plants, photos, and checklist items appear on
the other phone within seconds. Everything still works offline — changes
queue up locally (an "outbox") and push automatically when you're back
online; conflicts resolve last-write-wins per record.

Privacy note: your data lives only on your phones and in *your* Supabase
project. The URL/key are stored on-device, never in this repository. Anyone
with your key + household code could read the data, so don't share them —
for a plant tracker this "household password" model is a sensible tradeoff.

The manual **Export/Import backup** in Settings still works as an offline
safety net.

## How it was built (the 0→1 steps)

1. **Scoped the product**: shared plant tracker → plants, schedules,
   photos, checklist, reminders, suggestions, two users.
2. **Chose the stack**: plain HTML/CSS/JS PWA — no build step, no server,
   free hosting on this repo's existing GitHub Pages (`docs/`), private by
   default, installable on both phones.
3. **Data model** (IndexedDB): `plants` (schedules + last-done dates),
   `logs` (who/what/when history), `photos` (resized JPEG blobs), `tasks`
   (household checklist), `settings` (profiles).
4. **Core logic**: next-due = last-done + interval; the Today view groups
   tasks into overdue / due today / next 7 days.
5. **Care knowledge base**: `plants-data.js` — 20+ species with suggested
   watering/fertilizing intervals, light needs, and tips, plus seasonal
   advice. Selecting a species pre-fills its schedule.
6. **PWA layer**: manifest + service worker for offline use and
   home-screen install; daily notification when tasks are due.
7. **Real-time sync**: local-first sync engine (`sync.js`) over a
   user-owned Supabase project — offline outbox, incremental pulls,
   realtime subscriptions, photo blobs in Supabase Storage, last-write-wins
   merges.
8. **Tested**: automated browser run-throughs — app features end-to-end,
   plus a two-device sync test against a mock Supabase server (plant +
   photo created on phone A appear on phone B; phone B's watering shows up
   on phone A) — all green.

## Files

```
docs/plant-tracker/
├── index.html           app shell
├── styles.css           mobile-first styling (light + dark mode)
├── app.js               app logic (IndexedDB, router, views)
├── sync.js              real-time sync engine (outbox, pull, realtime)
├── plants-data.js       species care guide + seasonal tips
├── sw.js                service worker (offline cache)
├── manifest.webmanifest PWA manifest
├── vendor/supabase.js   supabase-js client (self-hosted, MIT)
└── icons/               app icons
```

To develop locally: `cd docs/plant-tracker && python3 -m http.server 8000`
then open http://localhost:8000.
