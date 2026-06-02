# 168 Hours — Time Tracking PWA

A personal time-use tracker built on the **Experience Sampling Method (ESM)**: random prompts throughout the day ask "what are you doing right now?" and accumulate data to show how you actually spend your 168 hours each week.

---

## What This Is

Most time-tracking apps ask you to log time manually or run a timer. This app takes a different approach rooted in behavioral research: instead of relying on memory or active tracking, it pings you at random intervals and captures a snapshot. Over days and weeks, these snapshots build a statistically valid picture of your time use with minimal friction — one tap per prompt, under 5 seconds.

The categories mirror the 168-hour worksheet used in college success and life-planning curricula: Sleep, Meals, Learning, Work, Commute, Social, Hobbies, Exercise, Chores, Self-care, Free Time, Other. Users can also create their own custom categories.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, single file | Zero build step, deployable anywhere |
| Auth | Supabase Auth (email/password) | Per-user data, secure, built into the same Supabase project |
| Database | Supabase (Postgres) | Free tier, real SQL, instant REST API, RLS |
| Notifications | Web Push via Supabase Edge Function + pg_cron | Server-delivered; arrives even when the app is closed |
| PWA | Service Worker + Web App Manifest | Installable on home screen, offline-capable |
| Charts | Chart.js (CDN) | Lightweight, no bundler needed |
| Fonts | Google Fonts (Playfair Display + DM Sans) | Clean & minimal aesthetic |

**There is no build system.** No npm, no webpack, no TypeScript. All three files (`index.html`, `sw.js`, `manifest.json`) are dropped into any static host and it works.

---

## File Structure

```
/
├── index.html       # Entire app: HTML + CSS + JS in one file
├── sw.js            # Service Worker: PWA caching + Web Push handler + notification click handler
├── manifest.json    # PWA manifest: installability, theme, icons
└── README.md        # This file
```

---

## Auth

The app requires a **Supabase email/password account**. Unauthenticated users see a sign-in / create-account screen; the main app is hidden until a session exists.

Flow:
1. **Auth screen** — sign in or create account (email + password, minimum 8 characters).
2. **Verify-email screen** — shown after sign-up if email confirmation is enabled; includes a resend button and a "use a different account" link.
3. **Main app** — revealed once Supabase confirms an active session via `onAuthStateChange`.
4. **Forgot password** — triggers a Supabase password-reset email with a redirect back to the app.
5. **Sign out** — available in the Settings tab; clears local state and returns to the auth screen.

All data is scoped to the signed-in user. There is no anonymous / shared data model.

---

## Tabs

| Tab | Purpose |
|---|---|
| **Log** | Tap an activity category + optional note → saves to Supabase |
| **History** | Last 60 entries, newest first |
| **Stats** | Doughnut chart + percentage bars across all time |
| **Summary** | Replica of the 168-hour Part 2 worksheet, filled with your data + Download .xlsx button |
| **Calendar** | 168-cell grid with three sub-views: This Week (live), Past (browse any archived week), Average (stacked bands across all weeks) |
| **Settings** | Account info + sign-out, notifications (enable + send a test), week size (168 / 336 hours), custom activities management, delete-all-data |

---

## Database

**Supabase project:** `kcsjdgpatoiprgvthdlc`
**URL:** `https://kcsjdgpatoiprgvthdlc.supabase.co`

### Schema

```sql
-- User activity logs
CREATE TABLE time_logs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  activity   text        NOT NULL,
  note       text,
  logged_at  timestamptz NOT NULL DEFAULT now(),
  week_start date        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES auth.users(id)
);

-- User-defined activity categories (color + label)
CREATE TABLE custom_activities (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label      text        NOT NULL,
  hex        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id)
);

-- Per-user key/value preferences (e.g. week_size = '168' | '336')
CREATE TABLE user_prefs (
  key        text        NOT NULL,
  value      text        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY (key, user_id)
);

-- One row per subscribed device for Web Push delivery
CREATE TABLE push_subscriptions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id),
  endpoint   text        NOT NULL UNIQUE,
  p256dh     text        NOT NULL,
  auth       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Randomly-generated daily prompt fire times per user
CREATE TABLE prompt_schedule (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id),
  fire_at    timestamptz NOT NULL,
  sent_at    timestamptz,           -- NULL until delivered; set to prevent double-send
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-only configuration (VAPID keypair, cron secret, contact subject)
-- RLS is ENABLED with NO policies — only the service role can read this table.
CREATE TABLE app_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);
```

