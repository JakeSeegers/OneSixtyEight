# 168 Hours — Time Tracking PWA

A personal time-use tracker built on the **Experience Sampling Method (ESM)**: random prompts throughout the day ask "what are you doing right now?" and accumulate data to show how you actually spend your 168 hours each week.

---

## What This Is

Most time-tracking apps ask you to log time manually or run a timer. This app takes a different approach rooted in behavioral research: instead of relying on memory or active tracking, it pings you at random intervals and captures a snapshot. Over days and weeks, these snapshots build a statistically valid picture of your time use with minimal friction — one tap per prompt, under 5 seconds.

The categories mirror the 168-hour worksheet used in college success and life-planning curricula: Sleep, Meals, Learning, Work, Commute, Social, Hobbies, Exercise, Chores, Self-care, Free Time, Other.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, single file | Zero build step, deployable anywhere |
| Database | Supabase (Postgres) | Free tier, real SQL, instant REST API |
| Notifications | Web Notifications API + localStorage scheduler | No server required for scheduling |
| PWA | Service Worker + Web App Manifest | Installable on home screen, offline-capable |
| Charts | Chart.js (CDN) | Lightweight, no bundler needed |
| Fonts | Google Fonts (Playfair Display + DM Sans) | Clean & minimal aesthetic |

**There is no build system.** No npm, no webpack, no TypeScript. All three files (`index.html`, `sw.js`, `manifest.json`) are dropped into any static host and it works.

---

## File Structure

```
/
├── index.html       # Entire app: HTML + CSS + JS in one file
├── sw.js            # Service Worker: PWA caching + notification click handler
├── manifest.json    # PWA manifest: installability, theme, icons
└── README.md        # This file
```

---


## Tabs

| Tab | Purpose |
|---|---|
| **Log** | Tap an activity category + optional note → saves to Supabase |
| **History** | Last 60 entries, newest first |
| **Stats** | Doughnut chart + percentage bars across all time |
| **Summary** | Replica of the 168-hour Part 2 worksheet, filled with your data + Download .xlsx button |
| **Calendar** | 168-cell grid (24 hours × 7 days), colored by logged activity for the current week |

## Database

**Supabase project:** `kcsjdgpatoiprgvthdlc`
**URL:** `https://kcsjdgpatoiprgvthdlc.supabase.co`

### Schema

```sql
CREATE TABLE time_logs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  activity   text        NOT NULL,
  note       text,
  logged_at  timestamptz NOT NULL DEFAULT now()
);
```

### RLS Policies

Row Level Security is enabled. Two policies exist for the `anon` role:
- `anon insert` — allows anyone with the publishable key to insert rows
- `anon select` — allows anyone with the publishable key to read rows

> **Note for AI agents:** This is a single-user personal app. If adding multi-user support, replace the anon policies with user-scoped policies using `auth.uid()` and add a `user_id` column. Supabase Auth (email/magic link or OAuth) would be the natural addition.

### Adding Columns

If you add columns to `time_logs`, add them via a Supabase migration, not a raw `ALTER TABLE`, so the schema stays tracked. Example:

```sql
-- Example: adding mood tracking
ALTER TABLE time_logs ADD COLUMN mood smallint CHECK (mood BETWEEN 1 AND 5);
```

---

## Credentials

The app uses a **publishable (anon) key** — this is safe to commit and expose in client-side code. It is not a secret key. Do not add the Supabase service role key to this codebase.

```javascript
// index.html — top of <script>
const SUPABASE_URL = 'https://kcsjdgpatoiprgvthdlc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tvlXARIX31Wk5P-SRPuMzw__MTBYtcH';
```

---

## How the Notification Scheduler Works

The ESM (Experience Sampling Method) scheduler avoids two failure modes:
1. **Fixed-time alerts** — users adapt their behavior in anticipation
2. **Purely random alerts** — can cluster (3 in one hour, none for 6 hours), disrupting daily life

**Solution: stratified random sampling.** Waking hours (8am–10pm) are split into 7 equal two-hour blocks. One notification fires at a random moment within each block. This guarantees even distribution while preserving unpredictability.

```javascript
// index.html
const BLOCKS = [[8,10],[10,12],[12,14],[14,16],[16,18],[18,20],[20,22]];
```

