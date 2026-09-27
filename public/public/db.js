const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'phoenix.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,

    -- currencies
    coins REAL NOT NULL DEFAULT 0,      -- ash-coin (soft currency)
    shards REAL NOT NULL DEFAULT 0,     -- ember-shard (future $PHOENIX)

    -- tap mechanics
    per_tap REAL NOT NULL DEFAULT 1,
    energy INTEGER NOT NULL DEFAULT 1000,
    max_energy INTEGER NOT NULL DEFAULT 1000,
    energy_regen_per_sec REAL NOT NULL DEFAULT 1,
    tap_level INTEGER NOT NULL DEFAULT 1,
    energy_level INTEGER NOT NULL DEFAULT 1,
    regen_level INTEGER NOT NULL DEFAULT 1,

    -- growth / leveling
    level INTEGER NOT NULL DEFAULT 1,
    feed_progress INTEGER NOT NULL DEFAULT 0,
    nest_progress INTEGER NOT NULL DEFAULT 0,
    flame_progress INTEGER NOT NULL DEFAULT 0,

    -- idle production (Nest)
    nest_rate REAL NOT NULL DEFAULT 10,   -- shards per hour
    last_nest_claim INTEGER NOT NULL,

    -- spin wheel
    last_spin INTEGER,

    -- tasks / counters
    total_taps INTEGER NOT NULL DEFAULT 0,
    total_claims INTEGER NOT NULL DEFAULT 0,
    total_shop_upgrades INTEGER NOT NULL DEFAULT 0,
    tasks_claimed TEXT NOT NULL DEFAULT '[]',

    last_seen INTEGER NOT NULL
  );
`);

const GROW_MAX = 3; // each category (feed/nest/flame) caps at 3 before a level-up is possible

const GROW_BASE_COST = { feed: 150, nest: 250, flame: 200 };

function growCost(kind, level, progress) {
  const base = GROW_BASE_COST[kind];
  return Math.round(base * (1 + level * 0.4) * (progress + 1));
}

// Shop upgrades (tap power / energy cap / regen speed) — separate from growth.
const SHOP_UPGRADES = {
  tap: { baseCost: 50, growth: 1.6, apply: (u) => { u.per_tap += 1; } },
  energy: { baseCost: 80, growth: 1.6, apply: (u) => { u.max_energy += 500; u.energy = u.max_energy; } },
  regen: { baseCost: 120, growth: 1.8, apply: (u) => { u.energy_regen_per_sec += 0.5; } }
};

function shopCost(kind, currentLevel) {
  const cfg = SHOP_UPGRADES[kind];
  return Math.round(cfg.baseCost * Math.pow(cfg.growth, currentLevel - 1));
}

const TASKS = [
  { id: 'first_taps', name: 'Tap the flame 50 times', metric: 'total_taps', target: 50, reward: { coins: 100 } },
  { id: 'reach_level_3', name: 'Reach level 3', metric: 'level', target: 3, reward: { coins: 300, shards: 10 } },
  { id: 'claim_nest_3', name: 'Claim the nest 3 times', metric: 'total_claims', target: 3, reward: { coins: 150 } },
  { id: 'upgrade_3', name: 'Buy 3 shop upgrades', metric: 'total_shop_upgrades', target: 3, reward: { shards: 15 } },
];

const SPIN_REWARDS = [
  { label: '+50 ash-coin', coins: 50 },
  { label: '+120 ash-coin', coins: 120 },
  { label: '+5 ember-shard', shards: 5 },
  { label: '+15 ember-shard', shards: 15 },
  { label: '+300 energy', energy: 300 },
  { label: 'Jackpot: +500 ash-coin', coins: 500 },
];

function getOrCreateUser(id, username) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, username, coins, shards, per_tap, energy, max_energy,
        energy_regen_per_sec, last_nest_claim, last_seen)
      VALUES (?, ?, 0, 0, 1, 1000, 1000, 1, ?, ?)
    `).run(id, username || '', now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return regenEnergy(user);
}

function regenEnergy(user) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - user.last_seen) / 1000);
  const regained = elapsedSec * user.energy_regen_per_sec;
  const newEnergy = Math.min(user.max_energy, user.energy + regained);
  db.prepare('UPDATE users SET energy = ?, last_seen = ? WHERE id = ?').run(newEnergy, now, user.id);
  user.energy = newEnergy;
  user.last_seen = now;
  return user;
}

function pendingShards(user) {
  const elapsedHours = Math.max(0, (Date.now() - user.last_nest_claim) / 3600000);
  return elapsedHours * user.nest_rate;
}

function applyTaps(id, tapCount) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  user = regenEnergy(user);

  const affordableTaps = Math.min(tapCount, Math.floor(user.energy));
  if (affordableTaps <= 0) return user;

  const earned = affordableTaps * user.per_tap;
  const newCoins = user.coins + earned;
  const newEnergy = user.energy - affordableTaps;
  const newTotalTaps = user.total_taps + affordableTaps;

  db.prepare('UPDATE users SET coins = ?, energy = ?, total_taps = ? WHERE id = ?')
    .run(newCoins, newEnergy, newTotalTaps, id);

  user.coins = newCoins;
  user.energy = newEnergy;
  user.total_taps = newTotalTaps;
  return user;
}