`week_start` is always the **Sunday** of whichever calendar week the entry belongs to. The JS client sends it explicitly. **Week rollover** is automatic — at Sunday midnight, new logs get a new `week_start`. Old weeks are never modified.

### RLS Policies

Row Level Security is **enabled on every table**. Every user-facing policy is scoped to `auth.uid() = user_id`, meaning users can only read and write their own rows. The old "anon can read/write everything" model has been replaced entirely.

`app_config` is the exception: RLS is enabled with **no policies**, so only the Supabase service role (used by Edge Functions) can access it. Client-side code cannot read VAPID private keys or the cron secret.

### Adding Columns

Use a Supabase migration rather than a raw `ALTER TABLE` so the schema stays tracked:

```sql
-- Example: adding mood tracking
ALTER TABLE time_logs ADD COLUMN mood smallint CHECK (mood BETWEEN 1 AND 5);
```

---

## Credentials

The app uses a **publishable (anon) key** — safe to commit and expose in client-side code. It is not the service role key.

```javascript
// index.html — top of <script>
const SUPABASE_URL = 'https://kcsjdgpatoiprgvthdlc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tvlXARIX31Wk5P-SRPuMzw__MTBYtcH';
```

The **VAPID public key** is also hardcoded in `index.html` (safe to expose). The VAPID private key and cron secret live only in `app_config` (server-side, service-role access only).

---

## How the Notification Scheduler Works

The ESM (Experience Sampling Method) scheduler avoids two failure modes:
1. **Fixed-time alerts** — users adapt their behavior in anticipation
2. **Purely random alerts** — can cluster (3 in one hour, none for 6 hours), disrupting daily life

**Solution: stratified random sampling.** Waking hours (8 am–10 pm) are split into 7 equal two-hour blocks. One notification fires at a random moment within each block. This guarantees even distribution while preserving unpredictability.

```javascript
// The 7 two-hour blocks
const BLOCKS = [[8,10],[10,12],[12,14],[14,16],[16,18],[18,20],[20,22]];
```

### Web Push architecture (server-delivered)

Notifications now use **Web Push** and are delivered by the server, so they arrive **even when the app is closed**.

```
Supabase Cron (pg_cron)
  └─► pg_net HTTP POST
        └─► send-push Edge Function
              └─► VAPID JWT signed + payload encrypted (@negrel/webpush Deno library)
                    └─► Browser push service
                          └─► sw.js `push` event → showNotification
```

**Two pg_cron jobs run continuously:**

| Job | Schedule | What it does |
|---|---|---|
| `gen-daily-prompts` | every 15 min | Calls `gen_daily_prompts()`, a `SECURITY DEFINER` plpgsql function. For each user who has at least one push subscription and no schedule yet for their local day, it generates 7 stratified-random `fire_at` timestamps — one per two-hour block across 8 am–10 pm — computed in **the user's own timezone** (the IANA `tz` stored in `user_prefs`, validated against `pg_timezone_names`, falling back to `America/New_York`). |
| `send-due-prompts` | every minute | Calls the `send-push` Edge Function with the cron secret. The function finds all `prompt_schedule` rows where `fire_at <= now()` and `sent_at IS NULL`, pushes to each of that user's subscribed devices, then sets `sent_at`. HTTP 404/410 responses from the push service cause the dead subscription to be auto-pruned from `push_subscriptions`. |

