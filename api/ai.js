// Secure AI proxy. The Anthropic key lives ONLY here (in env vars), never in the browser.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const supaUrl = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const svc = process.env.SUPABASE_SERVICE_KEY;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!supaUrl || !anon || !svc || (!apiKey && !process.env.OPENROUTER_API_KEY)) {
      return res.status(500).json({ error: "Server not configured — check env vars" });
    }

    // 1) Verify the caller is a signed-in user
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Sign in required" });
    const uRes = await fetch(supaUrl + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    // 2) Invite gate: only people who signed up with your code may use the AI
    const invite = process.env.INVITE_CODE;
    if (invite && (user.user_metadata || {}).invite !== invite) {
      return res.status(403).json({ error: "This account wasn't created with the invite code" });
    }

    // 3) Per-user daily limit so nobody can burn your bill
    const limit = parseInt(process.env.DAILY_LIMIT || "300", 10);
    const day = new Date().toISOString().slice(0, 10);
    const bump = await fetch(supaUrl + "/rest/v1/rpc/bump_usage", {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: "Bearer " + svc,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user: user.id, p_day: day }),
    });
    const count = bump.ok ? await bump.json() : 0;
    if (count > limit) return res.status(429).json({ error: "Daily AI limit reached — resets tomorrow" });

    // 4) Validate and forward to Anthropic
    const body = req.body || {};
    const prompt = body.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 80000) {
      return res.status(400).json({ error: "Bad prompt" });
    }
    const maxTokens = Math.min(Math.max(parseInt(body.max_tokens || 1000, 10) || 1000, 1), 8000);

    // Provider switch: if OPENROUTER_API_KEY is set, use OpenRouter (accepts PayPal).
    // Otherwise use Anthropic directly. Same Claude models either way.
    const orKey = process.env.OPENROUTER_API_KEY;
    let text;
    if (orKey) {
      let model = process.env.MODEL || "anthropic/claude-3.5-haiku";
      const orMap = {
        "claude-3-5-haiku-latest": "anthropic/claude-3.5-haiku",
        "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
        "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
        "claude-opus-4-8": "anthropic/claude-opus-4.8",
      };
      if (orMap[model]) model = orMap[model];
      else if (!model.includes("/")) model = "anthropic/" + model;
      const aRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + orKey, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await aRes.json();
      if (!aRes.ok) {
        return res.status(502).json({ error: (data && data.error && data.error.message) || "AI request failed" });
      }
      text = ((data.choices || [])[0] || {}).message ? data.choices[0].message.content || "" : "";
    } else {
      let model = process.env.MODEL || "claude-3-5-haiku-latest";
      if (model.includes("/")) model = model.split("/").pop().replace(/\.(\d)/g, "-$1");
      const aRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await aRes.json();
      if (!aRes.ok) {
        return res.status(502).json({ error: (data && data.error && data.error.message) || "AI request failed" });
      }
      text = (data.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
    }
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