function buyShopUpgrade(id, kind) {
  if (!SHOP_UPGRADES[kind]) return { error: 'unknown_upgrade' };
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const levelField = `${kind}_level`;
  const currentLevel = user[levelField];
  const cost = shopCost(kind, currentLevel);
  if (user.coins < cost) return { error: 'not_enough_coins', cost };

  user.coins -= cost;
  SHOP_UPGRADES[kind].apply(user);
  user[levelField] = currentLevel + 1;
  user.total_shop_upgrades += 1;

  db.prepare(`
    UPDATE users SET coins = ?, per_tap = ?, max_energy = ?, energy = ?,
      energy_regen_per_sec = ?, tap_level = ?, energy_level = ?, regen_level = ?,
      total_shop_upgrades = ?
    WHERE id = ?
  `).run(
    user.coins, user.per_tap, user.max_energy, user.energy,
    user.energy_regen_per_sec, user.tap_level, user.energy_level, user.regen_level,
    user.total_shop_upgrades, id
  );

  return { user, nextCost: shopCost(kind, user[levelField]) };
}

function growCategory(id, kind) {
  if (!GROW_BASE_COST[kind]) return { error: 'unknown_category' };
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const field = `${kind}_progress`;
  if (user[field] >= GROW_MAX) return { error: 'already_maxed' };

  const cost = growCost(kind, user.level, user[field]);
  if (user.coins < cost) return { error: 'not_enough_coins', cost };

  user.coins -= cost;
  user[field] += 1;

  db.prepare(`UPDATE users SET coins = ?, ${field} = ? WHERE id = ?`).run(user.coins, user[field], id);
  return { user };
}

function canLevelUp(user) {
  return user.feed_progress >= GROW_MAX && user.nest_progress >= GROW_MAX && user.flame_progress >= GROW_MAX;
}

function levelUp(id) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);
  if (!canLevelUp(user)) return { error: 'not_ready' };

  const rewardCoins = 100 * user.level;
  const rewardShards = 5 * user.level;

  user.level += 1;
  user.feed_progress = 0;
  user.nest_progress = 0;
  user.flame_progress = 0;
  user.coins += rewardCoins;
  user.shards += rewardShards;
  user.max_energy += 100;
  user.nest_rate += 5;

  db.prepare(`
    UPDATE users SET level = ?, feed_progress = 0, nest_progress = 0, flame_progress = 0,
      coins = ?, shards = ?, max_energy = ?, nest_rate = ?
    WHERE id = ?
  `).run(user.level, user.coins, user.shards, user.max_energy, user.nest_rate, id);

  return { user, reward: { coins: rewardCoins, shards: rewardShards } };
}

function claimNest(id) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const earned = pendingShards(user);
  if (earned < 0.01) return { error: 'nothing_to_claim' };

  user.shards += earned;
  user.last_nest_claim = Date.now();
  user.total_claims += 1;

  db.prepare('UPDATE users SET shards = ?, last_nest_claim = ?, total_claims = ? WHERE id = ?')
    .run(user.shards, user.last_nest_claim, user.total_claims, id);

  return { user, earned };
}

function spin(id) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const now = Date.now();
  if (user.last_spin && now - user.last_spin < 24 * 3600 * 1000) {
    return { error: 'already_spun', nextSpinAt: user.last_spin + 24 * 3600 * 1000 };
  }

  const reward = SPIN_REWARDS[Math.floor(Math.random() * SPIN_REWARDS.length)];
  user.coins += reward.coins || 0;
  user.shards += reward.shards || 0;
  user.energy = Math.min(user.max_energy, user.energy + (reward.energy || 0));
  user.last_spin = now;

  db.prepare('UPDATE users SET coins = ?, shards = ?, energy = ?, last_spin = ? WHERE id = ?')
    .run(user.coins, user.shards, user.energy, user.last_spin, id);

  return { user, reward };
}

function claimTask(id, taskId) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return { error: 'unknown_task' };

  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const claimed = JSON.parse(user.tasks_claimed);
  if (claimed.includes(taskId)) return { error: 'already_claimed' };
  if (user[task.metric] < task.target) return { error: 'not_ready' };

  user.coins += task.reward.coins || 0;
  user.shards += task.reward.shards || 0;
  claimed.push(taskId);
  user.tasks_claimed = JSON.stringify(claimed);

  db.prepare('UPDATE users SET coins = ?, shards = ?, tasks_claimed = ? WHERE id = ?')
    .run(user.coins, user.shards, user.tasks_claimed, id);

  return { user, reward: task.reward };
}

function withDerived(user) {
  return {
    ...user,
    pending_shards: pendingShards(user),
    can_level_up: canLevelUp(user),
    tasks_claimed: JSON.parse(user.tasks_claimed),
  };
}

module.exports = {
  db, getOrCreateUser, applyTaps, buyShopUpgrade, shopCost, growCategory, growCost,
  levelUp, claimNest, spin, claimTask, withDerived,
  GROW_MAX, SHOP_UPGRADES, TASKS, SPIN_REWARDS,
};
