// Permanent account + data deletion. Apple's App Store guideline 5.1.1(v)
// requires any app with account creation to let people delete their account
// from inside the app. This wipes the user's journal data and their login.
module.exports = async (req, res) => {
  // CORS so the native app (capacitor://localhost) can call this cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const svc = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !anon || !svc) return res.status(500).json({ error: "Server not configured" });

    // Confirm who is asking — they can only ever delete themselves.
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Sign in required" });
    const uRes = await fetch(supaUrl + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();
    const uid = user.id;

    const H = { apikey: svc, Authorization: "Bearer " + svc, "Content-Type": "application/json" };
    const rest = supaUrl + "/rest/v1/";

    // 1) wipe their rows in every table keyed by user_id
    for (const table of ["kv", "push_subs", "push_log", "usage", "entry_log"]) {
      await fetch(rest + table + "?user_id=eq." + uid, { method: "DELETE", headers: H }).catch(() => {});
    }
    // 2) delete the auth account itself (admin API, service key)
    const del = await fetch(supaUrl + "/auth/v1/admin/users/" + uid, { method: "DELETE", headers: H });
    if (!del.ok && del.status !== 404) {
      const t = await del.text().catch(() => "");
      return res.status(502).json({ error: "Could not delete the account: " + t.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, deleted: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
