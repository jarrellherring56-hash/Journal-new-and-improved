# Journal — App Store guide

Everything to turn the web app into an iOS app, submit it, and update it after.
Read the **honest realities** section first — a few of these need a Mac (or a cloud
Mac) and your Apple account, which no one can do for you.

---

## What's already done (in the code)
The app changes Apple *requires* are built and in this repo:
- **In-app account deletion** — Customize → Delete account (`api/delete-account.js`). Apple guideline 5.1.1(v) requires this for any app with sign-up.
- **Privacy policy** — `privacy.html`, served at `https://journal-new-and-improved.vercel.app/privacy.html`. You'll paste that URL into App Store Connect.
- **Native-safe API calls** — `API_BASE` in `index.html` makes the app talk to your Vercel backend whether it runs on the web or inside the native shell.
- **Capacitor wrapper scaffold** — in `mobile/` (config + a script that bundles the web app).

## Honest realities (read this)
1. **You need a Mac at the final step.** Building/signing/submitting an iOS app requires macOS + Xcode. Since you're on Windows, use a **cloud Mac** (Codemagic free tier, or MacinCloud ~$1/hr) or borrow a Mac. There is no Windows-only path to the App Store.
2. **Apple Developer Program: $99/year** (you're buying it tomorrow).
3. **Notifications won't work in the native app out of the box.** Web push doesn't carry into a native wrapper — the App Store version needs **native push (APNs)**, which is a separate build (register an APNs token, store it, and have the cron send via APNs instead of web-push). Your PWA/home-screen users keep getting reminders as they do now. Tell me and I'll add native push as a follow-up.
4. **Subscriptions must use Apple's In-App Purchase** if you charge inside the iOS app — Apple takes 15–30% and forbids Stripe for digital subscriptions. (You have no billing yet, so decide before you add it.)
5. **Rejection risk (Guideline 4.2):** Apple rejects apps that are "just a wrapped website." Bundling the app (below) plus your offline shell, real features, and account system helps you pass, but it's a real risk on a first review.

---

## One-time setup (do this after you have the Developer account)

### 1. Apple side
- Enroll in the **Apple Developer Program** ($99).
- In **App Store Connect** → create a new app: pick a **Bundle ID** (reverse-DNS, e.g. `com.jarrellherring.journal`) and the app name "Journal".
- Update `mobile/capacitor.config.json` → `appId` to match that exact Bundle ID.

### 2. Build the iOS project (on a Mac / cloud Mac)
From the `mobile/` folder:
```bash
npm install
npm run add-ios      # bundles the web app into mobile/www and creates the iOS project
npx cap open ios     # opens it in Xcode
```
In Xcode: set your Team (your Developer account), the Bundle ID, an app icon (drop `icon-1024.png` into the asset catalog — generate one from your existing icon), and a launch screen (dark `#0a0b0e`).

### 3. Submit
- In Xcode: **Product → Archive → Distribute App → App Store Connect → Upload.**
- In App Store Connect, fill in: description, keywords, screenshots (required sizes), the **privacy policy URL** above, the **privacy "nutrition label"** (declare: email, user content, and that data is *not* used for tracking — match `privacy.html`), age rating, and confirm **account deletion** is supported.
- **Submit for review.** ~1–3 days.

### No Mac? Use Codemagic
Codemagic has cloud macOS runners that build and submit Capacitor apps. Connect this repo, add your Apple signing (App Store Connect API key + certificates it can generate), point it at the `mobile/` Capacitor project, and it builds + uploads without you owning a Mac. Their docs have a Capacitor iOS template.

---

## How to UPDATE the app after it's live — this is the important part

Not everything requires an App Store resubmission. It splits cleanly:

| What you change | How it updates | Resubmit to Apple? |
|---|---|---|
| **Backend / AI / notifications / bug fixes in `/api`** | Deploy to Vercel (push → promote), same as now | **No — instant.** |
| **Supabase (SQL, data)** | Run in Supabase | **No.** |
| **Prices, server config, env vars** | Vercel env vars | **No.** |
| **The web UI itself (`index.html`)** | Rebuild the iOS app and resubmit | **Yes — a new review (~1–3 days).** |

**Why:** the native app *bundles* a copy of `index.html`. Backend changes are always live because the app calls your Vercel API. But UI changes are baked into the build, so they ship through a new App Store version.

**To ship a UI update to the App Store:**
1. Make your web changes and deploy to Vercel (so web/PWA users get them too).
2. In `mobile/`: `npm run sync` (re-copies the web app into the build).
3. In Xcode: bump the **version/build number**, Archive, Upload, submit for review.

**Want instant UI updates without resubmitting?** Two options, both optional:
- **Capacitor Live Updates (Appflow)** — push web/UI changes over-the-air to installed apps (paid service). Best of both worlds.
- **Remote-load** — set `server.url` in `capacitor.config.json` to your Vercel URL so the app loads the live site directly. Then every Vercel deploy updates the app instantly — but it raises the 4.2 rejection risk and drops offline support. Riskier for approval; fine once you're established.

---

## Pre-submit checklist
- [ ] Developer account active, Bundle ID created, `appId` matches.
- [ ] Privacy policy URL reachable (`/privacy.html`).
- [ ] Account deletion works in-app (test it on a throwaway account).
- [ ] App icon (1024×1024) and launch screen set.
- [ ] Screenshots for required device sizes.
- [ ] Privacy nutrition label matches `privacy.html`.
- [ ] Decide on notifications (native push now, or later) and billing (Apple IAP if charging in-app).
- [ ] `npm run sync` after any web change, then bump the build number.
