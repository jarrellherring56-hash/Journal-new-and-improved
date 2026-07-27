// Owner-only usage stats. Returns WHO is using the journal and how much —
// never WHAT they wrote. Entry text is parsed on the server purely to count
// words/entries and is then discarded; it is never sent to the browser.
module.exports = async (req, res) => {
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const svc = process.env.SUPABASE_SERVICE_KEY;
    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (!supaUrl || !anon || !svc) {
      return res.status(500).json({ error: "Server not configured" });
    }
    // If no owner is configured, nobody is admin — fail closed.
    if (!adminEmail) return res.status(403).json({ error: "No admin configured", admin: false });

    // Who is calling?
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Sign in required" });
    const uRes = await fetch(supaUrl + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired" });
    const caller = await uRes.json();
    const isAdmin = String(caller.email || "").trim().toLowerCase() === adminEmail;
    if (!isAdmin) return res.status(403).json({ error: "Not authorized", admin: false });

    // A cheap probe the client uses to decide whether to show the Members tab.
    if (req.query && req.query.probe) return res.status(200).json({ admin: true });

    const H = { apikey: svc, Authorization: "Bearer " + svc, "Content-Type": "application/json" };

    // 1) all accounts (id, email, join date, last sign-in)
    const uListRes = await fetch(supaUrl + "/auth/v1/admin/users?per_page=1000", { headers: H });
    const uData = uListRes.ok ? await uListRes.json() : { users: [] };
    const users = Array.isArray(uData) ? uData : (uData.users || []);
    const byId = {};
    for (const u of users) {
      byId[u.id] = {
        email: u.email || "(no email)",
        memberSince: u.created_at || null,
        lastSignIn: u.last_sign_in_at || null,
        entries: 0, notes: 0, days: 0, words: 0, lastEntry: null, firstEntry: null,
      };
    }

    // 2) each user's journal blob — parsed for COUNTS ONLY, text thrown away
    const kvRes = await fetch(
      supaUrl + "/rest/v1/kv?key=eq.daybook:days:v1&select=user_id,value,updated_at",
      { headers: H }
    );
    const rows = kvRes.ok ? await kvRes.json() : [];
    const wc = (s) => (typeof s === "string" && s.trim() ? s.trim().split(/\s+/).length : 0);
    for (const row of rows) {
      const m = byId[row.user_id];
      if (!m) continue;
      let days = {};
      try { days = JSON.parse(row.value) || {}; } catch (e) { continue; }
      const keys = Object.keys(days).filter((k) => (days[k].entries || []).length > 0).sort();
      m.days = keys.length;
      m.firstEntry = keys[0] || null;
      m.lastEntry = keys[keys.length - 1] || null;
      for (const k of keys) {
        for (const en of days[k].entries || []) {
          for (const seg of en.segments || []) {
            m.notes += 1;
            // count words across whatever text a segment holds, then forget it
            m.words += wc(seg.text) + wc(seg.q) + wc(seg.a);
          }
          m.entries += 1;
        }
      }
    }

    const members = Object.values(byId).sort((a, b) => {
      // most recently active first; never-written accounts last
      if (a.lastEntry && b.lastEntry) return a.lastEntry < b.lastEntry ? 1 : -1;
      if (a.lastEntry) return -1;
      if (b.lastEntry) return 1;
      return 0;
    });

    const totals = members.reduce((t, m) => ({
      members: t.members + 1,
      active: t.active + (m.entries > 0 ? 1 : 0),
      entries: t.entries + m.entries,
      words: t.words + m.words,
    }), { members: 0, active: 0, entries: 0, words: 0 });

    return res.status(200).json({ admin: true, totals, members });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
