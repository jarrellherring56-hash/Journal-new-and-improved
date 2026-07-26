// Runs every few minutes (Vercel Cron). For each device that turned reminders
// on, it looks at that user's schedule and today's entry, decides what's due
// right now in the device's own timezone, and sends a push. A small log table
// guarantees each reminder fires exactly once.
const webpush = require("web-push");

const STORAGE_KEY = "daybook:days:v1";
const SCHED_KEY = "daybook:schedule:v1";

// How far ahead we nudge, and how far back we still catch a missed run (minutes).
const LEAD_MIN = 5;   // a 3:00 item fires at the ~2:55 run — a few minutes' warning
const GRACE_MIN = 6;  // if a cron run is skipped, still fire slightly late

// Wall-clock {y,mo,d,h,mi} in a given IANA timezone, as a comparable UTC-based
// millisecond count. Both "now" and each item map through the same fiction, so
// their difference is the real minutes-apart (DST edges aside, fine for reminders).
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  let h = parseInt(p.hour, 10); if (h === 24) h = 0; // some engines emit "24"
  return {
    y: +p.year, mo: +p.month, d: +p.day, h, mi: +p.minute,
    dayKey: p.year + "-" + p.month + "-" + p.day,
  };
}
const asMs = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi);

module.exports = async (req, res) => {
  // Vercel attaches CRON_SECRET (if set) as a Bearer token. Reject anything else
  // so the endpoint can't be triggered by a random visitor.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = String(req.headers.authorization || "");
    if (auth !== "Bearer " + secret) return res.status(401).json({ error: "no" });
  }

  const supaUrl = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_KEY;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!supaUrl || !svc || !pub || !priv) {
    return res.status(500).json({ error: "Push not configured — check VAPID + Supabase env vars" });
  }
  webpush.setVapidDetails(subject, pub, priv);

  const H = { apikey: svc, Authorization: "Bearer " + svc, "Content-Type": "application/json" };
  const rest = supaUrl + "/rest/v1/";
  const now = new Date();
  let sent = 0;

  // one push, deduped through push_log so a later run never repeats it. We
  // "claim" the reminder by inserting the log row first (a PK conflict means
  // it already fired), but if the actual send then fails we release the claim
  // so the next run can retry — otherwise a transient network blip would lose
  // the reminder for good.
  const fireOnce = async (userId, tag, sub, payload) => {
    const logRes = await fetch(rest + "push_log", {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" }, // PK conflict => already sent
      body: JSON.stringify({ user_id: userId, tag }),
    });
    if (logRes.status === 409) return;            // already fired on an earlier run
    if (!logRes.ok) return;                        // couldn't claim; nothing logged, retry next run
    const releaseClaim = () =>
      fetch(rest + "push_log?user_id=eq." + userId + "&tag=eq." + encodeURIComponent(tag),
        { method: "DELETE", headers: H }).catch(() => {});
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        // subscription is permanently gone — drop it, don't retry a dead endpoint
        await fetch(rest + "push_subs?endpoint=eq." + encodeURIComponent(sub.endpoint),
          { method: "DELETE", headers: H }).catch(() => {});
      } else {
        // transient failure — give the reminder back so the next run tries again
        await releaseClaim();
      }
    }
  };

  try {
    // keep push_log small: once an event is a week past, its dedupe row is dead weight
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    fetch(rest + "push_log?sent_at=lt." + weekAgo, { method: "DELETE", headers: H }).catch(() => {});

    const subsRes = await fetch(rest + "push_subs?select=*", { headers: H });
    const subs = subsRes.ok ? await subsRes.json() : [];

    // group subscriptions by user so we read each user's data only once
    const byUser = {};
    for (const s of subs) (byUser[s.user_id] = byUser[s.user_id] || []).push(s);

    for (const userId of Object.keys(byUser)) {
      const rows = byUser[userId];
      const kvGet = async (key) => {
        const r = await fetch(rest + "kv?select=value&user_id=eq." + userId + "&key=eq." + encodeURIComponent(key), { headers: H });
        const d = r.ok ? await r.json() : [];
        try { return d[0] ? JSON.parse(d[0].value) : null; } catch (e) { return null; }
      };
      const sched = (await kvGet(SCHED_KEY)) || [];
      const days = (await kvGet(STORAGE_KEY)) || {};

      for (const row of rows) {
        const tz = row.tz || "UTC";
        const nowL = localParts(now, tz);
        const nowMs = asMs(nowL.y, nowL.mo, nowL.d, nowL.h, nowL.mi);

        // --- timed schedule items ---
        for (const item of Array.isArray(sched) ? sched : []) {
          if (!item || item.done || !item.date || !item.time) continue;
          const [iy, imo, idd] = item.date.split("-").map(Number);
          const [ih, imi] = item.time.split(":").map(Number);
          if (!iy || ih == null || Number.isNaN(ih)) continue;
          const lead = asMs(iy, imo, idd, ih, imi) - nowMs; // ms until the item
          if (lead <= LEAD_MIN * 60000 && lead >= -GRACE_MIN * 60000) {
            // tag is per-device (endpoint) so every device the user kept on gets it,
            // and includes date+time so rescheduling an item earns a fresh reminder
            await fireOnce(userId, "sched:" + item.id + ":" + item.date + "T" + item.time + ":" + row.endpoint, row.sub, {
              title: item.title || "Reminder",
              body: item.note ? item.note : ("At " + item.time),
              url: "/",
            });
          }
        }

        // --- daily "time to journal" nudge (only if nothing written today) ---
        if (row.reminder_time && /^\d{2}:\d{2}$/.test(row.reminder_time)) {
          const [rh, rm] = row.reminder_time.split(":").map(Number);
          const lead = asMs(nowL.y, nowL.mo, nowL.d, rh, rm) - nowMs;
          const today = days[nowL.dayKey];
          const wroteToday = today && Array.isArray(today.entries) && today.entries.length > 0;
          if (lead <= 0 && lead >= -GRACE_MIN * 60000 && !wroteToday) {
            await fireOnce(userId, "journal:" + nowL.dayKey + ":" + row.endpoint, row.sub, {
              title: "Time to journal",
              body: "Take a minute to write down your day.",
              url: "/",
            });
          }
        }
      }
    }

    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(500).json({ error: "cron failed" });
  }
};
