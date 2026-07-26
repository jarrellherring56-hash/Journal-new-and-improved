// Saves (or removes) a device's push subscription. The subscription itself is
// not secret, but we still gate on the signed-in user so one account can't
// register reminders under another. Nothing here needs the Anthropic key.
module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ error: "POST or DELETE only" });
  }
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const svc = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !anon || !svc) {
      return res.status(500).json({ error: "Server not configured — check env vars" });
    }

    // Who is this? (same check the AI endpoint uses)
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Sign in required" });
    const uRes = await fetch(supaUrl + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    const body = req.body || {};
    const sub = body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "Missing subscription" });

    const rest = supaUrl + "/rest/v1/push_subs";
    const headers = {
      apikey: svc,
      Authorization: "Bearer " + svc,
      "Content-Type": "application/json",
    };

    if (req.method === "DELETE") {
      // reminders turned off on this device: drop just this endpoint
      const q = "?user_id=eq." + user.id + "&endpoint=eq." + encodeURIComponent(sub.endpoint);
      const r = await fetch(rest + q, { method: "DELETE", headers });
      if (!r.ok) return res.status(502).json({ error: "Could not remove subscription" });
      return res.status(200).json({ ok: true, removed: true });
    }

    // upsert this device's row (one per endpoint)
    const row = {
      user_id: user.id,
      endpoint: sub.endpoint,
      sub,
      tz: typeof body.tz === "string" ? body.tz.slice(0, 64) : null,
      reminder_time: typeof body.reminderTime === "string" && /^\d{2}:\d{2}$/.test(body.reminderTime)
        ? body.reminderTime : null,
      updated_at: new Date().toISOString(),
    };
    const r = await fetch(rest, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Could not save subscription: " + t.slice(0, 200) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
