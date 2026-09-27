require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const {
  getOrCreateUser, applyTaps, buyShopUpgrade, shopCost,
  growCategory, growCost, levelUp, claimNest, spin, claimTask, withDerived,
  GROW_MAX, TASKS, SPIN_REWARDS,
} = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;

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

function shopCosts(user) {
  return {
    tap: shopCost('tap', user.tap_level),
    energy: shopCost('energy', user.energy_level),
    regen: shopCost('regen', user.regen_level),
  };
}

function growCosts(user) {
  return {
    feed: user.feed_progress >= GROW_MAX ? null : growCost('feed', user.level, user.feed_progress),
    nest: user.nest_progress >= GROW_MAX ? null : growCost('nest', user.level, user.nest_progress),
    flame: user.flame_progress >= GROW_MAX ? null : growCost('flame', user.level, user.flame_progress),
  };
}

function fullState(user) {
  const derived = withDerived(user);
  return {
    user: derived,
    shopCosts: shopCosts(user),
    growCosts: growCosts(user),
    tasks: TASKS.map((t) => ({
      ...t,
      progress: Math.min(user[t.metric], t.target),
      claimed: derived.tasks_claimed.includes(t.id),
      ready: user[t.metric] >= t.target && !derived.tasks_claimed.includes(t.id),
    })),
  };
}

app.get('/api/state', identify, (req, res) => {
  const user = getOrCreateUser(req.tgUser.id, req.tgUser.username);
  res.json(fullState(user));
});

app.post('/api/tap', identify, (req, res) => {
  const count = Math.min(Number(req.body.count) || 0, 200);
  const user = applyTaps(req.tgUser.id, count);
  if (!user) return res.status(404).json({ error: 'no_user' });
  res.json(fullState(user));
});

app.post('/api/shop/upgrade', identify, (req, res) => {
  const result = buyShopUpgrade(req.tgUser.id, req.body.kind);
  if (result.error) return res.status(400).json(result);
  res.json(fullState(result.user));
});

app.post('/api/grow', identify, (req, res) => {
  const result = growCategory(req.tgUser.id, req.body.kind);
  if (result.error) return res.status(400).json(result);
  res.json(fullState(result.user));
});

app.post('/api/levelup', identify, (req, res) => {
  const result = levelUp(req.tgUser.id);
  if (result.error) return res.status(400).json(result);
  res.json({ ...fullState(result.user), reward: result.reward });
});

app.post('/api/nest/claim', identify, (req, res) => {
  const result = claimNest(req.tgUser.id);
  if (result.error) return res.status(400).json(result);
  res.json({ ...fullState(result.user), earned: result.earned });
});

app.post('/api/spin', identify, (req, res) => {
  const result = spin(req.tgUser.id);
  if (result.error) return res.status(400).json(result);
  res.json({ ...fullState(result.user), reward: result.reward });
});

app.post('/api/task/claim', identify, (req, res) => {
  const result = claimTask(req.tgUser.id, req.body.taskId);
  if (result.error) return res.status(400).json(result);
  res.json({ ...fullState(result.user), reward: result.reward });
});

app.get('/api/spin/rewards', identify, (req, res) => {
  res.json({ rewards: SPIN_REWARDS });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Phoenix Rises server running on port ${PORT}`));
