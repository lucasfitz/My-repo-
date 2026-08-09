# 🌱 Sprout — Plant Care Tracker

A mobile-first web app for tracking your houseplants together — watering and
fertilizing schedules, photo journals, daily checklists, reminders, and a
built-in care guide. Built for two people (you and your wife) to share.

**Live app:** https://lucasfitz.github.io/My-repo-/plant-tracker/

No accounts, no servers, no build step — it's a plain HTML/CSS/JS Progressive
Web App. All data is stored privately on each device (IndexedDB), including
photos.

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
4. **Add your plants**: Add tab → pick the species (the schedule
   auto-fills with sensible defaults) → snap a photo.
5. **Enable reminders**: Settings → Enable notifications. Sprout sends one
   summary notification per day when plants are due.
6. **Each day**: open the Today tab, tap the ✓ next to each due task.
   Done.

## How sharing between two phones works

Each phone keeps its own copy of the data (nothing is uploaded anywhere).
To sync up: **Settings → Export backup** on one phone, share the file
(AirDrop/Messages/email), then **Settings → Import** on the other. Import
merges by ID — newer waterings win and nothing duplicates, so syncing in
either direction is safe.

In practice the easiest routine is: one phone is the "source of truth" you
both check off from, and you export a backup to the other occasionally as
insurance.

> **Want real-time sync?** The natural upgrade is adding a small backend
> (Supabase or Firebase both have free tiers): move the IndexedDB reads and
> writes in `app.js` behind a sync layer, and both phones share one
> database with live updates. The data model here (plants / logs / photos /
> tasks keyed by ID) maps 1:1 onto that.

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
7. **Tested**: automated browser run-through (add plants, complete tasks,
   upload photos, switch profiles, export) — all green.

## Files

```
docs/plant-tracker/
├── index.html           app shell
├── styles.css           mobile-first styling (light + dark mode)
├── app.js               all app logic (IndexedDB, router, views)
├── plants-data.js       species care guide + seasonal tips
├── sw.js                service worker (offline cache)
├── manifest.webmanifest PWA manifest
└── icons/               app icons
```

To develop locally: `cd docs/plant-tracker && python3 -m http.server 8000`
then open http://localhost:8000.
