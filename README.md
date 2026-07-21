# Journal

A private, AI-powered journal. It's a single-page web app (works offline, installs to your phone home screen) with a tiny serverless function that keeps your AI key secret. Each person's entries are locked to their own account by the database itself.

- **Front end:** `index.html` (React via CDN — no build step), `sw.js`, `manifest.webmanifest`, icons.
- **AI proxy:** `api/ai.js` (runs on Vercel; your Anthropic/OpenRouter key lives only here).
- **Database + login:** Supabase (`supabase.sql` sets it up).

New here? Read **`SETUP.md`** — it walks through the whole thing in ~15 minutes with no coding. The checklist below is the short version.

---

## Deploy: GitHub → Vercel

### 1. Supabase (database + logins) — free
1. Create a project at https://supabase.com.
2. **SQL Editor → New query →** paste all of `supabase.sql` → **Run**.
3. **Authentication → Sign In / Up → Email →** turn **OFF** "Confirm email" → Save.
4. **Project Settings → API →** copy your **Project URL**, **anon** key, and **service_role** key.

### 2. AI key
- Anthropic: https://console.anthropic.com → create a key (`sk-ant-…`), add a payment method, set a monthly spend cap.
- Or OpenRouter (accepts PayPal): create a key and set `OPENROUTER_API_KEY` instead of `ANTHROPIC_API_KEY`.

### 3. Paste your two public Supabase values into `index.html`
Near the top you'll see:
```js
const SUPABASE_URL = "…";
const SUPABASE_ANON_KEY = "…";
```
Set them to your **Project URL** and **anon** key. (These two are safe to be public. The secret keys go in step 5.)

### 4. Push to GitHub
Create a new repository and upload this whole folder (keep `api/` inside it). Either:
- On github.com: **New repository → uploading an existing file →** drag the folder's contents in, **or**
- With git:
  ```bash
  git init
  git add .
  git commit -m "Journal app"
  git branch -M main
  git remote add origin https://github.com/<you>/<repo>.git
  git push -u origin main
  ```

### 5. Import into Vercel — free
1. https://vercel.com → **Add New → Project →** import your GitHub repo.
2. Framework preset: **Other** (no build command, no output dir — it's already static).
3. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your `sk-ant-…` key (omit if using OpenRouter) |
   | `OPENROUTER_API_KEY` | your OpenRouter key (only if not using Anthropic) |
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon / public key |
   | `SUPABASE_SERVICE_KEY` | your service_role key (secret) |
   | `INVITE_CODE` | any word, e.g. `XOCREW` |
   | `DAILY_LIMIT` | optional — AI calls per person per day (default 300) |
   | `MODEL` | optional — default `claude-3-5-haiku-latest`; for smarter sorting use `claude-sonnet-4-6` |

4. **Deploy.** You'll get a link like `https://your-journal.vercel.app`.

### 6. Invite people
Send them the link + the invite code. They tap **Create account** (email + password + code) and they're in.
- **iPhone:** open in Safari → Share → **Add to Home Screen**.
- **Android:** Chrome menu → **Install app**.

---

## Updating later
Change a file, commit, and push — Vercel redeploys automatically. Nobody's data is touched by updates.

## Privacy
- Journal rows are locked per-account by database Row Level Security — the database itself refuses cross-user reads.
- The AI key exists only on the server; browsers never see it.
- Only accounts created with your invite code can use the AI, and each person has a daily cap.
- `vercel.json` gives the AI function up to 60s so long entries don't time out.