The schedule is generated once per day and stored in `localStorage` under the key `notif_schedule` as `{ date: string, times: number[] }`. On page load, if the stored date matches today, the existing schedule is reused (so reloading the page doesn't reschedule).

**Known limitation:** `setTimeout`-based notifications only fire while the browser tab/PWA is open. True background delivery requires a push server. See the roadmap below for how to implement this.

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
--warn:      #c8773a   /* warm orange — errors, warnings (reserved, not yet used) */
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

Defined as a constant array in `index.html`. To add, remove, or rename categories, edit `ACTIVITIES`:

```javascript
const ACTIVITIES = [
  { id: 'sleep',    label: 'Sleep',    icon: '🌙' },
  { id: 'meals',    label: 'Meals',    icon: '🍽️' },
  { id: 'learning', label: 'Learning', icon: '📚' },
  { id: 'work',     label: 'Work',     icon: '💼' },
  { id: 'commute',  label: 'Commute',  icon: '🚌' },
  { id: 'social',   label: 'Social',   icon: '👥' },
  { id: 'hobbies',  label: 'Hobbies',  icon: '🎨' },
  { id: 'exercise', label: 'Exercise', icon: '🏃' },
  { id: 'chores',   label: 'Chores',   icon: '🧹' },
  { id: 'selfcare', label: 'Self-care',icon: '✨' },
  { id: 'freetime', label: 'Free time',icon: '☁️' },
  { id: 'other',    label: 'Other',    icon: '•••' },
];
```

The `id` field is what gets stored in the database. **Do not change existing `id` values** after data has been collected — historical entries will lose their category label in the UI. If renaming a category, update only the `label` and `icon`.

The companion `COLORS` array assigns chart colors by index position — keep it the same length as `ACTIVITIES`.

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

> The app must be served over **HTTPS** for Service Workers and Notifications to work. All the hosts above provide HTTPS by default.

---

## Roadmap / Suggested Improvements

These are roughly ordered by value and complexity. Any AI agent picking this up should start from this list.

### High value, low complexity

- **Week view in Stats** — filter the stats chart to last 7 days vs all time. Add a `timeRange` state variable (`'week' | 'all'`) and pass a `.gte('logged_at', sevenDaysAgo)` filter to the Supabase query in `loadStats()`.

- **168-hour wheel visualization** — the app's namesake. A radial/polar chart showing each category's share of a 168-hour week. Requires estimating hours from entry counts (assume each entry represents ~1–2 hours, or let the user configure it). Chart.js has a `polarArea` chart type that works well here.

- **Delete entries** — add a swipe-to-delete or long-press gesture on history entries. Supabase call: `db.from('time_logs').delete().eq('id', entry.id)`.

- **Configurable notification times** — let users set their own waking hours instead of the hardcoded 8am–10pm window. Store in `localStorage` as `{ start: 8, end: 22 }`.

### Medium complexity

- **Weekly summary view** — a dedicated tab or modal showing "this week vs last week" comparison. Pull two date ranges from Supabase and render side-by-side bars.

- **Streak / consistency tracking** — count how many days in a row the user has logged at least one entry. Store a `streak` value in `localStorage`, updated on each successful submit.

- **Mood/energy co-logging** — add a 1–5 scale after selecting an activity. This requires adding a `mood smallint` column to `time_logs` (migration above). Enables future correlation analysis ("I'm happiest during Exercise and Social").

- **CSV export** — a button in Stats that fetches all rows and downloads them as a `.csv` file. Pure client-side: use `Blob` and a temporary `<a>` with `download` attribute. No backend needed.

### Higher complexity

- **True background notifications via Web Push** — the current `setTimeout` approach requires the app to be open. Real background delivery needs:
  1. A VAPID key pair (generate with `web-push` npm package)
  2. A `/subscribe` endpoint that saves `PushSubscription` objects to a new `push_subscriptions` table in Supabase
  3. A scheduled job (Supabase Edge Function with a pg_cron trigger, or a free cron service hitting a serverless function) that sends pushes at the right times
  4. The service worker's `push` event handler (skeleton already in `sw.js`)

  This is the single biggest UX improvement available.

- **Supabase Auth** — if the app is ever shared with others or used across multiple devices, add authentication. Supabase provides magic link and OAuth (Google). After adding auth, scope all queries with `eq('user_id', user.id)` and update RLS policies accordingly.

- **AI-powered weekly reflection** — send the week's `time_logs` to the Claude API and generate a short narrative ("You spent 34% of your logged time on Learning this week, up from 18% last week…"). Could live in a new "Reflect" tab.

---

## Code Conventions

- **No build system.** Keep it that way unless there's a strong reason to add one. The entire value of this codebase is its deployability.
- **All JS is vanilla.** No frameworks. If adding interactivity, use the existing DOM manipulation patterns already in the file.
- **CSS variables for all design tokens.** Never hardcode a color or radius outside `:root`.
- **Supabase queries live in their own named async functions** (`submitLog`, `loadHistory`, `loadStats`). Keep data-fetching logic separate from rendering logic inside those functions.
- **`ACTIVITIES` is the single source of truth** for categories — used for the grid, the history display, and the stats chart. Don't hardcode category names anywhere else.
- **localStorage** is used only for the notification schedule and any future user preferences. It is not used as a data store — all user data lives in Supabase.

---

## Known Issues / Gotchas

- **iOS Safari notifications:** Web Push on iOS requires the PWA to be added to the home screen first. Notifications will not work in the Safari browser tab on iOS. After installing to home screen, they work normally.
- **Notification schedule resets on page reload:** If the user closes and reopens the app, `armNotifications()` re-arms only the future `setTimeout` calls from today's schedule. Past slots that fired are not re-triggered. This is correct behavior.
- **`manifest.json` icon:** Currently uses an inline SVG data URI which works for PWA display but may not render on all platforms' home screens. Replace with a proper PNG at `icon-192.png` and `icon-512.png` for production.
- **Stats query fetches all rows:** `loadStats()` does `SELECT activity` with no date filter. For users with thousands of entries this is fine (the column is tiny), but add a date filter if performance becomes an issue.

---

## Origin

This app was built to accompany the **168 Hours Assignment** — a college orientation exercise where students map out how they spend all 168 hours of a week across sleep, meals, classes, work, commuting, family/friend time, hobbies, chores, personal care, and free time. The goal is to make the invisible visible: most people have no accurate sense of where their time actually goes until they measure it.

The random-prompt approach is grounded in the **Experience Sampling Method** (Csikszentmihalyi & Larson, 1983), which has been used in psychology and behavioral research for decades to capture real-time self-reports without recall bias.