> **Timezone:** Each device reports its IANA timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) on sign-in, saved to `user_prefs.tz`. Prompts fire during the user's *local* 8 am–10 pm. DST is handled automatically by Postgres `AT TIME ZONE`. Unknown/missing zones fall back to Eastern. The zone is auto-detected (re-detected on each sign-in), not a manual setting.

**`send-push` Edge Function has two modes:**

- **Cron mode** — authenticated by an `x-cron-secret` header that must match the value stored in `app_config`. Used by `send-due-prompts`.
- **Test mode** — authenticated by the user's Supabase JWT. Fires one push to all of that user's devices immediately. Triggered by the "Send a test" button in Settings.

**Client side:**

- `sw.js` is registered on page load.
- `sw.js` handles the `push` event: parses the payload and calls `showNotification`.
- When the user enables reminders, the client calls `pushManager.subscribe()` with the VAPID public key and upserts the resulting subscription into `push_subscriptions`.

**iOS caveat:** Web Push on iOS only works after the PWA is installed to the Home Screen (iOS 16.4+). It never works in a Safari browser tab. The app shows an install hint to iOS users who try to enable notifications before installing.

---

## Design System

All visual tokens are CSS custom properties on `:root`:

```css
--bg:        #f5f0e8   /* warm off-white page background */
--surface:   #ffffff   /* card/input backgrounds */
--ink:       #1a1a18   /* primary text */
--ink-light: #6b6b5f   /* secondary text, labels */
--accent:    #2d5a3d   /* forest green — primary actions, selections */
--accent-lt: #e8f0ea   /* light green tint — selected state backgrounds */
--warn:      #c8773a   /* warm orange — errors, warnings */
--border:    #e0d9cc   /* card borders, dividers */
--radius:    14px      /* border radius for all cards/buttons */
--shadow:    0 2px 16px rgba(0,0,0,0.07)
```

**Typography:**
- Display/headings: `Playfair Display` (serif, weight 400/500)
- Body/UI: `DM Sans` (sans-serif, weight 300/400/500)

When making UI changes, edit these variables rather than hardcoding color values. The entire app will stay consistent.

---

## Activity Categories

Built-in categories are defined as `BUILTIN` in `index.html`. Each entry has an `id`, `label`, `hex` color, and a short display name:

```javascript
const BUILTIN = [
  { id: 'sleep',    label: 'Sleep',     hex: '#4A7C8E', short: 'Sleep' },
  { id: 'meals',    label: 'Meals',     hex: '#C8773A', short: 'Meals' },
  { id: 'learning', label: 'Learning',  hex: '#2D5A3D', short: 'Learn' },
  { id: 'work',     label: 'Work',      hex: '#5A3D7C', short: 'Work' },
  { id: 'commute',  label: 'Commute',   hex: '#7C6A3D', short: 'Commute' },
  { id: 'social',   label: 'Social',    hex: '#3D7C6A', short: 'Social' },
  { id: 'hobbies',  label: 'Hobbies',   hex: '#9B3D7C', short: 'Hobby' },
  { id: 'exercise', label: 'Exercise',  hex: '#3D5A7C', short: 'Exercise' },
  { id: 'chores',   label: 'Chores',    hex: '#8E7A4A', short: 'Chores' },
  { id: 'selfcare', label: 'Self-care', hex: '#7C5A3D', short: 'Self-care' },
  { id: 'freetime', label: 'Free time', hex: '#4A8E7A', short: 'Free' },
  { id: 'other',    label: 'Other',     hex: '#8E8E8E', short: 'Other' },
];
```

The `id` field is what gets stored in the database. **Do not change existing `id` values** after data has been collected — historical entries will lose their category label in the UI. If renaming a category, update only `label` and `hex`.

**Custom activities** are created by users in Settings → Custom activities. They are stored in the `custom_activities` table (per-user, with a color chosen from a preset palette) and merged with `BUILTIN` at runtime. Users can delete their own custom categories; built-in categories cannot be deleted.

