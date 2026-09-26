# The Phoenix Rises 🔥

A Telegram tap-to-earn Mini App, in the "Capybara Raise & Earn TON" style — coins live
in your own database for now, with a clean path to a real TON token later.

## How it's built
- **`bot.js`** — Telegraf bot. `/start` sends a button that opens the game as a Telegram
  Mini App (a Web App running inside Telegram).
- **`server.js`** — Express API. Verifies every request really came from Telegram
  (using `initData` + your bot token, per Telegram's Mini App auth spec), and stores
  each player's coins/energy/upgrades.
- **`db.js`** — SQLite (`better-sqlite3`) storage and the upgrade cost curves.
- **`public/`** — the game itself: HTML/CSS/JS with the Telegram Web App SDK.

Coins are earned by tapping the phoenix. Energy limits how many taps you can make before
it needs to regenerate. Coins buy three upgrades: more per tap, more max energy, and
faster regeneration — classic idle/clicker loop.

## Running it locally
```bash
npm install
cp .env.example .env
# edit .env: put your BOT_TOKEN from @BotFather, and a public HTTPS URL in WEBAPP_URL
npm run start   # starts the Express server (serves the game + API)
npm run bot     # in a second terminal, starts the Telegram bot
```

Telegram Mini Apps must be served over **HTTPS**, even for testing. Easiest options:
- `npx ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`)
- Paste the HTTPS URL it gives you into `WEBAPP_URL` in `.env`, restart the bot.

Then message your bot on Telegram and tap **"Enter the Flame."**

### Testing in a normal browser (no Telegram)
Open `http://localhost:3000/index.html?devUserId=12345` directly. The server accepts a
`devUserId` fallback when `NODE_ENV` isn't `production`, so you can play without Telegram
during development. Never ship that fallback to production — set `NODE_ENV=production`
on your real server so only verified Telegram requests are accepted.

## Deploying for real
1. Host `server.js` + `bot.js` somewhere that stays running (Railway, Render, Fly.io, a
   small VPS). SQLite is fine for launch; migrate to Postgres later if you need scale.
2. Set `NODE_ENV=production`, real `BOT_TOKEN`, and `WEBAPP_URL` pointing at your
   deployed HTTPS domain.
3. In @BotFather, set your bot's Menu Button to open the same `WEBAPP_URL`, so players
   can also launch the game from the chat menu, not just `/start`.

## About the future TON coin
This version is intentionally self-contained — no wallet, no blockchain calls — so you
can validate the game loop first. When you're ready to move toward a real token:
- Add [TonConnect](https://docs.ton.org/develop/dapps/ton-connect/overview) to `public/`
  to let players connect a TON wallet.
- Decide the conversion rule (e.g. a snapshot of `coins` balances at a cutoff, or an
  ongoing claim/withdraw flow) — this is a product and tokenomics decision, not a
  coding one, and worth deciding deliberately rather than baking in early.
- Keep the in-app ledger (this SQLite/Postgres database) as the source of truth until
  a real token conversion is designed; don't wire wallet balances directly into gameplay.

## Notes on fairness / anti-cheat
- All coin math happens **server-side** (`db.js`) — the client only sends "I tapped
  N times," never a coin amount, so a modified client can't grant itself coins.
- `initData` is HMAC-verified against your bot token on every request, so requests
  can't be spoofed as another user.
- Taps are capped per request (200) as a basic rate limit; for a public launch, add
  a proper per-second rate limiter too.
