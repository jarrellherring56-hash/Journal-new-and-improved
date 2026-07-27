# Journal — one-time setup (15–20 minutes, no coding)

You'll do 4 things: make a database, make an AI key, paste 2 values into one file, and click deploy.

---

## 1. Database + logins (Supabase — free)

1. Go to https://supabase.com → Start your project → sign up → **New project** (any name, any password, closest region).
2. Left sidebar → **SQL Editor** → **New query** → paste the ENTIRE contents of `supabase.sql` from this folder → **Run**. You should see "Success".
3. Left sidebar → **Authentication → Sign In / Up → Email** → turn **OFF** "Confirm email" → Save. (This lets friends sign up instantly without a confirmation email.)
4. Left sidebar → **Project Settings → API**. Keep this page open — you need three values:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon / public** key
   - **service_role** key  ← secret, treat like a password

## 2. AI key (Anthropic)

1. Go to https://console.anthropic.com → sign up → **API Keys** → **Create Key** → copy it (starts with `sk-ant-`).
2. Add a payment method, then go to **Limits** and set a monthly spend cap (e.g. $5) so the bill can never surprise you.

## 3. Paste two values into the app

Open `index.html` in any text editor. Near the top you'll see:

```
const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL_HERE";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY_HERE";
```

Replace with your **Project URL** and **anon/public** key from step 1.4. Save.
(These two are safe to be public — the secret ones go in step 4 instead.)

## 4. Deploy (Vercel — free)

1. Go to https://vercel.com → sign up → **Add New → Project**.
2. Easiest path: put this folder on GitHub and import it. No-GitHub path: install the Vercel CLI or use vercel.com/new's upload option — the whole folder, keeping `api/` inside it.
3. Before hitting Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key |
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon/public key |
| `SUPABASE_SERVICE_KEY` | your service_role key |
| `INVITE_CODE` | any word you choose, e.g. `XOCREW` |
| `DAILY_LIMIT` | optional, AI calls per person per day (default 300) |
| `MODEL` | optional; default `claude-sonnet-4-6`. Cheaper: `claude-haiku-4-5`. Best: `claude-opus-4-8`. |
| `WEB_SEARCH` | optional; on by default. Set to `off` to disable web search entirely. |
| `WEB_SEARCH_MAX_USES` | optional; results per question (default 5) |
| `VAPID_PUBLIC` | for reminders; see below |
| `VAPID_PRIVATE` | for reminders; see below |
| `VAPID_SUBJECT` | for reminders; `mailto:you@example.com` |
| `CRON_SECRET` | optional; any random word — stops outsiders poking the reminder job |
| `ADMIN_EMAIL` | optional; your email. Unlocks a **Members** tab (owner only) showing who uses the app and how much — counts and dates only, never entry text. Leave unset to disable. |

Using OpenRouter instead of Anthropic? Set `OPENROUTER_API_KEY` rather than
`ANTHROPIC_API_KEY`. Web search works on both, through different mechanisms:
OpenRouter uses its own `web` plugin (~$0.005 per question, up to 10 results),
Anthropic uses its built-in search tool (~$0.01 per search). Token costs are
extra on either.

4. **Deploy.** You'll get a link like `https://your-journal.vercel.app`.

## 4b. Reminders / notifications (optional)

Push notifications need a key pair (VAPID) and a scheduled job. The job runs
every 5 minutes and requires the **Vercel Pro plan** (Hobby caps cron at once a
day, which can't do exact-time reminders).

1. In Vercel → your project → **Settings → Environment Variables**, add the
   `VAPID_PUBLIC`, `VAPID_PRIVATE`, and `VAPID_SUBJECT` values you were given
   (`VAPID_SUBJECT` is just `mailto:` + your email). Optionally add a
   `CRON_SECRET` set to any random word.
2. The `VAPID_PUBLIC` value must ALSO match the one near the top of `index.html`
   (`const VAPID_PUBLIC = "…"`). If you generate a fresh pair, update both.
3. Redeploy. Vercel picks up the schedule from `vercel.json` automatically.
4. Reminders are **on by default** — no setting to find. The permission popup
   appears by itself the first time you interact with the app (tap anything);
   just choose **Allow**. On iPhone, add the app to the Home Screen and open it
   from there first (web push doesn't work in a plain Safari tab). To stop a
   device buzzing, switch Reminders **Off** in Customize.

## 5. Invite your friends

Send them: the link + the invite code. They tap **Create account** (email + password + code) and they're in.
- **iPhone:** open the link in Safari → Share → **Add to Home Screen** → real app icon.
- **Android:** Chrome → menu → **Add to Home screen** / Install app.

---

## Node version
`package.json` pins `"node": "24.x"`. Vercel warns about open-ended ranges like
`>=18` because they'd auto-jump to whatever major ships next, so a future Node
release could break the AI endpoint with no change from you. Bump this
deliberately when you want to move.

## How updates work
Tell Claude what to change → get an updated `index.html` (or other file) → replace it in your project → redeploy (with GitHub connected, just push and it deploys itself). Nobody's data is ever touched by updates.

## Privacy guarantees in this build
- Each user's journal rows are locked by database Row Level Security to their own account — the database itself refuses cross-user reads, not just the app.
- The Anthropic key exists only on the server; browsers never see it.
- Only accounts created with your invite code can use the AI, and each person has a daily cap.

## If something breaks
- "Server not configured" → an env var name is misspelled in Vercel.
- Sign-up says invalid → check step 1.3 (email confirmation OFF).
- AI errors for a friend → they signed up without the invite code; have them make a new account with it.
