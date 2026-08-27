// Copies the web app's static files from the parent folder into mobile/www,
// which Capacitor bundles into the native iOS app. Run this before `cap sync`.
// API calls resolve to the live Vercel origin automatically (see API_BASE in
// index.html), so the bundled app talks to your existing backend.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");
const WWW = path.join(__dirname, "www");
fs.mkdirSync(WWW, { recursive: true });

const files = [
  "index.html", "sw.js", "manifest.webmanifest", "privacy.html",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];
for (const f of files) {
  const from = path.join(SRC, f);
  if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(WWW, f)); console.log("copied " + f); }
  else console.warn("skip (missing): " + f);
}
console.log("web assets ready in mobile/www");