---

## Deploying

Any static host works. Recommended options:

**Netlify Drop (fastest):**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the folder containing the three files
3. Done — live URL in seconds

**GitHub Pages:**
1. Push files to a repo (or this repo)
2. Settings → Pages → Deploy from branch → `main` / `root`

**Vercel:**
```bash
npx vercel --prod
```

> The app must be served over **HTTPS** for Service Workers and Web Push to work. All the hosts above provide HTTPS by default.

---

## Roadmap / Suggested Improvements

### Still to do

- **168-hour wheel visualization** — a radial/polar chart showing each category's share of a 168-hour week. Chart.js has a `polarArea` chart type that works well here.

- **Streak / consistency tracking** — count how many days in a row the user has logged at least one entry.

- **Mood/energy co-logging** — a 1–5 scale after selecting an activity. Requires adding a `mood smallint` column to `time_logs`.

- **Two-week calendar rendering** — when week size is 336, the calendar currently renders on a single 168-cell grid (the second week's data is collapsed into the same view). A true 336-cell grid would require layout work.

### Already implemented (not a roadmap item)

- Web Push background notifications (server-delivered via pg_cron + Edge Function)
- Supabase Auth (email/password, email verification, password reset)
- Custom user-defined activity categories (stored in `custom_activities`)
- Week size toggle (168 / 336 hours), stored in `user_prefs`
- .xlsx export (Summary tab → Download button)

---

## Code Conventions

- **No build system.** Keep it that way unless there's a strong reason to add one. The entire value of this codebase is its deployability.
- **All JS is vanilla.** No frameworks. If adding interactivity, use the existing DOM manipulation patterns already in the file.
- **CSS variables for all design tokens.** Never hardcode a color or radius outside `:root`.
- **Supabase queries live in their own named async functions** (`submitLog`, `loadHistory`, `loadStats`). Keep data-fetching logic separate from rendering logic inside those functions.
- **`BUILTIN` is the base source of truth** for built-in categories. At runtime, `ACTIVITIES` = `BUILTIN` + the user's `customActs` loaded from Supabase. Don't hardcode category names anywhere else.
- **`localStorage` is not used as a data store.** All user data (logs, prefs, custom activities, push subscriptions) lives in Supabase, scoped by `user_id`.

---

## Known Issues / Gotchas

- **iOS Safari notifications:** Web Push on iOS requires the PWA to be added to the Home Screen first (iOS 16.4+). Notifications will not work in the Safari browser tab on iOS. The app shows an install hint when it detects an iOS user who hasn't installed.
- **Two-week calendar mode:** When week size is set to 336 hours, the Calendar tab renders on a single 168-cell grid. The second week's entries are visible but the grid isn't extended to 336 cells.
- **Notification timezone:** Auto-detected per device on sign-in and stored in `user_prefs.tz`; prompts fire in the user's local time. A user who travels has their schedule follow the device's reported timezone after the next sign-in. There's no manual timezone override UI.
- **`manifest.json` icon:** Currently uses an inline SVG data URI which works for PWA display but may not render on all platforms' home screens. Replace with a proper PNG at `icon-192.png` and `icon-512.png` for production.
- **Stats query fetches all rows:** `loadStats()` does `SELECT activity` with no date filter. For users with thousands of entries this is fine (the column is tiny), but add a date filter if performance becomes an issue.

---

## Origin

This app was built to accompany the **168 Hours Assignment** — a college orientation exercise where students map out how they spend all 168 hours of a week across sleep, meals, classes, work, commuting, family/friend time, hobbies, chores, personal care, and free time. The goal is to make the invisible visible: most people have no accurate sense of where their time actually goes until they measure it.

The random-prompt approach is grounded in the **Experience Sampling Method** (Csikszentmihalyi & Larson, 1983), which has been used in psychology and behavioral research for decades to capture real-time self-reports without recall bias.
