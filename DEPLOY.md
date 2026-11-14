# Deploying ASHA — step-by-step guide

ASHA is a plain Node.js app with **zero npm dependencies**, so it deploys anywhere
that runs Node 18+. Two proven free paths below.

> ⚠️ **Before you publish:** the case data is currently in-memory (resets on restart)
> and there is no real login for professionals/officials. Fine for a demo deployment —
> just present it as a prototype. Also: the site offers mental-health guidance, so keep
> the helpline disclaimers visible.

---

## Option A — Render (recommended, free, ~10 minutes)

1. **Put the code on GitHub**
   - Create a repository at https://github.com/new (name it e.g. `asha-sih`).
   - In `D:\SIH`, run:
     ```bash
     git init
     git add package.json server.js index.html theme.css asha-brand.css asha-svg.html *.html README.md
     git commit -m "ASHA initial deploy"
     git branch -M main
     git remote add origin https://github.com/<your-username>/asha-sih.git
     git push -u origin main
     ```
   - **Never commit `.env`** (it is already in `.gitignore`) — it holds your Groq key.

2. **Create the web service**
   - Go to https://dashboard.render.com → **New + → Web Service**.
   - Connect your GitHub repo.
   - Settings:
     - **Runtime:** Node
     - **Build command:** *(leave empty)*
     - **Start command:** `node server.js`
     - **Instance type:** Free
   - Under **Environment → Add**:
     - `GROQ_API_KEY` = your key (from https://console.groq.com/keys)
     - (optional) `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`
   - **Create Web Service.** In ~1 minute you get a URL like
     `https://asha-sih.onrender.com`.

3. **Open the URL** — done. Health check: `https://<your-app>/api/health`
   should return `{"aiProvider":"groq",...}`.

Notes:
- Free Render instances **sleep after 15 min idle**; the first visit then takes ~50s
  to wake. Fine for a demo (open the link before you present).
- In-memory cases reset when it sleeps/redeploys — expected for the prototype.

---

## Option B — Railway (also free tier, simpler UI)

1. Push to GitHub exactly as in Option A step 1.
2. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node. Add the `GROQ_API_KEY` variable under **Variables**.
4. Open **Settings → Networking → Generate Domain** → you get a public URL.

---

## Enabling real SMS OTP with Supabase

ASHA's login page can verify real Indian mobile numbers with a 6-digit OTP.
The server prefers **Supabase Phone Auth** (falls back to Twilio Verify if
Supabase is absent).

**Important:** Supabase does not send SMS itself — it forwards to an SMS
provider you configure *inside* Supabase (Twilio, MessageBird, Vonage or
Textlocal). So the one-time setup is:

1. Create a free project at https://supabase.com
2. **Project Settings → API** — copy:
   - `Project URL`  → this is `SUPABASE_URL`
   - `anon public` key → this is `SUPABASE_ANON_KEY`
3. **Authentication → Sign In / Providers → Phone** → Enable.
   Enter your SMS provider credentials (e.g. Twilio Account SID + Auth Token).
   On Twilio's free trial, only your own verified numbers receive SMS — fine
   for a demo; upgrade for arbitrary numbers.
4. Put the two values in `.env` (local) or Render/Railway environment
   variables (deployed):
   ```
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_ANON_KEY=eyJhbGciOi...
   ```
5. Restart the server. `GET /api/health` should now show
   `"otpProvider":"supabase"` and `"smsConfigured":true`.

Flow afterwards: victim enters mobile → Supabase sends the SMS OTP →
ASHA verifies it via Supabase → the verified number is attached to the
case so professionals can contact the victim even after they close the
browser.

---

On Render: Settings → Custom Domains → add a domain you own (e.g. `ashaSupport.in`).
Free options: get a `.tech`/`.live` student domain or use a GitHub Student Pack domain.

---

## What to set up on your phone-lab demo day

- Open the deployed URL on the demo laptop **before** the presentation (wake the free instance).
- Have `https://<your-app>/api/health` open in a tab as a "system live" slide.
- Voice input needs Chrome/Edge + mic permission on the machine you present with.
