// Runs every few minutes (Vercel Cron). For each device that turned reminders
// on, it looks at that user's schedule and today's entry, decides what's due
// right now in the device's own timezone, and sends a push. A small log table
// guarantees each reminder fires exactly once.
const webpush = require("web-push");
const crypto = require("crypto");
const http2 = require("http2");

const STORAGE_KEY = "daybook:days:v1";
const SCHED_KEY = "daybook:schedule:v1";

// ---- Apple Push Notification service (native iOS app) ----
// The native app registers an APNs device token instead of a web-push
// subscription; those go through APNs here. Credentials come from a .p8 auth
// key made in the Apple Developer portal — set the env vars once you have it.
// Until then, native sends no-op gracefully and web push is unaffected.
let _apnsJwt = null, _apnsJwtAt = 0;
function apnsJwt() {
  const key = process.env.APNS_KEY, kid = process.env.APNS_KEY_ID, iss = process.env.APNS_TEAM_ID;
  if (!key || !kid || !iss) return null;
  if (_apnsJwt && Date.now() - _apnsJwtAt < 50 * 60000) return _apnsJwt; // APNs tokens last ~60 min
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = b64({ alg: "ES256", kid }) + "." + b64({ iss, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign("sha256", Buffer.from(signingInput),
    { key: key.replace(/\\n/g, "\n"), dsaEncoding: "ieee-p1363" }).toString("base64url");
  _apnsJwt = signingInput + "." + sig; _apnsJwtAt = Date.now();
  return _apnsJwt;
}
function sendApns(token, payload) {
  return new Promise((resolve, reject) => {
    const jwt = apnsJwt();
    if (!jwt) return reject(Object.assign(new Error("APNs not configured"), { statusCode: 500 }));
    const host = String(process.env.APNS_PRODUCTION || "").toLowerCase() === "true"
      ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: "default" } });
    const client = http2.connect(host);
    let done = false;
    const fail = (e) => { if (done) return; done = true; try { client.close(); } catch (x) {} reject(e); };
    client.on("error", fail);
    const req = client.request({
      ":method": "POST", ":path": "/3/device/" + token,
      "authorization": "bearer " + jwt,
      "apns-topic": process.env.APNS_BUNDLE_ID || "",
      "apns-push-type": "alert", "content-type": "application/json",
    });
    let status = 0, data = "";
    req.on("response", (h) => { status = h[":status"]; });
    req.on("data", (d) => { data += d; });
    req.on("end", () => {
      if (done) return; done = true; try { client.close(); } catch (x) {}
      if (status === 200) resolve();
      else reject(Object.assign(new Error("APNs " + status + " " + data), { statusCode: status }));
    });
    req.on("error", fail);
    req.write(body); req.end();
  });
}
// A native sub is stored as { platform:"ios", token, endpoint:token }.
const isNativeSub = (sub) => sub && (sub.platform === "ios" || (sub.token && !sub.keys));

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
  // Only the trigger that knows CRON_SECRET may run this. Vercel's own cron sends
  // it as a Bearer token; an external scheduler (e.g. cron-job.org on the free
  // plan) can send it either as that header OR as a ?key= query param — simple
  // pingers that can't set headers still work. A random visitor gets rejected.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = String(req.headers.authorization || "");
    const key = (req.query && req.query.key) || "";
    if (auth !== "Bearer " + secret && key !== secret) return res.status(401).json({ error: "no" });
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
      if (isNativeSub(sub)) await sendApns(sub.token || sub.endpoint, payload);
      else await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      // web-push: 404/410 gone. APNs: 410 Unregistered / 400 BadDeviceToken.
      if (code === 404 || code === 410 || code === 400) {
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
