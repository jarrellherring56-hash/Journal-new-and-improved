// Secure speech-to-text proxy. Records from the app are sent here as base64
// audio; this forwards them to Groq's Whisper (whisper-large-v3) and returns
// the transcript. The Groq key lives ONLY here (in env vars), never in the
// browser. Same auth + invite gate as the AI endpoint.
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
    const groqKey = process.env.GROQ_API_KEY;
    if (!supaUrl || !anon || !groqKey) {
      return res.status(500).json({ error: "Server not configured — check env vars (GROQ_API_KEY)" });
    }

    // 1) Verify the caller is a signed-in user
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Sign in required" });
    const uRes = await fetch(supaUrl + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    // 2) Invite gate: only people who signed up with your code may use it
    const invite = process.env.INVITE_CODE;
    if (invite && (user.user_metadata || {}).invite !== invite) {
      return res.status(403).json({ error: "This account wasn't created with the invite code" });
    }

    // 3) Validate the audio payload
    const body = req.body || {};
    const b64 = typeof body.audio === "string" ? body.audio : "";
    if (!b64) return res.status(400).json({ error: "No audio" });
    let buf;
    try { buf = Buffer.from(b64, "base64"); } catch (e) { return res.status(400).json({ error: "Bad audio" }); }
    if (!buf.length) return res.status(400).json({ error: "Empty audio" });
    // Whisper handles up to 25MB; our client caps recordings well under that.
    if (buf.length > 24 * 1024 * 1024) return res.status(413).json({ error: "Recording too long" });

    // Give the file an extension Groq can map to a format, from the mime type.
    const mime = String(body.mime || "audio/webm").toLowerCase();
    const ext =
      mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac") ? "m4a" :
      mime.includes("mpeg") || mime.includes("mp3") ? "mp3" :
      mime.includes("wav") ? "wav" :
      mime.includes("ogg") ? "ogg" :
      mime.includes("flac") ? "flac" : "webm";

    // 4) Forward to Groq's OpenAI-compatible transcription endpoint (multipart)
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), "audio." + ext);
    form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (typeof body.language === "string" && /^[a-z]{2}$/.test(body.language)) {
      form.append("language", body.language);
    }
    // A short prompt nudges Whisper toward clean punctuation/casing.
    form.append("prompt", "This is a personal journal entry. Use natural punctuation and capitalization.");

    const gRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + groqKey },
      body: form,
    });
    const data = await gRes.json().catch(() => ({}));
    if (!gRes.ok) {
      const emsg = (data && data.error && data.error.message) || "Transcription failed";
      return res.status(502).json({ error: emsg });
    }
    return res.status(200).json({ text: String((data && data.text) || "").trim() });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
