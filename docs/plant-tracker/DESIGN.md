# Sprout — Design Spec

Derived from the reference: oversized tight display type, a warm neutral ground
with white cards floating on it, photography carrying all the color, and
circular floating controls. The interface is monochrome scaffolding; the plants
supply the color.

---

## 1. Principles

1. **Photography is the color.** Chrome is black, white, and warm grey. A plant
   photo should be the most saturated thing on any screen. Accent color is
   reserved for state that must be noticed (overdue), never for decoration.
2. **Type carries the hierarchy.** Big, tight, heavy headings do the work that
   borders and color would otherwise do. Scale contrast is dramatic — display
   type is ~3× body, not 1.3×.
3. **Cards float on a ground.** The background is warm grey; surfaces are pure
   white with a generous radius and a soft shadow. Never a white card on a white
   page.
4. **Controls are circular and float.** Primary actions are filled black
   circles that sit over content. Secondary are hairline-outlined circles.
5. **Breathe.** Whitespace is a feature. When in doubt, remove a divider and add
   space instead.

---

## 2. Typography — San Francisco

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
             system-ui, "Segoe UI", Roboto, sans-serif;
```

`-apple-system` resolves to SF and, on Apple platforms, automatically switches
to **SF Pro Display** optical sizing above ~20px — which is exactly the crisp
tight-tracked look in the reference. Set `font-optical-sizing: auto`.

Negative tracking is the signature. The larger the type, the tighter it gets.

| Role | Size | Weight | Tracking | Leading | Use |
|---|---|---|---|---|---|
| **Display** | 40px | 700 | −0.045em | 0.98 | Screen titles. Allowed to wrap to 2–3 stacked lines. |
| **Title** | 27px | 700 | −0.035em | 1.05 | Plant names, card subjects |
| **Headline** | 19px | 600 | −0.02em | 1.2 | Section headings |
| **Body** | 16px | 400 | −0.01em | 1.5 | Paragraphs, advice |
| **Label** | 15px | 590 | −0.01em | 1.3 | Buttons, list rows |
| **Meta** | 13px | 500 | 0 | 1.4 | Dates, captions, secondary rows |
| **Micro** | 11px | 600 | +0.04em | 1.2 | Tab labels, uppercase eyebrows |

Rules:
- Display type **stacks** — "Good morning, / Lucas" reads as two tight lines, not
  one long one. Set `max-width: 12ch` on display headings to force the wrap.
- Never use display weight below 19px; small heavy text reads as shouting.
- Numbers in stats use `font-variant-numeric: tabular-nums` so they don't jitter.

---

## 3. Color

Monochrome scaffolding, warm rather than blue-grey.

```
--ground        #EFEDE9   warm greige page background
--surface       #FFFFFF   cards
--surface-sunk  #F5F3F0   inset areas inside cards (inputs, media placeholders)
--ink           #12110F   near-black; all primary text and filled buttons
--ink-2         #6E6A64   secondary text, meta
--ink-3         #A8A39C   placeholder, disabled
--hairline      rgba(18,17,15,.10)
```

Semantic — used only for state, never decoration:

```
--alert         #C0392B   overdue
--alert-bg      #F8EBE8
--warn          #B0761E   due soon / fertilize
--warn-bg       #FAF1E4
--cool          #2F6D8F   water
--cool-bg       #E8F0F4
--grow          #3F7A52   healthy / connected
--grow-bg       #E9F1EB
```

**Dark mode** inverts the ground, keeping the warmth:

```
--ground        #131211
--surface       #1D1B19
--surface-sunk  #262320
--ink           #F4F2EF
--ink-2         #A29D96
--hairline      rgba(255,255,255,.12)
```

Semantic hues lighten ~25% in dark mode so they stay legible on a dark surface.

---

## 4. Shape & elevation

| Token | Value | Applies to |
|---|---|---|
| `--r-card` | 28px | Cards, sheets |
| `--r-media` | 22px | Photos inside cards |
| `--r-field` | 16px | Inputs, small buttons |
| `--r-pill` | 999px | Chips, nav bar, circular buttons |

```
--lift-1  0 2px 10px rgba(18,17,15,.05)    resting cards
--lift-2  0 10px 30px rgba(18,17,15,.11)   floating nav, circular controls
```

No borders on cards — the ground/surface contrast defines the edge. Hairlines
are for *dividing inside* a card only.

---

## 5. Components

### Card
White, `--r-card`, `--lift-1`, 20px padding. A card with a photo runs the photo
edge-to-edge inside with `--r-media`, 6px inset from the card edge.

### Media card (plants, photo journal)
```
┌─────────────────────────┐
│ ◯ Monty          2d ago │  ← meta row: 32px avatar/emoji, Title name, Meta right
│ ┌─────────────────────┐ │
│ │                     │ │  ← photo, aspect 4/5, --r-media
│ │        photo        │ │
│ │                 (◯) │ │  ← optional floating control, bottom-right, 44px
│ └─────────────────────┘ │
│ Monstera · Living room  │  ← Meta
└─────────────────────────┘
```

### Circular controls
- **Primary** 56px, filled `--ink`, white glyph, `--lift-2`. Floats over media,
  bottom-center or bottom-right, 16px inset.
- **Secondary** 44px, `--surface`, 1px hairline, ink glyph.
- Icons are 1.7px-stroke line art on a 24px grid — never filled shapes.

### Buttons
- **Filled**: `--ink` bg, `--ground` text, `--r-pill`, 14px × 22px, Label type.
- **Quiet**: `--surface` bg, hairline border, ink text.
- **Plain**: text only, ink, underline on press.
- Full-width buttons keep the pill radius — they read as capsules, not bars.

### Chips / badges
`--r-pill`, 11px Micro type, semantic bg + fg pair, 4px × 11px. Only one chip
per row may be a semantic (colored) chip; the rest are neutral.

### Tab bar
A **floating pill**, not an edge-to-edge bar:
- Inset 12px from the screen sides, 10px above the safe area
- `--surface`, `--r-pill`, `--lift-2`, 62px tall
- 5 items; icon 23px line art + Micro label
- Inactive `--ink-3`, active `--ink` with stroke-width 2.1
- **Add** is a 46px filled `--ink` circle inside the bar — the dark accent the
  reference uses at the right of its nav

### Inputs
`--surface-sunk` fill, no border at rest, `--r-field`, 14px × 16px, Body type.
On focus: 1.5px `--ink` ring. Placeholder `--ink-3`.

### Stat
No card. Big tabular number in Title size over a Micro label in `--ink-2`,
separated by hairline verticals. Numbers are the hierarchy; boxes aren't needed.

### Bottom drawer
For a decision that belongs to the screen you are on — choosing between things,
confirming a suggestion — rather than a place you navigate to.
- Rises from the bottom over a `rgba(18,17,15,.42)` scrim, 28px top corners,
  `--surface`, `--lift-2`, capped at 88vh
- 38×4px grab handle, then a Title-size heading and one line of `--ink-2` subtitle
- Body scrolls; the footer holds the actions and does not, so the primary
  action is always in reach of a thumb
- Footer carries the safe-area inset and a hairline top edge
- Dismissible by scrim tap or Esc — and dismissing must leave the user
  somewhere sensible, never back at a dead end

### Choice row
A tappable row inside a drawer: 58px image thumbnail, name / botanical name /
one line of reasoning, and a confidence chip. `--surface-sunk` at rest; the
picked row goes `--surface` with a 1.5px `--ink` border. The selected row
expands to a horizontally scrolling strip of 108px reference photos, so a
suggestion can be compared rather than trusted.

---

## 6. Layout

- Page gutter 20px; max width 640px centered
- Vertical rhythm: 8 / 12 / 20 / 32 / 48
- Section spacing 32px; card-to-card 14px
- Content bottom padding 116px to clear the floating nav
- Screen titles get 8px top / 24px bottom margin, and stack (see §2)

---

## 7. Motion

Restrained and quick — 140–200ms, `cubic-bezier(.2,.7,.3,1)`.
- Press: `scale(.97)` on buttons and cards
- Card enter: 12px rise + fade
- Never animate layout width/height; transform and opacity only
- Respect `prefers-reduced-motion: reduce` by dropping to opacity-only

---

## 8. Iconography

Line art, 24px grid, 1.7px stroke, round caps and joins, `currentColor`.
No emoji in navigation, headings, or buttons. Emoji survive only where they
encode data the user reads at a glance — weather conditions and the species
avatar on a plant with no photo.

---

## 9. Do / Don't

| Do | Don't |
|---|---|
| Let a photo be the loudest thing | Add colored gradients or tinted cards |
| Stack display headings tightly | Set a 40px heading on one long line |
| Use one semantic color per row | Color-code every chip |
| Float controls over media | Put a full-width bar under every photo |
| Divide with space | Divide with rules |
