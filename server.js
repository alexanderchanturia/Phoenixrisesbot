require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { getOrCreateUser, applyTaps, buyUpgrade, costFor, topUsers, UPGRADES } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;

// Verifies that initData really came from Telegram, using the bot token.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}

// Middleware: identifies the calling user from Telegram initData.
// Falls back to a query param for local browser testing (NOT for production).
function identify(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUser = verifyInitData(initData);

  if (verifiedUser) {
    req.tgUser = verifiedUser;
    return next();
  }

  if (process.env.NODE_ENV !== 'production' && req.query.devUserId) {
    req.tgUser = { id: Number(req.query.devUserId), username: 'dev_tester' };
    return next();
  }

  return res.status(401).json({ error: 'invalid_or_missing_init_data' });
}

app.get('/api/state', identify, (req, res) => {
  const user = getOrCreateUser(req.tgUser.id, req.tgUser.username);
  res.json({ user, costs: nextCosts(user) });
});

app.post('/api/tap', identify, (req, res) => {
  const count = Math.min(Number(req.body.count) || 0, 200); // basic anti-spam cap per request
  const user = applyTaps(req.tgUser.id, count);
  if (!user) return res.status(404).json({ error: 'no_user' });
  res.json({ user });
});

app.post('/api/upgrade', identify, (req, res) => {
  const { kind } = req.body;
  const result = buyUpgrade(req.tgUser.id, kind);
  if (result.error) return res.status(400).json(result);
  res.json({ user: result.user, costs: nextCosts(result.user) });
});

app.get('/api/leaderboard', identify, (req, res) => {
  res.json({ leaders: topUsers(20) });
});

function nextCosts(user) {
  return {
    tap: costFor('tap', user.tap_level),
    energy: costFor('energy', user.energy_level),
    regen: costFor('regen', user.regen_level)
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Phoenix Rises server running on port ${PORT}`));
