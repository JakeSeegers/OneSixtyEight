import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as webpush from "jsr:@negrel/webpush@^0.3.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Rotating prompt copy: one call-to-action + one reflective question per prompt.
const CALLS = [
  "Log what you're doing right now.",
  "Take a second to record this moment.",
  "Time to track your current activity.",
  "Log this hour before it passes.",
  "Tap in and log your activity.",
  "Stop and log this moment.",
  "Log how this hour of your 168 is being spent.",
  "Record what this hour is going toward.",
  "Track this hour before it's gone.",
  "Account for this hour right now.",
  "Capture this hour before it slips by.",
  "Take ownership of this moment and log it.",
  "Log this moment in your 168.",
  "Be honest and record your current activity.",
  "Don't let this hour go unaccounted for.",
];
const QUESTIONS = [
  "Is what you're doing moving you forward or pulling you back?",
  "Does this feel aligned with your goals?",
  "Would the version of you who set these goals be happy right now?",
  "Is this the best use of this hour?",
  "How does this fit with what you're working toward?",
  "Is this hour being spent the way you planned?",
  "Are you being intentional with this moment?",
  "How does this hour fit into your bigger picture?",
  "Is this moment working for you or against you?",
  "Does this piece of your 168 reflect your priorities?",
  "Is this how you want this hour to count?",
  "Is this where you want your time going?",
  "Does this hour reflect what matters most to you?",
  "Is this the best version of how this hour could be spent?",
  "Will you be glad you spent this hour this way?",
];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
function pickMessage() { return `${pick(CALLS)} ${pick(QUESTIONS)}`; }

let _cfg: Record<string, string> | null = null;
async function getConfig() {
  if (_cfg) return _cfg;
  const { data, error } = await admin.from("app_config").select("key,value");
  if (error) throw error;
  const cfg: Record<string, string> = {};
  for (const r of data!) cfg[r.key] = r.value;
  _cfg = cfg;
  return cfg;
}

let _appServer: any = null;
async function getAppServer() {
  if (_appServer) return _appServer;
  const cfg = await getConfig();
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(cfg.vapid_keys), { extractable: false });
  _appServer = await webpush.ApplicationServer.new({ contactInformation: cfg.vapid_subject, vapidKeys });
  return _appServer;
}

async function sendToUser(uid: string) {
  const appServer = await getAppServer();
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", uid);
  const body = pickMessage(); // one random prompt per delivery (same across a user's devices)
  let sent = 0, pruned = 0;
  for (const s of subs ?? []) {
    try {
      const subscriber = await appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await subscriber.pushTextMessage(
        JSON.stringify({ title: "168 Hours", body, url: "/" }),
        { urgency: "high", ttl: 300 }, // high priority so Doze doesn't drop it; 5-min TTL matches the log window (LOG_WINDOW_MS) so a device that wakes after the window never shows a stale, already-closed prompt
      );
      sent++;
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404 || status === 410) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
        pruned++;
      } else {
        console.error("push error", status, e?.message ?? e);
      }
    }
  }
  return { sent, pruned };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cfg = await getConfig();
    const cronHeader = req.headers.get("x-cron-secret");

    let userIds: string[] = [];
    let dueIds: string[] = [];

    if (cronHeader && cronHeader === cfg.cron_secret) {
      const { data: due } = await admin
        .from("prompt_schedule")
        .select("id,user_id")
        .is("sent_at", null)
        .lte("fire_at", new Date().toISOString());
      for (const d of due ?? []) { userIds.push(d.user_id); dueIds.push(d.id); }
    } else {
      const authz = req.headers.get("Authorization");
      if (!authz) return json({ ok: false, error: "unauthorized" }, 401);
      const { data: { user } } = await admin.auth.getUser(authz.replace("Bearer ", ""));
      if (!user) return json({ ok: false, error: "unauthorized" }, 401);
      userIds = [user.id];
    }

    const uniqueUsers = [...new Set(userIds)];
    let sent = 0, pruned = 0;
    for (const uid of uniqueUsers) {
      const r = await sendToUser(uid);
      sent += r.sent; pruned += r.pruned;
    }
    if (dueIds.length) {
      await admin.from("prompt_schedule").update({ sent_at: new Date().toISOString() }).in("id", dueIds);
    }
    return json({ ok: true, users: uniqueUsers.length, sent, pruned });
  } catch (e: any) {
    console.error("handler error", e?.message ?? e);
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
