// Secure AI proxy. The Anthropic key lives ONLY here (in env vars), never in the browser.
module.exports = async (req, res) => {
  // CORS: the native app loads from capacitor://localhost and calls this
  // cross-origin, which triggers a preflight. Web (same origin) is unaffected.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
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

    // Web search is ON by default (set WEB_SEARCH=off to disable for the whole
    // deployment). Only question-answering calls set body.web, so tagging entries
    // never spends a search.
    const webAllowed = String(process.env.WEB_SEARCH || "on").toLowerCase() !== "off";
    const wantWeb = body.web === true && webAllowed;
    const webMaxUses = Math.min(Math.max(parseInt(process.env.WEB_SEARCH_MAX_USES || "5", 10) || 5, 1), 10);

    // Provider switch: if OPENROUTER_API_KEY is set, use OpenRouter (accepts
    // PayPal). Otherwise use Anthropic directly. Same Claude models either way.
    const orKey = process.env.OPENROUTER_API_KEY;
    let text;
    let sources = [];
    let webError = null;
    if (orKey) {
      let model = process.env.MODEL || "anthropic/claude-sonnet-4.6";
      const orMap = {
        "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
        "claude-sonnet-5": "anthropic/claude-sonnet-5",
        "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
        "claude-opus-4-8": "anthropic/claude-opus-4.8",
      };
      if (orMap[model]) model = orMap[model];
      else if (!model.includes("/")) model = "anthropic/" + model;
      const payload = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      };
      // OpenRouter can't run Anthropic's web_search tool — it has its own "web"
      // plugin instead, which works across every model. Left unset, it prefers
      // the provider's native search and falls back to Exa.
      if (wantWeb) payload.plugins = [{ id: "web", max_results: webMaxUses }];
      const aRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + orKey, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await aRes.json();
      if (!aRes.ok) {
        return res.status(502).json({ error: (data && data.error && data.error.message) || "AI request failed" });
      }
      const msg = ((data.choices || [])[0] || {}).message || {};
      text = msg.content || "";
      // pages it cited, as url_citation annotations, de-duplicated
      const seen = new Set();
      for (const a of msg.annotations || []) {
        const c = a && a.url_citation;
        if (c && c.url && !seen.has(c.url)) {
          seen.add(c.url);
          sources.push({ url: c.url, title: c.title || c.url });
        }
      }
      // No banner when sources are empty: most questions ("how was my week?")
      // genuinely don't need the web, and a red warning on every one of those
      // would be noise.
    } else {
      let model = process.env.MODEL || "claude-sonnet-4-6";
      if (model.includes("/")) model = model.split("/").pop().replace(/\.(\d)/g, "-$1");

      let messages = [{ role: "user", content: prompt }];
      const seen = new Set();
      let useWeb = wantWeb;
      text = "";

      // Web search runs as a server-side loop. When it hits the per-turn iteration
      // cap the API returns stop_reason "pause_turn" — resend the assistant turn
      // unchanged to continue. Bounded so a runaway can't spin.
      for (let turn = 0; turn < 5; turn++) {
        const payload = { model, max_tokens: maxTokens, messages };
        if (useWeb) {
          payload.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: webMaxUses }];
        }
        const aRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const data = await aRes.json();
        if (!aRes.ok) {
          const emsg = (data && data.error && data.error.message) || "AI request failed";
          // If the search tool itself is what the API rejected (not enabled for the
          // org, or unsupported by this model), answer without it rather than failing.
          if (useWeb && aRes.status === 400) {
            useWeb = false;
            webError = emsg;
            // start clean, so no half-finished search turns confuse the retry
            messages = [{ role: "user", content: prompt }];
            text = "";
            sources = [];
            seen.clear();
            continue;
          }
          return res.status(502).json({ error: emsg });
        }

        for (const b of data.content || []) {
          if (b.type === "text") text += (text ? "\n" : "") + b.text;
          // collect the pages it actually looked at, de-duplicated
          if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
            for (const r of b.content) {
              if (r && r.type === "web_search_result" && r.url && !seen.has(r.url)) {
                seen.add(r.url);
                sources.push({ url: r.url, title: r.title || r.url });
              }
            }
          }
        }

        if (data.stop_reason !== "pause_turn") break;
        messages = messages.concat([{ role: "assistant", content: data.content }]);
      }
    }
    return res.status(200).json({ text: String(text || "").trim(), sources, webError });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
